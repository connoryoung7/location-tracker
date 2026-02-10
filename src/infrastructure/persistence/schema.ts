import { sql } from 'drizzle-orm';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
