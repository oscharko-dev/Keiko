// Activity-log coverage for the outbound transport. `gatewayFetch` is where a stuck Keiko run
// most often actually is — a wedged CONNECT, a target the egress policy refuses, a peer the
// default trust store rejects — and none of those distinguish themselves in the thrown error the
// caller sees. Hermetic: every case injects `fetchImpl`, so no socket, DNS lookup, or proxy
// negotiation happens.

import { describe, expect, it } from "vitest";
import { gatewayFetch, OutboundHttpEgressError } from "./http.js";
import type { ModelGatewayLogEvent, ModelGatewayLogSink } from "./observability.js";

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

function respondWith(status: number): typeof fetch {
  return (): Promise<Response> => Promise.resolve(new Response("body-never-logged", { status }));
}

describe("gatewayFetch — activity log", () => {
  // THE ATTEMPT LINE. Every other line in this module is written when the call RETURNS, so a
  // wedged CONNECT or a gateway that accepts the socket and goes quiet produced nothing at all —
  // the log was empty for precisely the window under investigation. `info`, because a line only
  // visible after raising the threshold and reproducing the hang is not evidence of the hang.
  it("writes an attempt line at info before the transport is entered", async () => {
    const log = recorder();
    let opsAtDispatch: readonly string[] = ["<transport never entered>"];
    const observing: typeof fetch = (): Promise<Response> => {
      opsAtDispatch = ops(log.events);
      return Promise.resolve(new Response("", { status: 200 }));
    };
    await gatewayFetch("https://gateway.example:8443/v1/embeddings?key=sk-live", {
      method: "POST",
      body: '{"input":"private document text"}',
      timeoutMs: 4_000,
      fetchImpl: observing,
      log: log.sink,
    });
    expect(opsAtDispatch).toContain("http.gateway.fetch.started");
    const started = eventFor(log.events, "http.gateway.fetch.started");
    expect(started.level).toBe("info");
    expect(started.category).toBe("http");
    expect(started.extra).toMatchObject({
      endpoint: "https://gateway.example:8443",
      method: "POST",
      requestBytes: 33,
      timeoutMs: 4_000,
    });
    // The body is measured, never carried; the query string carried a key.
    expect(JSON.stringify(started)).not.toContain("private document text");
    expect(JSON.stringify(started)).not.toContain("sk-live");
  });

  it("leaves the attempt line readable while a request that never returns is in flight", async () => {
    const log = recorder();
    let entered: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let answer: (response: Response) => void = () => undefined;
    const wedged: typeof fetch = () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
        entered();
      });
    const pending = gatewayFetch("https://gateway.example/v1/x", {
      fetchImpl: wedged,
      log: log.sink,
    });
    await inFlight;
    expect(ops(log.events)).toContain("http.gateway.fetch.started");
    expect(ops(log.events)).not.toContain("http.gateway.fetch.completed");
    answer(new Response("", { status: 200 }));
    await expect(pending).resolves.toMatchObject({ status: 200 });
  });

  it("reports the attempt even for a call the egress policy refuses outright", async () => {
    const log = recorder();
    await expect(
      gatewayFetch("http://127.0.0.1:9/blocked", {
        fetchImpl: respondWith(200),
        egress: { denyLoopback: true },
        log: log.sink,
      }),
    ).rejects.toBeInstanceOf(OutboundHttpEgressError);
    // The attempt is on record BEFORE the policy check runs, so a refusal is a started/failed
    // pair rather than a lone failure with nothing to attribute it to.
    expect(ops(log.events)).toEqual([
      "http.gateway.fetch.started",
      "http.gateway.egress.planned",
      "http.gateway.fetch.failed",
    ]);
  });

  it("reports bytes for a byte body and omits the field for a shape it will not measure", async () => {
    const bytes = recorder();
    await gatewayFetch("https://gateway.example/v1/x", {
      body: new Uint8Array(512),
      fetchImpl: respondWith(200),
      log: bytes.sink,
    });
    expect(eventFor(bytes.events, "http.gateway.fetch.started").extra).toMatchObject({
      requestBytes: 512,
    });

    // A size field must never cost an allocation on the hot path or consume a body to obtain it,
    // so a shape this transport does not send verbatim reports nothing rather than being coerced.
    const other = recorder();
    await gatewayFetch("https://gateway.example/v1/x", {
      body: new URLSearchParams({ q: "x" }),
      fetchImpl: respondWith(200),
      log: other.sink,
    });
    expect(
      eventFor(other.events, "http.gateway.fetch.started").extra?.requestBytes,
    ).toBeUndefined();
  });

  // The port's level predicate, from the transport's side: a sink that declines `debug` must
  // never be handed one — the `logEndpointHost` parse behind the route-planning line is pure waste
  // when nobody is reading at that level.
  it("materialises no debug event at all for a sink that declines debug", async () => {
    const events: ModelGatewayLogEvent[] = [];
    const gated: ModelGatewayLogSink = {
      write: (event): void => {
        events.push(event);
      },
      enabled: (level): boolean => level !== "debug",
    };
    await gatewayFetch("https://gateway.example/v1/x", {
      fetchImpl: respondWith(200),
      log: gated,
    });
    expect(events.map((event) => event.level)).not.toContain("debug");
    // The started/completed pair survives the gate; only the `debug` route-planning line is
    // suppressed. A threshold that erased the successful outcome would take the evidence that
    // requests are flowing with it — see the outcome-level case below.
    expect(ops(events)).toEqual(["http.gateway.fetch.started", "http.gateway.fetch.completed"]);

    const answered: ModelGatewayLogEvent[] = [];
    await gatewayFetch("https://gateway.example/v1/x", {
      fetchImpl: respondWith(503),
      log: {
        write: (event): void => {
          answered.push(event);
        },
        enabled: (level): boolean => level !== "debug",
      },
    });
    // A non-2xx outcome is `warn`, so the gate must still let it through.
    expect(ops(answered)).toContain("http.gateway.fetch.completed");
  });

  it("names the route the call took before it takes it", async () => {
    const log = recorder();
    await gatewayFetch("https://gateway.example:8443/v1/chat/completions?key=sk-live", {
      fetchImpl: respondWith(200),
      log: log.sink,
    });
    const planned = eventFor(log.events, "http.gateway.egress.planned");
    expect(planned.level).toBe("debug");
    expect(planned.category).toBe("http");
    expect(planned.extra).toMatchObject({
      endpoint: "https://gateway.example:8443",
      proxied: false,
      transport: "injected",
    });
    // The query string carried a key; it must not reach the line.
    expect(JSON.stringify(planned)).not.toContain("sk-live");
  });

  // THE LEVEL OF A SUCCESS IS THE POINT. At `debug` this line was invisible at the default `info`
  // threshold, so a healthy outbound request wrote nothing at all and an operator watching a run
  // that appears frozen could not distinguish "requests are flowing" from "nothing is being sent"
  // — the first question of the field incident. Only the completion answers it: the attempt line
  // is written whether or not the socket ever answers.
  it("logs a 2xx outcome at info and a non-2xx outcome at warn, with the status", async () => {
    const okLog = recorder();
    await gatewayFetch("https://gateway.example/v1/x", {
      fetchImpl: respondWith(200),
      log: okLog.sink,
    });
    const completed = eventFor(okLog.events, "http.gateway.fetch.completed");
    expect(completed.level).toBe("info");
    expect(completed.status).toBe(200);
    expect(typeof completed.durationMs).toBe("number");

    const errLog = recorder();
    await gatewayFetch("https://gateway.example/v1/x", {
      fetchImpl: respondWith(503),
      log: errLog.sink,
    });
    const answered = eventFor(errLog.events, "http.gateway.fetch.completed");
    expect(answered.level).toBe("warn");
    expect(answered.status).toBe(503);
  });

  // CORRELATION. With N requests in flight against one endpoint the lines are interleaved, so
  // "which of these is the one that never came back" is unanswerable from endpoint and method
  // alone — every line of a call has to name the operation that issued it.
  it("carries the caller's correlation id on every line of a call", async () => {
    const log = recorder();
    await gatewayFetch("https://gateway.example/v1/embeddings", {
      method: "POST",
      body: "{}",
      fetchImpl: respondWith(200),
      log: log.sink,
      logContext: { correlationId: "run-42" },
    });
    expect(log.events.length).toBeGreaterThan(1);
    expect(log.events.map((event) => event.correlationId)).toEqual(log.events.map(() => "run-42"));
    expect(ops(log.events)).toContain("http.gateway.fetch.completed");
  });

  it("carries the correlation id on a fail-closed refusal and on a transport rejection", async () => {
    const refused = recorder();
    await expect(
      gatewayFetch("http://127.0.0.1:9/blocked", {
        fetchImpl: respondWith(200),
        egress: { denyLoopback: true },
        log: refused.sink,
        logContext: { correlationId: "run-43" },
      }),
    ).rejects.toBeInstanceOf(OutboundHttpEgressError);
    expect(eventFor(refused.events, "http.gateway.fetch.failed").correlationId).toBe("run-43");

    const broken = recorder();
    const failing: typeof fetch = () => Promise.reject(new Error("no route"));
    await expect(
      gatewayFetch("https://gateway.example/v1/x", {
        fetchImpl: failing,
        log: broken.sink,
        logContext: { correlationId: "run-44" },
      }),
    ).rejects.toThrow();
    expect(eventFor(broken.events, "http.gateway.fetch.failed").correlationId).toBe("run-44");
  });

  it("leaves the lines uncorrelated when the caller supplies no context", async () => {
    const log = recorder();
    await gatewayFetch("https://gateway.example/v1/x", {
      fetchImpl: respondWith(200),
      log: log.sink,
    });
    expect(log.events.map((event) => event.correlationId)).toEqual(log.events.map(() => undefined));
  });

  // BYTES, not UTF-16 code units. The field is read against a gateway's request-size limit, and an
  // embedding body is document text: for a CJK or accented corpus `String.length` under-reports
  // what is actually sent, which is the difference between a body under the limit and one over it.
  it("reports the UTF-8 byte length of a text body, not its character count", async () => {
    const log = recorder();
    // 3 bytes per ideograph, 2 per umlaut: 12 characters, 26 bytes.
    const body = '{"input":"日本語テキスト über"}';
    expect(body.length).toBeLessThan(Buffer.byteLength(body, "utf8"));
    await gatewayFetch("https://gateway.example/v1/embeddings", {
      method: "POST",
      body,
      fetchImpl: respondWith(200),
      log: log.sink,
    });
    expect(eventFor(log.events, "http.gateway.fetch.started").extra).toMatchObject({
      requestBytes: Buffer.byteLength(body, "utf8"),
    });
  });

  it("never writes the response body into the line", async () => {
    const log = recorder();
    await gatewayFetch("https://gateway.example/v1/x", {
      fetchImpl: respondWith(500),
      log: log.sink,
    });
    expect(JSON.stringify(log.events)).not.toContain("body-never-logged");
  });

  it("carries the egress taxonomy code for a fail-closed target refusal", async () => {
    const log = recorder();
    await expect(
      gatewayFetch("http://127.0.0.1:9/blocked", {
        fetchImpl: respondWith(200),
        egress: { denyLoopback: true },
        log: log.sink,
      }),
    ).rejects.toBeInstanceOf(OutboundHttpEgressError);
    const failed = eventFor(log.events, "http.gateway.fetch.failed");
    expect(failed.level).toBe("warn");
    expect(failed.errorKind).toBe("PROXY_BLOCKED_BY_POLICY");
    expect(failed.extra).toMatchObject({ endpoint: "http://127.0.0.1:9" });
    expect(ops(log.events)).not.toContain("http.gateway.fetch.completed");
  });

  it("labels a transport rejection with the error kind and no message text", async () => {
    const log = recorder();
    const failing: typeof fetch = () =>
      Promise.reject(
        Object.assign(new Error("connect ECONNREFUSED sk-in-message"), {
          code: "ECONNREFUSED",
        }),
      );
    await expect(
      gatewayFetch("https://gateway.example/v1/x", { fetchImpl: failing, log: log.sink }),
    ).rejects.toThrow();
    const failed = eventFor(log.events, "http.gateway.fetch.failed");
    expect(failed.errorKind).toBe("ECONNREFUSED");
    expect(JSON.stringify(failed)).not.toContain("sk-in-message");
  });

  it("stays silent — and behaviourally identical — when no sink is wired", async () => {
    const response = await gatewayFetch("https://gateway.example/v1/x", {
      fetchImpl: respondWith(200),
    });
    expect(response.status).toBe(200);
    await expect(
      gatewayFetch("http://127.0.0.1:9/blocked", {
        fetchImpl: respondWith(200),
        egress: { denyLoopback: true },
      }),
    ).rejects.toBeInstanceOf(OutboundHttpEgressError);
  });

  it("does not leak the sink into the RequestInit handed to the transport", async () => {
    const log = recorder();
    let seenInit: RequestInit | undefined;
    const capturing: typeof fetch = (_input, init): Promise<Response> => {
      seenInit = init;
      return Promise.resolve(new Response("", { status: 200 }));
    };
    await gatewayFetch("https://gateway.example/v1/x", {
      fetchImpl: capturing,
      log: log.sink,
      logContext: { correlationId: "corr-init" },
    });
    expect(seenInit).toBeDefined();
    expect(seenInit).not.toHaveProperty("log");
    expect(seenInit).not.toHaveProperty("fetchImpl");
    // A correlation id is a local diagnostic handle, never wire data.
    expect(seenInit).not.toHaveProperty("logContext");
    expect(JSON.stringify(seenInit)).not.toContain("corr-init");
  });
});
