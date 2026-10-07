// Tests for the fault-injecting proxy of the Coding Workbench live lab
// (scripts/testing/coding-workbench-lab/chaos-proxy.mjs): the validation of a control body, the
// fault state, every fault mode against a real loopback upstream, and the teardown of a call whose
// client went away. The proxy's timers are injected, so no test waits for a configured delay, and
// every wait is on an event (a log line, a socket close, a scheduled timer), never on the clock.

import { Buffer } from "node:buffer";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  checkChaosSpec,
  createChaosProxy,
  createChaosState,
} from "../testing/coding-workbench-lab/chaos-proxy.mjs";

const SERVERS = [];
const CALLS = [];

afterEach(() => {
  while (CALLS.length > 0) CALLS.pop().destroy();
  while (SERVERS.length > 0) {
    const server = SERVERS.pop();
    server.close();
    server.closeAllConnections();
  }
});

async function listen(server) {
  SERVERS.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

/** A message sink that lets a test await the next line matching a pattern. */
function recorder() {
  const messages = [];
  const waiters = [];
  return {
    messages,
    write(message) {
      messages.push(message);
      for (const waiter of waiters.splice(0)) {
        if (waiter.pattern.test(message)) waiter.resolve(message);
        else waiters.push(waiter);
      }
    },
    next(pattern) {
      const seen = messages.find((message) => pattern.test(message));
      if (seen !== undefined) return Promise.resolve(seen);
      return new Promise((resolve) => waiters.push({ pattern, resolve }));
    },
  };
}

/** Injected timers: nothing fires until the test fires it. */
function fakeTimers() {
  const scheduled = [];
  const cleared = [];
  const waiting = [];
  return {
    scheduled,
    cleared,
    set(callback, ms) {
      const handle = { callback, ms };
      scheduled.push(handle);
      for (const resolve of waiting.splice(0)) resolve(handle);
      return handle;
    },
    clear(handle) {
      cleared.push(handle);
    },
    firstScheduled() {
      if (scheduled.length > 0) return Promise.resolve(scheduled[0]);
      return new Promise((resolve) => waiting.push(resolve));
    },
  };
}

/** A loopback model server; `handler` answers each request once its body has arrived. */
async function startUpstream(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const entry = {
        method: req.method,
        url: req.url,
        host: req.headers.host,
        body: Buffer.concat(chunks).toString("utf8"),
        req,
        res,
      };
      seen.push(entry);
      handler(entry);
    });
  });
  return { seen, port: await listen(server) };
}

async function startProxy({ upstreamPort, state = createChaosState(), timers }) {
  const logs = recorder();
  const errors = recorder();
  const server = createChaosProxy({
    upstream: { host: "127.0.0.1", port: upstreamPort },
    state,
    log: (message) => logs.write(message),
    logError: (message) => errors.write(message),
    ...(timers === undefined ? {} : { timers }),
  });
  return { port: await listen(server), state, logs, errors };
}

/** One client call; `closed` settles when its connection is gone, with or without a response. */
function openCall(
  port,
  {
    method = "POST",
    path = "/v1/chat/completions",
    body = method === "GET" ? undefined : "{}",
    headers,
  } = {},
) {
  const chunks = [];
  const waiting = [];
  const call = {
    status: undefined,
    headers: undefined,
    complete: undefined,
    bytes: () => Buffer.concat(chunks).length,
    body: () => Buffer.concat(chunks).toString("utf8"),
    untilBytes(count) {
      if (call.bytes() >= count) return Promise.resolve();
      return new Promise((resolve) => waiting.push({ count, resolve }));
    },
    destroy: () => call.request.destroy(),
  };
  call.closed = new Promise((resolve) => {
    call.request = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      call.status = res.statusCode;
      call.headers = res.headers;
      res.on("data", (chunk) => {
        chunks.push(chunk);
        for (const waiter of waiting.splice(0)) {
          if (call.bytes() >= waiter.count) waiter.resolve();
          else waiting.push(waiter);
        }
      });
      res.on("error", () => undefined);
      res.on("close", () => {
        call.complete = res.complete;
        resolve();
      });
    });
    call.request.on("error", () => resolve());
  });
  call.request.end(body);
  CALLS.push(call);
  return call;
}

const echoUpstream = (extra = {}) =>
  startUpstream(({ res, body, host, method }) => {
    res.writeHead(200, { "content-type": "application/json", "x-upstream": "yes", ...extra });
    res.end(JSON.stringify({ body, host, method }));
  });

