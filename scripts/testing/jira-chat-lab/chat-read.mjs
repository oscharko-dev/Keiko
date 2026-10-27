import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  buildUiHandlerDeps,
  createUiServer,
  buildCspHeader,
  extractInlineScriptHashes,
} from "../../../packages/keiko-server/dist/index.js";
import {
  createFileServerLogSink,
  createServerLogger,
  setServerLogger,
} from "../../../packages/keiko-server/dist/observability/index.js";
import {
  parseGatewayConfig,
  createDefaultChatCapability,
  toolCallingConfigurationFingerprint,
} from "../../../packages/keiko-model-gateway/dist/index.js";
import { probeGatewayToolCalling } from "../../../packages/keiko-server/dist/gateway-tool-calling-probe.js";
import {
  mintLauncherPairingAttestation,
  SESSION_PAIRING_LAUNCHER_SECRET_ENV,
} from "../../../packages/keiko-server/dist/coding-app-session/launcherSessionPairingPort.js";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session-pairing";
import { loadSession, readPrivateFile, requireLicense } from "./lab-client.mjs";

process.on("warning", (warning) => {
  if (warning.code !== "KEIKO_LOG_SINK_FAILED") return;
  console.log(
    JSON.stringify({ operation: "jira-chat-live-read", passed: false, stage: "activity-log" }),
  );
  process.exitCode = 1;
});

