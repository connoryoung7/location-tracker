import { mock } from 'bun:test';
import type { EventPublisher, Geocoder, LocationRepository, Logger, NotificationSender } from '@/domain/ports.ts';
import type { GeocodingResult } from '@/domain/types.ts';
import type { DomainEvent } from '@/domain/events.ts';

export function mockLocationRepository(): {
  [K in keyof LocationRepository]: ReturnType<typeof mock>;
} {
  return {
    saveLocation: mock(() => {}),
    saveTransition: mock(() => {}),
    saveWaypoint: mock(() => {}),
    saveAddress: mock(() => {}),
    healthCheck: mock(() => Promise.resolve()),
  };
}

export function mockGeocoder(result?: GeocodingResult): {
  [K in keyof Geocoder]: ReturnType<typeof mock>;
} {
  return {
    geocode: mock(() => Promise.resolve(result ? [result] : [])),
    reverseGeocode: mock(() => Promise.resolve(result ?? { lat: 0, lon: 0 })),
  };
}

export function mockEventPublisher(): {
  [K in keyof EventPublisher]: ReturnType<typeof mock<(event: DomainEvent) => void>>;
} {
  return {
    publish: mock<(event: DomainEvent) => void>(() => {}),
  };
}

export function mockLogger(): {
  [K in keyof Logger]: ReturnType<typeof mock>;
} {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
}

export function mockNotificationSender(): {
  [K in keyof NotificationSender]: ReturnType<typeof mock>;
} {
  return {
    sendNotification: mock(() => Promise.resolve()),
  };
}
