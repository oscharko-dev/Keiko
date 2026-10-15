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
    sourceComplete: scope.source ? contents.some((text) => text.includes(scope.source)) : null,
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
    const timer = setTimeout(() => reject(new Error("bff-start-timeout")), 45000);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("bff-start-failed"));
    });
    child.once("message", (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

function bffProcess(dir, env) {
  let child, session, baseUrl;
  async function start() {
    const fd = openSync(join(dir, "server.private.log"), "a", 0o600);
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
    const ready = await waitForReady(child);
    baseUrl = `http://127.0.0.1:${ready.port}`;
    session = await openApiSession(baseUrl, env);
  }
  async function stop() {
    if (child?.exitCode === null)
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGTERM");
      });
  }
  return {
    start,
    stop,
    get baseUrl() {
      return baseUrl;
    },
    request: (...args) => session.request(...args),
  };
}

async function startObservedBff(dir, proxy, provider, contextWindow) {
  let bff;
  const close = async () => {
    await bff?.stop();
    await new Promise((resolve) => {
      proxy.close(resolve);
      proxy.closeAllConnections();
    });
  };
  try {
    const { project, env } = await runtimeEnvironment(
      dir,
      proxy.address().port,
      provider,
      contextWindow,
    );
    bff = bffProcess(dir, env);
    await bff.start();
    return { bff, project, env, close };
  } catch (error) {
    await close();
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

export async function startRuntime(
  dir,
  { contextWindow = 131072, skillBody = "", source = "" } = {},
) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const provider = await localProvider(contextWindow),
    physical = [],
    state = createChaosState(),
    compactionPrompts = await canonicalCompactionPrompts();
  let scope = { id: "setup", question: "", skillBody, source, compactionPrompts };
  const proxy = createChaosProxy({
    upstream: provider.upstream,
    state,
    log: () => undefined,
    logError: () => physical.push({ caseId: scope.id, error: "proxy-upstream-failed" }),
  });
  observeProxy(proxy, physical, () => scope);
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
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
      scope = { id, question, skillBody, source, compactionPrompts };
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
