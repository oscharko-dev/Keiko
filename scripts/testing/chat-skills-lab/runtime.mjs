// Real BFF and Gateway composition with private, isolated state. The existing lab proxy observes
// serialized provider requests without retaining their contents or changing the configured model.
import { fork, spawn } from "node:child_process";
import { writeFileSync, mkdirSync, openSync, closeSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { randomBytes, createHash } from "node:crypto";
import { createChaosProxy, createChaosState } from "../coding-workbench-lab/chaos-proxy.mjs";
import { openApiSession, importBuilt } from "../coding-workbench-lab/lab-common.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
export const MODEL = "gemma-4-31b-it";
export const digest = (text) => createHash("sha256").update(text).digest("hex");

export async function workingDiffDigest(cwd) {
  const hash = createHash("sha256");
  const child = spawn("git", ["diff", "--no-ext-diff", "HEAD"], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
  });
  child.stdout.on("data", (chunk) => hash.update(chunk));
  const code = await new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("source-diff-unavailable")));
    child.once("close", resolve);
  });
  if (code !== 0) throw new Error("source-diff-unavailable");
  return hash.digest("hex");
}

function providerUrl(address) {
  const url = new URL(address);
  if (
    url.protocol !== "http:" ||
    !new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("loopback-gateway-required");
  return url;
}

function validateServedModel(served, contextWindow) {
  if (
    !Number.isInteger(served?.context_window) ||
    served.context_window < contextWindow ||
    !Number.isInteger(served.max_output_tokens)
  )
    throw new Error("served-model-unavailable");
  if (Number.isInteger(served.max_input_tokens) && served.max_input_tokens < contextWindow)
    throw new Error("served-input-limit-too-small");
}

async function localProvider(contextWindow) {
  const key = process.env.KEIKO_SKILL_LAB_API_KEY;
  const address = process.env.KEIKO_SKILL_LAB_BASE_URL;
  if (!key || !address) throw new Error("local-gateway-configuration-required");
  const url = providerUrl(address);
  const info = await globalThis
    .fetch(new URL("/model/info", url), {
      headers: { authorization: `Bearer ${key}` },
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(30000),
    })
    .then((response) => response.json());
  const served = info.data?.find((item) => item.model_name === MODEL)?.model_info;
  validateServedModel(served, contextWindow);
  return {
    key,
    served,
    upstream: { host: url.hostname.replace(/^\[|\]$/gu, ""), port: Number(url.port || 80) },
  };
}

function sourceWitnessObservations(contents, markers) {
  if (
    !Array.isArray(markers) ||
    markers.length > 32 ||
    Array.from(markers).some(
      (marker) => typeof marker !== "string" || marker.length === 0 || marker.length > 4096,
    )
  )
    throw new TypeError("source-witness-list-invalid");
  return markers.map((marker) => ({
    digest: digest(marker),
    present: contents.some((text) => text.includes(marker)),
  }));
}

function sourceObservation(contents, scope) {
  const sourceComplete = scope.source ? contents.some((text) => text.includes(scope.source)) : null;
  if (scope.sourceWitnesses === undefined) return { sourceComplete };
  return {
    sourceComplete,
    sourceWitnesses: sourceWitnessObservations(contents, scope.sourceWitnesses),
  };
}

export function requestObservation(payload, bytes, body, scope) {
  const contents = (payload.messages ?? []).map((message) =>
    typeof message.content === "string" ? message.content : JSON.stringify(message.content),
  );
  const compaction = (payload.messages ?? []).some(
    (message) => message.role === "system" && scope.compactionPrompts.has(message.content),
  );
  const skillOccurrences = scope.skillBody
    ? contents.reduce((count, text) => count + text.split(scope.skillBody).length - 1, 0)
    : 0;
  return {
    requestBytes: bytes,
    model: payload.model,
    stream: payload.stream === true,
    maxTokens: payload.max_tokens ?? payload.max_completion_tokens,
    messageCount: contents.length,
    skillOccurrences,
    skillDigest: skillOccurrences > 0 ? digest(scope.skillBody) : null,
    ...sourceObservation(contents, scope),
    operation: compaction ? "compaction" : "conversation",
    caseRequest:
      !compaction && !!scope.question && contents.some((text) => text.includes(scope.question)),
    requestDigest: digest(body),
  };
}

function inspectRequest(req, entry, scope) {
  const chunks = [];
  let bytes = 0;
  req.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes <= 2_000_000) chunks.push(chunk);
  });
  req.on("end", () => {
    try {
      if (bytes > 2_000_000) throw new Error("request-inspection-limit");
      const body = Buffer.concat(chunks);
      Object.assign(
        entry,
        requestObservation(JSON.parse(body.toString("utf8")), bytes, body, scope),
      );
    } catch {
      entry.error = "request-inspection-failed";
    }
  });
}

