import { test, expect, describe } from 'bun:test';
import { NotificationEventPublisher } from '@/infrastructure/events/notification.event-publisher.ts';
import { mockNotificationSender } from '@/test/mocks.ts';
import type { GeofenceEvent } from '@/domain/events.ts';

describe('NotificationEventPublisher', () => {
  test('formats subject/body for an entered event using the area name', async () => {
    const notificationSender = mockNotificationSender();
    const publisher = new NotificationEventPublisher(notificationSender);

    const event: GeofenceEvent = {
      _type: 'area.entered',
      userId: 'AB',
      areaId: 'area-1',
      areaName: 'Home',
      lat: 42.3601,
      lon: -71.0589,
      tst: 1700000000,
    };

    await publisher.publish(event);

    expect(notificationSender.sendNotification).toHaveBeenCalledWith(
      'AB entered Home',
      'User AB entered area "Home" at 42.3601, -71.0589 (tst=1700000000)',
    );
  });

  test('formats subject/body for an exited event, falling back to areaId when no name', async () => {
    const notificationSender = mockNotificationSender();
    const publisher = new NotificationEventPublisher(notificationSender);

    const event: GeofenceEvent = {
      _type: 'area.exited',
      userId: 'CD',
      areaId: 'area-2',
      lat: 1,
      lon: 2,
      tst: 1700000100,
    };

    await publisher.publish(event);

    expect(notificationSender.sendNotification).toHaveBeenCalledWith(
      'CD exited area-2',
      'User CD exited area "area-2" at 1, 2 (tst=1700000100)',
    );
  });
});
