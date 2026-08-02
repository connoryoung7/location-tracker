import type {
  Address,
  Area,
  GeocodingResult,
  LocationPayload,
  TransitionPayload,
  WaypointPayload,
} from '@/domain/types.ts';

export function buildLocationPayload(overrides?: Partial<LocationPayload>): LocationPayload {
  return {
    _type: 'location',
    lat: 42.3601,
    lon: -71.0589,
    tst: 1700000000,
    tid: 'AB',
    ...overrides,
  };
}

export function buildWaypointPayload(overrides?: Partial<WaypointPayload>): WaypointPayload {
  return {
    _type: 'waypoint',
    desc: 'Home',
    tst: 1700000000,
    ...overrides,
  };
}

export function buildTransitionPayload(overrides?: Partial<TransitionPayload>): TransitionPayload {
  return {
    _type: 'transition',
    tst: 1700000000,
    wtst: 1699999000,
    acc: 10,
    event: 'enter',
    ...overrides,
  };
}

export function buildAddress(overrides?: Partial<Address>): Address {
  return {
    displayName: '123 Main St, Boston, MA 02101, US',
    street: '123 Main St',
    city: 'Boston',
    state: 'Massachusetts',
    country: 'United States',
    countryCode: 'us',
    postalCode: '02101',
    ...overrides,
  };
}

export function buildGeocodingResult(overrides?: Partial<GeocodingResult>): GeocodingResult {
  return {
    lat: 42.3601,
    lon: -71.0589,
    address: buildAddress(),
    ...overrides,
  };
}

export function buildArea(overrides?: Partial<Area>): Area {
  return {
    id: 'area-1',
    userId: 'AB',
    name: 'Home',
    lat: 42.3601,
    lon: -71.0589,
    radius: 100,
    ...overrides,
  };
}
