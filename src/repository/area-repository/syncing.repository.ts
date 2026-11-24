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
/**
 * Longest an area write waits for the user's lock: SQLite's busy timeout, so a
 * write fails as fast in-process as across processes. Postgres bounds its own
 * wait at 250 ms.
 */
const USER_LOCK_WAIT_MS = 1_000;
/**
 * How long a repair, which runs on reads, waits for the user's lock before
 * leaving the user dirty for the next read. Short, so a read is never held up
 * for long by a write, or by its own caller holding the lock.
 */
const REPAIR_LOCK_WAIT_MS = 100;
/** The boot rebuild runs before traffic is served, so it can wait longer per user. */
const REBUILD_LOCK_WAIT_MS = 5_000;

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

  /**
   * Rewrites the whole projection from the source, one user at a time under
   * their lock (see {@link reprojectUser}). Covers users only the source, only
   * the index, or only the dirty set knows about, so stale slices are cleared
   * too. A user whose lock stays busy is marked dirty for the next read.
   */
  async rebuildProjection(): Promise<void> {
    const areas = await this.source.listAllAreas();
    const userIds = new Set([
      ...areas.map((area) => area.userId),
      ...(await this.projection.listAllAreas()).map((area) => area.userId),
      ...(await this.redis.smembers(areaProjectionDirtyKey())),
    ]);

    let skipped = 0;
    for (const userId of userIds) {
      if (!(await this.reprojectUser(userId, REBUILD_LOCK_WAIT_MS))) {
        skipped += 1;
        await this.markDirty(userId);
      }
    }
    this.logger.info(
      `Projected ${areas.length} areas into the geofence index` +
        (skipped ? `; ${skipped} busy users left for repair` : ''),
    );
  }

  async addArea(area: Area): Promise<void> {
    await this.underUserLock(area.userId, async () => {
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
    return this.underUserLock(area.userId, async () => {
      if (!(await this.source.updateArea(area))) {
        return false;
      }
      await this.project(area.userId, () => this.projection.applyArea(area));
      return true;
    });
  }

  async removeArea(userId: string, areaId: string): Promise<void> {
    await this.underUserLock(userId, async () => {
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

  /**
   * Runs one write holding the user's lock, waiting at most
   * {@link USER_LOCK_WAIT_MS} for it. The source write commits with the lock's
   * transaction, after `work` has already updated the index, so a failure at
   * any point, the commit included, can leave the index ahead of the store.
   * The user is then marked dirty, so the next read rebuilds their index from
   * what the store really holds. A failure before anything was written only
   * costs one needless repair.
   */
  private async underUserLock<T>(userId: string, work: () => Promise<T>): Promise<T> {
    try {
      return await this.userLock.withUserLock(userId, work, { waitMs: USER_LOCK_WAIT_MS });
    } catch (error) {
      await this.markDirty(userId);
      throw error;
    }
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
      if (await this.reprojectUser(userId, REPAIR_LOCK_WAIT_MS)) {
        this.logger.info(`Repaired projected areas for ${userId}`);
      }
    }
  }

  /**
   * Rewrites one user's index from the source, holding their lock. Area writes
   * commit only when they release it, so the source then holds every write that
   * has already reached the index: without the lock, a repair could read the
   * old circle while an edit's new one sat in Redis uncommitted, write the old
   * one back, and call the user clean. The dirty marker is cleared inside the
   * lock for the same reason.
   *
   * Resolves false, leaving the user dirty, if the lock stays busy for `waitMs`
   * or the rewrite fails. A read made while holding the lock, as recompute's is,
   * therefore just gives up after `waitMs` instead of waiting for itself.
   */
  private async reprojectUser(userId: string, waitMs: number): Promise<boolean> {
    try {
      await this.userLock.withUserLock(
        userId,
        async () => {
          await this.projection.replaceUserAreas(userId, await this.source.listAreas(userId));
          this.localDirtyUserIds.delete(userId);
          await this.redis.srem(areaProjectionDirtyKey(), userId);
        },
        { waitMs },
      );
      return true;
    } catch (error) {
      this.logger.warn(`Could not re-project areas for ${userId}; will retry`, error);
      return false;
    }
  }
}
