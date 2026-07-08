import { test, expect, describe } from 'bun:test';
import { handleLocation } from '@/application/handlers/location.handler.ts';
import {
  mockEventPublisher,
  mockGeocoder,
  mockGeofenceEvaluator,
  mockLocationRepository,
  mockLogger,
} from '@/test/mocks.ts';
import { buildLocationPayload } from '@/test/factories.ts';
import type { GeofenceEvent } from '@/domain/events.ts';

describe('handleLocation', () => {
  test('publishes every event returned by the geofence evaluator', async () => {
    const events: GeofenceEvent[] = [
      {
        _type: 'area.entered',
        userId: 'AB',
        areaId: 'area-1',
        areaName: 'Home',
        lat: 42.3601,
        lon: -71.0589,
        tst: 1700000000,
      },
      {
        _type: 'area.exited',
        userId: 'AB',
        areaId: 'area-2',
        lat: 42.3601,
        lon: -71.0589,
        tst: 1700000000,
      },
    ];

    const repo = mockLocationRepository();
    const geofence = mockGeofenceEvaluator();
    geofence.evaluate.mockResolvedValue(events);
    const eventPublisher = mockEventPublisher();

    await handleLocation(buildLocationPayload(), {
      repo,
      logger: mockLogger(),
      reverseGeocoder: mockGeocoder(),
      geofence,
      eventPublisher,
    });

    expect(eventPublisher.publish).toHaveBeenCalledTimes(2);
    expect(eventPublisher.publish).toHaveBeenNthCalledWith(1, events[0]);
    expect(eventPublisher.publish).toHaveBeenNthCalledWith(2, events[1]);
  });

  test('saves the location even when geofence evaluation throws', async () => {
    const repo = mockLocationRepository();
    const geofence = mockGeofenceEvaluator();
    geofence.evaluate.mockRejectedValue(new Error('redis down'));
    const eventPublisher = mockEventPublisher();
    const logger = mockLogger();

    await handleLocation(buildLocationPayload(), {
      repo,
      logger,
      reverseGeocoder: mockGeocoder(),
      geofence,
      eventPublisher,
    });

    expect(repo.saveLocation).toHaveBeenCalledTimes(1);
    expect(eventPublisher.publish).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  test('evaluates geofence with the payload tid, lon, lat, and tst', async () => {
    const geofence = mockGeofenceEvaluator();

    await handleLocation(buildLocationPayload({ tid: 'AB', lat: 1, lon: 2, tst: 3 }), {
      repo: mockLocationRepository(),
      logger: mockLogger(),
      reverseGeocoder: mockGeocoder(),
      geofence,
      eventPublisher: mockEventPublisher(),
    });

    expect(geofence.evaluate).toHaveBeenCalledWith('AB', 2, 1, 3);
  });
});
