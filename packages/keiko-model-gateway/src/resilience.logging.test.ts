// Activity-log coverage for the retry loop and the circuit breaker. Both are pure decision
// machines over an injected Clock, so every assertion here is deterministic and instant — no
// sleeping, no wall-clock reads, no shared state between cases.

import { describe, expect, it } from "vitest";
import {
  CancelledError,
  ProviderError,
  RateLimitError,
  TransportError,
} from "@oscharko-dev/keiko-security/errors/gateway";
import { CircuitBreaker, executeWithRetry } from "./resilience.js";
import type { ModelGatewayLogEvent, ModelGatewayLogSink } from "./observability.js";
import type { CircuitBreakerConfig, Clock } from "./types.js";

interface Recorder {
  readonly sink: ModelGatewayLogSink;
  readonly events: ModelGatewayLogEvent[];
}

function recorder(): Recorder {
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

function ops(events: readonly ModelGatewayLogEvent[]): readonly string[] {
  return events.map((event) => event.op);
}

function eventFor(events: readonly ModelGatewayLogEvent[], op: string): ModelGatewayLogEvent {
  const found = events.find((event) => event.op === op);
  if (found === undefined) {
    throw new Error(`expected an event with op '${op}', saw: ${ops(events).join(", ")}`);
  }
  return found;
}

function stubClock(): Clock {
  let current = 0;
  return {
    now: (): number => (current += 1),
    sleep: (): Promise<void> => Promise.resolve(),
  };
}

const RETRY_CONFIG = { maxRetries: 2, retryBaseDelayMs: 10 } as const;

describe("executeWithRetry — activity log", () => {
  it("writes one scheduled line per backoff and an exhausted line when retries run out", async () => {
    const log = recorder();
    const attempt = (): Promise<never> => Promise.reject(new TransportError("upstream reset"));
    await expect(
      executeWithRetry(attempt, RETRY_CONFIG, stubClock(), undefined, () => 0.5, {
        sink: log.sink,
        modelId: "example-chat-model",
        correlationId: "corr-1",
      }),
    ).rejects.toBeInstanceOf(TransportError);

    expect(ops(log.events)).toEqual([
      "gateway.retry.scheduled",
      "gateway.retry.scheduled",
      "gateway.retry.exhausted",
    ]);
    const scheduled = eventFor(log.events, "gateway.retry.scheduled");
    expect(scheduled.category).toBe("gateway");
    expect(scheduled.level).toBe("warn");
    expect(scheduled.correlationId).toBe("corr-1");
    expect(scheduled.errorKind).toBe("GATEWAY_TRANSPORT");
    expect(scheduled.extra).toMatchObject({
      modelId: "example-chat-model",
      attempt: 1,
      maxRetries: 2,
    });
    expect(typeof scheduled.extra?.delayMs).toBe("number");
    // TransportError carries neither an HTTP status nor a server-supplied retry delay, so
    // providerErrorDetail() must contribute nothing here — pinning the negative case keeps the
    // positive ones below honest.
    expect(scheduled.extra?.httpStatus).toBeUndefined();
    expect(scheduled.extra?.retryAfterMs).toBeUndefined();
  });

  it("carries the provider's httpStatus on both the scheduled and exhausted retry lines", async () => {
    const log = recorder();
    const attempt = (): Promise<never> =>
      Promise.reject(new ProviderError("upstream overloaded", 503));
    await expect(
      executeWithRetry(attempt, RETRY_CONFIG, stubClock(), undefined, () => 0.5, {
        sink: log.sink,
        modelId: "example-chat-model",
      }),
    ).rejects.toBeInstanceOf(ProviderError);

    const scheduledLines = log.events.filter((event) => event.op === "gateway.retry.scheduled");
    expect(scheduledLines).toHaveLength(2);
    for (const line of scheduledLines) {
      expect(line.extra?.httpStatus).toBe(503);
      expect(line.extra?.retryAfterMs).toBeUndefined();
    }
    const exhausted = eventFor(log.events, "gateway.retry.exhausted");
    expect(exhausted.extra?.httpStatus).toBe(503);
    expect(exhausted.extra?.retryAfterMs).toBeUndefined();
  });

  it("carries the provider's retryAfterMs and httpStatus=429 on both the scheduled and exhausted retry lines", async () => {
    const log = recorder();
    const attempt = (): Promise<never> => Promise.reject(new RateLimitError("slow down", 1_500));
    await expect(
      executeWithRetry(
        attempt,
        { maxRetries: 1, retryBaseDelayMs: 10 },
        stubClock(),
        undefined,
        () => 0.5,
        {
          sink: log.sink,
        },
      ),
    ).rejects.toBeInstanceOf(RateLimitError);

    const scheduled = eventFor(log.events, "gateway.retry.scheduled");
    expect(scheduled.extra?.retryAfterMs).toBe(1_500);
    // A rate limit is always HTTP 429 by definition — RateLimitError carries httpStatus too, so a
    // consumer never has to infer the status from errorKind === GATEWAY_RATE_LIMIT alone.
    expect(scheduled.extra?.httpStatus).toBe(429);
    const exhausted = eventFor(log.events, "gateway.retry.exhausted");
    expect(exhausted.extra?.retryAfterMs).toBe(1_500);
    expect(exhausted.extra?.httpStatus).toBe(429);
  });

  it("labels the terminal attempt with the attempt number it gave up on", async () => {
    const log = recorder();
    const attempt = (): Promise<never> => Promise.reject(new TransportError("upstream reset"));
    await expect(
      executeWithRetry(attempt, RETRY_CONFIG, stubClock(), undefined, () => 0.5, {
        sink: log.sink,
      }),
    ).rejects.toBeInstanceOf(TransportError);
    expect(eventFor(log.events, "gateway.retry.exhausted").extra).toMatchObject({
      attempt: 3,
      maxRetries: 2,
    });
  });

  it("writes nothing at all when the first attempt succeeds", async () => {
    const log = recorder();
    const result = await executeWithRetry(
      () => Promise.resolve("ok"),
      RETRY_CONFIG,
      stubClock(),
      undefined,
      () => 0.5,
      { sink: log.sink },
    );
    expect(result).toBe("ok");
    expect(log.events).toEqual([]);
  });

  it("writes an exhausted line — not a scheduled one — for a terminal (non-retryable) error", async () => {
    const log = recorder();
    const attempt = (): Promise<never> => Promise.reject(new CancelledError("client went away"));
    await expect(
      executeWithRetry(attempt, RETRY_CONFIG, stubClock(), undefined, () => 0.5, {
        sink: log.sink,
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(ops(log.events)).toEqual(["gateway.retry.exhausted"]);
    expect(eventFor(log.events, "gateway.retry.exhausted").extra).toMatchObject({ attempt: 1 });
  });

  it("distinguishes a spent deadline from a failing provider on the budget-exhausted line", async () => {
    const log = recorder();
    // A clock that jumps past the whole budget on its second read, so the SECOND loop turn finds
    // no budget left. The first turn already failed, so `hadPriorFailure` must be true.
    // Reads 1-3 (start, first attempt budget, post-failure remaining budget) stay inside the
    // window so attempt 1 actually runs and fails; read 4 — the second turn's budget check —
    // lands past it.
    let reads = 0;
    const clock: Clock = {
      now: (): number => {
        reads += 1;
        return reads <= 3 ? 0 : 10_000;
      },
      sleep: (): Promise<void> => Promise.resolve(),
    };
    const attempt = (): Promise<never> => Promise.reject(new RateLimitError("slow down", 5));
    await expect(
      executeWithRetry(
        attempt,
        { maxRetries: 3, retryBaseDelayMs: 1, timeoutMs: 1000 },
        clock,
        undefined,
        () => 0.5,
        { sink: log.sink, modelId: "m" },
      ),
    ).rejects.toBeInstanceOf(RateLimitError);
    const budget = eventFor(log.events, "gateway.retry.budget-exhausted");
    expect(budget.level).toBe("warn");
    expect(budget.errorKind).toBe("GATEWAY_RATE_LIMIT");
    expect(budget.extra).toMatchObject({
      modelId: "m",
      hadPriorFailure: true,
      retryAfterMs: 5,
    });
    // A rate limit is always HTTP 429 by definition — RateLimitError carries httpStatus too.
    expect(budget.extra?.httpStatus).toBe(429);
  });

  it("carries the provider's httpStatus on the budget-exhausted line", async () => {
    const log = recorder();
    // Same clock-jump shape as above: attempt 1 runs and fails inside the budget, the second
    // turn's budget check lands past it.
    let reads = 0;
    const clock: Clock = {
      now: (): number => {
        reads += 1;
        return reads <= 3 ? 0 : 10_000;
      },
      sleep: (): Promise<void> => Promise.resolve(),
    };
    const attempt = (): Promise<never> => Promise.reject(new ProviderError("overloaded", 503));
    await expect(
      executeWithRetry(
        attempt,
        { maxRetries: 3, retryBaseDelayMs: 1, timeoutMs: 1000 },
        clock,
        undefined,
        () => 0.5,
        { sink: log.sink, modelId: "m" },
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    const budget = eventFor(log.events, "gateway.retry.budget-exhausted");
    expect(budget.extra?.httpStatus).toBe(503);
    expect(budget.extra?.retryAfterMs).toBeUndefined();
  });

  it("stays silent — and behaviourally identical — when no sink is wired", async () => {
    const attempt = (): Promise<never> => Promise.reject(new TransportError("upstream reset"));
    await expect(
      executeWithRetry(attempt, RETRY_CONFIG, stubClock(), undefined, () => 0.5),
    ).rejects.toBeInstanceOf(TransportError);
  });
});

const BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 2,
  cooldownMs: 1000,
  halfOpenProbes: 1,
};

describe("CircuitBreaker — activity log", () => {
  it("names the transition when the breaker trips, including the failure count that did it", () => {
    const log = recorder();
    const clock = stubClock();
    const breaker = new CircuitBreaker("m", BREAKER_CONFIG, clock, log.sink);
    breaker.recordFailure();
    expect(log.events).toEqual([]);
    breaker.recordFailure();
    const opened = eventFor(log.events, "gateway.circuit.opened");
    expect(opened.level).toBe("warn");
    expect(opened.category).toBe("gateway");
    expect(opened.extra).toMatchObject({
      modelId: "m",
      previousState: "closed",
      consecutiveFailures: 2,
      cooldownMs: 1000,
    });
  });

  // While the breaker is open EVERY caller is refused, so one fact — "the breaker for model m is
  // open" — used to become one `warn` line per call: the highest-volume, lowest-information point
  // of an outage, drowning the transitions that carry the news and pushing the lines from BEFORE
  // the outage out of retention. The first refusal after a transition still reports at `warn`; the
  // rest are demoted to `debug` and counted.
  it("reports the first refusal at warn and demotes the repeats to debug", () => {
    const log = recorder();
    let now = 0;
    const clock: Clock = { now: () => now, sleep: () => Promise.resolve() };
    const breaker = new CircuitBreaker("m", BREAKER_CONFIG, clock, log.sink);
    breaker.recordFailure();
    breaker.recordFailure();
    for (let call = 0; call < 5; call += 1) {
      now += 10;
      expect(() => {
        breaker.assertAllowed();
      }).toThrow();
    }
    const rejections = log.events.filter((event) => event.op === "gateway.circuit.rejected");
    expect(rejections).toHaveLength(5);
    expect(rejections.map((event) => event.level)).toEqual([
      "warn",
      "debug",
      "debug",
      "debug",
      "debug",
    ]);
    expect(rejections[0]?.extra).toMatchObject({
      modelId: "m",
      state: "open",
      reason: "cooldown",
      rejectedSinceTransition: 1,
    });
    // The count is what makes the demotion lossless: the volume is still reported, as a number.
    expect(rejections.at(-1)?.extra).toMatchObject({ rejectedSinceTransition: 5 });
  });

  // The demotion must be a real saving, not a relabelling: for a sink that declines `debug`,
  // a repeat refusal must not allocate an event at all.
  it("writes nothing beyond the first refusal for a sink that declines debug", () => {
    const events: ModelGatewayLogEvent[] = [];
    let now = 0;
    const clock: Clock = { now: () => now, sleep: () => Promise.resolve() };
    const breaker = new CircuitBreaker("m", BREAKER_CONFIG, clock, {
      write: (event): void => {
        events.push(event);
      },
      enabled: (level): boolean => level !== "debug",
    });
    breaker.recordFailure();
    breaker.recordFailure();
    for (let call = 0; call < 50; call += 1) {
      expect(() => {
        breaker.assertAllowed();
      }).toThrow();
    }
    expect(events.filter((event) => event.op === "gateway.circuit.rejected")).toHaveLength(1);
    // …and the volume it absorbed still surfaces, once, on the transition that ends the window.
    now = 2000;
    breaker.assertAllowed();
    expect(eventFor(events, "gateway.circuit.half-open").extra).toMatchObject({
      rejectedWhileOpen: 50,
    });
  });

  // A new window is a new rate-limit window: the operator must be told again, at warn, that calls
  // are being refused, rather than the counter staying latched from the previous outage — and the
  // count each window absorbed rides the transition that ENDS it, on every transition, not just
  // the recovery one.
  it("resets the budget on each transition and rolls the count onto the line that ends the window", () => {
    const log = recorder();
    let now = 0;
    const clock: Clock = { now: () => now, sleep: () => Promise.resolve() };
    const breaker = new CircuitBreaker("m", BREAKER_CONFIG, clock, log.sink);
    breaker.recordFailure();
    breaker.recordFailure();
    for (let call = 0; call < 3; call += 1) {
      expect(() => {
        breaker.assertAllowed();
      }).toThrow();
    }
    now = 2000;
    breaker.assertAllowed();
    expect(eventFor(log.events, "gateway.circuit.half-open").extra).toMatchObject({
      rejectedWhileOpen: 3,
    });
    // Half-open with its single probe already in flight: this refusal opens a fresh window.
    expect(() => {
      breaker.assertAllowed();
    }).toThrow();
    breaker.recordFailure();
    const opened = log.events.filter((event) => event.op === "gateway.circuit.opened");
    expect(opened.at(-1)?.extra).toMatchObject({
      previousState: "half-open",
      rejectedSincePreviousTransition: 1,
    });
    const rejections = log.events.filter((event) => event.op === "gateway.circuit.rejected");
    // First of the open window, two demoted repeats, then the first of the half-open window.
    expect(rejections.map((event) => event.level)).toEqual(["warn", "debug", "debug", "warn"]);
    expect(rejections.map((event) => event.extra?.rejectedSinceTransition)).toEqual([1, 2, 3, 1]);
  });

  it("records the half-open probe window and the close that ends it", () => {
    const log = recorder();
    let now = 0;
    const clock: Clock = { now: () => now, sleep: () => Promise.resolve() };
    const breaker = new CircuitBreaker("m", BREAKER_CONFIG, clock, log.sink);
    breaker.recordFailure();
    breaker.recordFailure();
    now = 2000;
    breaker.assertAllowed();
    expect(eventFor(log.events, "gateway.circuit.half-open").extra).toMatchObject({
      modelId: "m",
      probes: 1,
    });
    breaker.recordSuccess();
    expect(eventFor(log.events, "gateway.circuit.closed").extra).toMatchObject({
      previousState: "half-open",
    });
    expect(breaker.status("m").state).toBe("closed");
  });

  it("separates a probe-saturation refusal from a cooldown refusal", () => {
    const log = recorder();
    let now = 0;
    const clock: Clock = { now: () => now, sleep: () => Promise.resolve() };
    const breaker = new CircuitBreaker(
      "m",
      { ...BREAKER_CONFIG, halfOpenProbes: 1 },
      clock,
      log.sink,
    );
    breaker.recordFailure();
    breaker.recordFailure();
    now = 2000;
    breaker.assertAllowed();
    expect(() => {
      breaker.assertAllowed();
    }).toThrow();
    const saturated = log.events.filter(
      (event) => event.op === "gateway.circuit.rejected" && event.extra?.state === "half-open",
    );
    expect(saturated).toHaveLength(1);
    expect(saturated[0]?.extra).toMatchObject({
      reason: "probe-saturated",
      probesInFlight: 1,
    });
  });

  it("stays silent when no sink is wired", () => {
    const clock = stubClock();
    const breaker = new CircuitBreaker("m", BREAKER_CONFIG, clock);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(() => {
      breaker.assertAllowed();
    }).toThrow();
  });
});

// A breaker is shared by every caller of a model, so "some request was refused" is not an answer
// when N requests are in flight against one endpoint. The refusal line names the call that was
// refused, when the caller has an id; the transitions name the call that tipped them.
describe("CircuitBreaker — caller correlation", () => {
  it("names the refused call, and the call that tripped the breaker", () => {
    const log = recorder();
    const clock: Clock = { now: () => 0, sleep: () => Promise.resolve() };
    const breaker = new CircuitBreaker("m", BREAKER_CONFIG, clock, log.sink);
    breaker.recordFailure("run-1");
    breaker.recordFailure("run-2");
    expect(eventFor(log.events, "gateway.circuit.opened").correlationId).toBe("run-2");
    expect(() => {
      breaker.assertAllowed("run-3");
    }).toThrow();
    const rejected = eventFor(log.events, "gateway.circuit.rejected");
    expect(rejected.correlationId).toBe("run-3");
    expect(rejected.extra).toMatchObject({ modelId: "m", state: "open", reason: "cooldown" });
  });

  it("leaves the lines uncorrelated for a caller that supplies no id", () => {
    const log = recorder();
    const breaker = new CircuitBreaker("m", BREAKER_CONFIG, stubClock(), log.sink);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(eventFor(log.events, "gateway.circuit.opened").correlationId).toBeUndefined();
  });
});
