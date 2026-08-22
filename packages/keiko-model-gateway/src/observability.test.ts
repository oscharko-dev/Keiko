import { describe, expect, it } from "vitest";
import {
  logEndpointHost,
  logErrorKind,
  logLevelEnabled,
  logTimer,
  nullModelGatewayLogSink,
  resolveLogSink,
  withCorrelationId,
  type ModelGatewayLogEvent,
  type ModelGatewayLogLevel,
  type ModelGatewayLogSink,
} from "./observability.js";

describe("resolveLogSink", () => {
  it("falls back to the shared no-op sink when the caller wired nothing", () => {
    expect(resolveLogSink(undefined)).toBe(nullModelGatewayLogSink);
  });

  // Object identity was the earlier assertion here. It stood in for the real contract — the
  // caller's sink receives the event — and that contract is what this now checks, because the
  // sink is deliberately WRAPPED so a throwing caller sink cannot fail the outbound call.
  it("delivers events to the caller's sink when one is wired", () => {
    const received: string[] = [];
    const sink = {
      write: (event: ModelGatewayLogEvent): void => {
        received.push(event.op);
      },
    };
    resolveLogSink(sink).write({ category: "gateway", op: "gateway.chat.started" });
    expect(received).toStrictEqual(["gateway.chat.started"]);
  });

  it("swallows an event on the null sink without throwing", () => {
    const event: ModelGatewayLogEvent = { category: "gateway", op: "noop" };
    expect(() => {
      nullModelGatewayLogSink.write(event);
    }).not.toThrow();
  });

  it("is frozen so a caller cannot turn the no-op into a recorder", () => {
    expect(Object.isFrozen(nullModelGatewayLogSink)).toBe(true);
  });
});

describe("logLevelEnabled", () => {
  it("treats a sink without a predicate as accepting every level", () => {
    const sink: ModelGatewayLogSink = { write: (): void => undefined };
    for (const level of ["debug", "info", "warn", "error"] satisfies ModelGatewayLogLevel[]) {
      expect(logLevelEnabled(sink, level)).toBe(true);
    }
  });

  it("asks the sink's predicate, and asks it with the level in question", () => {
    const asked: ModelGatewayLogLevel[] = [];
    const sink: ModelGatewayLogSink = {
      write: (): void => undefined,
      enabled: (level): boolean => {
        asked.push(level);
        return level !== "debug";
      },
    };
    expect(logLevelEnabled(sink, "debug")).toBe(false);
    expect(logLevelEnabled(sink, "warn")).toBe(true);
    expect(asked).toEqual(["debug", "warn"]);
  });

  // The unwired default must not merely discard events — it must let a gated call site skip
  // building them at all, which is the whole point of the predicate.
  it("reports every level disabled on the shared no-op sink", () => {
    expect(logLevelEnabled(nullModelGatewayLogSink, "debug")).toBe(false);
    expect(logLevelEnabled(nullModelGatewayLogSink, "error")).toBe(false);
    expect(logLevelEnabled(resolveLogSink(undefined), "info")).toBe(false);
  });
});

describe("withCorrelationId", () => {
  function recorder(): {
    readonly sink: ModelGatewayLogSink;
    readonly events: ModelGatewayLogEvent[];
  } {
    const events: ModelGatewayLogEvent[] = [];
    return {
      events,
      sink: {
        write(event: ModelGatewayLogEvent): void {
          events.push(event);
        },
      },
    };
  }

  // No id means no wrapper at all: an uncorrelated caller must keep its exact previous behaviour,
  // down to the object identity, so instrumenting the correlation path cannot change the cost of
  // a call that does not use it.
  it("returns the sink unchanged when there is no id to bind", () => {
    const sink: ModelGatewayLogSink = { write: (): void => undefined };
    expect(withCorrelationId(sink, undefined)).toBe(sink);
  });

  it("stamps the id on an event that carries none", () => {
    const log = recorder();
    withCorrelationId(log.sink, "corr-9").write({ category: "http", op: "http.gateway.x" });
    expect(log.events[0]?.correlationId).toBe("corr-9");
  });

  // An id already on the event wins: `gateway.ts` stamps its own per-call id, and a wrapper that
  // overwrote it would silently retag another subsystem's line.
  it("never overwrites an id the event already carries", () => {
    const log = recorder();
    withCorrelationId(log.sink, "outer").write({
      category: "gateway",
      op: "gateway.chat.started",
      correlationId: "inner",
    });
    expect(log.events[0]?.correlationId).toBe("inner");
  });

  it("leaves every other field of the event untouched", () => {
    const log = recorder();
    const event: ModelGatewayLogEvent = {
      level: "warn",
      category: "embedding",
      op: "embedding.batch.dispatch",
      status: 500,
      durationMs: 12,
      errorKind: "RATE_LIMIT",
      extra: { inputCount: 36 },
    };
    withCorrelationId(log.sink, "corr-1").write(event);
    expect(log.events[0]).toEqual({ ...event, correlationId: "corr-1" });
  });

  // The predicate is DELEGATED, not copied: a sink implementing `enabled` as a method must keep
  // its `this`, or wrapping it would answer with the wrong threshold — or throw.
  it("delegates the level predicate to the wrapped sink, preserving its receiver", () => {
    class ThresholdSink implements ModelGatewayLogSink {
      private readonly declined: ModelGatewayLogLevel = "debug";
      readonly events: ModelGatewayLogEvent[] = [];
      write(event: ModelGatewayLogEvent): void {
        this.events.push(event);
      }
      // Reads instance state on purpose: a wrapper that copied the function instead of calling it
      // through the sink would lose `this` and blow up here rather than answering.
      enabled(level: ModelGatewayLogLevel): boolean {
        return level !== this.declined;
      }
    }
    const sink = new ThresholdSink();
    const wrapped = withCorrelationId(sink, "corr-2");
    expect(logLevelEnabled(wrapped, "debug")).toBe(false);
    expect(logLevelEnabled(wrapped, "info")).toBe(true);
    wrapped.write({ category: "http", op: "http.gateway.fetch.started" });
    expect(sink.events[0]?.correlationId).toBe("corr-2");
  });

  it("keeps a sink without a predicate open at every level", () => {
    const wrapped = withCorrelationId({ write: (): void => undefined }, "corr-3");
    for (const level of ["debug", "info", "warn", "error"] satisfies ModelGatewayLogLevel[]) {
      expect(logLevelEnabled(wrapped, level)).toBe(true);
    }
  });
});