export function responseObservation(raw) {
  const responses = raw.startsWith("data:")
    ? raw
        .split("\n")
        .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
        .map((line) => JSON.parse(line.slice(6)))
    : [JSON.parse(raw)];
  const finishReason =
    responses.findLast((response) => response.choices?.[0]?.finish_reason)?.choices[0]
      .finish_reason ?? null;
  return {
    usage: responses.findLast((response) => response.usage)?.usage ?? null,
    finishReason,
    responseKind: finishReason ? "complete" : "incomplete",
  };
}

function inspectResponse(res, entry, started) {
  const chunks = [];
  let bytes = 0;
  const write = res.write.bind(res),
    end = res.end.bind(res);
  const capture = (chunk) => {
    if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
      bytes += Buffer.byteLength(chunk);
      if (bytes <= 2_000_000) chunks.push(Buffer.from(chunk));
    }
  };
  res.write = (chunk, ...args) => {
    capture(chunk);
    return write(chunk, ...args);
  };
  res.end = (chunk, ...args) => {
    capture(chunk);
    return end(chunk, ...args);
  };
  res.on("close", () => {
    entry.durationMs = Date.now() - started;
    entry.status = res.statusCode;
    try {
      if (bytes > 2_000_000) throw new Error("response-inspection-limit");
      Object.assign(entry, responseObservation(Buffer.concat(chunks).toString("utf8")));
    } catch {
      entry.responseKind = "interrupted-or-invalid";
    }
  });
}

function observeProxy(proxy, physical, getScope) {
  proxy.on("request", (req, res) => {
    if (!/\/chat\/completions$/u.test(req.url)) return;
    const started = Date.now(),
      scope = getScope();
    const entry = { caseId: scope.id, startedAt: new Date(started).toISOString() };
    physical.push(entry);
    inspectRequest(req, entry, scope);
    inspectResponse(res, entry, started);
  });
}

async function drainPhysicalRequests(physical) {
  const deadline = Date.now() + 360000;
  let lastCount = -1;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    const pending = physical.some((entry) => entry.startedAt && !entry.responseKind);
    if (pending || lastCount !== physical.length) quietSince = Date.now();
    if (!pending && Date.now() - quietSince >= 2000) return;
    lastCount = physical.length;
    await delay(100);
  }
  throw new Error("physical-request-drain-timeout");
}

