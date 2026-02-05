/** Base type shared by all OwnTracks payloads */
export type OwnTracksBase = {
  _type: string;
};

/** Location report from the device */
export type LocationPayload = OwnTracksBase & {
  _type: "location";
  /** Latitude (degrees) */
  lat: number;
  /** Longitude (degrees) */
  lon: number;
  /** Timestamp of the GPS fix (Unix epoch seconds) */
  tst: number;
  /** Tracker ID used to display user initials (required for HTTP mode) */
  tid: string;
  /** Accuracy of the location fix (meters, only present if non-zero) */
  acc?: number;
  /** Altitude above sea level (meters, only present if non-zero) */
  alt?: number;
  /** Battery level (0-100%) */
  batt?: number;
  /** Battery status: 0=unknown, 1=unplugged, 2=charging, 3=full */
  bs?: 0 | 1 | 2 | 3;
  /** Velocity (km/h, only present if non-zero) */
  vel?: number;
  /** Trigger for the location report: p=ping, c=circular, C=circular(iOS), b=beacon, r=reportLocation, u=manual, t=timer, v=monitoring */
  t?: string;
  /** Internet connectivity: w=WiFi, o=offline, m=mobile */
  conn?: "w" | "o" | "m";
  /** Course over ground (degrees, only present if non-zero) */
  cog?: number;
  /** Vertical accuracy (meters, only present if non-zero) */
  vac?: number;
  /** Barometric pressure (kPa) */
  p?: number;
  /** Point of interest name */
  poi?: string;
  /** Base64 encoded image associated with POI */
  image?: string;
  /** Filename of image associated with POI */
  imagename?: string;
  /** Monitoring mode: 1=significant, 2=move */
  m?: 1 | 2;
  /** Name of connected WiFi SSID */
  SSID?: string;
  /** WiFi access point BSSID */
  BSSID?: string;
  /** Tag name */
  tag?: string;
  /** Region radius for enter/leave events (meters) */
  rad?: number;
  /** List of region names the device is currently in */
  inregions?: string[];
  /** List of region IDs the device is currently in */
  inrids?: string[];
  /** Original MQTT topic (included in HTTP payloads) */
  topic?: string;
  /** Timestamp of message creation if it differs from tst (Unix epoch seconds) */
  created_at?: number;
  /** List of motion states detected */
  motionactivities?: string[];
};

/** Last Will and Testament - published when connection to the broker is lost */
export type LwtPayload = OwnTracksBase & {
  _type: "lwt";
  /** Timestamp at which the app first connected (Unix epoch seconds) */
  tst: number;
};

/** A geographical region or BLE beacon definition */
export type WaypointPayload = OwnTracksBase & {
  _type: "waypoint";
  /** Name of the waypoint */
  desc: string;
  /** Timestamp of waypoint creation (Unix epoch seconds) */
  tst: number;
  /** Latitude (degrees) */
  lat?: number;
  /** Longitude (degrees) */
  lon?: number;
  /** Radius around the waypoint (meters) */
  rad?: number;
  /** UUID of BLE Beacon */
  uuid?: string;
  /** Major number of BLE Beacon */
  major?: number;
  /** Minor number of BLE Beacon */
  minor?: number;
  /** Region ID, created automatically */
  rid?: string;
};

/** Enter/leave event for a waypoint region or beacon */
export type TransitionPayload = OwnTracksBase & {
  _type: "transition";
  /** Timestamp at which event occurred (Unix epoch seconds) */
  tst: number;
  /** Timestamp of the waypoint creation (Unix epoch seconds) */
  wtst: number;
  /** Accuracy of geographical coordinates (meters) */
  acc: number;
  /** Event type */
  event: "enter" | "leave";
  /** Latitude at which event occurred (degrees) */
  lat?: number;
  /** Longitude at which event occurred (degrees) */
  lon?: number;
  /** Tracker ID (required for HTTP mode) */
  tid?: string;
  /** Name of the waypoint */
  desc?: string;
  /** Trigger type: c=circular, b=beacon, l=location */
  t?: "c" | "b" | "l";
  /** Region ID */
  rid?: string;
};

