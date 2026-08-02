import type { Logger, NotificationSender } from '@/domain/ports.ts';

export class LogNotificationSender implements NotificationSender {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async sendNotification(subject: string, body: string): Promise<void> {
    this.logger.info(`Notification: ${subject}`, { body });
  }
}
