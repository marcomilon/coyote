/**
 * CloudWatch Embedded Metric Format: a metric is one JSON log line, so it costs no API call.
 * Namespace "Coyote". Alarms and the dashboard are defined in infra/lib/monitoring.ts.
 */
export type MetricName =
  | 'Submitted' | 'RateLimited' | 'Rejected' | 'Generated' | 'Failed' | 'Published'
  | 'Reported' | 'Quarantined' | 'TokensIn' | 'TokensOut' | 'HeroImages';

export function emitMetrics(metrics: Partial<Record<MetricName, number>>, log: (line: string) => void = console.log): void {
  const names = Object.keys(metrics);
  if (names.length === 0) return;
  log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: 'Coyote', Dimensions: [[]], Metrics: names.map((Name) => ({ Name, Unit: 'Count' })) }],
      },
      ...metrics,
    }),
  );
}