/** BLE beacon ranging data */
export type BeaconPayload = OwnTracksBase & {
  _type: "beacon";
  /** Name of seen beacon */
  desc?: string;
  /** UUID of seen beacon */
  uuid?: string;
  /** Major number of seen beacon */
  major?: number;
  /** Minor number of seen beacon */
  minor?: number;
  /** Timestamp at which beacon was seen (Unix epoch seconds) */
  tst?: number;
  /** Accuracy of proximity value (meters) */
  acc?: number;
  /** Received signal strength (decibels) */
  rssi?: number;
  /** Relative distance to beacon: 0=unknown, 1=immediate, 2=near, 3=far */
  prox?: 0 | 1 | 2 | 3;
};

/** Step counter data */
export type StepsPayload = OwnTracksBase & {
  _type: "steps";
  /** Timestamp of request (Unix epoch seconds) */
  tst: number;
  /** Steps walked in specified time period */
  steps: number;
  /** Effective start of time period (Unix epoch seconds) */
  from: number;
  /** Effective end of time period (Unix epoch seconds) */
  to: number;
};

/** User identification and display data */
export type CardPayload = OwnTracksBase & {
  _type: "card";
  /** Tracker ID to associate card with */
  tid: string;
  /** Name to identify the user */
  name?: string;
  /** Base64 encoded PNG image for the user */
  face?: string;
};

/** Bulk waypoint export */
export type WaypointsPayload = OwnTracksBase & {
  _type: "waypoints";
  /** Array of waypoint messages */
  waypoints: WaypointPayload[];
  /** Identification of the creator */
  _creator?: string;
};

/** Encrypted message wrapper */
export type EncryptedPayload = OwnTracksBase & {
  _type: "encrypted";
  /** Encrypted and Base64 encoded original JSON message */
  data: string;
};

/** Device status and capabilities */
export type StatusPayload = OwnTracksBase & {
  _type: "status";
  altimeterAuthorizationStatus?: string;
  altimeterIsRelativeAltitudeAvailable?: boolean;
  backgroundRefreshStatus?: boolean;
  deviceIdentifierForVendor?: string;
  deviceModel?: string;
  deviceSystemName?: string;
  deviceSystemVersion?: string;
  deviceUserInterfaceIdiom?: string;
  locale?: string;
  localeUsesMetricSystem?: boolean;
  locationManagerAuthorizationStatus?: string;
  motionActivityManagerAuthorizationStatus?: string;
  motionActivityManagerIsActivityAvailable?: boolean;
  noMap?: number;
  noRevgeo?: number;
  pedometerIsDistanceAvailable?: boolean;
  pedometerIsFloorCountingAvailable?: boolean;
  pedometerIsStepCountingAvailable?: boolean;
  version?: string;
};

/** Remote command request */
export type CmdPayload = OwnTracksBase & {
  _type: "cmd";
  /** Action to perform */
  action:
    | "dump"
    | "status"
    | "reportSteps"
    | "reportLocation"
    | "clearWaypoints"
    | "setWaypoints"
    | "setConfiguration"
    | "waypoints";
  /** Configuration to import (for setConfiguration) */
  configuration?: Record<string, unknown>;
  /** Waypoints to import (for setWaypoints) */
  waypoints?: WaypointPayload[];
  /** Start timestamp for step reporting range (Unix epoch seconds) */
  from?: number;
  /** End timestamp for step reporting range (Unix epoch seconds) */
  to?: number;
};

/** Feature request message */
export type RequestPayload = OwnTracksBase & {
  _type: "request";
  /** Request type */
  request: string;
  /** Tour specification for tour requests */
  tour?: Record<string, unknown>;
};

/** Union of all OwnTracks payload types that can be sent to the server */
export type OwnTracksPayload =
  | LocationPayload
  | LwtPayload
  | WaypointPayload
  | TransitionPayload
  | BeaconPayload
  | StepsPayload
  | CardPayload
  | WaypointsPayload
  | EncryptedPayload
  | StatusPayload
  | CmdPayload
  | RequestPayload;
