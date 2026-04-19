import type { Logger } from '@/domain/ports.ts';

export class ConsoleLogger implements Logger {
  info(message: string, data?: unknown): void {
    console.warn('%s', `[INFO] ${message}`, data !== undefined ? data : '');
  }

  warn(message: string, data?: unknown): void {
    console.warn('%s', `[WARN] ${message}`, data !== undefined ? data : '');
  }

  error(message: string, data?: unknown): void {
    console.error('%s', `[ERROR] ${message}`, data !== undefined ? data : '');
  }
}
