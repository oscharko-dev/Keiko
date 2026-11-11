import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { SESSION_PAIRING_LAUNCHER_SECRET_ENV } from "../../../packages/keiko-server/dist/coding-app-session/launcherSessionPairingPort.js";
import { startJiraChatTransports } from "./jira-chat-4081-transport.mjs";
import { seedBacklogPod, saveBacklogTemplates } from "./jira-chat-4081-backlog.mjs";

const directory = process.env.KEIKO_E2E_JIRA_STATE;
if (!directory) throw new TypeError("KEIKO_E2E_JIRA_STATE is required");
const port = Number(process.env.KEIKO_E2E_UI_PORT ?? "32381");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const transport = await startJiraChatTransports(directory, port + 1, port + 2);
const modelId = "jira-browser-verified";
const unavailableModelId = "jira-browser-unverified";
const providers = [modelId, unavailableModelId].map((id) => ({
  modelId: id,
  baseUrl: `http://127.0.0.1:${port + 2}/v1`,
  apiKey: "synthetic-model-fixture",
  timeoutMs: 15_000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
}));
const raw = {
  providers,
  capabilities: providers.map((provider) => ({
    ...createDefaultChatCapability(provider.modelId),
    streaming: true,
    toolCalling: true,
    structuredOutput: true,
    supportsResponseFormat: true,
    contextWindow: 131072,
    maxOutputTokens: 2048,
  })),
  egress: { caBundlePath: transport.caPath },
};
const verdict = await probeGatewayToolCalling(parseGatewayConfig(raw), providers[0]);
if (verdict !== "verified") throw new TypeError("Synthetic gateway tool-calling probe failed");
raw.capabilities[0].toolCallingVerification = {
  status: "verified",
  checkedAt: new Date().toISOString(),
  probe: "gateway-tool-calling-v1",
  configurationFingerprint: toolCallingConfigurationFingerprint(providers[0]),
};
const configPath = join(directory, "keiko.config.json");
writeFileSync(configPath, JSON.stringify(raw), { mode: 0o600 });
const secret = randomBytes(48).toString("hex");
const log = createFileServerLogSink(join(directory, "logs"), { level: "debug" });
setServerLogger(createServerLogger({ sink: log, level: "debug" }));
const deps = buildUiHandlerDeps({
  configPath,
  evidenceDir: join(directory, "evidence"),
  uiDbPath: join(directory, "ui.db"),
  env: {
    KEIKO_STATE_DIR: directory,
    KEIKO_MEMORY_DIR: join(directory, "memory"),
    KEIKO_MEMORY_KEY: randomBytes(32).toString("base64"),
    KEIKO_OS_KEYCHAIN: "off",
    [SESSION_PAIRING_LAUNCHER_SECRET_ENV]: secret,
    KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY: randomBytes(32).toString("base64"),
  },
  activityLog: log,
});
Object.defineProperty(deps, "chatToolTurnBudget", {
  enumerable: true,
  get: () =>
    existsSync(join(directory, "draft-deadline.json"))
      ? { maxRuntimeMs: 15_000, maxToolCalls: 100, maxPatchBytes: 0 }
      : undefined,
});
for (const id of [modelId, unavailableModelId]) {
  deps.gatewayConfig.recordVerifiedCapability(
    id,
    { conversationReady: true },
    new Date().toISOString(),
  );
}
const projectPath = join(directory, "workspace");
mkdirSync(projectPath, { recursive: true });
deps.store.createProject(projectPath);
const chats = Object.fromEntries(
  [
    "approval",
    "revocation",
    "pending-stop",
    "unavailable",
    "accessibility-en",
    "accessibility-de",
    "backlog",
    "deadline",
    "batch-reload-en",
    "batch-reload-de",
  ].map((name) => [
    name,
    deps.store.createChat(
      projectPath,
      `Jira browser ${name}`,
      name === "unavailable" ? unavailableModelId : modelId,
    ),
  ]),
);
// Exercise the production Chat store and reload projection without a model or Jira dispatch.
for (const locale of ["en", "de"]) {
  const chat = chats[`batch-reload-${locale}`];
  const clientTurnId = `persisted-batch-${locale}`;
  const turn = deps.store.admitChatTurn(clientTurnId, {
    chatId: chat.id,
    role: "user",
    content: "Synthetic persisted requirements batch",
    timestamp: Date.now(),
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  });
  if (turn.kind !== "admitted") throw new TypeError("Synthetic batch turn was not admitted");
  const call = { id: `batch-${locale}`, name: "jira_draft_batch", arguments: {} };
  deps.store.updateChatToolTranscript(turn.userMessage.id, { kind: "started", call }, clientTurnId);
  deps.store.updateChatToolTranscript(
    turn.userMessage.id,
    {
      kind: "progress",
      callId: call.id,
      batchProgress: {
        phase: "drafting",
        draftedCount: 2,
        plannedCount: 4,
        coveredRequirementCount: 3,
        requirementCount: 8,
        failedCount: 0,
      },
    },
    clientTurnId,
  );
  deps.store.failChatTurn(chat.id, clientTurnId, "cancelled");
}
const backlogPod = await seedBacklogPod(deps);
saveBacklogTemplates(deps);
writeFileSync(
  join(directory, "fixture.json"),
  JSON.stringify({
    secret,
    projectPath,
    chats,
    modelId,
    unavailableModelId,
    jiraBaseUrl: transport.baseUrl,
    backlogPod,
  }),
  { mode: 0o600 },
);
const staticRoot = fileURLToPath(new URL("../../../packages/keiko-ui/out/", import.meta.url));
const hashes = extractInlineScriptHashes([readFileSync(join(staticRoot, "index.html"), "utf8")]);
const server = createUiServer({ port, handlerDeps: deps, staticRoot, csp: buildCspHeader(hashes) });
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  server.close();
  transport.close();
  await deps.dispose?.();
}
process.once("SIGTERM", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});
