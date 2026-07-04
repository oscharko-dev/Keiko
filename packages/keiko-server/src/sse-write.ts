// Shared SSE backpressure helper. Every SSE path in the server must call res.write() and react to
// the boolean it returns: false means the kernel send-buffer is full and the client is not draining.
// Continuing to write would grow Node's internal stream buffer without bound; the correct response is
// to abort the in-flight generator (so the model/queue call stops producing) and destroy the socket.
//
// Usage (mirrors terminal-routes.ts writeTerminalEvent and run-handlers.ts SseWriter.write):
//
//   writeOrDestroy(ctx.res, frame, controller);
//
// The controller parameter is an AbortController (or null when the caller manages abort separately
// via its own signal). Destroying the socket fires "close" on res, which the caller's existing
// res.on("close", …) listener picks up for any additional cleanup (e.g. registry deregistration).

import type { ServerResponse } from "node:http";

/**
 * Backpressure signal (GEN-PERF-CHAT-006). Emitted exactly once when a write is rejected because the
 * client is not draining, BEFORE the socket is destroyed, so a slow-client termination is observable
 * and distinguishable from an intentional user cancel. Carries only non-secret counts — never body
 * bytes — so it cannot leak model tokens if logged.
 */
export interface SseBackpressureSignal {
  readonly frameBytes: number;
  readonly accepted: false;
}

/**
 * Writes `frame` to `res`. When `res.write` returns false (TCP send-buffer full / slow client),
 * aborts `controller` (stops the upstream producer) and destroys the socket.
 *
 * When the write is rejected, `onBackpressure` (if supplied) is invoked exactly once with the frame
 * byte count before the socket is destroyed, giving callers a distinct, observable signal for a
 * backpressure kill rather than silently relabeling it as a user cancel. The callback is wrapped in a
 * try/catch so an observer throw can never propagate into the write loop.
 *
 * Returns the raw boolean from `res.write` so callers can short-circuit if needed.
 */
export function writeOrDestroy(
  res: ServerResponse,
  frame: string,
  controller: AbortController,
  onBackpressure?: (signal: SseBackpressureSignal) => void,
): boolean {
  const accepted = res.write(frame);
  if (!accepted) {
    if (onBackpressure !== undefined) {
      try {
        onBackpressure({ frameBytes: Buffer.byteLength(frame, "utf8"), accepted: false });
      } catch {
        // Observability must never break the protective abort+destroy path.
      }
    }
    controller.abort();
    res.destroy();
  }
  return accepted;
}
