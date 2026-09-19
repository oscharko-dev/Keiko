import { mkdirSync, writeFileSync } from "node:fs";
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
  UI_HOST,
} from "../packages/keiko-server/dist/index.js";
import { installProcessGuards } from "../packages/keiko-cli/dist/process-guards.js";
import { buildDevBffEnv, resolveDevBffStateDir } from "./lib/dev-bff-env.mjs";
import { refreshDevBffEvidence } from "./lib/dev-bff-evidence.mjs";
import { shutdownDevBff } from "./lib/dev-bff-shutdown.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = resolveDevBffStateDir({ repoRoot, processEnv: process.env });
const staticRoot = join(stateDir, "static-placeholder");
const port = Number(process.env.KEIKO_DEV_BFF_PORT ?? "1984");
const SHUTDOWN_TIMEOUT_MS = 30_000;
// The heartbeat `keiko ui` uses to re-evaluate readiness and persist the loss summary.
const EVIDENCE_HEARTBEAT_MS = 60_000;

function ensureStaticPlaceholder() {
  mkdirSync(staticRoot, { recursive: true });
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>Keiko Dev BFF</title>\n");
}

// Port 0 binds an ephemeral port (a hermetic test); the dev runner always passes a fixed one.
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Invalid KEIKO_DEV_BFF_PORT: ${String(process.env.KEIKO_DEV_BFF_PORT)}`);
  process.exit(2);
}

// The ONE effective environment every evidence path below shares — the process guards, startup
// readiness, the heartbeat refresh, and every domain composition site — built BEFORE any of them
// runs so none can fall back to a bare `process.env` that disagrees with it (#3557).
const env = buildDevBffEnv({ repoRoot, processEnv: process.env, stateDir });
// The product's own crash evidence: an uncaught exception or unhandled rejection is written as a
// body-free `process.fatal` line before the process exits, as `keiko ui` does — resolved against
// this SAME effective `env`, so the fatal line lands in `stateDir` like everything else this
// process writes, never wherever a bare `process.env` read would resolve to.
installProcessGuards({ env });
ensureStaticPlaceholder();
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
  refreshDevBffEvidence({ stateDir, env });
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
