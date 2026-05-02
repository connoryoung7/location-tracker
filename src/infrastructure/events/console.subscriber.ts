import type { EventBus, Logger } from '@/domain/ports.ts';

export function registerLoggingSubscribers(bus: EventBus, logger: Logger): void {
  bus.subscribe('geofence.entered', (event) => {
    logger.info(`Entered geofence "${event.geofenceName}" (tid=${event.tid})`, event);
  });
  bus.subscribe('geofence.exited', (event) => {
    logger.info(`Exited geofence "${event.geofenceName}" (tid=${event.tid})`, event);
  });
}
