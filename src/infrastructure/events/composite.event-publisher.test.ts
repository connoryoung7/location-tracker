import { test, expect, describe, mock } from 'bun:test';
import { CompositeEventPublisher } from '@/infrastructure/events/composite.event-publisher.ts';
import { mockLogger } from '@/test/mocks.ts';
import type { EventPublisher } from '@/domain/ports.ts';
import type { GeofenceEvent } from '@/domain/events.ts';

const event: GeofenceEvent = {
  _type: 'area.entered',
  userId: 'AB',
  areaId: 'area-1',
  lat: 42.3601,
  lon: -71.0589,
  tst: 1700000000,
};

describe('CompositeEventPublisher', () => {
  test('fans out the event to every sink', async () => {
    const sinkA: EventPublisher = { publish: mock(() => Promise.resolve()) };
    const sinkB: EventPublisher = { publish: mock(() => Promise.resolve()) };

    const composite = new CompositeEventPublisher([sinkA, sinkB], mockLogger());
    await composite.publish(event);

    expect(sinkA.publish).toHaveBeenCalledWith(event);
    expect(sinkB.publish).toHaveBeenCalledWith(event);
  });

  test('a throwing sink does not stop the others from being called', async () => {
    const failing: EventPublisher = {
      publish: mock(() => Promise.reject(new Error('sink down'))),
    };
    const succeeding: EventPublisher = { publish: mock(() => Promise.resolve()) };
    const logger = mockLogger();

    const composite = new CompositeEventPublisher([failing, succeeding], logger);
    await composite.publish(event);

    expect(failing.publish).toHaveBeenCalledWith(event);
    expect(succeeding.publish).toHaveBeenCalledWith(event);
    expect(logger.error).toHaveBeenCalled();
  });
});
