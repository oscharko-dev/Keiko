import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { Buffer } from "node:buffer";
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
import {
  actorDetails,
  labSessionConnection,
  loadSession,
  readPrivateFile,
  requireLicense,
} from "./lab-client.mjs";
import { sessionVerificationPort } from "./product-port.mjs";
import { establishedReadGrant } from "./read-grant.mjs";
import { prepareLabRun } from "./run-preflight.mjs";
import { drainLiveChatTurns } from "./chat-lifecycle.mjs";
import { createOwnedLiveChatProcess, runOwnedLiveChatLifecycle } from "./owned-live-chat.mjs";

let ownedEvidenceFailure;

process.on("warning", (warning) => {
  if (warning.code !== "KEIKO_LOG_SINK_FAILED") return;
  process.exitCode = 1;
  ownedEvidenceFailure?.();
  console.log(
    JSON.stringify({ operation: "jira-chat-live-read", passed: false, stage: "activity-log" }),
  );
});

/** Where the lab's live Keiko writes its Activity Log; a lane's state directory holds none. */
export const chatReadLogDirectory = (session) => join(session.directory, "chat-read-logs");

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
    throw failedStage(name, response.status);
  }
  return response;
}
function failedStage(_name, status, _failure) {
  console.log(
    JSON.stringify({
      operation: "jira-chat-live-http",
      stage: "request-failed",
      status: Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : 0,
      failureClass: "http-status",
    }),
  );
  return new TypeError("Live Chat HTTP stage failed");
}
// A buffered Chat turn sends its response headers only when the turn ends. Global fetch gives up
// on headers after five minutes, which is shorter than an accepted turn's Authority Envelope
// (#4175), so loopback JSON requests use node:http without a response timeout. A global fetch the
// caller replaced (instrumentation or a test transport) is honoured as given.
const NATIVE_FETCH = globalThis.fetch;
function loopbackJson(origin, cookie, path, body, method, signal) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      new URL(path, origin),
      {
        method,
        signal,
        headers: {
          Origin: origin,
          "X-Keiko-CSRF": "1",
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
          ...(payload === undefined ? {} : { "Content-Length": Buffer.byteLength(payload) }),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}
export async function jsonRequest(origin, cookie, name, path, body, method = "POST", signal) {
  if (!origin.startsWith("http:") || globalThis.fetch !== NATIVE_FETCH) {
    const response = await request(origin, cookie, name, path, body, method, signal);
    return response.status === 204 ? null : response.json();
  }
  const { status, text } = await loopbackJson(origin, cookie, path, body, method, signal);
  const ok = status >= 200 && status < 300;
  // A successful mutation without a body (204) has nothing to parse.
  if (status === 204) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // An error status still names its stage; a successful body must be JSON like request().json().
    if (ok) throw new TypeError(`${name} returned an unparsable body`, { cause: error });
    parsed = {};
  }
  if (!ok) throw failedStage(name, status, parsed);
  return parsed;
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
  // The configured capability (window, output bound) is the model's own; the laboratory must not
  // shrink it, or every long Jira turn fails on a limit the product never chose (#4175).
  const capability = config.capabilities?.find((entry) => entry.id === modelId);
  return { provider, capability, env: { [`KEIKO_MODEL_${token}_API_KEY`]: apiKey } };
}
// The gateway takes whole output limits only, and 0 means the model declared none.
function simulatedOutputLimit(base, simulated) {
  if (base.maxOutputTokens === 0) return 0;
  return Math.min(base.maxOutputTokens, Math.max(1, Math.floor(simulated / 8)));
}
// KEIKO_JIRA_LAB_CONTEXT_WINDOW deliberately simulates a smaller model on the same endpoint.
function chatCapability(modelId, configured) {
  const simulated = Number(process.env.KEIKO_JIRA_LAB_CONTEXT_WINDOW ?? "");
  const base = {
    ...createDefaultChatCapability(modelId),
    contextWindow: configured?.contextWindow ?? 32768,
    maxOutputTokens: configured?.maxOutputTokens ?? 2048,
  };
  return {
    ...base,
    ...(Number.isSafeInteger(simulated) && simulated > 0
      ? { contextWindow: simulated, maxOutputTokens: simulatedOutputLimit(base, simulated) }
      : {}),
    streaming: true,
    toolCalling: true,
  };
}
function liveModelProviders(modelId, { modelRetries = 0, embeddingModelId } = {}) {
  assertLiveModelOptions(modelId, modelRetries, embeddingModelId);
  const sources = [modelId, ...(embeddingModelId === undefined ? [] : [embeddingModelId])].map(
    (id) => {
      const selected = selectedGatewayProvider(id);
      return {
        capability: selected?.capability,
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
    capability: chatCapability(modelId, sources[0].capability),
    env: Object.assign({}, ...sources.map((source) => source.env)),
    additionalProviders: sources.slice(1).map((source) => source.provider),
    embeddingCapabilities:
      embeddingModelId === undefined
        ? []
        : [sources[1].capability ?? createDefaultEmbeddingCapability(embeddingModelId)],
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
  const { provider, capability, additionalProviders, embeddingCapabilities, env } =
    prepared ?? liveModelProviders(modelId, options);
  const raw = {
    providers: [provider, ...additionalProviders],
    capabilities: [capability, ...embeddingCapabilities],
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
async function createVerifiedPod(origin, cookie, session, actor, administration = false) {
  actorDetails(actor);
  if (actor === "admin" && !administration)
    throw new TypeError("The laboratory administrator requires explicit qualification scope");
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
      baseUrl: labSessionConnection(session).httpsOrigin,
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
  return credential;
}
/**
 * A new Chat's tool mode is Full access (owner decision 2026-11-02). A scenario that proves a write
 * approval passes its own mode, so the Chat asks exactly as the scenario expects.
 */
export async function prepareChat(
  origin,
  cookie,
  session,
  projectPath,
  modelId,
  actor = "api",
  toolMode = undefined,
  administration = false,
) {
  const credential = await createVerifiedPod(origin, cookie, session, actor, administration);
  const created = await jsonRequest(origin, cookie, "chat-create", "/api/chats", {
    projectPath,
    title: "Synthetic Jira live Chat",
    selectedModel: modelId,
  });
  return bindVerifiedChat(origin, cookie, created.chat, credential, toolMode, administration);
}

/** Private qualification state uses the real store without inventing a gateway/model provider. */
export async function prepareModelFreeChat(context, actor = "api", administration = false) {
  assert.equal(context.deps.gatewayConfig.current(), undefined);
  const credential = await createVerifiedPod(
    context.origin,
    context.cookie,
    context.session,
    actor,
    administration,
  );
  const created = context.deps.store.createChat(
    context.projectPath,
    "Synthetic model-free API qualification",
    "model-free-qualification",
  );
  const observed = await jsonRequest(
    context.origin,
    context.cookie,
    "qualification-chat-observe",
    `/api/chats?id=${encodeURIComponent(created.id)}&projectPath=${encodeURIComponent(context.projectPath)}`,
    undefined,
    "GET",
  );
  const chat = observed.chats.find((entry) => entry.id === created.id);
  assert.ok(chat);
  return bindVerifiedChat(
    context.origin,
    context.cookie,
    chat,
    credential,
    "autonomous-delivery",
    administration,
  );
}

async function bindVerifiedChat(origin, cookie, chat, credential, toolMode, administration) {
  let bound = await jsonRequest(
    origin,
    cookie,
    "chat-bind",
    `/api/chats?id=${encodeURIComponent(chat.id)}`,
    {
      jiraPodId: credential.livePod.podId,
      ...(toolMode === undefined ? {} : { toolMode }),
      expectedGroundingScopeIdentity: chat.groundingScopeIdentity,
    },
    "PATCH",
  );
  assert.equal(bound.chat.jiraPodBinding.podId, credential.livePod.podId);
  if (administration) {
    bound = await jsonRequest(
      origin,
      cookie,
      "chat-administration-enable",
      `/api/chats?id=${encodeURIComponent(chat.id)}`,
      {
        jiraAdministrationEnabled: true,
        expectedGroundingScopeIdentity: bound.chat.groundingScopeIdentity,
      },
      "PATCH",
    );
    assert.equal(bound.chat.jiraAdministrationEnabled, true);
    assert.equal(bound.chat.jiraPodBinding.podId, credential.livePod.podId);
  }
  if (toolMode !== undefined) assert.equal(bound.chat.toolMode, toolMode);
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
/**
 * A read never waits for a person: the route that decided it is gone and the server establishes
 * the grant itself. Observing the turn therefore only proves that no grant is ever pending.
 */
async function observeNoConsent(origin, cookie, chat, projectPath, signal, settled) {
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
    for (const message of messages.messages) establishedReadGrant(message);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
  }
}
function assertCompletedRead(completed) {
  const user = completed.messages.find((message) => message.role === "user");
  assert.equal(user.turnState, "completed");
  assert.ok(establishedReadGrant(user), "The server establishes the read grant itself");
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
    await observeNoConsent(origin, cookie, chat, projectPath, controller.signal, () => settled);
    const completed = await pending;
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
  const activityLog = createFileServerLogSink(chatReadLogDirectory(session), {
    level: "debug",
  });
  setServerLogger(createServerLogger({ sink: activityLog, level: "debug" }));
  return buildUiHandlerDeps({
    configPath: join(root, "keiko.config.json"),
    evidenceDir: join(root, "evidence"),
    uiDbPath: join(root, "ui.db"),
    env: {
      ...modelEnv,
      KEIKO_OS_KEYCHAIN: "off",
      KEIKO_MEMORY_DIR: join(root, "memory"),
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
async function pairedCookie(origin, secret, signal) {
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
    "POST",
    signal,
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

function decorateCredentialTransport(deps, decorate, session, decoratePrivate) {
  const credentials = deps.atlassianConnectorCredentials;
  assert.ok(credentials);
  const factory = credentials.httpBodyPortFactory.bind(credentials);
  const observed = (metadata, correlationId, lifecycle) =>
    sessionVerificationPort(session, factory(metadata, correlationId, lifecycle));
  credentials.httpBodyPortFactory = decorate === undefined ? observed : decorate(observed);
  // The private session and avatar transport takes only the product's lifecycle hooks; an
  // observer wraps them without changing a request, a response or the custody it belongs to.
  const privateFactory = credentials.jiraPrivatePortFactory;
  if (decoratePrivate !== undefined && privateFactory !== undefined)
    credentials.jiraPrivatePortFactory = (metadata, context, options, lifecycle) =>
      privateFactory(metadata, context, options, decoratePrivate(lifecycle));
}

function createLiveUiServer({ port, deps, root, browser, configureServer }) {
  const server = createUiServer({ port, handlerDeps: deps, ...uiSurface(root, browser) });
  configureServer?.({ server, store: deps.store });
  return server;
}

async function closeLiveProduct(server, deps, projectPath) {
  try {
    server?.closeAllConnections();
    if (server) await new Promise((resolve) => server.close(resolve));
  } finally {
    try {
      await drainLiveChatTurns(deps, projectPath);
    } finally {
      await deps.dispose?.();
    }
  }
}

/** The one server/dependency/model lifecycle, shared by in-process and owned-child qualification. */
async function startLiveProduct({
  root,
  session,
  secret,
  retainState,
  restoring,
  model,
  browser,
  decorateAtlassianHttp,
  decoratePrivateLifecycle,
  configureServer,
  port,
}) {
  const projectPath = join(root, "workspace");
  mkdirSync(projectPath, { recursive: true });
  const deps = createLiveDeps(root, session, secret, retainState, restoring, model.env);
  let server;
  try {
    decorateCredentialTransport(deps, decorateAtlassianHttp, session, decoratePrivateLifecycle);
    await model.configure(deps);
    if (!deps.store.listProjects().some((project) => project.path === projectPath))
      deps.store.createProject(projectPath);
    const selectedPort = port ?? (await unusedPort());
    server = createLiveUiServer({ port: selectedPort, deps, root, browser, configureServer });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(selectedPort, "127.0.0.1", resolve);
    });
    return {
      port: selectedPort,
      projectPath,
      deps,
      close: () => closeLiveProduct(server, deps, projectPath),
    };
  } catch (error) {
    await closeLiveProduct(server, deps, projectPath);
    throw error;
  }
}

function validateOwnedLiveOptions(options) {
  const allowed = new Set([
    "sessionDir",
    "root",
    "secret",
    "modelId",
    "modelRetries",
    "embeddingModelId",
    "browser",
    "restoring",
    "port",
  ]);
  if (
    Object.keys(options).some((key) => !allowed.has(key)) ||
    process.env.KEIKO_OS_KEYCHAIN !== "off"
  )
    throw new TypeError("owned-lab-invalid-initialization");
}

function bindOwnedEvidenceFailure(observer) {
  ownedEvidenceFailure = observer;
  if (process.exitCode === 1) {
    ownedEvidenceFailure?.();
    throw new TypeError("owned-lab-evidence-unavailable");
  }
}

/** Internal IPC entry: ordinary composition, same persisted state and credential-key owner. */
export async function startOwnedLiveChatServer(options, { onEvidenceFailure } = {}) {
  validateOwnedLiveOptions(options);
  if (
    typeof options.root !== "string" ||
    typeof options.sessionDir !== "string" ||
    !Number.isSafeInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  )
    throw new TypeError("owned-lab-invalid-initialization");
  const session = loadSession(options.sessionDir);
  const root = liveStateDirectory(session, true, options.root);
  bindOwnedEvidenceFailure(onEvidenceFailure);
  if (
    typeof options.secret !== "string" ||
    !/^[0-9a-f]{96}$/u.test(options.secret) ||
    !options.modelId
  )
    throw new TypeError("owned-lab-invalid-initialization");
  const model = prepareLiveModel(root, session, options.modelId, {
    modelRetries: options.modelRetries,
    embeddingModelId: options.embeddingModelId,
  });
  return startLiveProduct({ ...options, root, session, model, retainState: true });
}

function ownedLiveContext(options, root, secret, controller) {
  let cookie;
  const pair = async (signal) => {
    cookie = await pairedCookie(
      controller.origin,
      secret,
      globalThis.AbortSignal.any([
        globalThis.AbortSignal.timeout(30000),
        ...(signal ? [signal] : []),
      ]),
    );
  };
  const live = {
    session: options.session,
    modelId: options.modelId,
    root,
    secret,
    projectPath: join(root, "workspace"),
    get origin() {
      return controller.origin;
    },
    get cookie() {
      return cookie;
    },
    restartServer: async (restartOptions = {}) => {
      const began = globalThis.performance.now();
      await controller.restart(restartOptions);
      await pair(restartOptions.signal);
      return { restarted: true, downtimeMs: Math.ceil(globalThis.performance.now() - began) };
    },
  };
  return { live, pair };
}

async function withOwnedLiveChat(options) {
  if (!options.retainState || options.decorateAtlassianHttp || options.configureServer)
    throw new TypeError(
      "Owned laboratory children require retained state and serializable lifecycle options",
    );
  await requireLicense(options.session);
  const root = liveStateDirectory(options.session, true, options.restoreState);
  options.stateReady?.(root);
  const secret = randomBytes(48).toString("hex");
  const controller = createOwnedLiveChatProcess({
    port: await unusedPort(),
    initialization: {
      sessionDir: options.session.directory,
      root,
      secret,
      modelId: options.modelId,
      modelRetries: options.modelRetries,
      embeddingModelId: options.embeddingModelId,
      browser: options.browser,
      restoring: options.restoreState !== undefined,
    },
  });
  const context = ownedLiveContext(options, root, secret, controller);
  return runOwnedLiveChatLifecycle({
    run: async () => {
      await controller.start();
      await context.pair();
      await options.run(context.live);
      assert.notEqual(process.exitCode, 1);
    },
    close: () => controller.close(),
    audit: () => requireLicense(options.session),
  });
}

/** Reuse the paired production server, vault, real model probe and ordinary Chat routes. */
export async function withLiveChat({
  session,
  modelId,
  run,
  // KEIKO_JIRA_LAB_RETAIN_STATE=1 keeps a journey's Chat database in the private session to diagnose it.
  retainState = process.env.KEIKO_JIRA_LAB_RETAIN_STATE === "1",
  stateReady,
  browser = false,
  restoreState,
  decorateAtlassianHttp,
  configureServer,
  modelRetries,
  embeddingModelId,
  ownedChild = false,
}) {
  if (!modelId) throw new TypeError("A locally installed model is required");
  return withLabProduct({
    session,
    modelId,
    run,
    retainState,
    stateReady,
    browser,
    restoreState,
    decorateAtlassianHttp,
    configureServer,
    ownedChild,
    modelRetries,
    embeddingModelId,
    prepareModel: (root) =>
      prepareLiveModel(root, session, modelId, { modelRetries, embeddingModelId }),
  });
}

/** Same paired server/vault/transport as the Chat lab, with no provider or model probe. */
export async function withModelFreeJira({
  session,
  run,
  stateReady,
  decorateAtlassianHttp,
  decoratePrivateLifecycle,
}) {
  return withLabProduct({
    session,
    run,
    stateReady,
    decorateAtlassianHttp,
    decoratePrivateLifecycle,
    modelId: undefined,
    retainState: true,
    browser: false,
    prepareModel: () => ({
      env: { KEIKO_CA_BUNDLE_PATH: join(session.directory, "secrets", "tls", "ca.pem") },
      configure: () => undefined,
    }),
  });
}

async function withLabProduct(options) {
  const release = await prepareLabRun(options.session);
  try {
    return await (options.ownedChild ? withOwnedLiveChat(options) : runLabProduct(options));
  } finally {
    release();
  }
}

async function runLabProduct({
  session,
  modelId,
  run,
  retainState,
  stateReady,
  browser,
  restoreState,
  decorateAtlassianHttp,
  decoratePrivateLifecycle,
  configureServer,
  prepareModel,
}) {
  await requireLicense(session);
  const root = liveStateDirectory(session, retainState, restoreState);
  const projectPath = join(root, "workspace");
  mkdirSync(projectPath, { recursive: true });
  const secret = randomBytes(48).toString("hex");
  stateReady?.(root);
  const model = prepareModel(root);
  let product;
  try {
    product = await startLiveProduct({
      root,
      session,
      secret,
      retainState,
      restoring: restoreState !== undefined,
      model,
      browser,
      decorateAtlassianHttp,
      decoratePrivateLifecycle,
      configureServer,
    });
    const origin = `http://127.0.0.1:${product.port}`;
    const cookie = await pairedCookie(origin, secret);
    await run({ origin, cookie, session, projectPath, modelId, secret, root, deps: product.deps });
    await requireLicense(session);
    assert.notEqual(process.exitCode, 1);
  } finally {
    await product?.close();
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
