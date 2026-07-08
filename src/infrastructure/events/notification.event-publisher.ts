import type { DomainEvent } from '@/domain/events.ts';
import type { EventPublisher, NotificationSender } from '@/domain/ports.ts';

export class NotificationEventPublisher implements EventPublisher {
  private notificationSender: NotificationSender;

  constructor(notificationSender: NotificationSender) {
    this.notificationSender = notificationSender;
  }

  async publish(event: DomainEvent): Promise<void> {
    const areaLabel = event.areaName ?? event.areaId;
    const verb = event._type === 'area.entered' ? 'entered' : 'exited';
    const subject = `${event.userId} ${verb} ${areaLabel}`;
    const body = `User ${event.userId} ${verb} area "${areaLabel}" at ${event.lat}, ${event.lon} (tst=${event.tst})`;

    await this.notificationSender.sendNotification(subject, body);
  }
}
