import type {
  Address,
  Area,
  GeocodingResult,
  LocationPayload,
  TransitionPayload,
  WaypointPayload,
} from '@/domain/types.ts';
import type { DomainEvent, GeofenceEvent } from '@/domain/events.ts';

export interface LocationService {
  saveLocation(payload: LocationPayload): void | Promise<void>;
  saveTransition(payload: TransitionPayload): void | Promise<void>;
  saveWaypoint(payload: WaypointPayload): void | Promise<void>;
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
  addArea(area: Area): void | Promise<void>;
  removeArea(userId: string, areaId: string): void | Promise<void>;
  listAreas(userId: string): Promise<Area[]>;
  listAllAreas(): Promise<Area[]>;
  getArea(userId: string, areaId: string): Promise<Area | undefined>;
  healthCheck(): Promise<void>;
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
  healthCheck(): Promise<void>;
}

export interface GeofenceEvaluator {
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

export interface NotificationSender {
  sendNotification(subject: string, body: string): Promise<void>;
}

export interface MetricsCollector {
  recordRequest(method: string, path: string, statusCode: number, durationMs: number): void;
  getMetricsText(): Promise<string>;
}
