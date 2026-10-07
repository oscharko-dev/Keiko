#!/usr/bin/env node
// Fault-injecting HTTP proxy between LiteLLM and the model server (lab only). It forwards
// everything unchanged and injects faults only into POST */chat/completions, so LiteLLM's own error
// translation, retries and circuit breaker see what a peak-loaded model server would cause.
//
// Control: POST /__chaos with a JSON body selects the next fault, GET /__chaos reports the state.
// The control endpoint is unauthenticated: keep the proxy on loopback.
//   {"mode":"pass"}                                             forward unchanged
//   {"mode":"status","status":503,"count":2}                    answer the next `count` calls with `status`
//   {"mode":"status","status":503,"durationMs":180000}          answer every call with `status` for 3 minutes
//   {"mode":"status","status":429,"probability":0.5}            answer with `status` at random
//   {"mode":"latency","delayMs":90000,"count":1}                hold the next call before forwarding it
//   {"mode":"drop","afterBytes":400,"count":1}                  cut the response after N body bytes
//   {"mode":"stall","afterBytes":400,"stallMs":420000,"count":1} stop sending mid-body, then cut
//   {"mode":"hang","count":1}                                    accept the call and never answer
// `count` and `durationMs` end a fault; without either it lasts until the next POST /__chaos.
//
// Responses are fixed: a client never receives an error object, an error message or a stack of this
// process, only a fixed status line or a closed reason code. The diagnostic (error name and message,
// no stack) goes to this process's own stderr.
//
// A client that goes away (LiteLLM's own timeout, a cancelled run) ends the call: the upstream
// request is destroyed and every timer of an injected fault is cleared, so an abandoned call never
// reaches the model server late and never leaves a socket or a timer behind.
import { Buffer } from "node:buffer";
import { randomInt } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import { isMainModule } from "../../lib/is-main-module.mjs";
import { UsageError, parseCli, runMain } from "./lab-common.mjs";

const USAGE = [
  "usage: node chaos-proxy.mjs [--listen-port 11500] [--host 127.0.0.1] [--upstream 127.0.0.1:11434]",
  "",
  "Point the LiteLLM route's api_base at this proxy (host.docker.internal:<listen-port>/v1 from a",
  "Docker Desktop container) and leave the proxy on `pass` until a scenario sets a fault.",
  "Faults are described at the top of chaos-proxy.mjs.",
].join("\n");

