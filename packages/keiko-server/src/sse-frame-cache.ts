// GEN-PERF-FANOUT-001 — shared once-per-event redact+serialize for SSE fan-out.
//
// Every SSE fan-out path (agent-run sink writers via sse.ts, container/command-runner/
// terminal routes) redacted and JSON.stringify'd the SAME event object once PER
// SUBSCRIBER — and again for every ring-buffer replay to a late joiner. With K windows
// watching one run, CPU for the deepRedactStrings walk + serialization grew linearly
// with K on every event. The relationship-activity broadcaster (GEN-PERF-RELACT-001)
// already serializes once per event; this helper brings the remaining fan-out paths to
// the same cost without changing any writer/subscriber interface.
//
// Correctness relies on two existing invariants:
// - Event envelopes are immutable after emit. The sink's ring buffer stores the same
//   object reference it fans out, so mutation would already corrupt replays today.
// - The redactor is deterministic for a given input. Caching therefore returns exactly
//   the bytes the per-subscriber call produced — defense-in-depth redaction still runs
//   for every distinct event, just not repeatedly for the same one.
//
// The cache is keyed by redactor identity first (parallel server instances and test
// fixtures with their own redactors never share entries), then by event identity. Both
// levels are WeakMaps: an entry dies with its event (ring-buffer eviction) or its deps.

import type { Redactor } from "./deps.js";

const FRAME_CACHES = new WeakMap<Redactor, WeakMap<object, string>>();

export function redactedEventJson(redactor: Redactor, event: object): string {
  let byEvent = FRAME_CACHES.get(redactor);
  if (byEvent === undefined) {
    byEvent = new WeakMap();
    FRAME_CACHES.set(redactor, byEvent);
  }
  let json = byEvent.get(event);
  if (json === undefined) {
    json = JSON.stringify(redactor(event));
    byEvent.set(event, json);
  }
  return json;
}
