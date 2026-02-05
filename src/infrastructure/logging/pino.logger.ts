import pino from "pino";
import type { Logger } from "../../domain/ports.ts";

export class PinoLogger implements Logger {
  private logger: pino.Logger;

  constructor(options?: pino.LoggerOptions) {
    this.logger = pino(options);
  }

  info(message: string, data?: unknown): void {
    if (data !== undefined) {
      this.logger.info(data, message);
    } else {
      this.logger.info(message);
    }
  }

  warn(message: string, data?: unknown): void {
    if (data !== undefined) {
      this.logger.warn(data, message);
    } else {
      this.logger.warn(message);
    }
  }

  error(message: string, data?: unknown): void {
    if (data !== undefined) {
      this.logger.error(data, message);
    } else {
      this.logger.error(message);
    }
  }
}
