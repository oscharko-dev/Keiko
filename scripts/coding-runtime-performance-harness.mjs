import { Buffer } from "node:buffer";
// Native #2952 performance fixture. Only the provider response is controlled; discovery,
// authority, managed Git, native supervisor, readiness handshake and mounted HTTP are production.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { validateCodingWorkbenchRuntimeSseEvent } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import { resolveHostExecutable } from "./lib/host-executable.mjs";

export const CODING_PERFORMANCE_WORKLOAD = Object.freeze({ chunks: 64, chunkChars: 32 });
const TOKEN = "coding performance bounded text.";
const TEXT = TOKEN.repeat(CODING_PERFORMANCE_WORKLOAD.chunks);
const DEADLINE_MS = 60_000;
const PAIR_SECRET = "coding-performance-2952-launcher-fixture-secret";

async function runtimeModules() {
  const prefix = "../tests/e2e/servers/dist/packages/keiko-server/src/";
  const [deps, server, pairing, fixture] = await Promise.all([
    import(`${prefix}deps.js`),
    import(`${prefix}server.js`),
    import(`${prefix}coding-app-session/launcherSessionPairingPort.js`),
    import(`${prefix}coding-runtime/productionOpenCodeBackend.functional/_support.js`),
  ]);
  return { ...deps, ...server, ...pairing, ...fixture };
}

function initialize(root, config) {
  const repository = join(root, "repository");
  mkdirSync(repository);
  const git = resolveHostExecutable("git");
  const options = { cwd: repository, encoding: "utf8", timeout: 30_000, stdio: "ignore" };
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "performance@keiko.example"],
    ["config", "user.name", "Keiko performance fixture"],
    ["config", "commit.gpgsign", "false"],
  ])
    execFileSync(git, args, options);
  writeFileSync(join(repository, "fixture.txt"), "bounded fixture\n");
  execFileSync(git, ["add", "."], options);
  execFileSync(git, ["commit", "-qm", "Performance fixture"], options);
  mkdirSync(join(root, "ui-db"));
  writeFileSync(join(root, "ui-db", "keiko.config.json"), JSON.stringify(config));
  return repository;
}

function response() {
  return {
    modelId: "functional-model",
    content: TEXT,
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "performance",
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
      costClass: "low",
    },
  };
}

async function* streamFixture(observed) {
  observed.calls += 1;
  observed.firstYieldAt = performance.now();
  for (let index = 0; index < CODING_PERFORMANCE_WORKLOAD.chunks; index += 1) {
    observed.chunks += 1;
    observed.chars += TOKEN.length;
    yield { type: "delta", token: TOKEN };
  }
  yield { type: "done", response: response() };
}

function providerSeams(observed) {
  return {
    codingSidecarGatewayChatFactory: () => async () => {
      throw new Error("performance-fixture-requires-streaming");
    },
    codingSidecarGatewayChatStreamFactory: () => () => streamFixture(observed),
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture-port-missing");
  return address.port;
}

function runtimeDependencies(root, modules, port) {
  return modules.buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(root, "evidence"),
    uiDbPath: join(root, "ui-db", "keiko-ui.db"),
    env: {
      PATH: process.env.PATH,
      KEIKO_STATE_DIR: join(root, "state"),
      KEIKO_UI_PORT: String(port),
      KEIKO_CODING_RUNTIME_DEV_LANE: "1",
      KEIKO_CODING_DEPLOYMENT_CEILING: "autonomous-delivery",
      [modules.SESSION_PAIRING_LAUNCHER_SECRET_ENV]: PAIR_SECRET,
    },
    codingRuntimeServerPrincipal: () => "performance-operator",
  });
}

async function boot(root, modules, observed) {
  // Hold one OS-assigned listener throughout construction. Dispatch into createUiServer's real
  // handlers once its gateway authority is known; there is no close/rebind port reservation race.
  const listener = createServer();
  const port = await listen(listener);
  let deps;
  try {
    deps = runtimeDependencies(root, modules, port);
    if (deps.codingRuntimeHostQualified !== true)
      throw new Error(
        `fixture-runtime-unavailable:${deps.codingRuntimeUnavailableReason ?? "absent"}`,
      );
    const routed = modules.createUiServer({
      port,
      handlerDeps: { ...deps, ...providerSeams(observed) },
      staticRoot: root,
      csp: "default-src 'none'",
    });
    listener.on("request", (request, reply) => routed.emit("request", request, reply));
    listener.on("upgrade", (request, socket, head) =>
      routed.emit("upgrade", request, socket, head),
    );
    listener.on("close", () => routed.emit("close"));
    return { listener, deps, base: `http://127.0.0.1:${String(port)}` };
  } catch (error) {
    try {
      await deps?.dispose?.();
    } finally {
      await closeListener(listener);
    }
    throw error;
  }
}

