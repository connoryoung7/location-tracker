import type { Address, LocationPayload, ReverseGeocodingResult, TransitionPayload, WaypointPayload } from '@/domain/types.ts';
import type { DomainEvent } from '@/domain/events.ts';

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
  healthCheck(): Promise<void>;
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

export interface ReverseGeocoder {
  reverseGeocode(lat: number, lon: number): Promise<ReverseGeocodingResult>;
}

export interface EventPublisher {
  publish(event: DomainEvent): void | Promise<void>;
}
