import type { RedisClient } from 'bun';
import type { Area } from '@/domain/types.ts';
import type { AreaProjection, AreaRepository, Logger } from '@/domain/ports.ts';
import { areaProjectionDirtyKey } from '@/infrastructure/redis/keys.ts';
import {
  AreaLockBusyError,
  NO_ANSWER,
  RedisAreaLock,
  answerWithin,
} from '@/repository/area-repository/redis.area-lock.ts';

/** Longest an area write waits for another writer of the same user. */
const WRITE_LOCK_WAIT_MS = 1_000;
/** Longest a repair or rebuild waits for one user before leaving them for the next pass. */
const REPAIR_LOCK_WAIT_MS = 100;
/** How often {@link SyncingAreaRepository.startRepairing} looks for dirty users. */
const REPAIR_INTERVAL_MS = 10_000;
/** Longest a dirty marker waits for Redis before it is kept in-process instead. */
const MARK_DIRTY_TIMEOUT_MS = 1_000;

/**
 * Keeps the Redis geofence index in step with the area record of truth.
 *
 * Each write goes to the source first, committed on its own, then to the
 * projection, both holding the user's area lock ({@link RedisAreaLock}).
 * Writes for one user therefore reach both stores in the same order from every
 * process: without it, two edits of one area could land in the source as A
 * then B but in Redis as B then A, and geofencing would keep using the older
 * circle. And since the source has committed before Redis is touched, Redis
 * never holds a change the source then rolled back.
 *
 * A projection write that fails is **not** fatal -- the source stays correct
 * and the affected user is marked dirty for a repair. Repairs rebuild a user
 * from the source under the same lock, on a timer (see {@link startRepairing}).
 * Reads always come from the source and never repair.
 *
 * This mirrors the fan-out shape of `CompositeEventPublisher`: one failing sink
 * must not take down the request.
 */
export class SyncingAreaRepository implements AreaRepository {
  private source: AreaRepository;
  private projection: AreaProjection;
  private redis: RedisClient;
  private logger: Logger;
  private lock: RedisAreaLock;
  /**
   * Users whose dirty marker could not be stored in Redis (it was unreachable).
   * Kept in-process so repairDrift can still find them once Redis returns.
   */
  private localDirtyUserIds = new Set<string>();
  private repairTimer: ReturnType<typeof setInterval> | undefined;
  private isRepairing = false;

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
    // A write or repair whose lock expired under it may have written a stale
    // index, so that user is rebuilt by the next repair.
    this.lock = new RedisAreaLock(redis, logger, (userId) => this.markDirty(userId));
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
   * their lock (see {@link reprojectUser}). Covers users the source, the index,
   * or the dirty set knows about. The index's users are found from its
   * metadata keys, so a slice left half-written by a failed write is found and
   * cleared even when its areas can no longer be read back whole.
   *
   * A user that cannot be rebuilt now, because their lock is busy or a write
   * fails, is marked dirty, and the repair timer retries them.
   */
  async rebuildProjection(): Promise<void> {
    const areas = await this.source.listAllAreas();
    const userIds = new Set([
      ...areas.map((area) => area.userId),
      ...(await this.projection.listProjectedUserIds()),
      ...(await this.redis.smembers(areaProjectionDirtyKey())),
    ]);

    let deferred = 0;
    for (const userId of userIds) {
      if (!(await this.reprojectUser(userId))) {
        deferred += 1;
        await this.markDirty(userId);
      }
    }
    this.logger.info(
      `Projected ${areas.length} areas into the geofence index` +
        (deferred ? `; ${deferred} users left for repair` : ''),
    );
  }

  /**
   * Repairs dirty users every {@link REPAIR_INTERVAL_MS} until stopped. Every
   * entrypoint starts it, ingestion included, so a failed write or rebuild heals
   * even with no one reading areas.
   */
  startRepairing(intervalMs: number = REPAIR_INTERVAL_MS): void {
    if (this.repairTimer) return;
    this.repairTimer = setInterval(() => {
      // A slow pass must not overlap the next one.
      if (this.isRepairing) return;
      this.isRepairing = true;
      this.repairDrift().finally(() => {
        this.isRepairing = false;
      });
    }, intervalMs);
    this.repairTimer.unref();
  }

