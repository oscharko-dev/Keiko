import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { clearInterval, setInterval } from "node:timers";
import { fileURLToPath } from "node:url";
import {
  buildCspHeader,
  buildUiHandlerDeps,
  checkActivityLogReadiness,
  createUiServer,
  flushClientDiagnosticsIngestCounts,
  persistActivityLogLossSummary,
  refreshActivityLogReadiness,
  UI_HOST,
} from "../packages/keiko-server/dist/index.js";
import { installProcessGuards } from "../packages/keiko-cli/dist/process-guards.js";
import { shutdownDevBff } from "./lib/dev-bff-shutdown.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = resolve(process.env.KEIKO_STATE_DIR ?? join(repoRoot, ".keiko", "dev"));
const staticRoot = join(stateDir, "static-placeholder");
const port = Number(process.env.KEIKO_DEV_BFF_PORT ?? "1984");
const LOCAL_DOTENV_ENV_NAME_ALLOWLIST = new Set(["FIGMA_ACCESS_TOKEN"]);
const SHUTDOWN_TIMEOUT_MS = 30_000;
// The heartbeat `keiko ui` uses to re-evaluate readiness and persist the loss summary.
const EVIDENCE_HEARTBEAT_MS = 60_000;

function parseEnvValue(raw) {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === `"` && last === `"`) || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function loadLocalKeikoEnv(env) {
  const file = join(repoRoot, ".env");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return env;
  }
  const merged = { ...env };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!/^KEIKO_[A-Z0-9_]+$/.test(key) && !LOCAL_DOTENV_ENV_NAME_ALLOWLIST.has(key)) continue;
    if (merged[key] !== undefined) continue;
    merged[key] = parseEnvValue(line.slice(equals + 1));
  }
  return merged;
}

function ensureStaticPlaceholder() {
  mkdirSync(staticRoot, { recursive: true });
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>Keiko Dev BFF</title>\n");
}

// Port 0 binds an ephemeral port (a hermetic test); the dev runner always passes a fixed one.
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Invalid KEIKO_DEV_BFF_PORT: ${String(process.env.KEIKO_DEV_BFF_PORT)}`);
  process.exit(2);
}

// The product's own crash evidence: an uncaught exception or unhandled rejection is written as a
// body-free `process.fatal` line before the process exits, as `keiko ui` does.
installProcessGuards();
ensureStaticPlaceholder();
const env = loadLocalKeikoEnv({
  ...process.env,
  KEIKO_STATE_DIR: stateDir,
  KEIKO_UI_DATA_DIR: process.env.KEIKO_UI_DATA_DIR ?? join(stateDir, "ui"),
  KEIKO_MEMORY_DIR: process.env.KEIKO_MEMORY_DIR ?? join(stateDir, "memory"),
});
const initialProjectPath = env.KEIKO_INITIAL_PROJECT_PATH ?? repoRoot;

const handlerDeps = buildUiHandlerDeps({
  configPath: env.KEIKO_CONFIG_FILE,
  evidenceDir: env.KEIKO_EVIDENCE_DIR,
  uiDbPath: env.KEIKO_UI_DB,
  env,
  initialProjectPath,
  // The dev BFF owns its Activity Log for its whole life, like `keiko ui`: dispose seals it last,
  // so a restart leaves no active segment for the next process to recover as an orphan.
  closeActivityLogOnDispose: true,
});
// The startup readiness check `keiko ui` runs before it listens: a real write probe, persisted as
// `activity-log.readiness`, so `/api/health` never reports a readiness nothing evaluated.
const readiness = checkActivityLogReadiness({ stateDir, env });
if (readiness.readiness !== "ready") {
  console.error(
    `[dev:bff] diagnostic evidence is ${readiness.readiness} (${readiness.reasons.join(", ")}).`,
  );
}
const server = createUiServer({
  staticRoot,
  csp: buildCspHeader([]),
  port,
  handlerDeps,
});

server.listen(port, UI_HOST, () => {
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;
  console.log(`[dev:bff] listening on http://${UI_HOST}:${String(bound)}`);
});
const heartbeat = setInterval(() => {
  refreshActivityLogReadiness({ stateDir });
  persistActivityLogLossSummary("heartbeat");
}, EVIDENCE_HEARTBEAT_MS);
heartbeat.unref();

let shutdownStarted = false;

async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  clearInterval(heartbeat);
  flushClientDiagnosticsIngestCounts();
  persistActivityLogLossSummary("exit");
  const outcome = await shutdownDevBff({
    server,
    dispose: () => handlerDeps.dispose?.(),
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });
  if (!outcome.ok) {
    const pending = [
      ...(outcome.serverClosed ? [] : ["http"]),
      ...(outcome.runtimeDisposed ? [] : ["runtime"]),
    ];
    console.error(`[dev:bff] graceful shutdown did not complete (${pending.join("+")}).`);
  }
  process.exit(outcome.ok ? 0 : 1);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