describe("checkChaosSpec", () => {
  it("accepts every mode and keeps only the closed field set", () => {
    for (const mode of ["pass", "status", "latency", "drop", "stall", "hang"]) {
      expect(checkChaosSpec({ mode })).toEqual({ spec: { mode } });
    }
    expect(
      checkChaosSpec({
        mode: "status",
        status: 503,
        count: 2,
        probability: 0.5,
        delayMs: 1,
        afterBytes: 0,
        stallMs: 2,
        durationMs: 3,
        injected: "never copied",
      }),
    ).toEqual({
      spec: {
        mode: "status",
        status: 503,
        count: 2,
        probability: 0.5,
        delayMs: 1,
        afterBytes: 0,
        stallMs: 2,
        durationMs: 3,
      },
    });
  });

  it("answers a closed reason for anything that is not a fault description", () => {
    for (const value of [null, undefined, 7, "status", [], {}, { mode: "explode" }]) {
      expect(checkChaosSpec(value)).toEqual({ reason: "invalid-mode" });
    }
  });

  it("names the first field that is out of range, not an integer or not a number", () => {
    const cases = [
      [{ mode: "status", status: 399 }, "invalid-status"],
      [{ mode: "status", status: 600 }, "invalid-status"],
      [{ mode: "status", status: 503.5 }, "invalid-status"],
      [{ mode: "status", count: -1 }, "invalid-count"],
      [{ mode: "status", count: 1.5 }, "invalid-count"],
      [{ mode: "status", probability: 1.5 }, "invalid-probability"],
      [{ mode: "latency", delayMs: -1 }, "invalid-delayMs"],
      [{ mode: "drop", afterBytes: 1.5 }, "invalid-afterBytes"],
      [{ mode: "stall", stallMs: 2_147_483_648 }, "invalid-stallMs"],
      [{ mode: "status", durationMs: "180000" }, "invalid-durationMs"],
      [{ mode: "status", durationMs: Number.NaN }, "invalid-durationMs"],
    ];
    for (const [value, reason] of cases) expect(checkChaosSpec(value)).toEqual({ reason });
  });
});

describe("createChaosState", () => {
  it("passes everything until a fault is set, and counts what it forwards", () => {
    const state = createChaosState();
    expect(state.consume()).toBeUndefined();
    state.countForwarded();
    expect(state.snapshot()).toEqual({
      chaos: { mode: "pass" },
      remainingMs: undefined,
      stats: { forwarded: 1, injected: 0, byMode: {} },
    });
  });

  it("injects the fault `count` times and then falls back to pass, without touching the caller's spec", () => {
    const state = createChaosState();
    const spec = { mode: "status", status: 503, count: 2 };
    state.set(spec);
    expect(state.consume()).toMatchObject({ mode: "status", status: 503 });
    expect(state.consume()).toMatchObject({ mode: "status", status: 503 });
    expect(state.consume()).toBeUndefined();
    expect(spec.count).toBe(2);
    expect(state.snapshot().chaos).toEqual({ mode: "pass" });
    expect(state.snapshot().stats).toMatchObject({ injected: 2, byMode: { status: 2 } });
  });

  it("holds a fault for `durationMs` and then resets it", () => {
    let now = 1000;
    const state = createChaosState({ now: () => now });
    state.set({ mode: "status", status: 503, durationMs: 500 });
    now = 1200;
    expect(state.snapshot().remainingMs).toBe(300);
    expect(state.consume()).toMatchObject({ mode: "status" });
    expect(state.consume()).toMatchObject({ mode: "status" });
    now = 1500;
    expect(state.snapshot().remainingMs).toBe(0);
    expect(state.consume()).toBeUndefined();
    expect(state.snapshot()).toMatchObject({ chaos: { mode: "pass" }, remainingMs: undefined });
  });

  it("injects with the given probability and only counts what it injected", () => {
    let draw = 0.9;
    const state = createChaosState({ random: () => draw });
    state.set({ mode: "status", probability: 0.5, count: 1 });
    expect(state.consume()).toBeUndefined();
    draw = 0.1;
    expect(state.consume()).toMatchObject({ mode: "status" });
    expect(state.consume()).toBeUndefined();
    expect(state.snapshot().stats.injected).toBe(1);
  });
});

