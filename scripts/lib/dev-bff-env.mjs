import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// The dev BFF's effective environment and state directory, shared by the process itself and by its
// tests so the exact same merge/default logic backs both (#3557 review findings 1 and 2 — the
// fatal process guard and the heartbeat readiness refresh must resolve the SAME effective
// environment as every other evidence path in this process, never a silently different bare
// `process.env`).

const LOCAL_DOTENV_ENV_NAME_ALLOWLIST = new Set(["FIGMA_ACCESS_TOKEN"]);

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

// The repo-local `.env` text, or undefined when there is none. A file that exists but cannot be
// read fails closed, because treating it as missing would drop its `KEIKO_LOG_*` settings without a
// trace (#3557 review).
function readLocalDotenv(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

// Reads the repo-local `.env` file, folding only `KEIKO_*` (plus the narrow allowlist above) keys
// that `env` does not already carry into a NEW copy of it — `env` itself is never mutated, and a
// key already present wins over the file. A missing file is not an error: it simply returns `env`.
function loadLocalKeikoEnv(repoRoot, env) {
  const text = readLocalDotenv(join(repoRoot, ".env"));
  if (text === undefined) return env;
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

/**
 * The dev BFF's state directory: the configured `KEIKO_STATE_DIR` when set, else
 * `<repoRoot>/.keiko/dev` — deliberately its OWN default, distinct from the generic CLI default
 * (`<cwd>/.keiko`), so a dev session never shares a directory with a real `keiko` invocation.
 */
export function resolveDevBffStateDir({ repoRoot, processEnv }) {
  return resolve(processEnv.KEIKO_STATE_DIR ?? join(repoRoot, ".keiko", "dev"));
}

/**
 * The ONE effective environment every evidence path in the dev BFF must share: `processEnv`
 * (normally `process.env`) plus repo-local `.env` `KEIKO_*` keys folded in, `KEIKO_STATE_DIR`
 * pinned to `stateDir` (never the generic default `resolveDevBffStateDir` would fall back to on a
 * bare `processEnv` read), and the `KEIKO_UI_DATA_DIR`/`KEIKO_MEMORY_DIR` defaults derived from it.
 */
export function buildDevBffEnv({ repoRoot, processEnv, stateDir }) {
  return loadLocalKeikoEnv(repoRoot, {
    ...processEnv,
    KEIKO_STATE_DIR: stateDir,
    KEIKO_UI_DATA_DIR: processEnv.KEIKO_UI_DATA_DIR ?? join(stateDir, "ui"),
    KEIKO_MEMORY_DIR: processEnv.KEIKO_MEMORY_DIR ?? join(stateDir, "memory"),
  });
}

/**
 * The process-wide Activity Log writer resolves its directory and level from `process.env`, as it
 * does under `keiko ui`, which sets `KEIKO_STATE_DIR` there first. Copy exactly the evidence keys
 * of the effective environment into `target`, so every writer in this process agrees with the
 * explicit `env`: `KEIKO_STATE_DIR` and the `KEIKO_LOG_*` settings. Never copy a credential, which
 * would leak into every child process the BFF spawns.
 */
// A closed list, never a prefix: a `.env` key such as KEIKO_LOG_TOKEN would otherwise be copied
// into every child process the BFF spawns (#3557 review).
const PROCESS_WIDE_EVIDENCE_KEYS = [
  "KEIKO_STATE_DIR",
  "KEIKO_LOG_LEVEL",
  "KEIKO_LOG_SEGMENT_BYTES",
  "KEIKO_LOG_SEGMENT_SECONDS",
  "KEIKO_LOG_RETENTION_BYTES",
  "KEIKO_LOG_RETENTION_DAYS",
  "KEIKO_LOG_PIN_QUOTA_BYTES",
];

export function applyProcessWideEvidenceEnv(env, target) {
  for (const key of PROCESS_WIDE_EVIDENCE_KEYS) {
    const value = env[key];
    if (value !== undefined) target[key] = value;
  }
}
