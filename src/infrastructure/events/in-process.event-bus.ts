import type { DomainEvent } from '@/domain/types.ts';
import type { EventBus } from '@/domain/ports.ts';

type Handler<E extends DomainEvent = DomainEvent> = (event: E) => void | Promise<void>;

export class InProcessEventBus implements EventBus {
  private handlers = new Map<DomainEvent['_type'], Handler[]>();

  async publish(event: DomainEvent): Promise<void> {
    const handlers = this.handlers.get(event._type) ?? [];
    await Promise.all(handlers.map((handler) => handler(event)));
  }

  subscribe<E extends DomainEvent['_type']>(
    type: E,
    handler: (event: Extract<DomainEvent, { _type: E }>) => void | Promise<void>,
  ): void {
    const handlers = this.handlers.get(type) ?? [];
    handlers.push(handler as Handler);
    this.handlers.set(type, handlers);
  }
}
