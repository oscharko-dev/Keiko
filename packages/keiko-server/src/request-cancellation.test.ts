import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createRequestCancellation } from "./request-cancellation.js";
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
