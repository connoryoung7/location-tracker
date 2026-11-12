import type { RedisClient } from 'bun';
import type { Area } from '@/domain/types.ts';
import type { AreaProjection } from '@/domain/ports.ts';
import {
  areaMaxRadiusKey,
  areaMetaKey,
  areaMetaKeyPattern,
  geoAreasKey,
  geofenceInsideKey,
  geofencePendingExitKey,
  userIdFromAreaMetaKey,
} from '@/infrastructure/redis/keys.ts';

type AreaMeta = { name: string; radius: number };

const SCAN_BATCH_SIZE = 100;

/**
 * Projects areas into the Redis GEO index the geofence Lua script queries.
 *
 * This is a derived view, not a record of truth -- an `AreaRepository` owns the
 * areas. Every method is idempotent so a rebuild or repair can be replayed
 * safely.
 */
export class RedisAreaProjection implements AreaProjection {
  private redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async applyArea(area: Area): Promise<void> {
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
    // Drop the geofence state too, or the user stays "inside" an area that no
    // longer exists and a later location can never clear it.
    await this.redis.srem(geofenceInsideKey(userId), areaId);
    await this.redis.hdel(geofencePendingExitKey(userId), areaId);
  }

  /**
   * Rewrites one user's slice of the index. Geofence membership state
   * (`geofence:inside`, `geofence:pending-exit`) is deliberately preserved:
   * rebuilding the area definitions must not make a user who is already inside
   * an area re-enter it and fire a duplicate event.
   */
  async replaceUserAreas(userId: string, areas: Area[]): Promise<void> {
    await this.redis.del(geoAreasKey(userId));
    await this.redis.del(areaMetaKey(userId));
    await this.redis.del(areaMaxRadiusKey(userId));

    for (const area of areas) {
      await this.applyArea(area);
    }

    await this.pruneStaleGeofenceState(userId, new Set(areas.map((area) => area.id)));
  }

  async replaceAll(areas: Area[]): Promise<void> {
    const areasByUser = new Map<string, Area[]>();
    for (const area of areas) {
      const existing = areasByUser.get(area.userId);
      if (existing) {
        existing.push(area);
      } else {
        areasByUser.set(area.userId, [area]);
      }
    }

    // Users present only in Redis have no areas in the source of truth, so their
    // slice has to be cleared explicitly -- iterating the incoming areas alone
    // would leave them behind.
    for (const userId of await this.projectedUserIds()) {
      if (!areasByUser.has(userId)) {
        areasByUser.set(userId, []);
      }
    }

    for (const [userId, userAreas] of areasByUser) {
      await this.replaceUserAreas(userId, userAreas);
    }
  }

  async listAllAreas(): Promise<Area[]> {
    const areasByUser = await Promise.all(
      (await this.projectedUserIds()).map((userId) => this.listAreas(userId)),
    );

    return areasByUser.flat();
  }

  async healthCheck(): Promise<void> {
    await this.redis.ping();
  }

  private async listAreas(userId: string): Promise<Area[]> {
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

  /** Users with a slice in the index, discovered by scanning the meta keys. */
  private async projectedUserIds(): Promise<string[]> {
    const userIds: string[] = [];
    let cursor = '0';

    do {
      const [nextCursor, keys] = (await this.redis.send('SCAN', [
        cursor,
        'MATCH',
        areaMetaKeyPattern(),
        'COUNT',
        String(SCAN_BATCH_SIZE),
      ])) as [string, string[]];

      userIds.push(...keys.map(userIdFromAreaMetaKey));
      cursor = nextCursor;
    } while (cursor !== '0');

    // SCAN can return the same key more than once across iterations.
    return [...new Set(userIds)];
  }

  /** Forgets membership state for areas that no longer exist. */
  private async pruneStaleGeofenceState(userId: string, liveAreaIds: Set<string>): Promise<void> {
    const inside = await this.redis.smembers(geofenceInsideKey(userId));
    for (const areaId of inside) {
      if (!liveAreaIds.has(areaId)) {
        await this.redis.srem(geofenceInsideKey(userId), areaId);
      }
    }

    const pending = await this.redis.hgetall(geofencePendingExitKey(userId));
    for (const areaId of Object.keys(pending)) {
      if (!liveAreaIds.has(areaId)) {
        await this.redis.hdel(geofencePendingExitKey(userId), areaId);
      }
    }
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
