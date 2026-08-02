import type { DomainEvent } from '@/domain/events.ts';
import type { EventPublisher, Logger } from '@/domain/ports.ts';

export class CompositeEventPublisher implements EventPublisher {
  private sinks: EventPublisher[];
  private logger: Logger;

  constructor(sinks: EventPublisher[], logger: Logger) {
    this.sinks = sinks;
    this.logger = logger;
  }

  async publish(event: DomainEvent): Promise<void> {
    await Promise.all(
      this.sinks.map(async (sink) => {
        try {
          await sink.publish(event);
        } catch (err) {
          this.logger.error('Event sink failed to publish', err);
        }
      }),
    );
  }
}
