import type { LocationPayload, TransitionPayload } from '@/domain/types.ts';

export interface LocationService {
  saveLocation(payload: LocationPayload): void | Promise<void>;
  saveTransition(payload: TransitionPayload): void | Promise<void>;
}

export interface LocationRepository {
  saveLocation(payload: LocationPayload): void | Promise<void>;
  saveTransition(payload: TransitionPayload): void | Promise<void>;
  healthCheck(): Promise<void>;
}

export interface Logger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}