function gatewayConfiguration(port, contextWindow, served) {
  return {
    providers: [
      {
        modelId: MODEL,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        timeoutMs: 300000,
        maxRetries: 1,
        retryBaseDelayMs: 500,
        capability: {
          kind: "chat",
          contextWindow,
          maxOutputTokens: Math.min(served.max_output_tokens, Math.floor(contextWindow / 4)),
          toolCalling: served.supports_function_calling === true,
          structuredOutput: false,
          streaming: true,
          supportsImageInput: false,
          supportsDocumentInput: false,
          workflowEligible: false,
          costClass: "low",
          latencyClass: "standard",
          throughputHint: "local",
          preferredUseCases: ["Chat"],
          knownLimitations: [],
        },
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 1 },
  };
}

async function runtimeEnvironment(dir, port, provider, contextWindow) {
  const { CODING_APP_SESSION_LAUNCHER_SECRET_ENV } = await importBuilt(
    "keiko-contracts",
    "coding-app-session.js",
  );
  mkdirSync(join(dir, "synthetic-project"), { recursive: true });
  const project = realpathSync(join(dir, "synthetic-project")),
    configPath = join(dir, "gateway.json");
  writeFileSync(
    configPath,
    JSON.stringify(gatewayConfiguration(port, contextWindow, provider.served)),
    { mode: 0o600 },
  );
  return {
    project,
    env: {
      ...process.env,
      KEIKO_STATE_DIR: join(dir, "state"),
      KEIKO_UI_DATA_DIR: join(dir, "ui"),
      KEIKO_MEMORY_DIR: join(dir, "memory"),
      KEIKO_EVIDENCE_DIR: join(dir, "evidence"),
      KEIKO_CONFIG_FILE: configPath,
      KEIKO_INITIAL_PROJECT_PATH: project,
      KEIKO_MODEL_GEMMA_4_31B_IT_API_KEY: provider.key,
      [CODING_APP_SESSION_LAUNCHER_SECRET_ENV]: randomBytes(32).toString("hex"),
    },
  };
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const finish = (error, message) => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
      if (error) reject(error);
      else resolve(message);
    };
    const onError = (error) => finish(error);
    const onExit = () => finish(new Error("bff-start-failed"));
    const onMessage = (message) => finish(undefined, message);
    const timer = setTimeout(() => finish(new Error("bff-start-timeout")), 45000);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("message", onMessage);
  });
}

function observeBffChild(child) {
  const state = { child, error: undefined };
  child.on("error", (error) => {
    state.error ??= error;
  });
  return state;
}

function stopBffChild(child) {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
    return;
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => finish(error);
    const onExit = () => finish();
    child.once("error", onError);
    child.once("exit", onExit);
    try {
      child.kill("SIGTERM");
    } catch (error) {
      finish(error);
    }
  });
}

async function stopObservedBffChild(state) {
  const [completion] = await Promise.allSettled([stopBffChild(state?.child)]);
  const lifetimeError = state?.error;
  if (state) state.error = undefined;
  if (completion.status === "rejected") {
    if (lifetimeError && lifetimeError !== completion.reason)
      throw new AggregateError([lifetimeError, completion.reason], "bff-lifetime-and-stop-failed", {
        cause: lifetimeError,
      });
    throw completion.reason;
  }
  if (lifetimeError) throw lifetimeError;
}

function bffProcess(dir, env) {
  let state, session, baseUrl;
  async function start() {
    const fd = openSync(join(dir, "server.private.log"), "a", 0o600);
    let child;
    try {
      child = fork(fileURLToPath(new URL("./serve.mjs", import.meta.url)), [], {
        cwd: root,
        env,
        execArgv: [],
        stdio: ["ignore", fd, fd, "ipc"],
      });
    } finally {
      closeSync(fd);
    }
    const observed = observeBffChild(child);
    state = observed;
    try {
      const ready = await waitForReady(child);
      baseUrl = `http://127.0.0.1:${ready.port}`;
      session = await openApiSession(baseUrl, env);
      if (observed.error) throw observed.error;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("bff-start-failed");
    } catch (error) {
      if (observed.error === error) observed.error = undefined;
      throw error;
    }
  }
  return {
    start,
    stop: () => stopObservedBffChild(state),
    get baseUrl() {
      return baseUrl;
    },
    request: (...args) => session.request(...args),
  };
}

