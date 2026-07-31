/**
 * Pure cancellation/superseding helpers over {@link EditorRequestIdentity} (Issue #1192).
 *
 * Cross-boundary cancellation is expressed entirely through the serializable request identity: a
 * later request in the same `streamId` with a higher `sequence` supersedes earlier ones, and a
 * response is current only when it carries the exact latest request identity. The in-process
 * `AbortSignal` on the host port is a local abort handle only and is intentionally never a contract
 * field.
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
 * True iff a response carries the exact identity of the latest request.
 */
export function isResponseCurrent(
  responseRequest: EditorRequestIdentity,
  latestRequest: EditorRequestIdentity,
): boolean {
  return (
    responseRequest.requestId === latestRequest.requestId &&
    responseRequest.streamId === latestRequest.streamId &&
    responseRequest.sequence === latestRequest.sequence
  );
}

export function shouldDiscardResponse(
  responseRequest: EditorRequestIdentity,
  latestRequest: EditorRequestIdentity,
): boolean {
  return !isResponseCurrent(responseRequest, latestRequest);
}

/**
 * {@link shouldDiscardResponse} against a provider's *live* latest-request slot, which is `null` until
 * the first request is issued and may be reassigned while a response is in flight. A bridge must read
 * that slot at settle time (not snapshot it beforehand), so the nullable case belongs here rather than
 * in each bridge: with no request outstanding there is nothing the response can be current for, so it
 * is discarded.
 */
export function shouldDiscardAgainstLatest(
  responseRequest: EditorRequestIdentity,
  latestRequest: EditorRequestIdentity | null,
): boolean {
  return latestRequest === null || shouldDiscardResponse(responseRequest, latestRequest);
}
