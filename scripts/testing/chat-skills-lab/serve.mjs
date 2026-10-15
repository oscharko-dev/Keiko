import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.cwd();
const built = async (path) => import(pathToFileURL(join(root, path)).href);
const { buildDevBffEnv, applyProcessWideEvidenceEnv } = await built("scripts/lib/dev-bff-env.mjs");
const {
  buildCspHeader,
  buildUiHandlerDeps,
  checkActivityLogReadiness,
  createUiServer,
  loadCspHeader,
  UI_HOST,
} = await built("packages/keiko-server/dist/index.js");
const env = buildDevBffEnv({
  repoRoot: root,
  processEnv: process.env,
  stateDir: process.env.KEIKO_STATE_DIR,
});
applyProcessWideEvidenceEnv(env, process.env);
const staticRoot = process.env.KEIKO_SKILL_LAB_STATIC_ROOT ?? join(env.KEIKO_STATE_DIR, "static");
mkdirSync(staticRoot, { recursive: true });
if (!process.env.KEIKO_SKILL_LAB_STATIC_ROOT)
  writeFileSync(
    join(staticRoot, "index.html"),
    "<!doctype html><title>Private Chat qualification</title>\n",
  );
const deps = buildUiHandlerDeps({
  configPath: env.KEIKO_CONFIG_FILE,
  evidenceDir: env.KEIKO_EVIDENCE_DIR,
  uiDbPath: join(env.KEIKO_UI_DATA_DIR, "keiko-ui.db"),
  env,
  initialProjectPath: env.KEIKO_INITIAL_PROJECT_PATH,
  closeActivityLogOnDispose: true,
});
const readiness = checkActivityLogReadiness({ stateDir: env.KEIKO_STATE_DIR, env });
if (readiness.readiness !== "ready") throw new Error("Private qualification evidence unavailable");
const csp = process.env.KEIKO_SKILL_LAB_STATIC_ROOT
  ? await loadCspHeader(join(root, "dist/ui/csp-hashes.json"))
  : buildCspHeader([]);
const descriptor = { staticRoot, csp, port: 0, handlerDeps: deps };
const server = createUiServer(descriptor);
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, UI_HOST, resolve);
});
descriptor.port = server.address().port;
process.send?.({ kind: "ready", port: descriptor.port });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  await deps.dispose?.();
  process.exit(0);
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
process.on("message", (message) => {
  if (message === "stop") void close();
});
