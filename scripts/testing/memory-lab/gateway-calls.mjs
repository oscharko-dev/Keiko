// The lifecycle of a model call in the product's Activity Log, read by the lab (#4207, #4209). Every
// call the gateway admits writes one start line, and exactly one terminal line: `completed`, or one
// of the ways it ended without an answer (`failed`; `abandoned` for a stream whose consumer walked
// away). A call is open until a terminal line closes it, so a learner call that failed is finished,
// not pending. Counts and ids only; the log is body-free by contract.
const START_OPS = new Set(["gateway.chat.started", "gateway.stream.started"]);
const COMPLETED_OPS = new Set(["gateway.chat.completed", "gateway.stream.completed"]);
const FAILED_OPS = new Set([
  "gateway.chat.failed",
  "gateway.stream.failed",
  "gateway.stream.abandoned",
]);

/** True for the line that opens a call. */
export function isCallStart(event) {
  return START_OPS.has(event.op);
}

/** True for the line of a call that answered; only these carry token usage. */
export function isCallCompleted(event) {
  return COMPLETED_OPS.has(event.op);
}

/** True for a call that ended without an answer: failed, or abandoned by its consumer. */
export function isCallFailed(event) {
  return FAILED_OPS.has(event.op);
}

/**
 * The identity of one call. The gateway adds a `requestId` to its lines whenever the call runs under
 * a caller's correlation (the usual case), so two calls of one turn stay two calls; without it the
 * correlation id is the call's own.
 */
export function callKey(event) {
  const key = event.requestId ?? event.correlationId;
  return typeof key === "string" ? key : undefined;
}

/** Keys of the calls that started in `events` and have no terminal line yet. */
export function openCallKeys(events) {
  const open = new Set();
  for (const event of events) {
    const key = callKey(event);
    if (key === undefined) continue;
    if (isCallStart(event)) open.add(key);
    else if (isCallCompleted(event) || isCallFailed(event)) open.delete(key);
  }
  return open;
}
