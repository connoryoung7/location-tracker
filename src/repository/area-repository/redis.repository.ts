import type { RedisClient } from 'bun';
import type { Area } from '@/domain/types.ts';
import type { AreaRepository } from '@/domain/ports.ts';
import {
  areaMaxRadiusKey,
  areaMetaKey,
  geoAreasKey,
  geofenceInsideKey,
  geofencePendingExitKey,
} from '@/infrastructure/redis/keys.ts';

type AreaMeta = { name: string; radius: number };

export class RedisAreaRepository implements AreaRepository {
  private redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async addArea(area: Area): Promise<void> {
    await this.redis.send('GEOADD', [
      geoAreasKey(area.userId),
      String(area.lon),
      String(area.lat),
      area.id,
    ]);
    await this.redis.hset(areaMetaKey(area.userId), {
      [area.id]: JSON.stringify({ name: area.name, radius: area.radius } satisfies AreaMeta),
    });
    await this.recomputeMaxRadius(area.userId);
  }

  async removeArea(userId: string, areaId: string): Promise<void> {
    await this.redis.zrem(geoAreasKey(userId), areaId);
    await this.redis.hdel(areaMetaKey(userId), areaId);
    await this.recomputeMaxRadius(userId);
    await this.redis.srem(geofenceInsideKey(userId), areaId);
    await this.redis.hdel(geofencePendingExitKey(userId), areaId);
  }

  async listAreas(userId: string): Promise<Area[]> {
    const meta = await this.redis.hgetall(areaMetaKey(userId));
    const areaIds = Object.keys(meta);
    if (areaIds.length === 0) {
      return [];
    }

    const positions = (await this.redis.send('GEOPOS', [geoAreasKey(userId), ...areaIds])) as (
      | [string, string]
      | null
    )[];

    const areas: Area[] = [];
    areaIds.forEach((areaId, index) => {
      const position = positions[index];
      if (!position) {
        return;
      }
      const { name, radius } = JSON.parse(meta[areaId]!) as AreaMeta;
      areas.push({
        id: areaId,
        userId,
        name,
        lon: Number(position[0]),
        lat: Number(position[1]),
        radius,
      });
    });

    return areas;
  }

  async getArea(userId: string, areaId: string): Promise<Area | undefined> {
    const rawMeta = await this.redis.hget(areaMetaKey(userId), areaId);
    if (rawMeta === null) {
      return undefined;
    }

    const positions = (await this.redis.send('GEOPOS', [geoAreasKey(userId), areaId])) as (
      | [string, string]
      | null
    )[];
    const position = positions[0];
    if (!position) {
      return undefined;
    }

    const { name, radius } = JSON.parse(rawMeta) as AreaMeta;
    return {
      id: areaId,
      userId,
      name,
      lon: Number(position[0]),
      lat: Number(position[1]),
      radius,
    };
  }

  async healthCheck(): Promise<void> {
    await this.redis.ping();
  }

  private async recomputeMaxRadius(userId: string): Promise<void> {
    const meta = await this.redis.hgetall(areaMetaKey(userId));
    const radii = Object.values(meta).map((json) => (JSON.parse(json) as AreaMeta).radius);

    if (radii.length === 0) {
      await this.redis.del(areaMaxRadiusKey(userId));
      return;
    }

    await this.redis.set(areaMaxRadiusKey(userId), String(Math.max(...radii)));
  }
}
