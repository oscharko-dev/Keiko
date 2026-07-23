import type { RouteContext } from "./routes.js";

export interface RequestCancellation {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly dispose: () => void;
}

function requestAlreadyClosed(ctx: RouteContext): boolean {
  const responseClosed = ctx.res.destroyed || (ctx.res.closed && !ctx.res.writableEnded);
  return ctx.req.destroyed || responseClosed;
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
