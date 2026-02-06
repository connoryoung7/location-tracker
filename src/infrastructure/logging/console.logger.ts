import type { Logger } from "@/domain/ports.ts";

export class ConsoleLogger implements Logger {
  info(message: string, data?: unknown): void {
    console.log(`[INFO] ${message}`, data !== undefined ? data : "");
  }

  warn(message: string, data?: unknown): void {
    console.warn(`[WARN] ${message}`, data !== undefined ? data : "");
  }

  error(message: string, data?: unknown): void {
    console.error(`[ERROR] ${message}`, data !== undefined ? data : "");
  }
}
