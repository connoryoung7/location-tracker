import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { MetricsCollector } from '@/domain/ports.ts';

export class PrometheusMetricsCollector implements MetricsCollector {
  private readonly registry: Registry;
  private readonly requestDuration: Histogram;
  private readonly requestCount: Counter;

  constructor() {
    this.registry = new Registry();

    collectDefaultMetrics({ register: this.registry });

    this.requestDuration = new Histogram({
      name: 'http_request_duration_ms',
      help: 'HTTP request duration in milliseconds',
      labelNames: ['method', 'path', 'status_code'],
      buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
      registers: [this.registry],
    });

    this.requestCount = new Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'path', 'status_code'],
      registers: [this.registry],
    });
  }

  recordRequest(method: string, path: string, statusCode: number, durationMs: number): void {
    const labels = { method, path, status_code: String(statusCode) };
    this.requestDuration.observe(labels, durationMs);
    this.requestCount.inc(labels);
  }

  async getMetricsText(): Promise<string> {
    return this.registry.metrics();
  }
}
