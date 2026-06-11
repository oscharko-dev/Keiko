// Memory-specific packaged-install smoke. Retained separately from installable-package-smoke
// because this flow proves the shipped UI/BFF memory runtime with a fake model provider, while the
// generic install smoke stays fast and focused on the root artifact contract.

import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NPM_INSTALL_TIMEOUT_MS = 90_000;
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const UI_START_TIMEOUT_MS = 30_000;
const USER_ID = "memory-smoke-user";
const MODEL_ID = "example-chat-model";
// Salience capture (Epic #204) appends a SECOND model call per turn whose system prompt contains
// this marker; the chat completion never does. Skip salience calls when inspecting model prompts.
const SALIENCE_PROMPT_MARKER = "extract durable memories from a chat turn";
const latestChatRequestOf = (entries) =>
  [...entries].reverse().find((entry) => !JSON.stringify(entry).includes(SALIENCE_PROMPT_MARKER));

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const rootVersion = rootPackageJson.version;

function fail(message) {
  console.error(`installable-memory-smoke failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function run(cmd, args, options) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...options });
  if (result.error) {
    fail(`${cmd} ${args.join(" ")} could not spawn: ${result.error.message}`);
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, ms));
}

async function listen(server) {
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolvePromise();
    });
  });
}

function getPort(server) {
  const address = server.address();
  if (address === null || typeof address === "string") {
    fail("server did not bind to an IPv4 port");
  }
  return address.port;
}

function packRoot() {
  const result = run("npm", ["pack", "--silent"], { cwd: repoRoot });
  if (result.status !== 0) {
    fail(`npm pack exited ${String(result.status)}: ${result.stderr}`);
  }
  const tarballName = `oscharko-dev-keiko-${rootVersion}.tgz`;
  const tarballPath = join(repoRoot, tarballName);
  if (!existsSync(tarballPath)) {
    fail(`expected tarball at ${tarballPath} after npm pack`);
  }
  return tarballPath;
}

function installInto(tmp, tarballPath) {
  const initResult = run("npm", ["init", "-y"], { cwd: tmp });
  if (initResult.status !== 0) {
    fail(`npm init -y exited ${String(initResult.status)}: ${initResult.stderr}`);
  }
  const installResult = run(
    "npm",
    ["install", tarballPath, "--ignore-scripts", "--no-audit", "--no-fund", "--omit=optional"],
    { cwd: tmp, timeout: NPM_INSTALL_TIMEOUT_MS },
  );
  if (installResult.status !== 0) {
    fail(
      `npm install of tarball exited ${String(installResult.status)} ` +
        `(signal=${String(installResult.signal)}): ${installResult.stderr}`,
    );
  }
}

function gatewayConfig(providerBaseUrl) {
  return JSON.stringify(
    {
      providers: [
        {
          modelId: MODEL_ID,
          baseUrl: providerBaseUrl,
          apiKey: "memory-smoke-secret",
          timeoutMs: 30_000,
          maxRetries: 0,
          retryBaseDelayMs: 500,
          capability: {
            id: MODEL_ID,
            kind: "chat",
            contextWindow: 64_000,
            maxOutputTokens: 4_096,
            toolCalling: true,
            structuredOutput: true,
            streaming: true,
            supportsImageInput: false,
            supportsDocumentInput: false,
            workflowEligible: false,
            costClass: "medium",
            latencyClass: "standard",
            throughputHint: "memory smoke",
            preferredUseCases: ["Smoke verification"],
            knownLimitations: [],
          },
        },
      ],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    },
    null,
    2,
  );
}

async function startFakeProvider() {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = JSON.parse(bodyText);
    requests.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-memory-smoke",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: MODEL_ID,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "memory smoke response",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      }),
    );
  });
  await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${String(getPort(server))}/v1`,
    close: async () => {
      await new Promise((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      );
    },
    // Salience capture (Epic #204) issues a SECOND model call AFTER the chat completion, so the
    // chat request — the one carrying the memory block — is no longer the latest recorded request.
    latestChatRequest: () => latestChatRequestOf(requests),
  };
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = "health endpoint never answered";
  while (Date.now() < deadline) {
    try {
      const res = await globalThis.fetch(`${baseUrl}/api/health`);
      if (res.ok) {
        const body = await res.json();
        if (body.status === "ok") return;
      }
      lastError = `health returned HTTP ${String(res.status)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  fail(`UI health check did not pass within ${String(HEALTH_TIMEOUT_MS)}ms: ${lastError}`);
}

// eslint-disable-next-line max-lines-per-function
function startInstalledUi(tmp, configPath, uiDbPath, evidenceDir, memoryDir) {
  const bin = join(tmp, "node_modules", "@oscharko-dev", "keiko", "dist", "cli", "index.js");
  const portServer = createServer((_, res) => res.end("reserved"));
  // eslint-disable-next-line max-lines-per-function
  return listen(portServer).then(async () => {
    const port = getPort(portServer);
    await new Promise((resolvePromise, reject) =>
      portServer.close((error) => (error ? reject(error) : resolvePromise())),
    );
    const child = spawn(
      "node",
      [
        bin,
        "ui",
        "--port",
        String(port),
        "--config",
        configPath,
        "--ui-db",
        uiDbPath,
        "--evidence-dir",
        evidenceDir,
      ],
      {
        cwd: tmp,
        env: {
          ...process.env,
          KEIKO_MEMORY_DIR: memoryDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const exitPromise = new Promise((resolvePromise) =>
      child.once("exit", (code, signal) =>
        resolvePromise({
          code,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      ),
    );
    const healthPromise = waitForHealth(baseUrl);
    const timeoutPromise = new Promise((_, reject) =>
      globalThis.setTimeout(() => reject(new Error("UI start timed out")), UI_START_TIMEOUT_MS),
    );
    try {
      await Promise.race([healthPromise, timeoutPromise]);
    } catch (error) {
      child.kill("SIGTERM");
      const exited = await exitPromise;
      fail(
        `installed UI did not become healthy: ${error instanceof Error ? error.message : String(error)}\n` +
          `stdout:\n${exited.stdout}\n` +
          `stderr:\n${exited.stderr}`,
      );
    }
    return {
      baseUrl,
      stop: async () => {
        child.kill("SIGTERM");
        const exited = await exitPromise;
        if (exited.code !== 0 && exited.signal !== "SIGTERM") {
          fail(
            `installed UI exited unexpectedly with code=${String(exited.code)} signal=${String(exited.signal)}\n` +
              `stdout:\n${exited.stdout}\n` +
              `stderr:\n${exited.stderr}`,
          );
        }
      },
    };
  });
}

async function fetchText(url) {
  const res = await globalThis.fetch(url);
  assert(res.ok, `expected ${url} to return 2xx, got ${String(res.status)}`);
  return res.text();
}

async function api(baseUrl, path, options = {}) {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = {
    Accept: "application/json",
    ...(method === "GET" || method === "HEAD" ? {} : { "X-Keiko-CSRF": "1" }),
    ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(options.headers ?? {}),
  };
  const res = await globalThis.fetch(`${baseUrl}${path}`, {
    ...options,
    method,
    headers,
  });
  const text = await res.text();
  let body;
  try {
    body = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    fail(`${method} ${path} failed with HTTP ${String(res.status)}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function createChat(baseUrl, projectPath) {
  const body = await api(baseUrl, "/api/desktop/chats", {
    method: "POST",
    body: JSON.stringify({ projectPath, modelId: MODEL_ID }),
  });
  return body.chat.id;
}

function memoryWire(projectPath, conversationId, enabled = true) {
  return {
    enabled,
    budgetTokens: 900,
    context: {
      userId: USER_ID,
      workspaceId: projectPath,
      projectId: projectPath,
      conversationId,
    },
  };
}

async function sendChat(baseUrl, projectPath, chatId, content, enabled = true) {
  return api(baseUrl, "/api/desktop/chat", {
    method: "POST",
    body: JSON.stringify({
      chatId,
      projectPath,
      modelId: MODEL_ID,
      content,
      memory: memoryWire(projectPath, chatId, enabled),
    }),
  });
}

async function acceptProposal(baseUrl, proposalId) {
  return api(baseUrl, `/api/memory/proposals/${encodeURIComponent(proposalId)}/accept`, {
    method: "POST",
    body: "{}",
  });
}

async function correction(baseUrl, memoryId, body) {
  return api(baseUrl, `/api/memory/${encodeURIComponent(memoryId)}/correct`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

async function forgetMemory(baseUrl, memoryId) {
  return api(baseUrl, `/api/memory/${encodeURIComponent(memoryId)}/forget`, {
    method: "POST",
    body: JSON.stringify({ acknowledged: true, reason: "installable memory smoke" }),
  });
}

async function deleteMemory(baseUrl, memoryId) {
  return api(baseUrl, `/api/memory/${encodeURIComponent(memoryId)}`, {
    method: "DELETE",
    body: "{}",
  });
}

async function memoryContext(baseUrl, projectPath, chatId, queryText) {
  return api(baseUrl, "/api/memory/context", {
    method: "POST",
    body: JSON.stringify({ projectPath, chatId, queryText }),
  });
}

async function fetchMemory(baseUrl, memoryId) {
  const res = await globalThis.fetch(`${baseUrl}/api/memory/${encodeURIComponent(memoryId)}`, {
    headers: { Accept: "application/json" },
  });
  const text = await res.text();
  const body = text.length === 0 ? undefined : JSON.parse(text);
  return { status: res.status, body };
}

function assertNoFreshMemories(body, label) {
  assert(body !== undefined && typeof body === "object", `${label} did not return an object body`);
  assert(Array.isArray(body.memories), `${label} did not return a memories array`);
  assert(
    body.memories.length === 0,
    `${label} returned ${String(body.memories.length)} memories before user action`,
  );
  assert(body.total === 0, `${label} returned total=${String(body.total)} before user action`);
}

async function assertFreshMemoryState(baseUrl) {
  assertNoFreshMemories(await api(baseUrl, "/api/memory?limit=10"), "fresh /api/memory");
  assertNoFreshMemories(
    await api(baseUrl, "/api/memory/review-queue"),
    "fresh /api/memory/review-queue",
  );
}

// eslint-disable-next-line complexity, max-lines-per-function
async function main() {
  const tarballPath = packRoot();
  const installRoot = mkdtempSync(join(tmpdir(), "keiko-install-memory-smoke-"));
  const smokeRoot = mkdtempSync(join(tmpdir(), "keiko-memory-smoke-runtime-"));
  const provider = await startFakeProvider();
  let ui = null;
  try {
    installInto(installRoot, tarballPath);
    const configPath = join(smokeRoot, "keiko.config.json");
    const uiDbPath = join(smokeRoot, "keiko-ui.db");
    const evidenceDir = join(smokeRoot, "evidence");
    const memoryDir = join(smokeRoot, "memory");
    const projectA = join(smokeRoot, "project-a");
    const projectB = join(smokeRoot, "project-b");
    writeFileSync(configPath, gatewayConfig(provider.baseUrl), "utf8");
    mkdirSync(evidenceDir, { recursive: true });
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });

    ui = await startInstalledUi(installRoot, configPath, uiDbPath, evidenceDir, memoryDir);
    const homeHtml = await fetchText(`${ui.baseUrl}/`);
    assert(homeHtml.includes("Keiko"), "home page did not contain the Keiko shell marker");
    const memoryHtml = await fetchText(`${ui.baseUrl}/memoriaviva`);
    assert(memoryHtml.includes("MemoriaViva"), "/memoriaviva did not render the MemoriaViva route");
    await assertFreshMemoryState(ui.baseUrl);

    const rememberChatId = await createChat(ui.baseUrl, projectA);
    const remember = await sendChat(
      ui.baseUrl,
      projectA,
      rememberChatId,
      "remember that project alpha uses pnpm for installs",
    );
    const proposalId = remember.memory?.actions?.[0]?.proposalId;
    assert(
      typeof proposalId === "string" && proposalId.length > 0,
      "remember flow did not create a proposal",
    );
    await acceptProposal(ui.baseUrl, proposalId);

    const retrievalChatId = await createChat(ui.baseUrl, projectA);
    const retrieval = await sendChat(
      ui.baseUrl,
      projectA,
      retrievalChatId,
      "Which package manager should I use for installs?",
    );
    assert(
      retrieval.memory?.context?.enabled === true,
      "retrieval response did not mark memory as enabled",
    );
    assert(
      Array.isArray(retrieval.memory?.context?.memories) &&
        retrieval.memory.context.memories.length > 0,
      "retrieval response did not surface included memories",
    );
    // The chat completion carries the memory block; the trailing salience-capture call does not,
    // so inspect the latest CHAT request (salience calls are skipped) rather than the latest call.
    const retrievalPrompt = JSON.stringify(provider.latestChatRequest());
    assert(
      retrievalPrompt.includes("Included memory context:"),
      "model prompt did not include the memory block",
    );
    assert(
      retrievalPrompt.includes("pnpm"),
      "model prompt did not include the accepted memory body",
    );

    await ui.stop();
    ui = await startInstalledUi(installRoot, configPath, uiDbPath, evidenceDir, memoryDir);
    const restartChatId = await createChat(ui.baseUrl, projectA);
    const afterRestart = await memoryContext(
      ui.baseUrl,
      projectA,
      restartChatId,
      "Which package manager should I use for installs?",
    );
    assert(
      typeof afterRestart.contextBlock?.text === "string" &&
        afterRestart.contextBlock.text.includes("pnpm"),
      "accepted memory did not survive a UI restart",
    );

    const noMemoryChatId = await createChat(ui.baseUrl, projectA);
    const noMemory = await sendChat(
      ui.baseUrl,
      projectA,
      noMemoryChatId,
      "Which package manager should I use for installs?",
      false,
    );
    const noMemoryPrompt = JSON.stringify(provider.latestChatRequest());
    assert(
      noMemory.memory?.context?.enabled === false,
      "memory-off response did not mark context.enabled=false",
    );
    assert(
      !Array.isArray(noMemory.memory?.context?.memories) ||
        noMemory.memory.context.memories.length === 0,
      "memory-off response surfaced included memories",
    );
    assert(
      !noMemoryPrompt.includes("Included memory context:"),
      "memory-off model call included a memory block despite memory being disabled",
    );

    const corrected = await correction(
      ui.baseUrl,
      proposalId,
      "project alpha uses yarn for installs",
    );
    const correctionId = corrected.correction?.id;
    assert(
      typeof correctionId === "string" && correctionId.length > 0,
      "correction flow did not create a correction record",
    );
    await acceptProposal(ui.baseUrl, correctionId);

    const correctedChatId = await createChat(ui.baseUrl, projectA);
    const correctedRetrieval = await sendChat(
      ui.baseUrl,
      projectA,
      correctedChatId,
      "Which package manager should I use for installs now?",
    );
    const correctedPrompt = JSON.stringify(provider.latestChatRequest());
    assert(
      correctedPrompt.includes("yarn") &&
        correctedRetrieval.memory?.context?.memories?.some((memory) =>
          memory.bodyExcerpt.includes("yarn"),
        ),
      "corrected memory was not surfaced after acceptance",
    );

    const isolatedChatId = await createChat(ui.baseUrl, projectB);
    const isolated = await sendChat(
      ui.baseUrl,
      projectB,
      isolatedChatId,
      "Which package manager should I use for installs now?",
    );
    const isolatedPrompt = JSON.stringify(provider.latestChatRequest());
    assert(
      Array.isArray(isolated.memory?.context?.memories) &&
        isolated.memory.context.memories.length === 0,
      "project-scoped memory leaked into a different project",
    );
    assert(
      !isolatedPrompt.includes("pnpm") && !isolatedPrompt.includes("yarn"),
      "different-project model call contained out-of-scope memory",
    );

    const forgetChatId = await createChat(ui.baseUrl, projectA);
    const forgetSeed = await sendChat(
      ui.baseUrl,
      projectA,
      forgetChatId,
      "remember that project alpha deploys happen on Tuesdays",
    );
    const forgetId = forgetSeed.memory?.actions?.[0]?.proposalId;
    assert(
      typeof forgetId === "string" && forgetId.length > 0,
      "forget flow did not create a proposal",
    );
    await acceptProposal(ui.baseUrl, forgetId);
    await forgetMemory(ui.baseUrl, forgetId);
    const afterForgetChatId = await createChat(ui.baseUrl, projectA);
    const afterForget = await memoryContext(
      ui.baseUrl,
      projectA,
      afterForgetChatId,
      "Which day are deploys scheduled for?",
    );
    const afterForgetText = JSON.stringify(afterForget);
    assert(
      !afterForgetText.includes("Tuesdays") && !afterForgetText.includes("tuesdays"),
      "forgotten memory still appeared in retrieval",
    );

    const deleteChatId = await createChat(ui.baseUrl, projectA);
    const deleteSeed = await sendChat(
      ui.baseUrl,
      projectA,
      deleteChatId,
      "remember that project alpha delete-me flag is disabled",
    );
    const deleteId = deleteSeed.memory?.actions?.[0]?.proposalId;
    assert(
      typeof deleteId === "string" && deleteId.length > 0,
      "delete flow did not create a proposal",
    );
    await acceptProposal(ui.baseUrl, deleteId);
    await deleteMemory(ui.baseUrl, deleteId);
    const deleted = await fetchMemory(ui.baseUrl, deleteId);
    assert(deleted.status === 404, "hard-deleted memory still resolved from the Memory Center API");

    console.log(
      "installable-memory-smoke ok: tarball-installed UI/BFF served pages and exercised create, use, correct, forget, delete, scope isolation, restart persistence, and memory-off mode.",
    );
  } finally {
    if (ui !== null) {
      await ui.stop();
    }
    await provider.close();
    rmSync(installRoot, { recursive: true, force: true });
    rmSync(smokeRoot, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
}

void main();
