/**
 * Pure cancellation/superseding helpers over {@link EditorRequestIdentity} (Issue #1192).
 *
 * Cross-boundary cancellation is expressed entirely through the serializable request identity: a
 * later request in the same `streamId` with a higher `sequence` supersedes earlier ones, and a
 * response carrying an older sequence is stale. The in-process `AbortSignal` on the host port is a
 * local abort handle only and is intentionally never a contract field.
 */
import type { EditorRequestIdentity } from "./types.js";

/** True iff `next` belongs to the same stream as `current` and strictly follows it. */
export function completionRequestSupersedes(
  next: EditorRequestIdentity,
  current: EditorRequestIdentity,
): boolean {
  return next.streamId === current.streamId && next.sequence > current.sequence;
}

/**
 * True iff a response is still the freshest for its stream: same `streamId` and a sequence at least
 * as new as the latest request. A response from an older sequence in the same stream is stale.
 */
export function isResponseCurrent(
  responseRequest: EditorRequestIdentity,
  latestRequest: EditorRequestIdentity,
): boolean {
  // `>=`, not `===` (and intentionally looser than the strict `>` in completionRequestSupersedes): a
  // response whose sequence is at least the latest dispatched request is still current. Accepting a
  // newer-than-latest sequence is the defensive choice — it avoids a false discard if the caller's
  // latest-request bookkeeping lags a dispatch.
  return (
    responseRequest.streamId === latestRequest.streamId &&
    responseRequest.sequence >= latestRequest.sequence
  );
}

export function shouldDiscardResponse(
  responseRequest: EditorRequestIdentity,
  latestRequest: EditorRequestIdentity,
): boolean {
  return !isResponseCurrent(responseRequest, latestRequest);
}
