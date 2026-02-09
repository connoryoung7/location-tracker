import { z } from 'zod';

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
