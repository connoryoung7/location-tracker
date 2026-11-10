import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const locations = sqliteTable('locations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  lat: real('lat').notNull(),
  lon: real('lon').notNull(),
  tst: integer('tst').notNull(),
  tid: text('tid').notNull(),
  acc: real('acc'),
  alt: real('alt'),
  batt: integer('batt'),
  vel: real('vel'),
  conn: text('conn'),
  tag: text('tag'),
  topic: text('topic'),
  created_at: text('created_at').default(sql`(datetime('now'))`),
});

export const waypoints = sqliteTable('waypoints', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  desc: text('desc').notNull(),
  tst: integer('tst').notNull(),
  lat: real('lat'),
  lon: real('lon'),
  rad: real('rad'),
  uuid: text('uuid'),
  major: integer('major'),
  minor: integer('minor'),
  rid: text('rid'),
  created_at: text('created_at').default(sql`(datetime('now'))`),
});

export const addresses = sqliteTable('addresses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  lat: real('lat').notNull(),
  lon: real('lon').notNull(),
  display_name: text('display_name').notNull(),
  street: text('street'),
  city: text('city'),
  state: text('state'),
  country: text('country'),
  country_code: text('country_code'),
  postal_code: text('postal_code'),
  created_at: text('created_at').default(sql`(datetime('now'))`),
});

export const transitions = sqliteTable('transitions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tst: integer('tst').notNull(),
  wtst: integer('wtst').notNull(),
  acc: real('acc').notNull(),
  event: text('event').notNull(),
  lat: real('lat'),
  lon: real('lon'),
  tid: text('tid'),
  desc: text('desc'),
  t: text('t'),
  rid: text('rid'),
  created_at: text('created_at').default(sql`(datetime('now'))`),
});

/**
 * User-defined circular geofences. The record of truth: the Redis GEO index the
 * geofence evaluator queries is a projection rebuilt from this table.
 */
export const areas = sqliteTable(
  'areas',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull(),
    name: text('name').notNull(),
    lat: real('lat').notNull(),
    lon: real('lon').notNull(),
    /** Radius in meters. */
    radius: real('radius').notNull(),
    created_at: text('created_at').default(sql`(datetime('now'))`),
    updated_at: text('updated_at').default(sql`(datetime('now'))`),
  },
  (table) => [index('areas_user_id_idx').on(table.user_id)],
);

export const area_events = sqliteTable('area_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(),
  user_id: text('user_id').notNull(),
  area_id: text('area_id').notNull(),
  area_name: text('area_name'),
  lat: real('lat').notNull(),
  lon: real('lon').notNull(),
  tst: integer('tst').notNull(),
  created_at: text('created_at').default(sql`(datetime('now'))`),
});