async function unusedPort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
async function request(origin, cookie, name, path, body, method = "POST", signal) {
  const response = await globalThis.fetch(origin + path, {
    method,
    signal,
    headers: {
      Origin: origin,
      "X-Keiko-CSRF": "1",
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    console.log(
      JSON.stringify({
        operation: "jira-chat-live-http",
        stage: name,
        status: response.status,
        code: failure.error?.code,
      }),
    );
    throw new TypeError("Live Chat HTTP stage failed");
  }
  return response;
}
async function jsonRequest(origin, cookie, name, path, body, method, signal) {
  return (await request(origin, cookie, name, path, body, method, signal)).json();
}
async function configureModel(deps, modelId, session, configPath) {
  const provider = {
    modelId,
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "ollama-local",
    timeoutMs: 45000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
  const capability = {
    ...createDefaultChatCapability(modelId),
    contextWindow: 32768,
    maxOutputTokens: 2048,
    streaming: true,
    toolCalling: true,
  };
  const raw = {
    providers: [provider],
    capabilities: [capability],
    atlassian: {
      privateTargets: [{ baseUrl: "https://127.0.0.1:18443", addressClass: "loopback" }],
    },
    egress: { caBundlePath: join(session.directory, "secrets", "tls", "ca.pem") },
  };
  const probe = await probeGatewayToolCalling(parseGatewayConfig(raw), provider);
  assert.equal(probe, "verified");
  const proof = {
    status: "verified",
    checkedAt: new Date().toISOString(),
    probe: "gateway-tool-calling-v1",
    configurationFingerprint: toolCallingConfigurationFingerprint(provider),
  };
  const configured = { ...raw, capabilities: [{ ...capability, toolCallingVerification: proof }] };
  writeFileSync(configPath, JSON.stringify(configured), { mode: 0o600 });
  deps.gatewayConfig.set(parseGatewayConfig(configured), true);
  deps.gatewayConfig.recordVerifiedCapability(
    modelId,
    { conversationReady: true },
    new Date().toISOString(),
  );
  console.log(JSON.stringify({ operation: "jira-chat-live-model", verified: true }));
}
async function prepareChat(origin, cookie, session, projectPath, modelId) {
  const credential = await jsonRequest(
    origin,
    cookie,
    "credential-create",
    "/api/atlassian-connectors/credentials",
    {
      provider: "jira",
      deployment: "data-center",
      authScheme: "bearer-pat",
      displayName: "Synthetic live Chat qualification",
      baseUrl: "https://127.0.0.1:18443",
      apiToken: readPrivateFile(join(session.directory, "secrets", "api-token")),
      livePodCreationRequestId: randomUUID(),
    },
  );
  assert.ok(credential.livePod?.podId);
  const verification = await jsonRequest(
    origin,
    cookie,
    "credential-verify",
    `/api/atlassian-connectors/credentials/${encodeURIComponent(credential.authRef)}/verify`,
    {},
  );
  assert.equal(verification.status, "ok");
  const created = await jsonRequest(origin, cookie, "chat-create", "/api/chats", {
    projectPath,
    title: "Synthetic Jira live Chat",
    selectedModel: modelId,
  });
  const bound = await jsonRequest(
    origin,
    cookie,
    "chat-bind",
    `/api/chats?id=${encodeURIComponent(created.chat.id)}`,
    {
      jiraPodId: credential.livePod.podId,
      expectedGroundingScopeIdentity: created.chat.groundingScopeIdentity,
    },
    "PATCH",
  );
  assert.equal(bound.chat.jiraPodBinding.podId, credential.livePod.podId);
  console.log(JSON.stringify({ operation: "jira-chat-live-binding", verified: true }));
  return bound.chat;
}
function startReadTurn(origin, cookie, chat, projectPath, modelId, signal) {
  return jsonRequest(
    origin,
    cookie,
    "chat-send",
    "/api/desktop/chat",
    {
      chatId: chat.id,
      projectPath,
      modelId,
      clientTurnId: randomUUID(),
      expectedGroundingScopeIdentity: chat.groundingScopeIdentity,
      content:
        "Use the Jira projects tool to read the connected Jira project list. List the returned project keys only. Do not guess or use another source.",
      memory: { enabled: false, budgetTokens: 0, mode: "governed-assist", context: {} },
    },
    "POST",
    signal,
  );
}
async function observeConsent(origin, cookie, chat, projectPath, signal, settled) {
  while (!settled() && !signal.aborted) {
    const messages = await jsonRequest(
      origin,
      cookie,
      "chat-observe",
      `/api/chats/messages?chatId=${encodeURIComponent(chat.id)}&projectPath=${encodeURIComponent(projectPath)}`,
      undefined,
      "GET",
      signal,
    );
    const consent = messages.messages.find(
      (message) => message.toolTranscript?.readGrant?.state === "pending",
    );
    if (consent !== undefined) {
      assert.equal(consent.toolTranscript.exchanges[0].result, undefined);
      const grant = consent.toolTranscript.readGrant;
      const decided = await jsonRequest(
        origin,
        cookie,
        "read-consent",
        `/api/atlassian-connectors/action-approvals/${encodeURIComponent(grant.grantId)}/chat-read-consent`,
        { decision: "approve", disclosureVersion: grant.disclosureVersion },
      );
      assert.equal(decided.approval.state, "granted");
      return true;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
  }
  return false;
}
function assertCompletedRead(completed) {
  const user = completed.messages.find((message) => message.role === "user");
  assert.equal(user.turnState, "completed");
  const read = user.toolTranscript.exchanges.find(
    (exchange) => exchange.call.name === "jira_projects",
  );
  assert.equal(read.result.status, "completed");
  assert.ok(read.result.data.items.some((project) => project.key === "KEIKO"));
  assert.ok(
    completed.messages.some(
      (message) => message.role === "assistant" && message.content.includes("KEIKO"),
    ),
  );
  console.log(
    JSON.stringify({
      operation: "jira-chat-live-read",
      passed: true,
      toolCalls: user.toolTranscript.exchanges.length,
      projectCount: read.result.data.items.length,
    }),
  );
}
async function readTurn(origin, cookie, chat, projectPath, modelId) {
  const controller = new globalThis.AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 150000);
  let settled = false;
  const pending = startReadTurn(origin, cookie, chat, projectPath, modelId, controller.signal);
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    const granted = await observeConsent(
      origin,
      cookie,
      chat,
      projectPath,
      controller.signal,
      () => settled,
    );
    const completed = await pending;
    assert.equal(granted, true);
    assertCompletedRead(completed);
  } finally {
    globalThis.clearTimeout(timeout);
    controller.abort();
  }
}
function createLiveDeps(root, session, secret) {
  const activityLog = createFileServerLogSink(join(session.directory, "chat-read-logs"), {
    level: "debug",
  });
  setServerLogger(createServerLogger({ sink: activityLog, level: "debug" }));
  return buildUiHandlerDeps({
    configPath: join(root, "keiko.config.json"),
    evidenceDir: join(root, "evidence"),
    uiDbPath: join(root, "ui.db"),
    env: {
      [SESSION_PAIRING_LAUNCHER_SECRET_ENV]: secret,
      KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY: randomBytes(32).toString("base64"),
    },
    activityLog,
  });
}
function uiSurface(root) {
  if (process.argv[4] !== "--browser") return { staticRoot: root, csp: "default-src 'self'" };
  const staticRoot = fileURLToPath(new URL("../../../packages/keiko-ui/out/", import.meta.url));
  const hashes = extractInlineScriptHashes([readFileSync(join(staticRoot, "index.html"), "utf8")]);
  return { staticRoot, csp: buildCspHeader(hashes) };
}
async function runSelectedJourney(origin, cookie, session, projectPath, modelId, secret) {
  if (process.argv[4] !== "--browser") {
    const chat = await prepareChat(origin, cookie, session, projectPath, modelId);
    return readTurn(origin, cookie, chat, projectPath, modelId);
  }
  const { chat } = await jsonRequest(origin, cookie, "chat-create", "/api/chats", {
    projectPath,
    title: "Synthetic Jira browser Chat",
    selectedModel: modelId,
  });
  const { runBrowserRead } = await import("./browser-read.mjs");
  await runBrowserRead({
    origin,
    fragment: encodeCodingAppSessionPairingFragment(
      mintLauncherPairingAttestation({ secret, requestId: randomUUID(), issuedAtMs: Date.now() }),
    ),
    chat,
    session,
    observe: () =>
      jsonRequest(
        origin,
        cookie,
        "chat-observe",
        `/api/chats/messages?chatId=${encodeURIComponent(chat.id)}&projectPath=${encodeURIComponent(projectPath)}`,
        undefined,
        "GET",
      ),
  });
}
async function main() {
  const session = loadSession(process.argv[2]);
  const modelId = process.argv[3];
  if (!modelId) throw new TypeError("A locally installed model is required");
  await requireLicense(session);
  const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-jira-live-chat-"));
  const projectPath = join(root, "workspace");
  mkdirSync(projectPath);
  const secret = randomBytes(48).toString("hex");
  const deps = createLiveDeps(root, session, secret);
  let server;
  try {
    await configureModel(deps, modelId, session, join(root, "keiko.config.json"));
    deps.store.createProject(projectPath);
    const port = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    server = createUiServer({
      port,
      handlerDeps: deps,
      ...uiSurface(root),
    });
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    const attestation = mintLauncherPairingAttestation({
      secret,
      requestId: randomUUID(),
      issuedAtMs: Date.now(),
    });
    const paired = await request(
      origin,
      undefined,
      "pair",
      "/api/coding-workbench/app-session/pair",
      attestation,
    );
    const cookie = paired.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.ok(cookie.length > 0);
    await runSelectedJourney(origin, cookie, session, projectPath, modelId, secret);
    await requireLicense(session);
  } finally {
    server?.closeAllConnections();
    if (server) await new Promise((resolve) => server.close(resolve));
    await deps.dispose?.();
    rmSync(root, { recursive: true, force: true });
  }
}
await main().catch((error) => {
  console.log(
    JSON.stringify({
      operation: "jira-chat-live-read",
      passed: false,
      errorType: error instanceof Error ? error.name : "unknown",
      sourceLine:
        error instanceof Error ? Number(error.stack?.match(/chat-read\.mjs:(\d+)/)?.[1] ?? 0) : 0,
    }),
  );
  process.exitCode = 1;
});
