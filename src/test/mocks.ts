import { mock } from 'bun:test';
import type {
  AreaRepository,
  EventPublisher,
  Geocoder,
  GeofenceEvaluator,
  LocationRepository,
  Logger,
  Geocoder,
  LocationRepository,
  Logger,
  MetricsCollector,
  NotificationSender,
} from '@/domain/ports.ts';
import type { GeocodingResult } from '@/domain/types.ts';

export function mockLocationRepository(): {
  [K in keyof LocationRepository]: ReturnType<typeof mock>;
} {
  return {
    saveLocation: mock(() => {}),
    saveTransition: mock(() => {}),
    saveWaypoint: mock(() => {}),
    saveAddress: mock(() => {}),
    saveAreaEvent: mock(() => {}),
    healthCheck: mock(() => Promise.resolve()),
  };
}

export function mockAreaRepository(): {
  [K in keyof AreaRepository]: ReturnType<typeof mock>;
} {
  return {
    addArea: mock(() => {}),
    removeArea: mock(() => {}),
    listAreas: mock(() => Promise.resolve([])),
    getArea: mock(() => Promise.resolve(undefined)),
    healthCheck: mock(() => Promise.resolve()),
  };
}

export function mockGeofenceEvaluator(): {
  [K in keyof GeofenceEvaluator]: ReturnType<typeof mock>;
} {
  return {
    evaluate: mock(() => Promise.resolve([])),
  };
}

export function mockEventPublisher(): {
  [K in keyof EventPublisher]: ReturnType<typeof mock>;
} {
  return {
    publish: mock(() => Promise.resolve()),
  };
}

export function mockGeocoder(result?: GeocodingResult): {
  [K in keyof Geocoder]: ReturnType<typeof mock>;
} {
  return {
    reverseGeocode: mock(() => Promise.resolve(result ?? { lat: 0, lon: 0 })),
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

export function mockMetricsCollector(): {
  [K in keyof MetricsCollector]: ReturnType<typeof mock>;
} {
  return {
    recordRequest: mock(() => {}),
    getMetricsText: mock(() => Promise.resolve('')),
  };
}
