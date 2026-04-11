import type { WaypointPayload } from '@/domain/types.ts';

export type PubSubEvent = {
  _type: string;
};

export type UserWaypointUpdatedEvent = PubSubEvent & {
  _type: 'user-waypoint.updated';
  update_type: 'enter' | 'leave';
  waypoint: WaypointPayload;
  /** Transition timestamp (Unix epoch seconds) */
  transition_tst: number;
};

export type DomainEvent = UserWaypointUpdatedEvent;
