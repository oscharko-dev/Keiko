// Unit tests for the RB-6 operator diagnostics sink and correlation-id resolver.
import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  contentFreeErrorClass,
  describeError,
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticRecord,
} from "./diagnostics-log.js";
import {
  CORRELATION_HEADER,
  isValidCorrelationId,
  newCorrelationId,
  resolveCorrelationId,
} from "./correlation.js";

const identity = (message: string): string => message;

describe("describeError (RB-6)", () => {
  it("extracts a content-free class without reading the error message", () => {
    const described = describeError(new TypeError("bad value"));
    expect(described.errorClass).toBe("TypeError");
    expect(described).not.toHaveProperty("message");
  });

  it("captures a machine code and a gateway requestId when present", () => {
    const error = Object.assign(new Error("gateway blew up"), {
      code: "GATEWAY_TRANSPORT",
      requestId: "gw-req-42",
    });
    const described = describeError(error);
    expect(described.code).toBe("GATEWAY_TRANSPORT");
    expect(described.gatewayRequestId).toBe("gw-req-42");
  });

  it("handles a non-Error throw without crashing", () => {
    const described = describeError("just a string");
    expect(described.errorClass).toBe("string");
    expect(described.code).toBeUndefined();
  });
});

describe("contentFreeErrorClass (mutable Error.name hardening)", (): void => {
  it("degrades an overridden name on a plain Error and never serializes it", (): void => {
    const hostile = new Error("boom");
    hostile.name = "hostile-injected-label";
    const record = serverDiagnosticFromError({
      correlationId: "cid-hostile",
      operation: "op",
      source: "unit",
      error: hostile,
      redact: identity,
      now: (): number => 0,
    });
    expect(record.errorClass).toBe("Error");
    expect(JSON.stringify(record)).not.toContain("hostile-injected-label");
  });

  it("keeps a declared subclass distinguishable, even with a tampered name", (): void => {
    class GatewayShapedError extends Error {
      constructor(message: string) {
        super(message);
        this.name = new.target.name;
      }
    }
    expect(describeError(new GatewayShapedError("x")).errorClass).toBe("GatewayShapedError");
    const tampered = new GatewayShapedError("x");
    tampered.name = "leaked request text";
    expect(describeError(tampered).errorClass).toBe("GatewayShapedError");
  });

  it("recovers the declared class of a subclass that never assigns this.name", (): void => {
    class QuietSubclassError extends Error {}
    expect(contentFreeErrorClass(new QuietSubclassError("x"))).toBe("QuietSubclassError");
  });

  it("lets specific built-in names ride on generic instances", (): void => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(describeError(abort).errorClass).toBe("AbortError");
  });

  it("degrades to the generic class when no declared class name exists", (): void => {
    const anonymous = new (class extends Error {})("x");
    anonymous.name = "zz hostile zz";
    expect(contentFreeErrorClass(anonymous)).toBe("Error");
  });

  it("ignores an instance-level constructor planted by hostile data", (): void => {
    const tampered = Object.assign(new Error("x"), {
      name: "still-hostile",
      constructor: { name: "LeakedText123" },
    });
    expect(contentFreeErrorClass(tampered)).toBe("Error");
  });

  it("degrades when the prototype exposes no callable constructor", (): void => {
    class Ctorless extends Error {}
    Object.defineProperty(Ctorless.prototype, "constructor", { value: undefined });
    const err = new Ctorless("x");
    err.name = "tampered-name";
    expect(contentFreeErrorClass(err)).toBe("Error");
  });

  it("never throws when reflection over a hostile value throws", (): void => {
    const throwingName = new Error("x");
    Object.defineProperty(throwingName, "name", {
      get(): string {
        throw new Error("hostile accessor");
      },
    });
    expect(contentFreeErrorClass(throwingName)).toBe("Error");
    const throwingProto = new Proxy(new Error("x"), {
      getPrototypeOf(): object {
        throw new Error("hostile trap");
      },
    });
    expect(contentFreeErrorClass(throwingProto)).toBe("Error");
  });

  it("labels non-Error throws by their typeof", (): void => {
    expect(contentFreeErrorClass("plain string")).toBe("string");
    expect(contentFreeErrorClass(42)).toBe("number");
  });
});

