import { metrics } from '@opentelemetry/api';
import {
	AggregationTemporality,
	MeterProvider,
	MetricReader,
	type MetricData,
} from '@opentelemetry/sdk-metrics';

class CollectingReader extends MetricReader {
	constructor() {
		// Delta, so each `collect` shows only what happened since the last one and tests in one
		// process don't see each other's points.
		super({ aggregationTemporalitySelector: () => AggregationTemporality.DELTA });
	}
	onShutdown(): Promise<void> {
		return Promise.resolve();
	}
	onForceFlush(): Promise<void> {
		return Promise.resolve();
	}
}

// The global meter provider can be set once per process, and `bun test` runs every file in one.
let reader: CollectingReader | undefined;

/** Registers an in-memory meter provider (once per process); `collect()` returns data since the last call. */
export function recordMetrics() {
	if (!reader) {
		reader = new CollectingReader();
		metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
	}
	const shared = reader;
	return {
		async collect(): Promise<MetricData[]> {
			const { resourceMetrics } = await shared.collect();
			return resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
		},
	};
}
