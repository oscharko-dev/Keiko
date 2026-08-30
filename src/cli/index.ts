#!/usr/bin/env node
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { installProcessGuards, runCli } from "@oscharko-dev/keiko-cli";

if (process.platform === "win32") {
  process.title = "Keiko";
}

// Root package bin entry. This file remains the published executable target
// (`bin: dist/cli/index.js` in the root package.json) and is the only
// `src/cli/` file with a shebang.
//
// The bin entry is the authoritative reference point for three installation-
// dependent paths the cli package needs:
//   - the packaged UI static export at `dist/ui/static`, used by `keiko ui`;
//   - the bin executable path itself, used by `keiko start` when it re-execs
//     the cli as a detached child to serve the UI;
//   - the local-state auditor at `scripts/lib/local-state-audit.mjs`, used by
//     `keiko audit local-state` (KEIKO-0230). It stays a standalone,
//     builtins-only script with no package-graph edge, so the cli imports it
//     at runtime by path rather than depending on it.
// We surface all three via env vars before dispatch so the cli package does not
// have to deep-import the bin or know its own installation layout. Tests can
// override any variable to point at fixtures.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_DIST = resolve(HERE, "..");
const PACKAGE_ROOT = resolve(ROOT_DIST, "..");
process.env.KEIKO_CLI_BIN_PATH ??= resolve(HERE, "index.js");
process.env.KEIKO_UI_STATIC_ROOT ??= resolve(ROOT_DIST, "ui", "static");
process.env.KEIKO_LOCAL_STATE_AUDITOR ??= resolve(
  PACKAGE_ROOT,
  "scripts",
  "lib",
  "local-state-audit.mjs",
);

// Process-level catch-alls: a stray async error outside any request must exit
// with one clean, redacted line instead of a raw stack. The logic lives in
// keiko-cli (unit-tested); the facade only installs it.
installProcessGuards();

// Await normalizes synchronous and asynchronous commands. Assigning exitCode preserves the result
// while letting detached-helper error handlers finish their lazy activity-log drain; process.exit()
// would truncate those late events.
process.exitCode = await runCli(
  process.argv.slice(2),
  {
    out: (text: string): void => {
      process.stdout.write(text);
    },
    err: (text: string): void => {
      process.stderr.write(text);
    },
  },
  process.env,
);