const CHAOS_MODES = new Set(["pass", "status", "latency", "drop", "stall", "hang"]);
const MAX_TIMER_MS = 2_147_483_647;
const FIELD_LIMITS = {
  status: { min: 400, max: 599, integer: true },
  count: { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
  probability: { min: 0, max: 1 },
  delayMs: { min: 0, max: MAX_TIMER_MS },
  afterBytes: { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
  stallMs: { min: 0, max: MAX_TIMER_MS },
  durationMs: { min: 0, max: MAX_TIMER_MS },
};
const MODEL_CALL = /\/chat\/completions$/u;
const DEFAULT_STATUS = 503;
const DEFAULT_DELAY_MS = 60_000;
const DEFAULT_STALL_MS = 420_000;
const JSON_HEADERS = { "content-type": "application/json" };
const TEXT_HEADERS = { "content-type": "text/plain; charset=utf-8" };
const UPSTREAM_FAILURE_LINE = "502 chaos-proxy upstream failure";

const stamp = () => new Date().toISOString().slice(11, 23);

function proxyLog(message) {
  console.log(`${stamp()} ${message}`);
}

/** Diagnostics for the operator of the proxy: stderr, never a response. */
function proxyErrorLog(message) {
  console.error(`${stamp()} ${message}`);
}

const cryptoRandom = () => randomInt(0, 1_000_000) / 1_000_000;

function fieldIsValid(value, { min, max, integer }) {
  return (
    Number.isFinite(value) &&
    value >= min &&
    value <= max &&
    (integer !== true || Number.isInteger(value))
  );
}

/** Checks a decoded POST /__chaos body: `{ spec }`, or `{ reason }` from a closed vocabulary. */
export function checkChaosSpec(value) {
  if (value === null || typeof value !== "object" || !CHAOS_MODES.has(value.mode)) {
    return { reason: "invalid-mode" };
  }
  const present = Object.keys(FIELD_LIMITS).filter((field) => value[field] !== undefined);
  const invalid = present.find((field) => !fieldIsValid(value[field], FIELD_LIMITS[field]));
  if (invalid !== undefined) return { reason: `invalid-${invalid}` };
  // Only the closed field set is kept: nothing else from the request body enters the state.
  return { spec: { mode: value.mode, ...Object.fromEntries(present.map((f) => [f, value[f]])) } };
}

/** The current fault and its statistics; consume() takes one fault for one model call. */
export function createChaosState({ now = Date.now, random = cryptoRandom } = {}) {
  let chaos = { mode: "pass" };
  let expiresAt;
  let forwarded = 0;
  let injected = 0;
  const byMode = new Map();
  const reset = () => {
    chaos = { mode: "pass" };
    expiresAt = undefined;
  };
  return {
    countForwarded() {
      forwarded += 1;
    },
    set(spec) {
      chaos = { ...spec };
      expiresAt = typeof spec.durationMs === "number" ? now() + spec.durationMs : undefined;
    },
    snapshot() {
      const remainingMs = expiresAt === undefined ? undefined : Math.max(0, expiresAt - now());
      return {
        chaos,
        remainingMs,
        stats: { forwarded, injected, byMode: Object.fromEntries(byMode) },
      };
    },
    consume() {
      if (expiresAt !== undefined && now() >= expiresAt) reset();
      if (chaos.mode === "pass") return undefined;
      if (typeof chaos.probability === "number" && random() >= chaos.probability) return undefined;
      const active = { ...chaos };
      if (typeof chaos.count === "number") {
        chaos.count -= 1;
        if (chaos.count <= 0) reset();
      }
      injected += 1;
      byMode.set(active.mode, (byMode.get(active.mode) ?? 0) + 1);
      return active;
    },
  };
}

/**
 * One client call and everything that must stop when the client goes away: the upstream request
 * and the timers of an injected fault (the latency hold, the stall). cancel() is idempotent.
 */
function createExchange(timers) {
  const pending = new Set();
  const exchange = {
    closed: false,
    upstream: undefined,
    schedule(callback, delayMs) {
      const timer = timers.set(() => {
        pending.delete(timer);
        callback();
      }, delayMs);
      pending.add(timer);
    },
    cancel() {
      if (exchange.closed) return;
      exchange.closed = true;
      for (const timer of pending) timers.clear(timer);
      pending.clear();
      exchange.upstream?.destroy();
    },
  };
  return exchange;
}

/**
 * Sends the bytes before the cut, then ends the call: `drop` closes the connection once they are
 * on the wire (an immediate close would discard them and reset the connection before the client
 * saw a single byte), `stall` goes silent for `stallMs` and then closes it.
 */
function cutResponse(res, exchange, fault, { log }, head) {
  const limit = fault.afterBytes ?? 0;
  if (fault.mode === "drop") {
    log(`drop after ${String(limit)} bytes`);
    res.write(head, () => res.socket?.destroy());
  } else {
    const stallMs = fault.stallMs ?? DEFAULT_STALL_MS;
    log(`stall after ${String(limit)} bytes for ${String(stallMs)} ms`);
    res.write(head);
    exchange.schedule(() => res.socket?.destroy(), stallMs);
  }
  exchange.upstream?.destroy();
}

function relayResponse(upstreamResponse, res, exchange, fault, context) {
  res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
  const cutsBody = fault?.mode === "drop" || fault?.mode === "stall";
  const limit = fault?.afterBytes ?? 0;
  let sent = 0;
  let cut = false;
  upstreamResponse.on("data", (chunk) => {
    if (cut) return;
    if (!cutsBody || sent + chunk.length <= limit) {
      sent += chunk.length;
      res.write(chunk);
      return;
    }
    cut = true;
    cutResponse(res, exchange, fault, context, chunk.subarray(0, Math.max(0, limit - sent)));
  });
  upstreamResponse.on("end", () => {
    if (!cut) res.end();
  });
  // An upstream that dies mid-body ends the client's call the same way: a truncated response.
  upstreamResponse.on("error", (error) => {
    if (cut || exchange.closed) return;
    context.logError(`upstream response error: ${error.name}: ${error.message}`);
    res.destroy();
  });
}

function forward(req, res, body, context, exchange, fault) {
  if (exchange.closed) return;
  const { upstream: target, logError, state } = context;
  const upstream = httpRequest(
    {
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${target.host}:${String(target.port)}` },
    },
    (upstreamResponse) => relayResponse(upstreamResponse, res, exchange, fault, context),
  );
  exchange.upstream = upstream;
  upstream.on("error", (error) => {
    // Destroying the upstream request is this proxy's own teardown of an abandoned call.
    if (exchange.closed) return;
    logError(`upstream error: ${error.name}: ${error.message}`);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(502, TEXT_HEADERS);
    res.end(UPSTREAM_FAILURE_LINE);
  });
  upstream.end(body);
  state.countForwarded();
}

function decodeControlBody(body, logError) {
  const text = body.toString("utf8");
  if (text.trim() === "") return { value: { mode: "pass" } };
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    logError(`control body is not JSON: ${error.name}: ${error.message}`);
    return { reason: "invalid-json" };
  }
}

function handleControl(req, res, body, { log, logError, state }) {
  if (req.method === "POST") {
    const decoded = decodeControlBody(body, logError);
    const checked = decoded.reason === undefined ? checkChaosSpec(decoded.value) : decoded;
    if (checked.reason !== undefined) {
      logError(`control body rejected: ${checked.reason}`);
      res.writeHead(400, TEXT_HEADERS);
      res.end(`400 chaos-proxy invalid control body (${checked.reason})`);
      return;
    }
    state.set(checked.spec);
    log(`chaos set ${JSON.stringify(state.snapshot().chaos)}`);
  }
  res.writeHead(200, JSON_HEADERS);
  res.end(JSON.stringify(state.snapshot()));
}

/** The error body of a provider failure, in the OpenAI error shape LiteLLM translates. */
function answerStatus(res, fault) {
  const status = fault.status ?? DEFAULT_STATUS;
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify({ error: { message: `chaos ${String(status)}`, type: "server_error" } }));
}

function injectFault(req, res, body, context, exchange, fault) {
  switch (fault.mode) {
    case "status":
      answerStatus(res, fault);
      break;
    case "hang":
      context.log("hang: holding the call open");
      break;
    case "latency":
      exchange.schedule(
        () => forward(req, res, body, context, exchange, undefined),
        fault.delayMs ?? DEFAULT_DELAY_MS,
      );
      break;
    default:
      forward(req, res, body, context, exchange, fault);
  }
}

function handleRequest(req, res, body, context, exchange) {
  if (req.url === "/__chaos") {
    handleControl(req, res, body, context);
    return;
  }
  const isModelCall = req.method === "POST" && MODEL_CALL.test(req.url ?? "");
  const fault = isModelCall ? context.state.consume() : undefined;
  if (fault) context.log(`inject ${JSON.stringify(fault)}`);
  if (fault === undefined) forward(req, res, body, context, exchange, undefined);
  else injectFault(req, res, body, context, exchange, fault);
}

/** Reads one client call; a client that errors or closes early cancels everything the call started. */
function serveCall(req, res, context) {
  const exchange = createExchange(context.timers);
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("error", (error) => {
    context.logError(`client request error: ${error.name}: ${error.message}`);
    exchange.cancel();
    res.destroy();
  });
  res.on("error", (error) => {
    context.logError(`client response error: ${error.name}: ${error.message}`);
    exchange.cancel();
  });
  res.on("close", () => {
    if (!res.writableFinished)
      context.log("client closed the connection before the response ended");
    exchange.cancel();
  });
  req.on("end", () => handleRequest(req, res, Buffer.concat(chunks), context, exchange));
}

/**
 * An http.Server that forwards to `upstream` ({ host, port }) and injects the state's faults.
 * `timers` ({ set, clear }) is injectable so a test never waits for a real delay.
 */
export function createChaosProxy({
  upstream,
  state = createChaosState(),
  log = proxyLog,
  logError = proxyErrorLog,
  timers = { set: setTimeout, clear: clearTimeout },
}) {
  const context = { upstream, state, log, logError, timers };
  return createServer((req, res) => serveCall(req, res, context));
}

function parseUpstream(value) {
  let url;
  try {
    url = new URL(`http://${value}`);
  } catch {
    throw new UsageError(`--upstream must be host:port (got "${value}")`);
  }
  if (url.hostname === "" || url.port === "") {
    throw new UsageError(`--upstream must be host:port (got "${value}")`);
  }
  return { host: url.hostname, port: Number(url.port) };
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new UsageError(`--listen-port must be a TCP port (got "${value}")`);
  }
  return port;
}

async function main() {
  const cli = parseCli({
    usage: USAGE,
    options: {
      "listen-port": { type: "string", default: "11500" },
      host: { type: "string", default: "127.0.0.1" },
      upstream: { type: "string", default: "127.0.0.1:11434" },
    },
  });
  if (cli.help) return;
  const upstream = parseUpstream(cli.values.upstream);
  const listenPort = parsePort(cli.values["listen-port"]);
  const server = createChaosProxy({ upstream });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, cli.values.host, resolve);
  });
  proxyLog(
    `chaos proxy on ${cli.values.host}:${String(listenPort)} -> ${upstream.host}:${String(upstream.port)}`,
  );
  // The listening server keeps the process alive until a signal ends it.
}

if (isMainModule(import.meta.url)) runMain(main);
