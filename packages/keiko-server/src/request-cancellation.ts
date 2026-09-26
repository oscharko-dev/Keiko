import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes.js";

export interface RequestCancellation {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly dispose: () => void;
}

// The minimal req/res pair `requestAlreadyClosed` actually reads. A full `RouteContext` satisfies
// this structurally (its `params`/`url`/`correlationId` just come along for the ride), and so does
// the raw pair the top-level HTTP callback in `server.ts` holds before any route has matched — the
// moment the activity log's http-request line needs this same predicate, at response `close`.
export interface CancellableRequestTarget {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
}

// True once either side of the connection is gone: the request socket was destroyed before its
// body finished arriving, or the response socket closed without this server ever marking the
// response ended (a client abort, not a normal completion). Exported so the activity log's
// http-request line (`server.ts`) can reuse this exact predicate instead of re-reading `req`/`res`
// state a second way: `res.statusCode` defaults to 200 from construction regardless of whether
// anything was ever written, so the line needs this same "did the connection actually complete"
// signal to avoid reporting a dropped connection as a successful one.
//
// `!target.res.writableEnded` guards BOTH disjuncts, not just `closed`: verified against a real
// `http.Server` (not only the fake req/res doubles below), Node marks a `ServerResponse` `destroyed`
// once its stream is torn down AFTER a fully successful `res.end()` too — `destroyed` alone does not
// mean "aborted". Only every caller of this function today (`createRequestCancellation`) happens to
// call it before any response activity, where `writableEnded` is always still `false`, so this guard
// was a no-op for that caller and the bug was invisible until a second caller (the activity log's
// http-request line, at response `close`, i.e. potentially AFTER a normal completion) exercised it.
export function requestAlreadyClosed(target: CancellableRequestTarget): boolean {
  const responseClosed = !target.res.writableEnded && (target.res.destroyed || target.res.closed);
  const requestAborted = target.req.destroyed && !target.req.complete;
  return requestAborted || responseClosed;
}

export function createRequestCancellation(ctx: RouteContext, reason: string): RequestCancellation {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const responseClose = (): void => {
    if (!ctx.res.writableEnded) abort();
  };
  ctx.req.once("aborted", abort);
  ctx.res.once("close", responseClose);
  if (requestAlreadyClosed(ctx)) abort();
  return {
    controller,
    signal: controller.signal,
    dispose: (): void => {
      ctx.req.off("aborted", abort);
      ctx.res.off("close", responseClose);
    },
  };
}