export async function startObservedBff(
  dir,
  proxy,
  provider,
  contextWindow,
  prepareEnvironment = runtimeEnvironment,
) {
  let bff;
  const close = async () => {
    const stopped = await Promise.allSettled([bff?.stop()]);
    const closed = await Promise.allSettled([
      new Promise((resolve, reject) => {
        proxy.close((error) => (error ? reject(error) : resolve()));
      }),
      Promise.resolve().then(() => proxy.closeAllConnections()),
    ]);
    const failures = [...stopped, ...closed]
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "runtime-cleanup-failed");
  };
  try {
    const { project, env } = await prepareEnvironment(
      dir,
      proxy.address().port,
      provider,
      contextWindow,
    );
    bff = bffProcess(dir, env);
    await bff.start();
    return { bff, project, env, close };
  } catch (error) {
    const [cleanup] = await Promise.allSettled([close()]);
    if (cleanup.status === "rejected") {
      throw new AggregateError([error, cleanup.reason], "runtime-start-and-cleanup-failed", {
        cause: error,
      });
    }
    throw error;
  }
}

async function canonicalCompactionPrompts() {
  const { SUMMARY_SYSTEM_PROMPT } = await importBuilt(
    "keiko-server",
    "chat-compaction-model-summary.js",
  );
  const { PROMPT_COMPACTION_SYSTEM } = await importBuilt(
    "keiko-server",
    "chat-prompt-compaction.js",
  );
  return new Set([SUMMARY_SYSTEM_PROMPT, PROMPT_COMPACTION_SYSTEM]);
}

function createObservedProxy(provider, state, physical, getScope) {
  const proxy = createChaosProxy({
    upstream: provider.upstream,
    state,
    log: () => undefined,
    logError: () => physical.push({ caseId: getScope().id, error: "proxy-upstream-failed" }),
  });
  proxy.on("error", () => physical.push({ caseId: getScope().id, error: "proxy-server-failed" }));
  observeProxy(proxy, physical, getScope);
  return proxy;
}

export function listenProxy(proxy) {
  return new Promise((resolve, reject) => {
    const failed = (error) => {
      proxy.off("error", failed);
      proxy.off("listening", ready);
      reject(error);
    };
    const ready = () => {
      proxy.off("error", failed);
      proxy.off("listening", ready);
      resolve();
    };
    proxy.once("error", failed);
    try {
      proxy.listen(0, "127.0.0.1", ready);
    } catch (error) {
      failed(error);
    }
  });
}

export async function startRuntime(
  dir,
  {
    contextWindow = 131072,
    skillBody = "",
    source = "",
    sourceWitnesses,
    physicalRecorder = [],
  } = {},
) {
  if (!Array.isArray(physicalRecorder))
    throw new TypeError("caller-owned-physical-recorder-required");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const physical = physicalRecorder;
  const provider = await localProvider(contextWindow),
    state = createChaosState(),
    compactionPrompts = await canonicalCompactionPrompts();
  let scope = { id: "setup", question: "", skillBody, source, sourceWitnesses, compactionPrompts };
  const proxy = createObservedProxy(provider, state, physical, () => scope);
  await listenProxy(proxy);
  const { project, env, bff, close } = await startObservedBff(
    realpathSync(dir),
    proxy,
    provider,
    contextWindow,
  );
  return {
    model: MODEL,
    physical,
    state,
    project,
    served: provider.served,
    contextWindow,
    env,
    get baseUrl() {
      return bff.baseUrl;
    },
    setActive: (id, question = "") => {
      scope = { id, question, skillBody, source, sourceWitnesses, compactionPrompts };
    },
    request: bff.request,
    drain: () => drainPhysicalRequests(physical),
    restart: async () => {
      await drainPhysicalRequests(physical);
      await bff.stop();
      await bff.start();
    },
    close,
  };
}

export async function finalizeRuntime(runtime, save) {
  const results = [];
  for (const operation of [() => runtime?.drain(), () => runtime?.close()]) {
    const [result] = await Promise.allSettled([Promise.resolve().then(operation)]);
    results.push(result);
  }
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  const completedStatus = runtime ? "completed" : "not-started";
  const finalization = {
    status: failures.length > 0 ? "failed" : completedStatus,
    drain: runtime ? results[0].status : "not-started",
    close: runtime ? results[1].status : "not-started",
  };
  const [saved] = await Promise.allSettled([Promise.resolve().then(() => save(finalization))]);
  if (saved.status === "rejected") failures.push(saved.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "qualification-finalization-failed", { cause: failures[0] });
}
