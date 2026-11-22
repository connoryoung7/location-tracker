import type { GeofenceEvent } from '@/domain/events.ts';

/** Events returned when the caller does not ask for a specific number. */
export const DEFAULT_AREA_EVENT_LIMIT = 100;

/** An `area_events` row as both SQLite and Postgres return it. */
export type AreaEventRow = {
  type: string;
  user_id: string;
  area_id: string;
  area_name: string | null;
  lat: number;
  lon: number;
  tst: number;
};

export function toGeofenceEvent(row: AreaEventRow): GeofenceEvent {
  if (row.type !== 'area.entered' && row.type !== 'area.exited') {
    throw new Error(`Unknown area event type: ${row.type}`);
  }

  return {
    _type: row.type,
    userId: row.user_id,
    areaId: row.area_id,
    ...(row.area_name === null ? {} : { areaName: row.area_name }),
    lat: row.lat,
    lon: row.lon,
    tst: row.tst,
  };
}
