import type { DomainEvent, Geofence, GeofenceState, LocationPayload } from '@/domain/types.ts';

const EARTH_RADIUS_METERS = 6_371_008.8;

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a));
}

export function computeTransition(
  state: GeofenceState,
  isInside: boolean,
  nowMs: number,
  fence: Geofence,
  payload: LocationPayload,
): { newState: GeofenceState; event: DomainEvent | null } {
  const base: GeofenceState = { ...state, lastEvaluatedAt: nowMs };

  switch (state.status) {
    case 'outside':
      if (isInside) {
        return {
          newState: { ...base, status: 'inside', pendingExitAt: null },
          event: {
            _type: 'geofence.entered',
            geofenceId: fence.id,
            geofenceName: fence.name,
            tid: payload.tid,
            lat: payload.lat,
            lon: payload.lon,
            occurredAt: payload.tst,
          },
        };
      }
      return { newState: base, event: null };

    case 'inside':
      if (!isInside) {
        return {
          newState: { ...base, status: 'pending_exit', pendingExitAt: nowMs },
          event: null,
        };
      }
      return { newState: base, event: null };

    case 'pending_exit': {
      if (isInside) {
        return {
          newState: { ...base, status: 'inside', pendingExitAt: null },
          event: null,
        };
      }
      const ageMs = nowMs - (state.pendingExitAt ?? nowMs);
      if (ageMs >= fence.exitGraceSeconds * 1000) {
        return {
          newState: { ...base, status: 'outside', pendingExitAt: null },
          event: {
            _type: 'geofence.exited',
            geofenceId: fence.id,
            geofenceName: fence.name,
            tid: payload.tid,
            lat: payload.lat,
            lon: payload.lon,
            occurredAt: payload.tst,
          },
        };
      }
      return { newState: base, event: null };
    }
  }
}