describe("describeError machine-token bounds for code and requestId", (): void => {
  it("drops prose-shaped code and requestId values instead of forwarding content", (): void => {
    const hostile = Object.assign(new Error("x"), {
      code: "customer email jane@example.com",
      requestId: "she said: hello world",
    });
    const described = describeError(hostile);
    expect(described.code).toBeUndefined();
    expect(described.gatewayRequestId).toBeUndefined();
  });

  it("forwards machine tokens for producers that redact by constant message", (): void => {
    const coded = Object.assign(new Error("x"), {
      code: "GATEWAY_TIMEOUT",
      requestId: "req-7",
    });
    const described = describeError(coded);
    expect(described.code).toBe("GATEWAY_TIMEOUT");
    expect(described.gatewayRequestId).toBe("req-7");
  });
});

describe("emitServerDiagnostic (RB-6)", () => {
  it("keeps arbitrary provider and customer body text out of the diagnostic record", () => {
    const bodyMarker = "fixture-customer-provider-body-marker";
    const record = serverDiagnosticFromError({
      correlationId: "cid-body-free",
      operation: "POST /api/desktop/chat/stream",
      source: "unit",
      error: Object.assign(new Error(`upstream body: ${bodyMarker}`), {
        code: "GATEWAY_TRANSPORT",
        requestId: "gw-body-free-7",
        partialUsage: { promptTokens: 41, completionTokens: 7 },
      }),
      redact: () => bodyMarker,
      now: () => 0,
    });

    expect(record).toMatchObject({
      correlationId: "cid-body-free",
      operation: "POST /api/desktop/chat/stream",
      source: "unit",
      errorClass: "Error",
      message: "server-operation-failed",
      code: "GATEWAY_TRANSPORT",
      gatewayRequestId: "gw-body-free-7",
      partialUsage: { promptTokens: 41, completionTokens: 7 },
    });
    expect(JSON.stringify(record)).not.toContain(bodyMarker);
  });

  it("degrades throwing error properties without raising a second failure", () => {
    const propertyMarker = "fixture-hostile-error-property-marker";
    const hostile = new Error("placeholder");
    for (const property of ["message", "code", "requestId", "partialUsage"] as const) {
      Object.defineProperty(hostile, property, {
        configurable: true,
        get(): never {
          throw new Error(`${propertyMarker}-${property}`);
        },
      });
    }

    expect(() =>
      serverDiagnosticFromError({
        correlationId: "cid-hostile-properties",
        operation: "unit.hostile-properties",
        source: "unit",
        error: hostile,
        redact: identity,
        now: () => 0,
      }),
    ).not.toThrow();
    const record = serverDiagnosticFromError({
      correlationId: "cid-hostile-properties",
      operation: "unit.hostile-properties",
      source: "unit",
      error: hostile,
      redact: identity,
      now: () => 0,
    });
    expect(record).toMatchObject({
      errorClass: "Error",
      message: "server-operation-failed",
    });
    expect(record.code).toBeUndefined();
    expect(record.gatewayRequestId).toBeUndefined();
    expect(record.partialUsage).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain(propertyMarker);
  });

  it("degrades hostile proxies and nested usage getters without raising a second failure", () => {
    const trapMarker = "fixture-hostile-proxy-trap-marker";
    const partialUsage = Object.defineProperties(
      {},
      {
        promptTokens: {
          get(): never {
            throw new Error(`${trapMarker}-promptTokens`);
          },
        },
        completionTokens: { value: 7 },
      },
    );
    const hostile = new Proxy(Object.assign(new Error("placeholder"), { partialUsage }), {
      get(target, property, receiver): unknown {
        if (property === "message" || property === "code" || property === "requestId") {
          throw new Error(`${trapMarker}-${property}`);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const record = serverDiagnosticFromError({
      correlationId: "cid-hostile-proxy",
      operation: "unit.hostile-proxy",
      source: "unit",
      error: hostile,
      redact: identity,
      now: () => 0,
    });
    expect(record).toMatchObject({
      errorClass: "Error",
      message: "server-operation-failed",
    });
    expect(record.code).toBeUndefined();
    expect(record.gatewayRequestId).toBeUndefined();
    expect(record.partialUsage).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain(trapMarker);
  });

  it("replaces unbounded operation and source content with fixed labels", () => {
    const labelMarker = "fixture-customer-operation-marker";
    const record = serverDiagnosticFromError({
      correlationId: "cid-hostile-labels",
      operation: `POST /api/chat?prompt=${labelMarker}`,
      source: `unit source ${labelMarker}`,
      error: new Error("placeholder"),
      redact: identity,
      now: () => 0,
    });

    expect(record.operation).toBe("server.operation");
    expect(record.source).toBe("server.diagnostic");
    expect(JSON.stringify(record)).not.toContain(labelMarker);
  });

  // ADR-0173 D3-adjacent follow-up (#3235 review, Wave 5): an `operation` label built from a live
  // request path (`GET ${ctx.url.pathname}`-shaped) could carry a customer-chosen route segment
  // verbatim onto the record. `diagnosticLabel` now reduces the path portion of an operation label
  // through the SAME `redactRoutePath` reducer the HTTP request line uses, rather than accepting
  // any string that merely matches the shape regex.
  describe("operation labels never carry a raw request path (review follow-up, #3235)", () => {
    it("reduces a path with a customer-named segment to its route template", () => {
      const customerMarker = "fixture-customer-named-repository";
      const record = serverDiagnosticFromError({
        correlationId: "cid-path-template",
        operation: `GET /api/git/repositories/${customerMarker}/status`,
        source: "unit",
        error: new Error("placeholder"),
        redact: identity,
        now: () => 0,
      });

      expect(record.operation).toBe("GET /api/git/repositories/{id}/status");
      expect(JSON.stringify(record)).not.toContain(customerMarker);
    });

    it("leaves an operation label with no path component unchanged", () => {
      const record = serverDiagnosticFromError({
        correlationId: "cid-no-path",
        operation: "chat.stream",
        source: "unit",
        error: new Error("placeholder"),
        redact: identity,
        now: () => 0,
      });

      expect(record.operation).toBe("chat.stream");
    });

    it("falls back to server.operation for a traversal-shaped path", () => {
      const record = serverDiagnosticFromError({
        correlationId: "cid-traversal",
        operation: "GET /api/git/../../etc/passwd",
        source: "unit",
        error: new Error("placeholder"),
        redact: identity,
        now: () => 0,
      });

      expect(record.operation).toBe("server.operation");
    });

    it("keeps a fully-literal route path unchanged (every segment is a declared route word)", () => {
      const record = serverDiagnosticFromError({
        correlationId: "cid-literal-path",
        operation: "POST /api/desktop/chat/stream",
        source: "unit",
        error: new Error("placeholder"),
        redact: identity,
        now: () => 0,
      });

      expect(record.operation).toBe("POST /api/desktop/chat/stream");
    });
  });

  it("routes the record to the provided sink", () => {
    const records: ServerDiagnosticRecord[] = [];
    const record = serverDiagnosticFromError({
      correlationId: "cid-1",
      operation: "GET /api/x",
      source: "unit",
      error: new Error("nope"),
      redact: identity,
      now: () => 0,
    });
    emitServerDiagnostic(
      {
        record: (r) => {
          records.push(r);
        },
      },
      record,
    );
    expect(records).toHaveLength(1);
    const [captured] = records;
    expect(captured?.correlationId).toBe("cid-1");
    expect(captured?.timestamp).toBe("1970-01-01T00:00:00.000Z");
  });

  it("never throws when the sink itself throws", () => {
    const record = serverDiagnosticFromError({
      correlationId: "cid-2",
      operation: "op",
      source: "unit",
      error: new Error("x"),
      redact: identity,
    });
    const brokenSink = {
      record: (): void => {
        throw new Error("sink is broken");
      },
    };
    expect(() => {
      emitServerDiagnostic(brokenSink, record);
    }).not.toThrow();
  });
});

describe("resolveCorrelationId (RB-6)", () => {
  function req(headerValue: string | undefined): IncomingMessage {
    return {
      headers: headerValue === undefined ? {} : { [CORRELATION_HEADER]: headerValue },
    } as unknown as IncomingMessage;
  }

  it("mints a fresh UUID when no header is present", () => {
    const id = resolveCorrelationId(req(undefined));
    expect(isValidCorrelationId(id)).toBe(true);
  });

  it("reuses a well-formed client-supplied id", () => {
    const id = resolveCorrelationId(req("client-abc_123.def"));
    expect(id).toBe("client-abc_123.def");
  });

  it("rejects an unsafe client id (spaces, CRLF, too short/long) and mints one", () => {
    for (const bad of ["short", "has space", "line\nbreak", "x".repeat(200)]) {
      const id = resolveCorrelationId(req(bad));
      expect(id).not.toBe(bad);
      expect(isValidCorrelationId(id)).toBe(true);
    }
  });

  it("newCorrelationId returns distinct, valid ids", () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).not.toBe(b);
    expect(isValidCorrelationId(a)).toBe(true);
  });
});

describe("describeError partial-usage passthrough", () => {
  it("carries counts-only partialUsage from a mid-stream gateway failure", () => {
    const error = Object.assign(new Error("stream read failed"), {
      code: "GATEWAY_TRANSPORT",
      partialUsage: { promptTokens: 41, completionTokens: 7, streamedChars: 999 },
    });
    const described = describeError(error);
    // Counts survive; the char counter (and anything else) is not forwarded.
    expect(described.partialUsage).toEqual({ promptTokens: 41, completionTokens: 7 });
  });

  it("drops malformed or non-numeric partialUsage shapes (fail closed)", () => {
    const hostile = Object.assign(new Error("x"), {
      partialUsage: { promptTokens: "41 tokens of content", completionTokens: 7 },
    });
    expect(describeError(hostile).partialUsage).toBeUndefined();
    const nan = Object.assign(new Error("x"), {
      partialUsage: { promptTokens: Number.NaN, completionTokens: 7 },
    });
    expect(describeError(nan).partialUsage).toBeUndefined();
    expect(describeError(new Error("x")).partialUsage).toBeUndefined();
  });
});

// ADR-0173 D3: `describeError` wires `keikoStackFrames`/`causeChain` onto its result rather than
// re-deriving stack/cause reduction itself — `stack-frames.test.ts` owns the reducers' own
// contract (dist-anchoring, bounds, hostile-input handling); this suite only proves the wiring.
describe("describeError frames and causeChain (ADR-0173 D3)", () => {
  function withStack(error: Error, stack: string): Error {
    error.stack = stack;
    return error;
  }

  it("includes keikoStackFrames' reduction under frames", () => {
    const error = withStack(
      new Error("boom"),
      [
        "Error: boom",
        "    at Object.handler (file:///Users/someone/app/packages/keiko-server/dist/observability/server-log.js:128:18)",
        "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
      ].join("\n"),
    );
    expect(describeError(error).frames).toEqual([
      "packages/keiko-server/dist/observability/server-log.js:128:18",
    ]);
  });

  it("omits frames entirely rather than an empty array when nothing anchors", () => {
    const error = withStack(
      new Error("boom"),
      ["Error: boom", "    at node_modules/some-lib/index.js:1:1"].join("\n"),
    );
    expect(describeError(error).frames).toBeUndefined();
    expect(describeError("not an error").frames).toBeUndefined();
  });

  // The exact surviving frame COUNT is a property of the runtime (V8 inlining,
  // `Error.stackTraceLimit`, Vitest's transform), never of the reducer under test — so it is
  // pinned here against an INJECTED synthetic stack, not against a real thrown-error stack whose
  // shape the runtime controls. `diagnostics-log.activity-log.test.ts` deliberately asserts only
  // "at least one frame" on a real stack for that reason.
  it("pins the exact frame count for a synthetic multi-frame stack", () => {
    const error = withStack(
      new Error("boom"),
      [
        "Error: boom",
        "    at levelThree (file:///Users/someone/app/packages/keiko-server/dist/foo.js:10:5)",
        "    at levelTwo (file:///Users/someone/app/packages/keiko-server/dist/foo.js:20:7)",
        "    at levelOne (file:///Users/someone/app/packages/keiko-server/dist/foo.js:30:9)",
        "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
      ].join("\n"),
    );
    expect(describeError(error).frames).toEqual([
      "packages/keiko-server/dist/foo.js:10:5",
      "packages/keiko-server/dist/foo.js:20:7",
      "packages/keiko-server/dist/foo.js:30:9",
    ]);
  });

  it("includes causeChain's content-free class reduction of the error's cause chain", () => {
    const inner = new TypeError("inner");
    const outer = new Error("outer", { cause: inner });
    expect(describeError(outer).causeChain).toEqual(["TypeError"]);
  });

  it("omits causeChain rather than an empty array when the error carries no cause", () => {
    expect(describeError(new Error("no cause")).causeChain).toBeUndefined();
  });
});

describe("serverDiagnosticFromError forwards frames and causeChain (ADR-0173 D3)", () => {
  it("carries both onto the produced record when the error carries both", () => {
    const inner = new TypeError("inner");
    const error = new Error("outer", { cause: inner });
    error.stack = [
      "Error: outer",
      "    at file:///Users/someone/app/packages/keiko-server/dist/foo.js:1:1",
    ].join("\n");

    const record = serverDiagnosticFromError({
      correlationId: "cid-frames-chain",
      operation: "op",
      source: "unit",
      error,
      redact: identity,
      now: () => 0,
    });

    expect(record.frames).toEqual(["packages/keiko-server/dist/foo.js:1:1"]);
    expect(record.causeChain).toEqual(["TypeError"]);
  });

  it("omits both when the error carries neither a recognisable stack nor a cause", () => {
    const record = serverDiagnosticFromError({
      correlationId: "cid-no-evidence",
      operation: "op",
      source: "unit",
      error: "plain string throw",
      redact: identity,
      now: () => 0,
    });
    expect(record.frames).toBeUndefined();
    expect(record.causeChain).toBeUndefined();
  });
});
