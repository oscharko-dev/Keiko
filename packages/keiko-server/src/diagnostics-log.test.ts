// Unit tests for the RB-6 operator diagnostics sink and correlation-id resolver.
import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  contentFreeErrorClass,
  defaultServerDiagnosticSink,
  describeError,
  emitServerDiagnostic,
  evidenceRetentionDiagnosticObserver,
  serverDiagnosticFromError,
  type ServerDiagnosticRecord,
} from "./diagnostics-log.js";
import {
  CORRELATION_HEADER,
  isValidCorrelationId,
  newCorrelationId,
  resolveCorrelationId,
} from "./correlation.js";
import { ProviderError, RateLimitError } from "@oscharko-dev/keiko-security/errors/gateway";

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

  // ADR-0173 D5 g26: httpStatus/retryAfterMs are derived through the SAME instanceof-based
  // `providerErrorDetail()` (keiko-model-gateway/resilience.ts) `gateway.retry.*` lines already
  // use — reused, not re-implemented, so a diagnostic record and its sibling retry line never
  // disagree about what a `ProviderError`/`RateLimitError` carried.
  it("carries httpStatus from a ProviderError but not retryAfterMs", () => {
    const described = describeError(new ProviderError("upstream overloaded", 503));
    expect(described.httpStatus).toBe(503);
    expect(described.retryAfterMs).toBeUndefined();
  });

  // httpStatus is read off a RateLimitError too, deliberately: a rate limit is always HTTP 429 by
  // definition, so a consumer building a replay/reproduction artifact from these lines (e.g.
  // `GatewayReplayAttempt.httpStatus`) never has to infer the status from
  // errorClass === "RateLimitError" when the error itself already carries it.
  it("carries both retryAfterMs and httpStatus=429 from a RateLimitError", () => {
    const described = describeError(new RateLimitError("slow down", 4_000));
    expect(described.retryAfterMs).toBe(4_000);
    expect(described.httpStatus).toBe(429);
  });

  it("contributes neither field for an error that is neither a ProviderError nor a RateLimitError", () => {
    const described = describeError(new TypeError("unrelated"));
    expect(described.httpStatus).toBeUndefined();
    expect(described.retryAfterMs).toBeUndefined();
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

  it("routes the record to the provided sink", () => {
    const records: ServerDiagnosticRecord[] = [];
    const record = serverDiagnosticFromError({
      correlationId: "cid-routes-1",
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
    expect(captured?.correlationId).toBe("cid-routes-1");
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

  it("sanitizes an out-of-shape parentCorrelationId before ANY sink sees it, so a CRLF-bearing value never reaches the stderr line", () => {
    // Regression: `diagnosticActivityLogFields` already dropped an invalid `parentCorrelationId`
    // from the activity-log projection, but `defaultServerDiagnosticSink` serialized the ORIGINAL
    // record straight to stderr via JSON.stringify — a producer bug or hostile input could still
    // smuggle a CRLF (log-line injection) onto the operator's terminal even though the file-backed
    // activity log stayed clean. `emitServerDiagnostic` must sanitize the record once, before it
    // reaches any sink, so both tracks are protected.
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const record = serverDiagnosticFromError({
        correlationId: "cid-crlf-guard",
        operation: "unit.crlf-guard",
        source: "unit",
        error: new Error("x"),
        redact: identity,
        now: () => 0,
      });
      const hostileParentCorrelationId = "job-1\r\ninjected-fake-log-line-marker";

      emitServerDiagnostic(undefined, {
        ...record,
        parentCorrelationId: hostileParentCorrelationId,
      });

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const [line] = stderrSpy.mock.calls[0] as [string];
      expect(line).not.toContain(hostileParentCorrelationId);
      expect(line).not.toContain("injected-fake-log-line-marker");
      expect(line).not.toContain("\r\n");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("substitutes a fixed marker for an out-of-shape correlationId, for symmetry with parentCorrelationId", () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const record = serverDiagnosticFromError({
        correlationId: "cid-symmetry-guard",
        operation: "unit.symmetry-guard",
        source: "unit",
        error: new Error("x"),
        redact: identity,
        now: () => 0,
      });
      const hostileCorrelationId = "req-1\r\ninjected-fake-log-line-marker";

      emitServerDiagnostic(undefined, { ...record, correlationId: hostileCorrelationId });

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const [line] = stderrSpy.mock.calls[0] as [string];
      expect(line).not.toContain(hostileCorrelationId);
      expect(line).not.toContain("injected-fake-log-line-marker");
      // correlationId is required by the type, so an invalid value is replaced rather than
      // omitted — the sanitized record still carries a (content-free) correlationId.
      const parsed = JSON.parse(
        line.replace("[keiko-server:diagnostic] ", ""),
      ) as ServerDiagnosticRecord;
      expect(parsed.correlationId).toBe("invalid-correlation-id");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("sanitizes a CRLF-bearing correlationId/parentCorrelationId handed straight to defaultServerDiagnosticSink.record(), bypassing emitServerDiagnostic", () => {
    // Regression: `emitServerDiagnostic` sanitized the record, but three production call sites
    // (grounded-entailment-stage, codingRuntimeEventHub, sessionChannel) hand their record to
    // `ServerDiagnosticSink.record()` directly. The sanitization therefore has to live in the
    // default sink — the only sink that writes to stderr and the activity log — so that the
    // choke point is the writer itself, not one particular caller of it.
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const record = serverDiagnosticFromError({
        correlationId: "cid-direct-sink-guard",
        operation: "unit.direct-sink-guard",
        source: "unit",
        error: new Error("x"),
        redact: identity,
        now: () => 0,
      });

      defaultServerDiagnosticSink.record({
        ...record,
        correlationId: "req-1\r\ninjected-fake-log-line-marker",
        parentCorrelationId: "job-1\r\ninjected-parent-marker",
      });

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const [line] = stderrSpy.mock.calls[0] as [string];
      expect(line).not.toContain("injected-fake-log-line-marker");
      expect(line).not.toContain("injected-parent-marker");
      expect(line).not.toContain("\r\n");
      const parsed = JSON.parse(
        line.replace("[keiko-server:diagnostic] ", ""),
      ) as ServerDiagnosticRecord;
      expect(parsed.correlationId).toBe("invalid-correlation-id");
      expect(parsed.parentCorrelationId).toBeUndefined();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("leaves a well-formed parentCorrelationId untouched on the sanitized record", () => {
    const captured: ServerDiagnosticRecord[] = [];
    const record = serverDiagnosticFromError({
      correlationId: "cid-valid-parent",
      operation: "unit.valid-parent",
      source: "unit",
      error: new Error("x"),
      redact: identity,
      now: () => 0,
    });

    emitServerDiagnostic(
      { record: (r) => void captured.push(r) },
      { ...record, parentCorrelationId: "job-parent-abc123" },
    );

    expect(captured[0]?.parentCorrelationId).toBe("job-parent-abc123");
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

// ADR-0173 D5 / g12: `evidenceRetentionDiagnosticObserver`'s bound callback used to mint a fresh
// `randomUUID()` on EVERY `onRetentionDeleted` firing, so two deletions reported by the same
// retention sweep (the same observer registration) looked like unrelated operations. Fails before
// the fix — two firings from one observer would carry two different random UUIDs.
describe("evidenceRetentionDiagnosticObserver correlation id (ADR-0173 D5 / g12)", () => {
  it("shares one correlation id across every firing of the same observer", () => {
    const records: ServerDiagnosticRecord[] = [];
    const observe = evidenceRetentionDiagnosticObserver(
      { record: (record) => records.push(record) },
      "unit-test-source",
    );

    observe(2);
    observe(5);

    expect(records).toHaveLength(2);
    expect(records[0]?.correlationId).toBeDefined();
    expect(records[0]?.correlationId).toBe(records[1]?.correlationId);
  });

  it("mints a distinct id for each separate observer registration", () => {
    const records: ServerDiagnosticRecord[] = [];
    const sink = { record: (record: ServerDiagnosticRecord): number => records.push(record) };
    evidenceRetentionDiagnosticObserver(sink, "unit-test-source-a")(1);
    evidenceRetentionDiagnosticObserver(sink, "unit-test-source-b")(1);

    expect(records).toHaveLength(2);
    expect(records[0]?.correlationId).not.toBe(records[1]?.correlationId);
  });
});
