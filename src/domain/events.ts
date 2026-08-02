export type PubSubEvent = {
  _type: string;
};

export type AreaEnteredEvent = PubSubEvent & {
  _type: 'area.entered';
  userId: string;
  areaId: string;
  areaName?: string;
  lat: number;
  lon: number;
  tst: number;
};

export type AreaExitedEvent = PubSubEvent & {
  _type: 'area.exited';
  userId: string;
  areaId: string;
  areaName?: string;
  lat: number;
  lon: number;
  tst: number;
};

export type GeofenceEvent = AreaEnteredEvent | AreaExitedEvent;

export type DomainEvent = GeofenceEvent;
