import { z } from 'zod';
import { AREA_CATEGORY_COLORS } from '@/domain/types.ts';

export const LocationPayloadSchema = z.object({
  _type: z.literal('location'),
  lat: z.number(),
  lon: z.number(),
  tst: z.number(),
  tid: z.string(),
  acc: z.number().optional(),
  alt: z.number().optional(),
  batt: z.number().optional(),
  bs: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  vel: z.number().optional(),
  t: z.string().optional(),
  conn: z.enum(['w', 'o', 'm']).optional(),
  cog: z.number().optional(),
  vac: z.number().optional(),
  p: z.number().optional(),
  poi: z.string().optional(),
  image: z.string().optional(),
  imagename: z.string().optional(),
  m: z.union([z.literal(1), z.literal(2)]).optional(),
  SSID: z.string().optional(),
  BSSID: z.string().optional(),
  tag: z.string().optional(),
  rad: z.number().optional(),
  inregions: z.array(z.string()).optional(),
  inrids: z.array(z.string()).optional(),
  topic: z.string().optional(),
  created_at: z.number().optional(),
  motionactivities: z.array(z.string()).optional(),
});

export const LwtPayloadSchema = z.object({
  _type: z.literal('lwt'),
  tst: z.number(),
});

export const WaypointPayloadSchema = z.object({
  _type: z.literal('waypoint'),
  desc: z.string(),
  tst: z.number(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  rad: z.number().optional(),
  uuid: z.string().optional(),
  major: z.number().optional(),
  minor: z.number().optional(),
  rid: z.string().optional(),
});

export const TransitionPayloadSchema = z.object({
  _type: z.literal('transition'),
  tst: z.number(),
  wtst: z.number(),
  acc: z.number(),
  event: z.enum(['enter', 'leave']),
  lat: z.number().optional(),
  lon: z.number().optional(),
  tid: z.string().optional(),
  desc: z.string().optional(),
  t: z.enum(['c', 'b', 'l']).optional(),
  rid: z.string().optional(),
});

export const BeaconPayloadSchema = z.object({
  _type: z.literal('beacon'),
  desc: z.string().optional(),
  uuid: z.string().optional(),
  major: z.number().optional(),
  minor: z.number().optional(),
  tst: z.number().optional(),
  acc: z.number().optional(),
  rssi: z.number().optional(),
  prox: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
});

export const StepsPayloadSchema = z.object({
  _type: z.literal('steps'),
  tst: z.number(),
  steps: z.number(),
  from: z.number(),
  to: z.number(),
});

export const CardPayloadSchema = z.object({
  _type: z.literal('card'),
  tid: z.string(),
  name: z.string().optional(),
  face: z.string().optional(),
});

export const WaypointsPayloadSchema = z.object({
  _type: z.literal('waypoints'),
  waypoints: z.array(WaypointPayloadSchema),
  _creator: z.string().optional(),
});

export const EncryptedPayloadSchema = z.object({
  _type: z.literal('encrypted'),
  data: z.string(),
});

export const StatusPayloadSchema = z.object({
  _type: z.literal('status'),
  altimeterAuthorizationStatus: z.string().optional(),
  altimeterIsRelativeAltitudeAvailable: z.boolean().optional(),
  backgroundRefreshStatus: z.boolean().optional(),
  deviceIdentifierForVendor: z.string().optional(),
  deviceModel: z.string().optional(),
  deviceSystemName: z.string().optional(),
  deviceSystemVersion: z.string().optional(),
  deviceUserInterfaceIdiom: z.string().optional(),
  locale: z.string().optional(),
  localeUsesMetricSystem: z.boolean().optional(),
  locationManagerAuthorizationStatus: z.string().optional(),
  motionActivityManagerAuthorizationStatus: z.string().optional(),
  motionActivityManagerIsActivityAvailable: z.boolean().optional(),
  noMap: z.number().optional(),
  noRevgeo: z.number().optional(),
  pedometerIsDistanceAvailable: z.boolean().optional(),
  pedometerIsFloorCountingAvailable: z.boolean().optional(),
  pedometerIsStepCountingAvailable: z.boolean().optional(),
  version: z.string().optional(),
});

export const CmdPayloadSchema = z.object({
  _type: z.literal('cmd'),
  action: z.enum([
    'dump',
    'status',
    'reportSteps',
    'reportLocation',
    'clearWaypoints',
    'setWaypoints',
    'setConfiguration',
    'waypoints',
  ]),
  configuration: z.record(z.string(), z.unknown()).optional(),
  waypoints: z.array(WaypointPayloadSchema).optional(),
  from: z.number().optional(),
  to: z.number().optional(),
});

export const RequestPayloadSchema = z.object({
  _type: z.literal('request'),
  request: z.string(),
  tour: z.record(z.string(), z.unknown()).optional(),
});

export const OwnTracksPayloadSchema = z.discriminatedUnion('_type', [
  LocationPayloadSchema,
  LwtPayloadSchema,
  WaypointPayloadSchema,
  TransitionPayloadSchema,
  BeaconPayloadSchema,
  StepsPayloadSchema,
  CardPayloadSchema,
  WaypointsPayloadSchema,
  EncryptedPayloadSchema,
  StatusPayloadSchema,
  CmdPayloadSchema,
  RequestPayloadSchema,
]);

/** An area whose `id` the caller chose, so a seed run can upsert by it. */
export const AreaSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  name: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  radius: z.number().positive(),
});

