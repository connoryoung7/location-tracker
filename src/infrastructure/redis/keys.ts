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

/**
 * Users whose projected areas failed to write and may not match the source of
 * truth. Repaired opportunistically; see `SyncingAreaRepository`.
 */
export function areaProjectionDirtyKey(): string {
  return 'area:projection-dirty';
}

/**
 * Held while one of a user's areas is written to the store and then the index,
 * so writes from every process reach both in the same order. See
 * `RedisAreaLock`.
 */
export function areaWriteLockKey(userId: string): string {
  return `area:lock:${userId}`;
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
