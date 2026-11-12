import { expect, test } from 'bun:test';
import { PrometheusMetricsCollector } from '@/infrastructure/metrics/prometheus.metrics.ts';

test('recompute histogram has useful millisecond buckets', async () => {
  const metrics = new PrometheusMetricsCollector();
  metrics.recordRecompute(2500, 100, 3);
  const text = await metrics.getMetricsText();
  expect(text).toContain('geofence_recompute_duration_ms_bucket{le="1000"} 0');
  expect(text).toContain('geofence_recompute_duration_ms_bucket{le="5000"} 1');
});
