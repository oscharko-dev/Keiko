import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const directory = process.env.KEIKO_E2E_JIRA_STATE;
if (!directory) throw new TypeError("KEIKO_E2E_JIRA_STATE is required");
const port = Number(process.env.KEIKO_E2E_UI_PORT ?? "33581");
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
    contextWindow: 32768,
    maxOutputTokens: 2048,
  })),
  atlassian: { privateTargets: [{ baseUrl: transport.baseUrl, addressClass: "loopback" }] },
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
    [SESSION_PAIRING_LAUNCHER_SECRET_ENV]: secret,
    KEIKO_ATLASSIAN_CONNECTOR_CREDENTIALS_KEY: randomBytes(32).toString("base64"),
  },
  activityLog: log,
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
  ["approval", "revocation", "unavailable", "accessibility-en", "accessibility-de"].map((name) => [
    name,
    deps.store.createChat(
      projectPath,
      `Jira browser ${name}`,
      name === "unavailable" ? unavailableModelId : modelId,
    ),
  ]),
);
writeFileSync(
  join(directory, "fixture.json"),
  JSON.stringify({
    secret,
    projectPath,
    chats,
    modelId,
    unavailableModelId,
    jiraBaseUrl: transport.baseUrl,
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
