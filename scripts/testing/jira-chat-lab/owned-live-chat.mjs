// A controller may signal only ChildProcess objects it forked itself. It never accepts a pid.
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_ENTRY = fileURLToPath(new URL("./owned-live-chat-child.mjs", import.meta.url));
// The ordinary Chat drain owns 15 seconds; the child gets 20 and its parent a 5-second margin.
export const OWNED_LIVE_CHAT_CLOSE_TIMEOUT_MS = 20000;
const failure = (reason) => new TypeError(`owned-lab-${reason}`);

function notCancelled(signal) {
  if (signal?.aborted) throw failure("cancelled");
}

function optionsSignal(options = {}) {
  if (Object.keys(options).some((key) => key !== "signal")) throw failure("invalid-options");
  notCancelled(options.signal);
  return options.signal;
}

function live(state) {
  return (
    state !== undefined &&
    !state.exited &&
    state.child.pid !== undefined &&
    state.child.exitCode === null &&
    state.child.signalCode === null &&
    state.child.connected
  );
}

function requireLive(state) {
  if (!live(state) || state.error) throw failure("process-unavailable");
}

function failureMessage(message, nonce) {
  return (
    message !== null &&
    typeof message === "object" &&
    Object.keys(message).length === 3 &&
    message.kind === "failed" &&
    message.nonce === nonce &&
    message.reason === "activity-log-unavailable"
  );
}

function observeMessage(state, message, port, onFailure) {
  if (!state.readySeen && readyMessage(message, state.nonce, port)) {
    state.readySeen = true;
    return;
  }
  state.error = true;
  onFailure(
    failureMessage(message, state.nonce) ? "activity-log-unavailable" : "ipc-contract-failed",
  );
}