/**
 * A new area drawn in the UI. The server assigns the `id`, so clients cannot
 * overwrite an existing area by guessing one. Form posts arrive as strings,
 * hence the coercion on the numbers.
 */
export const CreateAreaSchema = z.object({
  userId: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  lat: z
    .union([z.number(), z.string().trim().min(1)])
    .transform(Number)
    .pipe(z.number().min(-90).max(90)),
  lon: z
    .union([z.number(), z.string().trim().min(1)])
    .transform(Number)
    .pipe(z.number().min(-180).max(180)),
  radius: z
    .union([z.number(), z.string().trim().min(1)])
    .transform(Number)
    .pipe(z.number().positive().max(100_000)),
});

/** What an area edit may change. The owner and ID come from the URL and never change. */
export const UpdateAreaSchema = CreateAreaSchema.omit({ userId: true });

/** A category name: trimmed, and unique per user regardless of case. */
const AreaCategoryNameSchema = z.string().trim().min(1).max(100);

const AreaCategoryColorSchema = z.enum(AREA_CATEGORY_COLORS);

/** IDs are server-generated UUIDs; this only bounds what a client can send. */
const AreaCategoryIdSchema = z.string().min(1).max(64);

/**
 * An area drawn in the map UI, optionally in one of the user's categories:
 * either an existing one by `categoryId`, or one named by `categoryName`,
 * which is reused if the user already has it (ignoring case) and created if not.
 * The ingestion API keeps using {@link CreateAreaSchema}, which has no category.
 */
export const CreateCategorizedAreaSchema = CreateAreaSchema.extend({
  categoryId: AreaCategoryIdSchema.optional(),
  categoryName: AreaCategoryNameSchema.optional(),
}).refine((area) => !(area.categoryId && area.categoryName), {
  message: 'Choose an existing category or name a new one, not both',
  path: ['categoryName'],
});

/** A new category. Without a colour, the server picks the least-used one. */
export const CreateAreaCategorySchema = z.object({
  userId: z.string().min(1).max(64),
  name: AreaCategoryNameSchema,
  color: AreaCategoryColorSchema.optional(),
});

/** A rename, a recolour, or both. */
export const UpdateAreaCategorySchema = z
  .object({
    name: AreaCategoryNameSchema.optional(),
    color: AreaCategoryColorSchema.optional(),
  })
  .refine((changes) => changes.name !== undefined || changes.color !== undefined, {
    message: 'Change the name or the colour',
  });

/** Puts an area in a category, or takes it out with an empty or null ID. */
export const SetAreaCategorySchema = z.object({
  categoryId: z
    .union([AreaCategoryIdSchema, z.literal(''), z.null()])
    .transform((categoryId) => categoryId || null),
});