describe("logErrorKind", () => {
  it("prefers a string `code` — the egress and gateway taxonomies both carry one", () => {
    const error = Object.assign(new Error("boom"), { code: "PROXY_BLOCKED_BY_POLICY" });
    expect(logErrorKind(error)).toBe("PROXY_BLOCKED_BY_POLICY");
  });

  it("falls back to the error name when there is no code", () => {
    expect(logErrorKind(new TypeError("boom"))).toBe("TypeError");
  });

  it("ignores a non-string or empty code rather than stringifying it", () => {
    expect(logErrorKind(Object.assign(new RangeError("x"), { code: 500 }))).toBe("RangeError");
    expect(logErrorKind(Object.assign(new RangeError("x"), { code: "" }))).toBe("RangeError");
  });

  // `code` is PROVIDER-CONTROLLED and `errorKind` is an envelope field, so it bypasses the
  // `extra` field-name policy entirely. An SDK that sets `code` to a sentence would otherwise
  // walk a provider message — the very thing `message` is refused for — straight into the log
  // through the one field guaranteed to be exempt. Same gate as the server's `errorKindOf`.
  it("refuses a `code` that is prose rather than an identifier", () => {
    const sentence = Object.assign(new RangeError("x"), {
      code: 'The request body was rejected: {"input": "patient record"}',
    });
    expect(logErrorKind(sentence)).toBe("RangeError");
  });

  it("refuses a `code` carrying whitespace, a newline, or an over-long opaque value", () => {
    const kinds = [
      "RATE LIMIT",
      "RATE\nLIMIT",
      `A${"b".repeat(64)}`,
      "1_LEADING_DIGIT",
      "-leading-dash",
    ].map((code) => logErrorKind(Object.assign(new RangeError("x"), { code })));
    expect(kinds).toEqual(["RangeError", "RangeError", "RangeError", "RangeError", "RangeError"]);
  });

  it("applies the same gate to `name`, and reports unknown when neither conforms", () => {
    expect(logErrorKind({ code: "not an identifier", name: "also not one" })).toBe("unknown");
    expect(logErrorKind({ name: "AbortError" })).toBe("AbortError");
  });

  // The gate must not cost the taxonomy: these are the exact shapes the egress, gateway and
  // Node transport layers produce, and every one of them has to survive it.
  it("still accepts the taxonomy codes the instrumentation actually emits", () => {
    const accepted = [
      "PROXY_BLOCKED_BY_POLICY",
      "ECONNREFUSED",
      "GATEWAY_RATE_LIMIT",
      "TimeoutError",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    ].map((code) => logErrorKind(Object.assign(new Error("x"), { code })));
    expect(accepted).toEqual([
      "PROXY_BLOCKED_BY_POLICY",
      "ECONNREFUSED",
      "GATEWAY_RATE_LIMIT",
      "TimeoutError",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    ]);
  });

  it("reports `unknown` for a thrown non-object", () => {
    expect(logErrorKind("a string with sk-secret in it")).toBe("unknown");
    expect(logErrorKind(undefined)).toBe("unknown");
    expect(logErrorKind(null)).toBe("unknown");
  });

  // The leak proof. `message` is where a provider body, an echoed prompt, or a full URL with a
  // key in it ends up; this function must never touch it. A getter that throws is the only way to
  // prove non-access rather than merely assert on the output.
  it("never reads `message`", () => {
    const error = new Error("placeholder");
    Object.defineProperty(error, "message", {
      get(): string {
        throw new Error("message must never be read by the log path");
      },
    });
    expect(() => logErrorKind(error)).not.toThrow();
    expect(logErrorKind(error)).toBe("Error");
  });

  // Reading `code` runs foreign code: a gateway SDK's error class, or a hostile response body
  // deserialized into a getter, can throw from its own accessor. This call sits inside a `catch`
  // block that is already building the retry-exhausted event (`resilience.ts`), so a throw here
  // would escape as the failure instead of describing it — an unreadable property is an
  // unclassifiable one and must degrade to the next candidate, exactly like its `code`/`name`
  // sibling in `keiko-local-knowledge`.
  it("degrades to the next candidate when a property accessor throws", () => {
    const hostile = { name: "ProviderTimeoutError" };
    Object.defineProperty(hostile, "code", {
      get(): string {
        throw new Error("accessor refused");
      },
      enumerable: true,
    });
    expect(() => logErrorKind(hostile)).not.toThrow();
    expect(logErrorKind(hostile)).toBe("ProviderTimeoutError");
  });

  it("degrades to `unknown` when every candidate accessor throws", () => {
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new Error("trap refused");
        },
      },
    );
    expect(() => logErrorKind(hostile)).not.toThrow();
    expect(logErrorKind(hostile)).toBe("unknown");
  });
});