function forkOwned(entry, environment, port, onFailure) {
  const child = fork(entry, [], {
    execArgv: [],
    serialization: "advanced",
    env: { ...environment, KEIKO_OS_KEYCHAIN: "off" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const state = { child, nonce: randomUUID(), exited: false, error: false };
  state.exit = new Promise((resolve) =>
    child.once("exit", (code, signal) => {
      state.exited = true;
      resolve({ code, signal });
    }),
  );
  child.on("error", () => {
    state.error = true;
  });
  child.on("message", (message) => observeMessage(state, message, port, onFailure));
  return state;
}

function readyMessage(message, nonce, port) {
  return (
    message !== null &&
    typeof message === "object" &&
    Object.keys(message).length === 3 &&
    message.kind === "ready" &&
    message.nonce === nonce &&
    message.port === port
  );
}

function waitReady(state, initialization, port, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      state.child.off("message", onMessage);
      state.child.off("error", onError);
      state.child.off("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message) =>
      finish(readyMessage(message, state.nonce, port) ? undefined : failure("invalid-readiness"));
    const onError = () => finish(failure("start-failed"));
    const onExit = () => finish(failure("start-exited"));
    const onAbort = () => finish(failure("cancelled"));
    const timer = globalThis.setTimeout(() => finish(failure("start-timeout")), timeoutMs);
    state.child.once("message", onMessage);
    state.child.once("error", onError);
    state.child.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    try {
      state.child.send({ kind: "start", nonce: state.nonce, initialization }, (error) => {
        if (error) finish(failure("ipc-unavailable"));
      });
    } catch {
      finish(failure("ipc-unavailable"));
    }
  });
}

async function waitHealth(state, origin, timeoutMs, signal) {
  const deadline = globalThis.performance.now() + timeoutMs;
  while (globalThis.performance.now() < deadline) {
    notCancelled(signal);
    requireLive(state);
    try {
      const response = await globalThis.fetch(`${origin}/api/health`, {
        redirect: "error",
        signal: globalThis.AbortSignal.any([
          globalThis.AbortSignal.timeout(Math.min(1000, timeoutMs)),
          ...(signal === undefined ? [] : [signal]),
        ]),
      });
      if (response.status === 200 && (await response.json()).status === "ok") {
        requireLive(state);
        return;
      }
    } catch {
      notCancelled(signal);
    }
    await delay(50, undefined, { signal }).catch(() => {
      throw failure("cancelled");
    });
  }
  throw failure("health-timeout");
}

async function waitExit(state, timeoutMs) {
  if (state.exited || state.child.pid === undefined) return;
  let timer;
  try {
    return await Promise.race([
      state.exit,
      new Promise((_, reject) => {
        timer = globalThis.setTimeout(() => reject(failure("stop-timeout")), timeoutMs);
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function signalOwned(state, signal, timeoutMs) {
  if (state === undefined || state.exited || state.child.pid === undefined) return;
  if (state.child.exitCode !== null || state.child.signalCode !== null)
    return waitExit(state, timeoutMs);
  try {
    if (!state.child.kill(signal)) throw failure("signal-refused");
  } catch {
    throw failure("signal-refused");
  }
  return waitExit(state, timeoutMs);
}

async function closeOwned(state, timeoutMs) {
  let exited;
  try {
    exited = await signalOwned(state, "SIGTERM", timeoutMs);
  } catch {
    await signalOwned(state, "SIGKILL", timeoutMs);
    throw failure("forced-cleanup");
  }
  if (exited !== undefined && (exited.code !== 0 || exited.signal !== null))
    throw failure("cleanup-failed");
}

function validProcessInitialization(configured) {
  return (
    typeof configured.entry === "string" &&
    isAbsolute(configured.entry) &&
    configured.initialization !== null &&
    typeof configured.initialization === "object" &&
    !Array.isArray(configured.initialization)
  );
}

function controllerOptions(options) {
  const allowed = new Set([
    "entry",
    "initialization",
    "port",
    "environment",
    "startTimeoutMs",
    "stopTimeoutMs",
    "healthTimeoutMs",
  ]);
  if (Object.keys(options).some((key) => !allowed.has(key))) throw failure("invalid-options");
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535)
    throw failure("invalid-port");
  const configured = {
    entry: DEFAULT_ENTRY,
    environment: process.env,
    startTimeoutMs: 120000,
    stopTimeoutMs: OWNED_LIVE_CHAT_CLOSE_TIMEOUT_MS + 5000,
    healthTimeoutMs: 10000,
    ...options,
  };
  if (!validProcessInitialization(configured)) throw failure("invalid-initialization");
  for (const key of ["startTimeoutMs", "stopTimeoutMs", "healthTimeoutMs"])
    if (!Number.isSafeInteger(configured[key]) || configured[key] < 1)
      throw failure("invalid-timeout");
  try {
    configured.initialization = structuredClone(options.initialization);
    configured.environment = { ...configured.environment };
  } catch {
    throw failure("invalid-initialization");
  }
  return configured;
}

class OwnedLiveChatProcess {
  #config;
  #state;
  #pending;
  #phase = "idle";
  #generation = 0;
  #closing;
  #failure;
  #lifetime = new globalThis.AbortController();

  constructor(options) {
    this.#config = controllerOptions(options);
  }

  get origin() {
    return `http://127.0.0.1:${this.#config.port}`;
  }

  async #serialize(action) {
    if (this.#pending || this.#closing) throw failure("operation-unavailable");
    this.#pending = Promise.resolve().then(action);
    try {
      return await this.#pending;
    } finally {
      this.#pending = undefined;
    }
  }

  async #launch(signal) {
    notCancelled(this.#lifetime.signal);
    const config = this.#config;
    this.#generation += 1;
    const state = forkOwned(config.entry, config.environment, config.port, (reason) => {
      this.#failure ??= reason;
    });
    this.#state = state;
    const combined = globalThis.AbortSignal.any([
      this.#lifetime.signal,
      ...(signal ? [signal] : []),
    ]);
    try {
      await waitReady(
        state,
        {
          ...config.initialization,
          port: config.port,
          restoring: this.#generation > 1 || config.initialization.restoring === true,
        },
        config.port,
        config.startTimeoutMs,
        combined,
      );
      await waitHealth(state, this.origin, config.healthTimeoutMs, combined);
      requireLive(state);
      this.#assertHealthy();
      this.#phase = "ready";
    } catch (error) {
      this.#phase = "failed";
      await signalOwned(state, "SIGKILL", config.stopTimeoutMs);
      throw error;
    }
  }

  start(options) {
    return this.#serialize(async () => {
      const signal = optionsSignal(options);
      if (this.#phase !== "idle") throw failure("already-started");
      this.#phase = "starting";
      await this.#launch(signal);
    });
  }

  restart(options) {
    return this.#serialize(async () => {
      const signal = optionsSignal(options);
      this.#assertHealthy();
      requireLive(this.#state);
      const began = globalThis.performance.now();
      this.#phase = "restarting";
      const exited = await signalOwned(this.#state, "SIGKILL", this.#config.stopTimeoutMs);
      if (exited?.signal !== "SIGKILL") throw failure("crash-unconfirmed");
      this.#assertHealthy();
      notCancelled(signal);
      await this.#launch(signal);
      this.#assertHealthy();
      return { restarted: true, downtimeMs: Math.ceil(globalThis.performance.now() - began) };
    });
  }

  close() {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close() {
    this.#lifetime.abort();
    await this.#pending?.catch(() => undefined);
    const unexpected = this.#phase === "ready" && !live(this.#state);
    try {
      await closeOwned(this.#state, this.#config.stopTimeoutMs);
      this.#assertHealthy();
      if (unexpected) throw failure("unexpected-exit");
      this.#phase = "closed";
    } catch (error) {
      this.#phase = "failed";
      throw error;
    }
  }

  status() {
    return {
      phase: this.#phase,
      generation: this.#generation,
      running: live(this.#state),
      ...(this.#failure === undefined ? {} : { failure: this.#failure }),
    };
  }

  #assertHealthy() {
    if (this.#failure !== undefined) throw failure(this.#failure);
  }
}

/** The fixture entry override uses this same owner; no path accepts an existing process identity. */
export function createOwnedLiveChatProcess(options) {
  return new OwnedLiveChatProcess(options);
}

/** Always audit the existing license and close the owned child, preserving every failed stage. */
export async function runOwnedLiveChatLifecycle({ run, close, audit }) {
  const errors = [];
  let value;
  try {
    value = await run();
  } catch (error) {
    errors.push(error);
  }
  const completed = await Promise.allSettled([
    Promise.resolve().then(close),
    Promise.resolve().then(audit),
  ]);
  for (const outcome of completed) if (outcome.status === "rejected") errors.push(outcome.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "owned-lab-lifecycle-failed");
  return value;
}