async function request(context, path, body) {
  const reply = await globalThis.fetch(`${context.base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Keiko-CSRF": "1",
      Origin: context.base,
      ...(context.cookie === undefined ? {} : { Cookie: context.cookie }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: globalThis.AbortSignal.timeout(DEADLINE_MS),
  });
  if (!reply.ok) {
    const failure = await reply.json();
    throw new Error(`fixture-http-${String(reply.status)}:${failure.error?.code ?? "unknown"}`);
  }
  return reply;
}

async function prepare(context, repository, modules) {
  const paired = await request(
    context,
    "/api/coding-workbench/app-session/pair",
    modules.mintLauncherPairingAttestation({
      secret: PAIR_SECRET,
      requestId: randomUUID(),
      issuedAtMs: Date.now(),
    }),
  );
  const cookie = paired.headers.getSetCookie().at(0)?.split(";").at(0);
  if (cookie === undefined) throw new Error("fixture-pairing-cookie-missing");
  context.cookie = cookie;
  const provisioned = await request(context, "/api/task-workspaces", {
    root: repository,
    taskId: "coding-performance",
    baseBranch: "main",
    requestedBy: "performance",
  }).then((reply) => reply.json());
  await request(context, "/api/task-workspaces/reconciliation", { requestedBy: "performance" });
  await request(context, "/api/task-workspaces/active", {
    workspaceId: provisioned.instance.workspaceId,
    requestedBy: "performance",
    acquireLock: false,
  });
}

async function readiness(context) {
  const started = performance.now();
  const ready = await request(
    context,
    "/api/coding-workbench/runtime/readiness?requestedMode=autonomous-delivery",
  ).then((reply) => reply.json());
  const elapsed = performance.now() - started;
  if (
    ready.runtimeAvailable !== true ||
    ready.runtimeEvidenceClass !== "functional-not-platform-qualified"
  ) {
    throw new Error("fixture-readiness-unqualified");
  }
  return elapsed;
}

async function firstByte(context, runId) {
  const started = performance.now();
  const reply = await request(context, `/api/coding-workbench/runtime/runs/${runId}/events`);
  const reader = reply.body.getReader();
  try {
    return await readCodingPerformanceFirstEvent(reader, started);
  } finally {
    await reader.cancel();
  }
}

export async function readCodingPerformanceFirstEvent(
  reader,
  started,
  now = () => performance.now(),
) {
  let firstByteMs;
  let buffer = "";
  const decoder = new globalThis.TextDecoder();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("fixture-sse-empty-or-incomplete");
    if (chunk.value.byteLength === 0) continue;
    firstByteMs ??= now() - started;
    buffer += decoder.decode(chunk.value, { stream: true });
    if (Buffer.byteLength(buffer) > 65_536) throw new Error("fixture-sse-too-large");
    const boundary = buffer.indexOf("\n\n");
    if (boundary < 0) continue;
    const data = buffer
      .slice(0, boundary)
      .split("\n")
      .find((line) => line.startsWith("data: "));
    if (data === undefined || !validateCodingWorkbenchRuntimeSseEvent(JSON.parse(data.slice(6))).ok)
      throw new Error("fixture-sse-invalid");
    return firstByteMs;
  }
}

async function finished(context, runId, observed) {
  const deadline = performance.now() + DEADLINE_MS;
  while (performance.now() < deadline) {
    const snapshot = await request(context, `/api/coding-workbench/runtime/runs/${runId}`).then(
      (reply) => reply.json(),
    );
    if (snapshot.state === "failed")
      throw new Error(`fixture-run-failed:${snapshot.failureCode ?? "unknown"}`);
    if (snapshot.state === "succeeded") {
      if (observed.calls !== 1 || observed.chars !== TEXT.length)
        throw new Error("fixture-throughput-incomplete");
      return performance.now() - observed.firstYieldAt;
    }
    await delay(5);
  }
  throw new Error("fixture-terminal-deadline");
}

async function measure(context, observed) {
  const readinessMs = await readiness(context);
  const started = performance.now();
  const snapshot = await request(context, "/api/coding-workbench/runtime/runs", {
    requestId: randomUUID(),
    taskIntent: "Return the bounded performance fixture text.",
    requestedMode: "autonomous-delivery",
    modelId: "functional-model",
  }).then((reply) => reply.json());
  const coldStartMs = performance.now() - started;
  if (snapshot.state !== "running") throw new Error(`fixture-start-state:${snapshot.state}`);
  const sseFirstByteMs = await firstByte(context, snapshot.runId);
  const boundedThroughputMs = await finished(context, snapshot.runId, observed);
  const observedOutputChars = await outputCount(context);
  return {
    coldStartMs,
    readinessMs,
    sseFirstByteMs,
    boundedThroughputMs,
    observedOutputChars,
    observedChunks: observed.chunks,
    observedChars: observed.chars,
    gatewayCalls: observed.calls,
  };
}

async function outputCount(context) {
  const channel = await request(context, "/api/coding-workbench/app-session/channel").then(
    (reply) => reply.json(),
  );
  const feed = channel.content?.feed;
  if (feed?.availability !== "available") throw new Error("fixture-output-unavailable");
  const assistant = feed.turns
    .flatMap((turn) => turn.messages)
    .filter((message) => message.role === "assistant")
    .map((message) => message.segments.map((segment) => segment.text).join(""));
  const delivered = assistant.find((text) => text === TEXT);
  if (delivered === undefined) throw new Error("fixture-output-mismatch");
  return delivered.length;
}

function closeListener(listener) {
  return new Promise((resolve, reject) => {
    listener.close((error) => (error === undefined ? resolve() : reject(error)));
    listener.closeAllConnections();
  });
}

async function close(context) {
  try {
    await context.deps.codingRuntimeOrchestrator?.shutdown();
  } finally {
    try {
      await context.deps.dispose?.();
    } finally {
      await closeListener(context.listener);
    }
  }
}

export async function measureCodingRuntimeSample() {
  const modules = await runtimeModules();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-coding-perf-")));
  const observed = { calls: 0, chunks: 0, chars: 0, firstYieldAt: 0 };
  let context;
  try {
    const repository = initialize(root, modules.functionalGatewayConfig());
    context = await boot(root, modules, observed);
    await prepare(context, repository, modules);
    return await measure(context, observed);
  } finally {
    try {
      if (context !== undefined) await close(context);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