describe("the proxy forwards unchanged and injects faults only into model calls", () => {
  it("forwards a call as it is, with the host header of the model server, and counts it", async () => {
    const upstream = await echoUpstream();
    const proxy = await startProxy({ upstreamPort: upstream.port });
    const call = openCall(proxy.port, { body: '{"a":1}' });
    await call.closed;
    expect(call.status).toBe(200);
    expect(call.headers["x-upstream"]).toBe("yes");
    expect(JSON.parse(call.body())).toEqual({
      body: '{"a":1}',
      host: `127.0.0.1:${String(upstream.port)}`,
      method: "POST",
    });
    expect(proxy.state.snapshot().stats).toMatchObject({ forwarded: 1, injected: 0 });
  });

  it("answers the next calls with the status in the OpenAI error shape, then passes", async () => {
    const upstream = await echoUpstream();
    const state = createChaosState();
    state.set({ mode: "status", status: 503, count: 2 });
    const proxy = await startProxy({ upstreamPort: upstream.port, state });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const call = openCall(proxy.port);
      await call.closed;
      expect(call.status).toBe(503);
      expect(JSON.parse(call.body())).toEqual({
        error: { message: "chaos 503", type: "server_error" },
      });
    }
    const third = openCall(proxy.port);
    await third.closed;
    expect(third.status).toBe(200);
    expect(upstream.seen).toHaveLength(1);
    expect(proxy.state.snapshot().stats).toMatchObject({ injected: 2, byMode: { status: 2 } });
  });

  it("uses 503 when the fault names no status, and the status it names otherwise", async () => {
    const upstream = await echoUpstream();
    const state = createChaosState();
    const proxy = await startProxy({ upstreamPort: upstream.port, state });
    state.set({ mode: "status", count: 1 });
    const defaulted = openCall(proxy.port);
    await defaulted.closed;
    expect(defaulted.status).toBe(503);
    state.set({ mode: "status", status: 429, count: 1 });
    const throttled = openCall(proxy.port);
    await throttled.closed;
    expect(throttled.status).toBe(429);
  });

  it("leaves every other call alone while a fault is active", async () => {
    const upstream = await echoUpstream();
    const state = createChaosState();
    state.set({ mode: "status", status: 503, durationMs: 60_000 });
    const proxy = await startProxy({ upstreamPort: upstream.port, state });
    const listing = openCall(proxy.port, { method: "GET", path: "/v1/models", body: undefined });
    const embeddings = openCall(proxy.port, { path: "/v1/embeddings" });
    const completions = openCall(proxy.port);
    await Promise.all([listing.closed, embeddings.closed, completions.closed]);
    expect([listing.status, embeddings.status, completions.status]).toEqual([200, 200, 503]);
    expect(upstream.seen.map((entry) => entry.url)).toEqual(
      expect.arrayContaining(["/v1/models", "/v1/embeddings"]),
    );
  });

  it("injects the status only at the drawn probability", async () => {
    const upstream = await echoUpstream();
    let draw = 0.9;
    const state = createChaosState({ random: () => draw });
    state.set({ mode: "status", probability: 0.5 });
    const proxy = await startProxy({ upstreamPort: upstream.port, state });
    const passed = openCall(proxy.port);
    await passed.closed;
    draw = 0.1;
    const failed = openCall(proxy.port);
    await failed.closed;
    expect([passed.status, failed.status]).toEqual([200, 503]);
  });
});

describe("the proxy cuts a response", () => {
  const bodyUpstream = () =>
    startUpstream(({ res }) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("x".repeat(1000));
    });

  it("drops the connection after the given bytes, which reach the client first", async () => {
    const upstream = await bodyUpstream();
    const state = createChaosState();
    state.set({ mode: "drop", afterBytes: 400, count: 1 });
    const proxy = await startProxy({ upstreamPort: upstream.port, state });
    const call = openCall(proxy.port);
    await call.closed;
    expect(call.status).toBe(200);
    expect(call.bytes()).toBe(400);
    expect(call.complete).toBe(false);
    expect(proxy.logs.messages).toContain("drop after 400 bytes");
  });

  it("drops a response whose cut is at the start before it sends a body byte", async () => {
    const upstream = await bodyUpstream();
    const state = createChaosState();
    state.set({ mode: "drop", afterBytes: 0, count: 1 });
    const proxy = await startProxy({ upstreamPort: upstream.port, state });
    const call = openCall(proxy.port);
    await call.closed;
    expect(call.bytes()).toBe(0);
    expect(call.complete).not.toBe(true);
  });

  it("stalls after the given bytes, stays silent and open, then closes when the stall ends", async () => {
    const upstream = await bodyUpstream();
    const timers = fakeTimers();
    const state = createChaosState();
    state.set({ mode: "stall", afterBytes: 100, stallMs: 7000, count: 1 });
    const proxy = await startProxy({ upstreamPort: upstream.port, state, timers });
    const call = openCall(proxy.port);
    await call.untilBytes(100);
    const stall = await timers.firstScheduled();
    expect(stall.ms).toBe(7000);
    expect(call.bytes()).toBe(100);
    expect(call.complete).toBeUndefined();
    stall.callback();
    await call.closed;
    expect(call.bytes()).toBe(100);
    expect(call.complete).toBe(false);
  });

  it("stalls for the default seven minutes when the fault names no stall time", async () => {
    const upstream = await bodyUpstream();
    const timers = fakeTimers();
    const state = createChaosState();
    state.set({ mode: "stall", afterBytes: 10, count: 1 });
    const proxy = await startProxy({ upstreamPort: upstream.port, state, timers });
    openCall(proxy.port);
    expect((await timers.firstScheduled()).ms).toBe(420_000);
  });

  it("lets a response through whole when it is shorter than the cut", async () => {
    const upstream = await bodyUpstream();
    const state = createChaosState();
    state.set({ mode: "drop", afterBytes: 5000, count: 1 });
    const proxy = await startProxy({ upstreamPort: upstream.port, state });
    const call = openCall(proxy.port);
    await call.closed;
    expect(call.bytes()).toBe(1000);
    expect(call.complete).toBe(true);
  });
});

