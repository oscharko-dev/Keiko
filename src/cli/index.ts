#!/usr/bin/env node
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "@oscharko-dev/keiko-cli";

// Root package bin entry. This file remains the published executable target
// (`bin: dist/cli/index.js` in the root package.json) and is the only
// `src/cli/` file with a shebang.
//
// The bin entry is the authoritative reference point for two installation-
// dependent paths the cli package needs:
//   - the packaged UI static export at `dist/ui/static`, used by `keiko ui`;
//   - the bin executable path itself, used by `keiko start` when it re-execs
//     the cli as a detached child to serve the UI.
// We surface both via env vars before dispatch so the cli package does not
// have to deep-import the bin or know its own installation layout. Tests can
// override either variable to point at fixtures.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_DIST = resolve(HERE, "..");
process.env.KEIKO_CLI_BIN_PATH ??= resolve(HERE, "index.js");
process.env.KEIKO_UI_STATIC_ROOT ??= resolve(ROOT_DIST, "ui", "static");

// runCli returns a number for synchronous commands and a Promise<number> for
// the async `run` command; Promise.resolve normalises both before exiting.
void Promise.resolve(
  runCli(
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
  ),
).then((code) => {
  process.exit(code);
});
