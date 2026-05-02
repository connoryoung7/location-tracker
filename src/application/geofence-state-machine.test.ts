import { describe, expect, test } from 'bun:test';
import type { Geofence, GeofenceState, LocationPayload } from '@/domain/types.ts';
import { computeTransition, haversineMeters } from '@/application/geofence-state-machine.ts';

const fence: Geofence = {
  id: 1,
  name: 'Home',
  lat: 42.3601,
  lon: -71.0589,
  radiusMeters: 100,
  tid: 'AB',
  exitGraceSeconds: 60,
  createdAt: '2026-01-01T00:00:00Z',
};

const payload: LocationPayload = {
  _type: 'location',
  lat: 42.3601,
  lon: -71.0589,
  tst: 1700000000,
  tid: 'AB',
};

const baseState: GeofenceState = {
  geofenceId: 1,
  tid: 'AB',
  status: 'outside',
  pendingExitAt: null,
  lastEvaluatedAt: 0,
};

const NOW = 1_700_000_000_000;

describe('computeTransition', () => {
  test('outside + inside → inside, emits entered', () => {
    const { newState, event } = computeTransition(baseState, true, NOW, fence, payload);
    expect(newState.status).toBe('inside');
    expect(newState.pendingExitAt).toBeNull();
    expect(newState.lastEvaluatedAt).toBe(NOW);
    expect(event?._type).toBe('geofence.entered');
    expect(event).toMatchObject({
      geofenceId: 1,
      geofenceName: 'Home',
      tid: 'AB',
      lat: 42.3601,
      lon: -71.0589,
      occurredAt: 1700000000,
    });
  });

  test('outside + outside → outside, no event', () => {
    const { newState, event } = computeTransition(baseState, false, NOW, fence, payload);
    expect(newState.status).toBe('outside');
    expect(newState.lastEvaluatedAt).toBe(NOW);
    expect(event).toBeNull();
  });

  test('inside + inside → inside, no event', () => {
    const inside: GeofenceState = { ...baseState, status: 'inside' };
    const { newState, event } = computeTransition(inside, true, NOW, fence, payload);
    expect(newState.status).toBe('inside');
    expect(event).toBeNull();
  });

  test('inside + outside → pending_exit (sets pendingExitAt), no event yet', () => {
    const inside: GeofenceState = { ...baseState, status: 'inside' };
    const { newState, event } = computeTransition(inside, false, NOW, fence, payload);
    expect(newState.status).toBe('pending_exit');
    expect(newState.pendingExitAt).toBe(NOW);
    expect(event).toBeNull();
  });

  test('pending_exit + inside → inside (cancels grace), no event', () => {
    const pending: GeofenceState = {
      ...baseState,
      status: 'pending_exit',
      pendingExitAt: NOW - 30_000,
    };
    const { newState, event } = computeTransition(pending, true, NOW, fence, payload);
    expect(newState.status).toBe('inside');
    expect(newState.pendingExitAt).toBeNull();
    expect(event).toBeNull();
  });

  test('pending_exit + outside, age < grace → still pending_exit, no event', () => {
    const pending: GeofenceState = {
      ...baseState,
      status: 'pending_exit',
      pendingExitAt: NOW - 30_000,
    };
    const { newState, event } = computeTransition(pending, false, NOW, fence, payload);
    expect(newState.status).toBe('pending_exit');
    expect(newState.pendingExitAt).toBe(NOW - 30_000);
    expect(event).toBeNull();
  });

  test('pending_exit + outside, age ≥ grace → outside, emits exited', () => {
    const pending: GeofenceState = {
      ...baseState,
      status: 'pending_exit',
      pendingExitAt: NOW - 60_000,
    };
    const { newState, event } = computeTransition(pending, false, NOW, fence, payload);
    expect(newState.status).toBe('outside');
    expect(newState.pendingExitAt).toBeNull();
    expect(event?._type).toBe('geofence.exited');
    expect(event).toMatchObject({
      geofenceId: 1,
      geofenceName: 'Home',
      tid: 'AB',
      occurredAt: 1700000000,
    });
  });

  test('pending_exit boundary: age exactly equals grace → fires exited', () => {
    const pending: GeofenceState = {
      ...baseState,
      status: 'pending_exit',
      pendingExitAt: NOW - 60_000,
    };
    const { event } = computeTransition(pending, false, NOW, fence, payload);
    expect(event?._type).toBe('geofence.exited');
  });

  test('pending_exit boundary: 1ms below grace → still pending', () => {
    const pending: GeofenceState = {
      ...baseState,
      status: 'pending_exit',
      pendingExitAt: NOW - 59_999,
    };
    const { newState, event } = computeTransition(pending, false, NOW, fence, payload);
    expect(newState.status).toBe('pending_exit');
    expect(event).toBeNull();
  });
});

describe('haversineMeters', () => {
  test('returns 0 for identical points', () => {
    expect(haversineMeters(42.3601, -71.0589, 42.3601, -71.0589)).toBe(0);
  });

  test('matches a known distance (Boston ↔ NYC ≈ 306 km)', () => {
    const meters = haversineMeters(42.3601, -71.0589, 40.7128, -74.006);
    expect(meters).toBeGreaterThan(305_000);
    expect(meters).toBeLessThan(310_000);
  });

  test('roughly 111 km per degree of latitude at equator', () => {
    const meters = haversineMeters(0, 0, 1, 0);
    expect(meters).toBeGreaterThan(110_000);
    expect(meters).toBeLessThan(112_000);
  });
});
