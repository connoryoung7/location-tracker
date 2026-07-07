import type { OwnTracksPayload } from '@/domain/types.ts';
import type {
  AreaRepository,
  EventPublisher,
  Geocoder,
  GeofenceEvaluator,
  LocationRepository,
  Logger,
  Geocoder,
  LocationRepository,
  Logger,
  MetricsCollector,
  PayloadDecryptor,
} from '@/domain/ports.ts';
import { handleLocation } from '@/application/handlers/location.handler.ts';
import { handleTransition } from '@/application/handlers/transition.handler.ts';
import { handleWaypoint } from '@/application/handlers/waypoint.handler.ts';
import { handleFallback } from '@/application/handlers/fallback.handler.ts';

export interface Deps {
  repo: LocationRepository;
  logger: Logger;
  decryptor: PayloadDecryptor;
  reverseGeocoder: Geocoder;
  geofence: GeofenceEvaluator;
  eventPublisher: EventPublisher;
  areaRepo: AreaRepository;
  metrics: MetricsCollector;
}

export async function handlePayload(payload: OwnTracksPayload, deps: Deps): Promise<void> {
  if (payload._type === 'encrypted' && payload.data) {
    try {
      const decrypted = deps.decryptor.decrypt(payload.data);
      const decoded = new TextDecoder().decode(decrypted);
      payload = JSON.parse(decoded) as OwnTracksPayload;
    } catch (err) {
      deps.logger.error('Failed to decrypt payload', err);
      return;
    }
  }

  switch (payload._type) {
    case 'location':
      await handleLocation(payload, deps);
      break;
    case 'waypoint':
      await handleWaypoint(payload, deps);
      break;
    case 'transition':
      await handleTransition(payload, deps);
      break;
    default:
      handleFallback(payload, deps);
      break;
  }
}
