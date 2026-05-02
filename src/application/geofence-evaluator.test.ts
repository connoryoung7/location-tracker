import { describe, expect, test } from 'bun:test';
import { evaluateGeofences } from '@/application/geofence-evaluator.ts';
import { buildGeofence, buildGeofenceState, buildLocationPayload } from '@/test/factories.ts';
import { mockEventBus, mockGeofenceRepository, mockLogger } from '@/test/mocks.ts';

const NOW = 1_700_000_000_000;
const now = () => NOW;

describe('evaluateGeofences', () => {
  test('short-circuits when there are no fences for the tid', async () => {
    const geofenceRepo = mockGeofenceRepository();
    const eventBus = mockEventBus();
    const logger = mockLogger();
    geofenceRepo.list.mockReturnValueOnce(Promise.resolve([]));

    await evaluateGeofences(buildLocationPayload(), { geofenceRepo, eventBus, logger, now });

    expect(geofenceRepo.list).toHaveBeenCalledTimes(1);
    expect(geofenceRepo.getState).toHaveBeenCalledTimes(0);
    expect(eventBus.publish).toHaveBeenCalledTimes(0);
  });

  test('skips fence when accuracy exceeds half its radius', async () => {
    const fence = buildGeofence({ radiusMeters: 100 });
    const geofenceRepo = mockGeofenceRepository();
    const eventBus = mockEventBus();
    const logger = mockLogger();
    geofenceRepo.list.mockReturnValueOnce(Promise.resolve([fence]));

    await evaluateGeofences(buildLocationPayload({ acc: 60, lat: fence.lat, lon: fence.lon }), {
      geofenceRepo,
      eventBus,
      logger,
      now,
    });

    expect(geofenceRepo.getState).toHaveBeenCalledTimes(0);
    expect(geofenceRepo.upsertState).toHaveBeenCalledTimes(0);
    expect(eventBus.publish).toHaveBeenCalledTimes(0);
  });

  test('publishes geofence.entered when transitioning outside → inside', async () => {
    const fence = buildGeofence({ radiusMeters: 100 });
    const geofenceRepo = mockGeofenceRepository();
    const eventBus = mockEventBus();
    const logger = mockLogger();
    geofenceRepo.list.mockReturnValueOnce(Promise.resolve([fence]));
    geofenceRepo.getState.mockReturnValueOnce(Promise.resolve(null));

    await evaluateGeofences(
      buildLocationPayload({ lat: fence.lat, lon: fence.lon, tid: fence.tid }),
      { geofenceRepo, eventBus, logger, now },
    );

    expect(geofenceRepo.upsertState).toHaveBeenCalledTimes(1);
    const upsertedState = geofenceRepo.upsertState.mock.calls[0]![0];
    expect(upsertedState.status).toBe('inside');

    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    const event = eventBus.publish.mock.calls[0]![0];
    expect(event._type).toBe('geofence.entered');
    expect(event.geofenceId).toBe(fence.id);
    expect(event.tid).toBe(fence.tid);
  });

  test('does not publish when staying inside (idempotent)', async () => {
    const fence = buildGeofence({ radiusMeters: 100 });
    const geofenceRepo = mockGeofenceRepository();
    const eventBus = mockEventBus();
    const logger = mockLogger();
    geofenceRepo.list.mockReturnValueOnce(Promise.resolve([fence]));
    geofenceRepo.getState.mockReturnValueOnce(
      Promise.resolve(buildGeofenceState({ geofenceId: fence.id, status: 'inside' })),
    );

    await evaluateGeofences(
      buildLocationPayload({ lat: fence.lat, lon: fence.lon, tid: fence.tid }),
      { geofenceRepo, eventBus, logger, now },
    );

    expect(eventBus.publish).toHaveBeenCalledTimes(0);
    // upsert still happens — lastEvaluatedAt advanced
    expect(geofenceRepo.upsertState).toHaveBeenCalledTimes(1);
  });

  test('emits geofence.exited after grace period elapses while outside', async () => {
    const fence = buildGeofence({ radiusMeters: 100, exitGraceSeconds: 60 });
    const geofenceRepo = mockGeofenceRepository();
    const eventBus = mockEventBus();
    const logger = mockLogger();
    geofenceRepo.list.mockReturnValueOnce(Promise.resolve([fence]));
    geofenceRepo.getState.mockReturnValueOnce(
      Promise.resolve(
        buildGeofenceState({
          geofenceId: fence.id,
          status: 'pending_exit',
          pendingExitAt: NOW - 60_000,
        }),
      ),
    );

    // Far away (~111 km)
    await evaluateGeofences(
      buildLocationPayload({ lat: fence.lat + 1, lon: fence.lon, tid: fence.tid }),
      { geofenceRepo, eventBus, logger, now },
    );

    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    const event = eventBus.publish.mock.calls[0]![0];
    expect(event._type).toBe('geofence.exited');
  });

  test('evaluates each fence independently', async () => {
    const home = buildGeofence({ id: 1, name: 'Home', lat: 42.3601, lon: -71.0589 });
    const office = buildGeofence({
      id: 2,
      name: 'Office',
      lat: 42.4001,
      lon: -71.0989,
      radiusMeters: 100,
    });
    const geofenceRepo = mockGeofenceRepository();
    const eventBus = mockEventBus();
    const logger = mockLogger();
    geofenceRepo.list.mockReturnValueOnce(Promise.resolve([home, office]));
    geofenceRepo.getState.mockReturnValue(Promise.resolve(null));

    // Inside Home, far from Office.
    await evaluateGeofences(buildLocationPayload({ lat: home.lat, lon: home.lon, tid: home.tid }), {
      geofenceRepo,
      eventBus,
      logger,
      now,
    });

    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    const event = eventBus.publish.mock.calls[0]![0];
    expect(event.geofenceId).toBe(1);
  });
});
