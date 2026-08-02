import type { RedisClient } from 'bun';
import type { DomainEvent } from '@/domain/events.ts';
import type { EventPublisher } from '@/domain/ports.ts';

const GEOFENCE_EVENTS_CHANNEL = 'geofence:events';

export class RedisEventPublisher implements EventPublisher {
  private redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async publish(event: DomainEvent): Promise<void> {
    await this.redis.publish(GEOFENCE_EVENTS_CHANNEL, JSON.stringify(event));
  }
}
