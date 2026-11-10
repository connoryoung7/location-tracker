import type { RedisClient } from 'bun';
import type { Area } from '@/domain/types.ts';
import type { AreaProjection, AreaRepository, Logger } from '@/domain/ports.ts';
import { areaProjectionDirtyKey } from '@/infrastructure/redis/keys.ts';

/**
 * Keeps the Redis geofence index in step with the area record of truth.
 *
 * Writes go to the source first, then the projection. A projection write that
 * fails is **not** fatal -- the source stays correct and the affected user is
 * marked dirty so the next read repairs them. Reads always come from the source.
 *
 * This mirrors the fan-out shape of `CompositeEventPublisher`: one failing sink
 * must not take down the request.
 */
export class SyncingAreaRepository implements AreaRepository {
  private source: AreaRepository;
  private projection: AreaProjection;
  private redis: RedisClient;
  private logger: Logger;

  constructor(
    source: AreaRepository,
    projection: AreaProjection,
    redis: RedisClient,
    logger: Logger,
  ) {
    this.source = source;
    this.projection = projection;
    this.redis = redis;
    this.logger = logger;
  }

  /**
   * Brings the projection in line with the source at startup.
   *
   * Runs the one-time cutover first: areas used to live only in Redis, so if the
   * source is empty and the projection is not, those areas are imported rather
   * than destroyed by the rebuild. Guarded on the source being empty, so it can
   * never overwrite real data and is safe to leave in place permanently.
   */
  async initialize(): Promise<void> {
    const sourceAreas = await this.source.listAllAreas();

    if (sourceAreas.length === 0) {
      const projected = await this.projection.listAllAreas();
      if (projected.length > 0) {
        this.logger.info(`Importing ${projected.length} Redis-only areas into the area store`);
        for (const area of projected) {
          await this.source.addArea(area);
        }
      }
    }

    await this.rebuildProjection();
  }

  /** Rewrites the whole projection from the source. */
  async rebuildProjection(): Promise<void> {
    const areas = await this.source.listAllAreas();
    await this.projection.replaceAll(areas);
    await this.redis.del(areaProjectionDirtyKey());
    this.logger.info(`Projected ${areas.length} areas into the geofence index`);
  }

  async addArea(area: Area): Promise<void> {
    await this.source.addArea(area);
    await this.project(area.userId, () => this.projection.applyArea(area));
  }

  async removeArea(userId: string, areaId: string): Promise<void> {
    await this.source.removeArea(userId, areaId);
    await this.project(userId, () => this.projection.removeArea(userId, areaId));
  }

  async listAreas(userId: string): Promise<Area[]> {
    await this.repairDrift();
    return this.source.listAreas(userId);
  }

  async listAllAreas(): Promise<Area[]> {
    await this.repairDrift();
    return this.source.listAllAreas();
  }

  async getArea(userId: string, areaId: string): Promise<Area | undefined> {
    return this.source.getArea(userId, areaId);
  }

  /** Healthy only when both stores answer -- a dead projection stops geofencing. */
  async healthCheck(): Promise<void> {
    await this.source.healthCheck();
    await this.projection.healthCheck();
  }

  private async project(userId: string, write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (error) {
      // The source already committed, so the projection is now stale for this
      // user. Record it instead of failing the request; geofencing for this user
      // is wrong until the repair runs.
      this.logger.error(`Failed to project areas for ${userId}, marking dirty`, error);
      await this.markDirty(userId);
    }
  }

  private async markDirty(userId: string): Promise<void> {
    try {
      await this.redis.sadd(areaProjectionDirtyKey(), userId);
    } catch (error) {
      // Redis is unreachable, so the dirty marker cannot be stored either. The
      // boot rebuild is the backstop.
      this.logger.error(`Failed to mark ${userId} dirty; rebuild on next boot`, error);
    }
  }

  /**
   * Re-projects any user whose write failed earlier. Called from reads so the
   * index self-heals without a background process -- the map UI's poll is enough
   * to trigger it. A no-op beyond one SMEMBERS when nothing is dirty.
   */
  private async repairDrift(): Promise<void> {
    let dirtyUserIds: string[];
    try {
      dirtyUserIds = await this.redis.smembers(areaProjectionDirtyKey());
    } catch {
      // Redis still down. Reads come from the source, so serve them anyway.
      return;
    }

    for (const userId of dirtyUserIds) {
      try {
        await this.projection.replaceUserAreas(userId, await this.source.listAreas(userId));
        await this.redis.srem(areaProjectionDirtyKey(), userId);
        this.logger.info(`Repaired projected areas for ${userId}`);
      } catch (error) {
        this.logger.error(`Failed to repair projected areas for ${userId}`, error);
      }
    }
  }
}
