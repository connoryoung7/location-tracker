import type { RedisClient } from 'bun';
import type { GeofenceReplayState } from '@/domain/types.ts';
import type { GeofenceEvaluator } from '@/domain/ports.ts';
import type { GeofenceEvent } from '@/domain/events.ts';
import {
  areaMaxRadiusKey,
  areaMetaKey,
  geoAreasKey,
  geofenceInsideKey,
  geofencePendingExitKey,
} from '@/infrastructure/redis/keys.ts';
import { evalGeofenceScript } from '@/infrastructure/geofence/geofence.lua.ts';

type RawEvent = [
  type: string,
  areaId: string,
  areaName: string,
  lat: string,
  lon: string,
  tst: string,
];

export class RedisGeofenceEvaluator implements GeofenceEvaluator {
  private redis: RedisClient;
  private thresholdSeconds: number;

  constructor(redis: RedisClient, thresholdSeconds: number) {
    this.redis = redis;
    this.thresholdSeconds = thresholdSeconds;
  }

  async restoreState(userId: string, state: GeofenceReplayState): Promise<void> {
    await this.redis.send('EVAL', [
      `
      local state = cjson.decode(ARGV[1])
      redis.call('DEL', KEYS[1], KEYS[2])
      for _, id in ipairs(state.inside) do redis.call('SADD', KEYS[1], id) end
      for _, pair in ipairs(state.pending) do redis.call('HSET', KEYS[2], pair[1], pair[2]) end
    `,
      '2',
      geofenceInsideKey(userId),
      geofencePendingExitKey(userId),
      JSON.stringify(state),
    ]);
  }

  async evaluate(userId: string, lon: number, lat: number, tst: number): Promise<GeofenceEvent[]> {
    const keys = [
      geoAreasKey(userId),
      areaMetaKey(userId),
      areaMaxRadiusKey(userId),
      geofenceInsideKey(userId),
      geofencePendingExitKey(userId),
    ];
    const args = [userId, String(lon), String(lat), String(tst), String(this.thresholdSeconds)];

    const rawEvents = (await evalGeofenceScript(this.redis, keys, args)) as RawEvent[];

    return rawEvents.map(([type, areaId, areaName, eventLat, eventLon, eventTst]) => {
      const base = {
        userId,
        areaId,
        areaName: areaName || undefined,
        lat: Number(eventLat),
        lon: Number(eventLon),
        tst: Number(eventTst),
      };

      return type === 'entered'
        ? { _type: 'area.entered' as const, ...base }
        : { _type: 'area.exited' as const, ...base };
    });
  }
}
