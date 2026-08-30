// One in-memory `ServerLogSink` for tests that assert emitted activity-log lines.
//
// The same ten-line body had been written six times across the git activity-log suites. Beyond the
// duplication, each copy was free to drift into a slightly different shape — and a capture fixture
// that quietly stops recording is the one kind of test helper whose failure looks exactly like a
// passing test. `.test-support.ts` is the package's established name for a shared fixture module
// (see `gitDelivery/runBoundAuthority.test-support.ts`); the coverage inventory excludes the
// suffix, so this adds no production surface.

import type { ServerLogEvent, ServerLogSink } from "./observability/index.js";

export interface ActivityLogCapture {
  /** Every event handed to the sink, in emission order. */
  readonly events: readonly ServerLogEvent[];
  readonly sink: ServerLogSink;
  /** Events for one `op`, for a suite that drives several operations through one sink. */
  readonly withOp: (op: string) => readonly ServerLogEvent[];
}

export function captureActivityLog(): ActivityLogCapture {
  const events: ServerLogEvent[] = [];
  return {
    events,
    sink: {
      write: (event): void => {
        events.push(event);
      },
    },
    withOp: (op): readonly ServerLogEvent[] => events.filter((event) => event.op === op),
  };
}
