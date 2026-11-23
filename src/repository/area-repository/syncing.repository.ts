import type { RedisClient } from 'bun';
import type { Area } from '@/domain/types.ts';
import type { AreaProjection, AreaRepository, Logger, UserLock } from '@/domain/ports.ts';
import { areaProjectionDirtyKey } from '@/infrastructure/redis/keys.ts';

/**
 * Keeps the Redis geofence index in step with the area record of truth.
 *
 * Writes go to the source first, then the projection. A projection write that
 * fails is **not** fatal -- the source stays correct and the affected user is
 * marked dirty so the next read repairs them. Reads always come from the source.
 *
 * Each write holds the user's lock, the one ingestion and recompute hold, from
 * the source write until the projection write is done. Writes for one user
 * therefore reach both stores in the same order from every process. Without
 * it, two edits of one area could land in the source as A then B but in Redis
 * as B then A, and geofencing would keep using the older circle.
 *
 * This mirrors the fan-out shape of `CompositeEventPublisher`: one failing sink
 * must not take down the request.
 */
export class SyncingAreaRepository implements AreaRepository {
  private source: AreaRepository;
  private projection: AreaProjection;
  private redis: RedisClient;
  private logger: Logger;
  private userLock: UserLock;
  /**
   * Users whose dirty marker could not be stored in Redis (it was unreachable).
   * Kept in-process so repairDrift can still find them once Redis returns.
   */
  private localDirtyUserIds = new Set<string>();

  constructor(
    source: AreaRepository,
    projection: AreaProjection,
    redis: RedisClient,
    logger: Logger,
    userLock: UserLock,
  ) {
    this.source = source;
    this.projection = projection;
    this.redis = redis;
    this.logger = logger;
    this.userLock = userLock;
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

  /**
   * Retries {@link initialize} in the background until it succeeds. For startups
   * where Redis was not reachable in time: without this the projection would stay
   * empty until the process restarted.
   */
  initializeInBackground(retryMs: number = 5_000): void {
    const attempt = async (): Promise<void> => {
      try {
        await this.initialize();
      } catch (error) {
        this.logger.warn(`Area projection not ready, retrying in ${retryMs}ms: ${error}`);
        setTimeout(attempt, retryMs).unref();
      }
    };
    setTimeout(attempt, retryMs).unref();
  }

  /** Rewrites the whole projection from the source. */
  async rebuildProjection(): Promise<void> {
    const areas = await this.source.listAllAreas();
    await this.projection.replaceAll(areas);
    await this.redis.del(areaProjectionDirtyKey());
    this.logger.info(`Projected ${areas.length} areas into the geofence index`);
  }

  async addArea(area: Area): Promise<void> {
    await this.userLock.withUserLock(area.userId, async () => {
      await this.source.addArea(area);
      await this.project(area.userId, () => this.projection.applyArea(area));
    });
  }

  /**
   * Projects only an update the source actually made. Under the user's lock no
   * other edit or delete of the area can land between the two writes, so the
   * projection always ends on the source's latest state.
   */
  async updateArea(area: Area): Promise<boolean> {
    return this.userLock.withUserLock(area.userId, async () => {
      if (!(await this.source.updateArea(area))) {
        return false;
      }
      await this.project(area.userId, () => this.projection.applyArea(area));
      return true;
    });
  }

  async removeArea(userId: string, areaId: string): Promise<void> {
    await this.userLock.withUserLock(userId, async () => {
      await this.source.removeArea(userId, areaId);
      await this.project(userId, () => this.projection.removeArea(userId, areaId));
    });
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

  /**
   * Source only: a category never affects whether someone is inside an area,
   * so the geofence's Redis index doesn't hold categories.
   */
  async setAreaCategory(
    userId: string,
    areaId: string,
    categoryId: string | null,
  ): Promise<boolean> {
    return this.source.setAreaCategory(userId, areaId, categoryId);
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
      // Redis is unreachable, so the marker cannot be stored there. Remember it
      // in-process so repairDrift can re-project once Redis is back.
      this.localDirtyUserIds.add(userId);
      this.logger.error(`Failed to mark ${userId} dirty in Redis; tracking locally`, error);
    }
  }

  /**
   * Re-projects any user whose write failed earlier. Called from reads so the
   * index self-heals without a background process -- the map UI's poll is enough
   * to trigger it. A no-op beyond one SMEMBERS when nothing is dirty.
   *
   * Repairs take no lock: recompute reads areas while holding the user's lock,
   * and that lock is not re-entrant. A write can therefore land between a
   * repair's read and its projection write and be overwritten by the older
   * snapshot. So the user stays dirty unless the source, read again afterwards,
   * still matches what was projected; the next read then repairs from fresh data.
   */
  private async repairDrift(): Promise<void> {
    let redisDirtyUserIds: string[];
    try {
      redisDirtyUserIds = await this.redis.smembers(areaProjectionDirtyKey());
    } catch {
      // Redis still down. Reads come from the source, so serve them anyway.
      return;
    }

    const dirtyUserIds = new Set([...redisDirtyUserIds, ...this.localDirtyUserIds]);
    for (const userId of dirtyUserIds) {
      try {
        const projected = await this.source.listAreas(userId);
        await this.projection.replaceUserAreas(userId, projected);
        if (!isSameProjection(projected, await this.source.listAreas(userId))) {
          this.logger.info(`Areas for ${userId} changed during repair; repairing again next read`);
          continue;
        }
        this.localDirtyUserIds.delete(userId);
        await this.redis.srem(areaProjectionDirtyKey(), userId);
        this.logger.info(`Repaired projected areas for ${userId}`);
      } catch (error) {
        this.logger.error(`Failed to repair projected areas for ${userId}`, error);
      }
    }
  }
}

/**
 * Whether two reads of a user's areas project the same index: same areas,
 * names, centres and radii. Categories are not projected, so they are ignored.
 */
function isSameProjection(a: Area[], b: Area[]): boolean {
  const key = (areas: Area[]) =>
    JSON.stringify(
      areas
        .map(({ id, name, lat, lon, radius }) => [id, name, lat, lon, radius])
        .sort(([idA], [idB]) => String(idA).localeCompare(String(idB))),
    );
  return key(a) === key(b);
}