describe("the proxy holds a call", () => {
  it("holds the call for the delay and then forwards it (latency)", async () => {
    const upstream = await echoUpstream();
    const timers = fakeTimers();
    const state = createChaosState();
    state.set({ mode: "latency", delayMs: 90_000, count: 1 });
    const proxy = await startProxy({ upstreamPort: upstream.port, state, timers });
    const call = openCall(proxy.port);
    const hold = await timers.firstScheduled();
    expect(hold.ms).toBe(90_000);
    expect(upstream.seen).toHaveLength(0);
    hold.callback();
    await call.closed;
    expect(call.status).toBe(200);
    expect(upstream.seen).toHaveLength(1);
  });

  it("holds a latency call for a minute when the fault names no delay", async () => {
    const upstream = await echoUpstream();
    const timers = fakeTimers();
    const state = createChaosState();
    state.set({ mode: "latency", count: 1 });
    const proxy = await startProxy({ upstreamPort: upstream.port, state, timers });
    openCall(proxy.port);
    expect((await timers.firstScheduled()).ms).toBe(60_000);
  });

  it("accepts a call and never answers it (hang), and does not forward it", async () => {
    const upstream = await echoUpstream();
    const state = createChaosState();
    state.set({ mode: "hang", count: 1 });
    const proxy = await startProxy({ upstreamPort: upstream.port, state });
    const call = openCall(proxy.port);
    await proxy.logs.next(/^hang: holding the call open$/u);
    expect(upstream.seen).toHaveLength(0);
    expect(proxy.state.snapshot().stats.forwarded).toBe(0);
    call.destroy();
    await proxy.logs.next(/client closed the connection before the response ended/u);
    expect(proxy.errors.messages).toEqual([]);
  });
});

