import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createRequestCancellation, requestAlreadyClosed } from "./request-cancellation.js";
import type { RouteContext } from "./routes.js";

interface RequestDouble extends EventEmitter {
  complete: boolean;
  destroyed: boolean;
}

interface ResponseDouble extends EventEmitter {
  closed: boolean;
  destroyed: boolean;
  writableEnded: boolean;
}

const ALREADY_CLOSED_CASES: readonly {
  readonly label: string;
  readonly request?: Partial<Pick<RequestDouble, "complete" | "destroyed">>;
  readonly response?: Partial<Pick<ResponseDouble, "closed" | "destroyed" | "writableEnded">>;
}[] = [
  { label: "incomplete request destroyed", request: { complete: false, destroyed: true } },
  { label: "response destroyed", response: { destroyed: true } },
  { label: "unfinished response closed", response: { closed: true } },
];

function context(): {
  readonly ctx: RouteContext;
  readonly req: RequestDouble;
  readonly res: ResponseDouble;
} {
  const req = Object.assign(new EventEmitter(), {
    complete: false,
    destroyed: false,
  });
  const res = Object.assign(new EventEmitter(), {
    closed: false,
    destroyed: false,
    writableEnded: false,
  });
  return {
    req,
    res,
    ctx: {
      correlationId: undefined,
      req: req as unknown as IncomingMessage,
      res: res as unknown as ServerResponse,
      params: {},
      url: new URL("http://127.0.0.1/test"),
    },
  };
}

describe("request cancellation", () => {
  it("removes request and response listeners when disposed", () => {
    const fixture = context();
    const cancellation = createRequestCancellation(fixture.ctx, "cancelled");

    expect(fixture.req.listenerCount("aborted")).toBe(1);
    expect(fixture.res.listenerCount("close")).toBe(1);
    cancellation.dispose();

    expect(fixture.req.listenerCount("aborted")).toBe(0);
    expect(fixture.res.listenerCount("close")).toBe(0);
    fixture.res.emit("close");
    expect(cancellation.signal.aborted).toBe(false);
  });

  it("does not abort when a successfully ended response closes", () => {
    const fixture = context();
    const cancellation = createRequestCancellation(fixture.ctx, "cancelled");
    fixture.res.writableEnded = true;

    fixture.res.emit("close");

    expect(cancellation.signal.aborted).toBe(false);
    expect(fixture.res.listenerCount("close")).toBe(0);
    cancellation.dispose();
  });

  it("aborts when an unfinished response closes", () => {
    const fixture = context();
    const cancellation = createRequestCancellation(fixture.ctx, "cancelled");

    fixture.res.emit("close");

    expect(cancellation.signal.aborted).toBe(true);
    expect(cancellation.signal.reason).toBe("cancelled");
    expect(fixture.res.listenerCount("close")).toBe(0);
    cancellation.dispose();
  });

  it.each(ALREADY_CLOSED_CASES)("starts aborted when $label", (testCase) => {
    const fixture = context();
    Object.assign(fixture.req, testCase.request);
    Object.assign(fixture.res, testCase.response);

    const cancellation = createRequestCancellation(fixture.ctx, "cancelled");

    expect(cancellation.signal.aborted).toBe(true);
    cancellation.dispose();
  });

  it("does not start aborted for an already closed successful response", () => {
    const fixture = context();
    fixture.res.closed = true;
    fixture.res.writableEnded = true;

    const cancellation = createRequestCancellation(fixture.ctx, "cancelled");

    expect(cancellation.signal.aborted).toBe(false);
    cancellation.dispose();
  });

  it("does not treat a fully consumed request as cancelled after Node destroys the message", (): void => {
    const fixture = context();
    fixture.req.complete = true;
    fixture.req.destroyed = true;

    const cancellation = createRequestCancellation(fixture.ctx, "cancelled");

    expect(cancellation.signal.aborted).toBe(false);
    cancellation.dispose();
  });
});

// `requestAlreadyClosed` itself, exported so `server.ts`'s activity log http-request line can
// reuse it at response `close` time — a moment `createRequestCancellation` never evaluates it at
// (it only calls the predicate once, synchronously, before any response activity).
describe("requestAlreadyClosed", () => {
  it("accepts the minimal req/res pair directly, without a full RouteContext", () => {
    const req = Object.assign(new EventEmitter(), { complete: true, destroyed: false });
    const res = Object.assign(new EventEmitter(), {
      closed: false,
      destroyed: false,
      writableEnded: true,
    });

    expect(
      requestAlreadyClosed({
        req: req as unknown as IncomingMessage,
        res: res as unknown as ServerResponse,
      }),
    ).toBe(false);
  });

  // Verified against a real `http.Server` (not only these fake doubles): Node marks a
  // `ServerResponse` `destroyed` once its stream is torn down after a fully successful `res.end()`
  // too, not only on an abrupt client disconnect. Every EXISTING caller (`createRequestCancellation`,
  // above) only ever evaluated this predicate before any response activity, where `writableEnded` is
  // always still `false` — so a `destroyed`-without-`writableEnded` shape never arose there and this
  // gap was invisible. The activity log's http-request line calls it AFTER the response may have
  // completed, which is exactly the shape this pins: `destroyed` alone must never mean "aborted"
  // once the response actually ended.
  it("does not treat a normally completed response (destroyed AND writableEnded) as already closed", () => {
    const req = Object.assign(new EventEmitter(), { complete: true, destroyed: false });
    const res = Object.assign(new EventEmitter(), {
      closed: true,
      destroyed: true,
      writableEnded: true,
    });

    expect(
      requestAlreadyClosed({
        req: req as unknown as IncomingMessage,
        res: res as unknown as ServerResponse,
      }),
    ).toBe(false);
  });

  it("still treats a destroyed response that never finished as closed", () => {
    const req = Object.assign(new EventEmitter(), { complete: true, destroyed: false });
    const res = Object.assign(new EventEmitter(), {
      closed: false,
      destroyed: true,
      writableEnded: false,
    });

    expect(
      requestAlreadyClosed({
        req: req as unknown as IncomingMessage,
        res: res as unknown as ServerResponse,
      }),
    ).toBe(true);
  });
});
