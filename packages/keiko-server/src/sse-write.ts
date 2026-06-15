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
 * Writes `frame` to `res`. When `res.write` returns false (TCP send-buffer full / slow client),
 * aborts `controller` (stops the upstream producer) and destroys the socket.
 *
 * Returns the raw boolean from `res.write` so callers can short-circuit if needed.
 */
export function writeOrDestroy(
  res: ServerResponse,
  frame: string,
  controller: AbortController,
): boolean {
  const accepted = res.write(frame);
  if (!accepted) {
    controller.abort();
    res.destroy();
  }
  return accepted;
}
