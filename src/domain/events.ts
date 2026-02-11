import type { TransitionPayload, WaypointPayload } from '@/domain/types.ts';

export type PubSubEvent = {
  _type: string;
};

export type UserWaypointUpdatedEvent = PubSubEvent & {
  _type: 'user-waypoint.updated';
  update_type: 'enter' | 'leave';
  waypoint: WaypointPayload;
  transition: TransitionPayload;
};

export type DomainEvent = UserWaypointUpdatedEvent;
