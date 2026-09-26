// The observable persistence path for Activity Log health evidence (#3532).
//
// The ordinary file sink never throws: a failed append is reported on stderr and the line is gone,
// which is right for request-path logging but useless for a readiness probe that must KNOW whether
// the write landed. `appendDurableServerLogBatch` is the production append path with an observable
// outcome — it appends through the same process-wide file state, fsyncs, and verifies the target
// identity before and after — so the readiness probe and the loss summary persist through it and
// read the result instead of guessing.
//
// This module is deliberately the ONE place that knows which server-log primitive provides that
// outcome. When the segment writer replaces the daily file, only `persistActivityLogEvents` changes.

import { appendDurableServerLogBatch, type ServerLogEvent } from "./server-log.js";

export type ActivityLogEventPersister = (
  stateDir: string,
  events: readonly ServerLogEvent[],
) => boolean;

/**
 * Durably appends `events` to the Activity Log of `stateDir`, bypassing the level threshold (the
 * callers persist mandatory evidence only). Returns whether every event was appended and synced.
 */
export function persistActivityLogEvents(
  stateDir: string,
  events: readonly ServerLogEvent[],
): boolean {
  if (events.length === 0) return true;
  const result = appendDurableServerLogBatch(stateDir, {
    level: "debug",
    inspect: () => ({ status: "append", events }),
  });
  return result.status === "appended";
}
