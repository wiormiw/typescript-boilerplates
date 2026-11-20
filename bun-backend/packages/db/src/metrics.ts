import { metrics } from '@opentelemetry/api';
import { LATENCY_BUCKETS_S } from '@starter/lib/metrics';

export const operationDuration = () =>
	metrics.getMeter('starter').createHistogram('db.client.operation.duration', {
		unit: 's',
		description: 'Duration of database client operations.',
		// Seconds-scale buckets: the SDK default boundaries are milliseconds, so every sample would land
		// in the first bucket and the quantiles would be meaningless.
		advice: { explicitBucketBoundaries: LATENCY_BUCKETS_S },
	});
