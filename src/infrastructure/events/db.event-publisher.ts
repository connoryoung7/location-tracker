import type { DomainEvent } from '@/domain/events.ts';
import type { EventPublisher, LocationRepository } from '@/domain/ports.ts';

export class DbEventPublisher implements EventPublisher {
  private repo: LocationRepository;

  constructor(repo: LocationRepository) {
    this.repo = repo;
  }

  async publish(event: DomainEvent): Promise<void> {
    await this.repo.saveAreaEvent(event);
  }
}