describe("logEndpointHost", () => {
  it("reduces a URL to scheme://host:port", () => {
    expect(logEndpointHost("https://gateway.example:8443/v1/embeddings")).toBe(
      "https://gateway.example:8443",
    );
  });

  it("drops userinfo credentials — a proxy URL routinely carries them", () => {
    const reduced = logEndpointHost("http://proxyuser:hunter2@proxy.internal:3128");
    expect(reduced).toBe("http://proxy.internal:3128");
    expect(reduced).not.toContain("hunter2");
    expect(reduced).not.toContain("proxyuser");
  });

  it("drops the path, query, and fragment where keys and deployment ids ride", () => {
    const reduced = logEndpointHost(
      "https://azure.example/openai/deployments/embed/embeddings?api-key=sk-live-1234#frag",
    );
    expect(reduced).toBe("https://azure.example");
    expect(reduced).not.toContain("sk-live-1234");
    expect(reduced).not.toContain("deployments");
  });

  it("accepts an already-parsed URL", () => {
    expect(logEndpointHost(new URL("https://host.example:9999/x"))).toBe(
      "https://host.example:9999",
    );
  });

  it("returns undefined rather than echoing an unparseable value back", () => {
    expect(logEndpointHost("not a url at all")).toBeUndefined();
    expect(logEndpointHost(undefined)).toBeUndefined();
  });
});

describe("logTimer", () => {
  it("measures a non-negative elapsed span rounded to three decimals", async () => {
    const elapsed = logTimer();
    await Promise.resolve();
    const first = elapsed();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(first)).toBe(true);
    expect(first).toBeCloseTo(Math.round(first * 1000) / 1000, 10);
  });

  it("is monotonic across successive reads of the same timer", async () => {
    const elapsed = logTimer();
    const first = elapsed();
    await Promise.resolve();
    expect(elapsed()).toBeGreaterThanOrEqual(first);
  });
});

describe("a caller-supplied sink is foreign code", () => {
  // The inversion this guards: a logging failure replacing the provider error the operation was
  // about to surface. Every consumer in this package obtains its sink through resolveLogSink, so
  // isolating there covers all of them.
  function throwingSink(): ModelGatewayLogSink {
    return {
      write(): void {
        throw new Error("sink is down");
      },
    };
  }

  it("does not let a throwing sink escape into the caller", () => {
    const sink = resolveLogSink(throwingSink());
    expect(() => {
      sink.write({ level: "info", category: "gateway", op: "gateway.chat.started" });
    }).not.toThrow();
  });

  it("does not let a throwing level predicate decide the request", () => {
    const sink = resolveLogSink({
      write(): void {
        // Accepts writes; only the predicate is hostile.
      },
      enabled(): boolean {
        throw new Error("predicate is down");
      },
    });
    expect(sink.enabled?.("debug")).toBe(true);
  });

  it("reports a dead sink once per instance, not once per line", () => {
    const attempts: string[] = [];
    const sink = resolveLogSink({
      write(event): void {
        attempts.push(event.op);
        if (event.op !== "gateway.log.sink-failed") throw new Error("sink is down");
      },
    });
    for (let index = 0; index < 5; index += 1) {
      sink.write({ level: "info", category: "gateway", op: "gateway.chat.started" });
    }
    // Five dropped lines, exactly one report.
    expect(attempts.filter((op) => op === "gateway.log.sink-failed")).toHaveLength(1);
  });
});
