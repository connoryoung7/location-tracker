export function geoAreasKey(userId: string): string {
  return `geo:areas:${userId}`;
}

export function areaMetaKey(userId: string): string {
  return `area:meta:${userId}`;
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
