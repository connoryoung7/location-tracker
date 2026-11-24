import type {
  Address,
  Area,
  AreaCategory,
  AreaCategoryColor,
  GeocodingResult,
  GeofenceReplayState,
  LocationPayload,
  PointOfInterest,
  TransitionPayload,
  WaypointPayload,
} from '@/domain/types.ts';
import type { DomainEvent, GeofenceEvent } from '@/domain/events.ts';

export interface LocationService {
  saveLocation(payload: LocationPayload): void | Promise<void>;
  saveTransition(payload: TransitionPayload): void | Promise<void>;
  saveWaypoint(payload: WaypointPayload): void | Promise<void>;
}

export interface ReplayStateRepository {
  readReplayState(userId: string): Promise<GeofenceReplayState | undefined>;
  clearReplayState(userId: string): Promise<void>;
}

export interface UserLock {
  /**
   * Runs `work` holding the user's lock, across processes. `waitMs` caps how
   * long to wait for the lock before rejecting without running `work`; an
   * implementation that already bounds the wait more tightly may ignore it.
   */
  withUserLock<T>(
    userId: string,
    work: () => Promise<T>,
    options?: { waitMs?: number },
  ): Promise<T>;
}

export interface LocationRepository {
  saveLocation(payload: LocationPayload): void | Promise<void>;
  saveTransition(payload: TransitionPayload): void | Promise<void>;
  saveWaypoint(payload: WaypointPayload): void | Promise<void>;
  saveAddress(lat: number, lon: number, address: Address): void | Promise<void>;
  saveAreaEvent(event: GeofenceEvent): void | Promise<void>;
  healthCheck(): Promise<void>;
}

export interface AreaRepository {
  /**
   * Upserts on `id`. A re-upsert without `categoryId` keeps the area's existing
   * category, so re-running a seed never strips categories; use
   * {@link setAreaCategory} to change or clear one.
   */
  addArea(area: Area): void | Promise<void>;
  /**
   * Changes the name and circle of an area the user already has, in one atomic
   * write. Resolves false, changing nothing, when they have no area with that ID:
   * unlike `addArea`, it never inserts, so it cannot bring back a deleted area.
   */
  updateArea(area: Area): boolean | Promise<boolean>;
  removeArea(userId: string, areaId: string): void | Promise<void>;
  listAreas(userId: string): Promise<Area[]>;
  listAllAreas(): Promise<Area[]>;
  getArea(userId: string, areaId: string): Promise<Area | undefined>;
  /**
   * Puts the area in a category, or takes it out with `null`. The caller checks
   * the category belongs to the same user. Returns false if the user has no
   * such area.
   */
  setAreaCategory(userId: string, areaId: string, categoryId: string | null): Promise<boolean>;
  healthCheck(): Promise<void>;
}

/** A user's categories for their areas. Every method is scoped to one user. */
export interface AreaCategoryRepository {
  /** Ordered by name, ignoring case. */
  listCategories(userId: string): Promise<AreaCategory[]>;
  getCategory(userId: string, categoryId: string): Promise<AreaCategory | undefined>;
  /** Looks a category up by name, ignoring case. */
  findCategoryByName(userId: string, name: string): Promise<AreaCategory | undefined>;
  addCategory(category: AreaCategory): Promise<'added' | 'name-taken'>;
  updateCategory(
    userId: string,
    categoryId: string,
    changes: { name?: string; color?: AreaCategoryColor },
  ): Promise<'updated' | 'not-found' | 'name-taken'>;
  /**
   * Deletes the category and, in the same transaction, takes its areas out of
   * it, so they stay in place uncategorised. Returns false if there is no such
   * category.
   */
  removeCategory(userId: string, categoryId: string): Promise<boolean>;
}

/**
 * The derived Redis view of the areas the geofence evaluator queries. Areas are
 * owned by an `AreaRepository`; this is a rebuildable index, never a record of
 * truth, so every method must be safe to replay.
 */
export interface AreaProjection {
  /** Upsert one area into the index. */
  applyArea(area: Area): Promise<void>;
  /** Drop one area and any geofence state tracking it. */
  removeArea(userId: string, areaId: string): Promise<void>;
  /** Replace a single user's areas, used for targeted repair. */
  replaceUserAreas(userId: string, areas: Area[]): Promise<void>;
  /** Replace the whole index, used for the boot rebuild. */
  replaceAll(areas: Area[]): Promise<void>;
  /** Areas currently in the index. Only the cutover import reads these. */
  listAllAreas(): Promise<Area[]>;
  /**
   * Every user with any slice in the index, even one too incomplete to read
   * back as areas, so a rebuild can clear it.
   */
  listProjectedUserIds(): Promise<string[]>;
  healthCheck(): Promise<void>;
}

export interface GeofenceEvaluator {
  restoreState?(userId: string, state: GeofenceReplayState): Promise<void>;
  evaluate(userId: string, lon: number, lat: number, tst: number): Promise<GeofenceEvent[]>;
}

export interface EventPublisher {
  publish(event: DomainEvent): void | Promise<void>;
}

export interface Logger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface PayloadDecryptor {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): Uint8Array;
}

export interface Geocoder {
  reverseGeocode(lat: number, lon: number): Promise<GeocodingResult>;
}

/** Looks up named places (shops, parks, …) around a coordinate. */
export interface PlaceFinder {
  findNearbyPlaces(lat: number, lon: number, radiusMeters: number): Promise<PointOfInterest[]>;
}

export interface NotificationSender {
  sendNotification(subject: string, body: string): Promise<void>;
}

export interface MetricsCollector {
  recordRecompute?(durationMs: number, locations: number, events: number): void;
  recordRequest(method: string, path: string, statusCode: number, durationMs: number): void;
  getMetricsText(): Promise<string>;
}

export interface LocationHistoryRepository {
  listLocations(
    userId: string,
    range?: { from?: number; to?: number },
  ): AsyncIterable<LocationPayload>;
  replaceAreaEvents(
    userId: string,
    events: GeofenceEvent[],
    state?: GeofenceReplayState,
  ): Promise<number>;
}

export interface AreaEventRepository {
  /** A user's area events, newest first. */
  listAreaEvents(userId: string, options?: { limit?: number }): Promise<GeofenceEvent[]>;
}

export interface TrackedUserRepository {
  listUserIds(): Promise<string[]>;
}