  stopRepairing(): void {
    clearInterval(this.repairTimer);
    this.repairTimer = undefined;
  }

  async addArea(area: Area): Promise<void> {
    await this.write(
      area.userId,
      () => this.source.addArea(area),
      () => this.projection.applyArea(area),
    );
  }

  /** Projects only an update the source actually made. */
  async updateArea(area: Area): Promise<boolean> {
    return this.write(
      area.userId,
      () => this.source.updateArea(area),
      (isUpdated) => (isUpdated ? this.projection.applyArea(area) : undefined),
    );
  }

  async removeArea(userId: string, areaId: string): Promise<void> {
    await this.write(
      userId,
      () => this.source.removeArea(userId, areaId),
      () => this.projection.removeArea(userId, areaId),
    );
  }

  async listAreas(userId: string): Promise<Area[]> {
    return this.source.listAreas(userId);
  }

  async listAllAreas(): Promise<Area[]> {
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
   * Re-projects every dirty user it can. The repair timer calls this; a user
   * whose lock is busy, or whose rewrite fails, stays dirty for the next pass.
   * A no-op beyond one SMEMBERS when nothing is dirty.
   */
  async repairDrift(): Promise<void> {
    let redisDirtyUserIds: string[];
    try {
      redisDirtyUserIds = await this.redis.smembers(areaProjectionDirtyKey());
    } catch {
      // Redis still down; the next pass tries again.
      return;
    }

    const dirtyUserIds = new Set([...redisDirtyUserIds, ...this.localDirtyUserIds]);
    for (const userId of dirtyUserIds) {
      if (await this.reprojectUser(userId)) {
        this.logger.info(`Repaired projected areas for ${userId}`);
      }
    }
  }

  /**
   * One area write, holding the user's area lock: the source first, then, from
   * what it returned, the index. A busy lock rejects the write, so the caller
   * can retry. If Redis cannot be reached at all, the index cannot be written
   * either, so the write goes to the source alone and the user is marked dirty
   * for the repair, which takes the lock once Redis is back. The index is never
   * written without the lock.
   */
  private async write<T>(
    userId: string,
    writeSource: () => T | Promise<T>,
    writeIndex: (result: T) => Promise<void> | undefined,
  ): Promise<T> {
    let hasStarted = false;
    try {
      return await this.lock.withLock(
        userId,
        async () => {
          hasStarted = true;
          const result = await writeSource();
          await this.project(userId, async () => {
            await writeIndex(result);
          });
          return result;
        },
        WRITE_LOCK_WAIT_MS,
      );
    } catch (error) {
      if (hasStarted || error instanceof AreaLockBusyError) throw error;
      this.logger.warn(`Area lock unreachable for ${userId}; writing the store only`, error);
      const result = await writeSource();
      await this.markDirty(userId);
      return result;
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
      const answer = await answerWithin(
        this.redis.sadd(areaProjectionDirtyKey(), userId),
        MARK_DIRTY_TIMEOUT_MS,
      );
      if (answer === NO_ANSWER) throw new Error('Redis did not answer');
    } catch (error) {
      // Redis is unreachable, or not answering, so the marker cannot be stored
      // there. Remember it in-process so repairDrift can re-project once Redis
      // is back.
      this.localDirtyUserIds.add(userId);
      this.logger.error(`Failed to mark ${userId} dirty in Redis; tracking locally`, error);
    }
  }

  /**
   * Rewrites one user's index from the source, holding their area lock, so no
   * write for them is half done: a repair can never write an older circle back
   * over a newer one. The dirty marker is cleared inside the lock for the same
   * reason.
   *
   * Resolves false, leaving the user dirty, if the lock stays busy for
   * {@link REPAIR_LOCK_WAIT_MS}, Redis is unreachable, or the rewrite fails.
   */
  private async reprojectUser(userId: string): Promise<boolean> {
    try {
      await this.lock.withLock(
        userId,
        async () => {
          await this.projection.replaceUserAreas(userId, await this.source.listAreas(userId));
          this.localDirtyUserIds.delete(userId);
          await this.redis.srem(areaProjectionDirtyKey(), userId);
        },
        REPAIR_LOCK_WAIT_MS,
      );
      return true;
    } catch (error) {
      this.logger.warn(`Could not re-project areas for ${userId}; will retry`, error);
      return false;
    }
  }
}