describe("the proxy ends a call whose client went away (review finding)", () => {
  it("never forwards a held call once its client left, and clears the hold", async () => {
    const upstream = await echoUpstream();
    const timers = fakeTimers();
    const state = createChaosState();
    state.set({ mode: "latency", delayMs: 120_000, count: 1 });
    const proxy = await startProxy({ upstreamPort: upstream.port, state, timers });
    const call = openCall(proxy.port);
    const hold = await timers.firstScheduled();
    call.destroy();
    await proxy.logs.next(/client closed the connection before the response ended/u);
    expect(timers.cleared).toContain(hold);
    // Even a timer that fires after all must not reach the model server for a client that is gone.
    hold.callback();
    expect(upstream.seen).toHaveLength(0);
    expect(proxy.state.snapshot().stats.forwarded).toBe(0);
  });

  it("destroys the upstream request when the client leaves while the model server is still answering", async () => {
    let upstreamSocketClosed;
    const closed = new Promise((resolve) => {
      upstreamSocketClosed = resolve;
    });
    const upstream = await startUpstream(({ req, res }) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      req.socket.on("close", () => upstreamSocketClosed("closed"));
    });
    const proxy = await startProxy({ upstreamPort: upstream.port });
    const call = openCall(proxy.port);
    await call.untilBytes(1);
    call.destroy();
    await expect(closed).resolves.toBe("closed");
    await proxy.logs.next(/client closed the connection before the response ended/u);
  });

  it("ends the client's call as a truncated response when the model server dies mid-body", async () => {
    const upstream = await startUpstream(({ res }) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n", () => res.socket.destroy());
    });
    const proxy = await startProxy({ upstreamPort: upstream.port });
    const call = openCall(proxy.port);
    await call.closed;
    expect(call.status).toBe(200);
    expect(call.complete).toBe(false);
    await proxy.errors.next(/^upstream response error: /u);
  });

  it("ends the client's call as a truncated response when the model server resets the connection mid-body (review finding)", async () => {
    // A reset (RST) reaches the proxy as an error of the upstream request, before the response's own
    // 'aborted'; ending the client's response there would hand LiteLLM a complete, chunk-terminated
    // answer and record a crashed model server as a finished one.
    const upstream = await startUpstream(({ res }) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
    });
    const proxy = await startProxy({ upstreamPort: upstream.port });
    const call = openCall(proxy.port);
    // The head and the first chunk are on the client's side, so the proxy has sent its headers.
    await call.untilBytes(1);
    upstream.seen[0].res.socket.resetAndDestroy();
    await call.closed;
    expect(call.status).toBe(200);
    expect(call.complete).toBe(false);
    await proxy.errors.next(/^upstream error: /u);
  });

  it("keeps serving after a client aborts in the middle of its request body", async () => {
    const upstream = await echoUpstream();
    const proxy = await startProxy({ upstreamPort: upstream.port });
    const aborted = connect(proxy.port, "127.0.0.1");
    aborted.on("error", () => undefined);
    await once(aborted, "connect");
    aborted.write(
      "POST /v1/chat/completions HTTP/1.1\r\nHost: lab\r\nContent-Length: 1000\r\n\r\npartial",
    );
    aborted.destroy();
    await proxy.logs.next(/client closed the connection before the response ended/u);
    // Node emits the request's error only for a body that never completed, and only to a listener:
    // the proxy's own request-error handler is what puts the diagnostic on the operator's sink.
    await proxy.errors.next(/^client request error: Error: aborted$/u);
    expect(upstream.seen).toHaveLength(0);
    const healthy = openCall(proxy.port, { method: "GET", path: "/__chaos", body: undefined });
    await healthy.closed;
    expect(healthy.status).toBe(200);
  });
});

describe("a failing model server", () => {
  it("answers a fixed line, never the error behind it, and logs the diagnostic on the error sink", async () => {
    const dead = createServer();
    dead.on("connection", (socket) => socket.destroy());
    const deadPort = await listen(dead);
    const proxy = await startProxy({ upstreamPort: deadPort });
    const call = openCall(proxy.port);
    await call.closed;
    expect(call.status).toBe(502);
    expect(call.body()).toBe("502 chaos-proxy upstream failure");
    expect(call.body()).not.toMatch(/ECONNRESET|hang up|Error/u);
    await proxy.errors.next(/^upstream error: /u);
  });
});

describe("the control endpoint", () => {
  const control = (proxy, body, method = "POST") =>
    openCall(proxy.port, { method, path: "/__chaos", body });

  it("reports the state, sets a fault with the closed field set and reports it back", async () => {
    const upstream = await echoUpstream();
    const proxy = await startProxy({ upstreamPort: upstream.port });
    const before = control(proxy, undefined, "GET");
    await before.closed;
    expect(JSON.parse(before.body())).toEqual({
      chaos: { mode: "pass" },
      stats: { forwarded: 0, injected: 0, byMode: {} },
    });
    const set = control(proxy, '{"mode":"status","status":503,"count":2,"evil":1}');
    await set.closed;
    expect(set.status).toBe(200);
    expect(JSON.parse(set.body()).chaos).toEqual({ mode: "status", status: 503, count: 2 });
    await proxy.logs.next(/^chaos set \{"mode":"status","status":503,"count":2\}$/u);
  });

  it("resets to pass on an empty body", async () => {
    const upstream = await echoUpstream();
    const state = createChaosState();
    state.set({ mode: "hang" });
    const proxy = await startProxy({ upstreamPort: upstream.port, state });
    const reset = control(proxy, "");
    await reset.closed;
    expect(JSON.parse(reset.body()).chaos).toEqual({ mode: "pass" });
  });

  it("refuses a body that is not JSON, not a fault or out of range, with a closed reason", async () => {
    const upstream = await echoUpstream();
    const proxy = await startProxy({ upstreamPort: upstream.port });
    for (const [body, reason] of [
      ["{ nope", "invalid-json"],
      ['{"mode":"explode"}', "invalid-mode"],
      ['{"mode":"status","status":200}', "invalid-status"],
    ]) {
      const call = control(proxy, body);
      await call.closed;
      expect(call.status).toBe(400);
      expect(call.body()).toBe(`400 chaos-proxy invalid control body (${reason})`);
      await proxy.errors.next(new RegExp(`control body rejected: ${reason}`, "u"));
    }
    expect(proxy.state.snapshot().chaos).toEqual({ mode: "pass" });
  });
});
