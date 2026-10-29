import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  createDefaultEmbeddingCapability,
  toolCallingConfigurationFingerprint,
} from "../../../packages/keiko-model-gateway/dist/index.js";
import { createProviderSecretResolver } from "../../../packages/keiko-server/dist/credentialVault.js";
import { probeGatewayToolCalling } from "../../../packages/keiko-server/dist/gateway-tool-calling-probe.js";
import {
  mintLauncherPairingAttestation,
  SESSION_PAIRING_LAUNCHER_SECRET_ENV,
} from "../../../packages/keiko-server/dist/coding-app-session/launcherSessionPairingPort.js";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session-pairing";
import { actorDetails, loadSession, readPrivateFile, requireLicense } from "./lab-client.mjs";
import { drainLiveChatTurns } from "./chat-lifecycle.mjs";

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
export async function request(origin, cookie, name, path, body, method = "POST", signal) {
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
export async function jsonRequest(origin, cookie, name, path, body, method, signal) {
  return (await request(origin, cookie, name, path, body, method, signal)).json();
}
function assertLiveModelOptions(modelId, modelRetries, embeddingModelId) {
  if (modelRetries !== 0 && modelRetries !== 1)
    throw new TypeError("Live model retries must be zero or one");
  if (
    embeddingModelId !== undefined &&
    (typeof embeddingModelId !== "string" ||
      embeddingModelId.trim() !== embeddingModelId ||
      !embeddingModelId ||
      embeddingModelId === modelId)
  )
    throw new TypeError("A distinct nonempty embedding model is required");
}
function selectedGatewayProvider(modelId) {
  const configPath = process.env.KEIKO_JIRA_LAB_GATEWAY_CONFIG;
  if (configPath === undefined) return undefined;
  const raw = JSON.parse(readPrivateFile(configPath));
  const secretResolver = createProviderSecretResolver({ configPath, env: process.env });
  const config = parseGatewayConfig(raw, {}, { secretResolver });
  const selected = config.providers.find((provider) => provider.modelId === modelId);
  if (selected === undefined) throw new TypeError("Selected laboratory model is not configured");
  if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(new URL(selected.baseUrl).hostname))
    throw new TypeError("Jira qualification requires a local model Gateway");
  const {
    apiKey,
    apiKeySecretRef: _reference,
    apiKeySourceModelId: _source,
    ...provider
  } = selected;
  if (typeof apiKey !== "string" || apiKey.length === 0)
    throw new TypeError("Configured laboratory model credential is unavailable");
  const token = modelId.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase();
  return { provider, env: { [`KEIKO_MODEL_${token}_API_KEY`]: apiKey } };
}
function liveModelProviders(modelId, { modelRetries = 0, embeddingModelId } = {}) {
  assertLiveModelOptions(modelId, modelRetries, embeddingModelId);
  const sources = [modelId, ...(embeddingModelId === undefined ? [] : [embeddingModelId])].map(
    (id) => {
      const selected = selectedGatewayProvider(id);
      return {
        provider: {
          ...(selected?.provider ?? {
            modelId: id,
            baseUrl: "http://127.0.0.1:11434/v1",
            apiKey: "ollama-local",
          }),
          timeoutMs: selected?.provider.timeoutMs ?? 45000,
          maxRetries: modelRetries,
          retryBaseDelayMs: 1,
        },
        env: selected?.env ?? {},
      };
    },
  );
  return {
    provider: sources[0].provider,
    env: Object.assign({}, ...sources.map((source) => source.env)),
    additionalProviders: sources.slice(1).map((source) => source.provider),
    embeddingCapabilities:
      embeddingModelId === undefined ? [] : [createDefaultEmbeddingCapability(embeddingModelId)],
  };
}
function prepareLiveModel(root, session, modelId, options) {
  const prepared = liveModelProviders(modelId, options);
  return {
    env: prepared.env,
    configure: (deps) =>
      configureModel(deps, modelId, session, join(root, "keiko.config.json"), options, prepared),
  };
}
export async function configureModel(deps, modelId, session, configPath, options, prepared) {
  const { provider, additionalProviders, embeddingCapabilities, env } =
    prepared ?? liveModelProviders(modelId, options);
  const capability = {
    ...createDefaultChatCapability(modelId),
    contextWindow: 32768,
    maxOutputTokens: 2048,
    streaming: true,
    toolCalling: true,
  };
  const raw = {
    providers: [provider, ...additionalProviders],
    capabilities: [capability, ...embeddingCapabilities],
    atlassian: {
      privateTargets: [{ baseUrl: "https://127.0.0.1:18443", addressClass: "loopback" }],
    },
    egress: { caBundlePath: join(session.directory, "secrets", "tls", "ca.pem") },
  };
  const parsed = parseGatewayConfig(raw, env);
  const resolved = parsed.providers.find((entry) => entry.modelId === modelId);
  assert.ok(resolved);
  const probe = await probeGatewayToolCalling(parsed, resolved);
  assert.equal(probe, "verified");
  const proof = {
    status: "verified",
    checkedAt: new Date().toISOString(),
    probe: "gateway-tool-calling-v1",
    configurationFingerprint: toolCallingConfigurationFingerprint(resolved),
  };
  const configured = {
    ...raw,
    capabilities: [{ ...capability, toolCallingVerification: proof }, ...embeddingCapabilities],
  };
  writeFileSync(configPath, JSON.stringify(configured), { mode: 0o600 });
  deps.gatewayConfig.set(parseGatewayConfig(configured, env), true);
  deps.gatewayConfig.recordVerifiedCapability(
    modelId,
    { conversationReady: true },
    new Date().toISOString(),
  );
  console.log(JSON.stringify({ operation: "jira-chat-live-model", verified: true }));
}
export async function prepareChat(origin, cookie, session, projectPath, modelId, actor = "api") {
  actorDetails(actor);
  if (actor === "admin") throw new TypeError("The laboratory administrator has no synthetic PAT");
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
      apiToken: readPrivateFile(join(session.directory, "secrets", `${actor}-token`)),
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
function createLiveDeps(root, session, secret, retainState, restoring = false, modelEnv = {}) {
  const credentialKey = restoring
    ? readPrivateFile(join(root, "credential-key"))
    : randomBytes(32).toString("base64");
  if (retainState && !restoring)
    writeFileSync(join(root, "credential-key"), credentialKey, { mode: 0o600, flag: "wx" });
  const activityLog = createFileServerLogSink(join(session.directory, "chat-read-logs"), {
    level: "debug",
  });
  setServerLogger(createServerLogger({ sink: activityLog, level: "debug" }));
  return buildUiHandlerDeps({
    configPath: join(root, "keiko.config.json"),
    evidenceDir: join(root, "evidence"),
    uiDbPath: join(root, "ui.db"),
    env: {
      ...modelEnv,
      [SESSION_PAIRING_LAUNCHER_SECRET_ENV]: secret,
      KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY: credentialKey,
    },
    activityLog,
  });
}
function uiSurface(root, browser) {
  if (!browser) return { staticRoot: root, csp: "default-src 'self'" };
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
async function pairedCookie(origin, secret) {
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
  return cookie;
}

function liveStateDirectory(session, retainState, restoreState) {
  if (restoreState !== undefined && !retainState)
    throw new TypeError("A reopened laboratory state must be retained");
  const root =
    restoreState === undefined
      ? mkdtempSync(
          join(retainState ? session.directory : realpathSync(tmpdir()), "keiko-jira-live-chat-"),
        )
      : realpathSync(restoreState);
  if (
    restoreState !== undefined &&
    !root.startsWith(`${realpathSync(session.directory)}/keiko-jira-live-chat-`)
  )
    throw new TypeError("Reopened state must belong to this synthetic laboratory session");
  return root;
}

function decorateCredentialTransport(deps, decorate) {
  if (decorate === undefined) return;
  const credentials = deps.atlassianConnectorCredentials;
  assert.ok(credentials);
  credentials.httpBodyPortFactory = decorate(credentials.httpBodyPortFactory.bind(credentials));
}

function createLiveUiServer({ port, deps, root, browser, configureServer }) {
  const server = createUiServer({ port, handlerDeps: deps, ...uiSurface(root, browser) });
  configureServer?.({ server, store: deps.store });
  return server;
}

/** Reuse the paired production server, vault, real model probe and ordinary Chat routes. */
export async function withLiveChat({
  session,
  modelId,
  run,
  retainState = false,
  stateReady,
  browser = false,
  restoreState,
  decorateAtlassianHttp,
  configureServer,
  modelRetries,
  embeddingModelId,
}) {
  if (!modelId) throw new TypeError("A locally installed model is required");
  await requireLicense(session);
  const root = liveStateDirectory(session, retainState, restoreState);
  const projectPath = join(root, "workspace");
  mkdirSync(projectPath, { recursive: true });
  const secret = randomBytes(48).toString("hex");
  stateReady?.(root);
  const model = prepareLiveModel(root, session, modelId, { modelRetries, embeddingModelId });
  const restoring = restoreState !== undefined;
  const deps = createLiveDeps(root, session, secret, retainState, restoring, model.env);
  decorateCredentialTransport(deps, decorateAtlassianHttp);
  let server;
  try {
    await model.configure(deps);
    if (!deps.store.listProjects().some((project) => project.path === projectPath))
      deps.store.createProject(projectPath);
    const port = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    server = createLiveUiServer({ port, deps, root, browser, configureServer });
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    const cookie = await pairedCookie(origin, secret);
    await run({ origin, cookie, session, projectPath, modelId, secret, root });
    await requireLicense(session);
    assert.notEqual(process.exitCode, 1);
  } finally {
    server?.closeAllConnections();
    if (server) await new Promise((resolve) => server.close(resolve));
    await drainLiveChatTurns(deps, projectPath);
    await deps.dispose?.();
    if (!retainState) rmSync(root, { recursive: true, force: true });
  }
}
async function main() {
  await withLiveChat({
    session: loadSession(process.argv[2]),
    modelId: process.argv[3],
    browser: process.argv[4] === "--browser",
    run: ({ origin, cookie, session, projectPath, modelId, secret }) =>
      runSelectedJourney(origin, cookie, session, projectPath, modelId, secret),
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
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
