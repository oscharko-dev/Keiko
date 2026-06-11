import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import {
  buildCspHeader,
  buildUiHandlerDeps,
  createUiServer,
  UI_HOST,
} from "../packages/keiko-server/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = resolve(process.env.KEIKO_STATE_DIR ?? join(repoRoot, ".keiko", "dev"));
const staticRoot = join(stateDir, "static-placeholder");
const port = Number(process.env.KEIKO_DEV_BFF_PORT ?? "1984");

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
    if (!/^KEIKO_[A-Z0-9_]+$/.test(key)) continue;
    if (merged[key] !== undefined) continue;
    merged[key] = parseEnvValue(line.slice(equals + 1));
  }
  return merged;
}

function ensureStaticPlaceholder() {
  mkdirSync(staticRoot, { recursive: true });
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>Keiko Dev BFF</title>\n");
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid KEIKO_DEV_BFF_PORT: ${String(process.env.KEIKO_DEV_BFF_PORT)}`);
  process.exit(2);
}

ensureStaticPlaceholder();
const env = loadLocalKeikoEnv({
  ...process.env,
  KEIKO_STATE_DIR: stateDir,
  KEIKO_UI_DATA_DIR: process.env.KEIKO_UI_DATA_DIR ?? join(stateDir, "ui"),
  KEIKO_MEMORY_DIR: process.env.KEIKO_MEMORY_DIR ?? join(stateDir, "memory"),
});

const server = createUiServer({
  staticRoot,
  csp: buildCspHeader([]),
  port,
  handlerDeps: buildUiHandlerDeps({
    configPath: env.KEIKO_CONFIG_FILE,
    evidenceDir: env.KEIKO_EVIDENCE_DIR,
    uiDbPath: env.KEIKO_UI_DB,
    env,
    initialProjectPath: repoRoot,
  }),
});

server.listen(port, UI_HOST, () => {
  console.log(`[dev:bff] listening on http://${UI_HOST}:${String(port)}`);
});

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
