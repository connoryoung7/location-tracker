export function geoAreasKey(userId: string): string {
  return `geo:areas:${userId}`;
}

export function areaMetaKey(userId: string): string {
  return `area:meta:${userId}`;
}

/** SCAN pattern matching every user's area metadata hash. */
export function areaMetaKeyPattern(): string {
  return areaMetaKey('*');
}

/** Inverse of {@link areaMetaKey}: recovers the user ID from a scanned key. */
export function userIdFromAreaMetaKey(key: string): string {
  return key.slice(areaMetaKey('').length);
}

export function areaMaxRadiusKey(userId: string): string {
  return `area:maxradius:${userId}`;
}

export function geofenceInsideKey(userId: string): string {
  return `geofence:inside:${userId}`;
}

export function geofencePendingExitKey(userId: string): string {
  return `geofence:pending-exit:${userId}`;
}
