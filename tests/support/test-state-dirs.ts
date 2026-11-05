// Vitest setup that keeps product defaults away from the real state of whoever runs the suite.
//
// Stores fall back to `~/.keiko/...` when no path is configured: the memory vault, the UI database,
// the workspace index and the CLI control state among them. A test configuring none of them would
// otherwise open, migrate or fail on those real files: a vault written by a newer checkout once
// turned hundreds of unrelated tests red. So `homedir()` answers a private directory inside a test
// process, also for a test that hands a store an empty environment, and the stores' own variables
// point a child process the same way. A test that sets HOME gets what it set.
//
// The HOME variable stays untouched: other tools read it, and the macOS keychain reacts to a home
// without one by raising a dialog on the person's desktop. `KEIKO_STATE_DIR` stays unset too, because
// setting it selects the production Activity Log writer (see `activity-log-test-writer.ts`).
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";

// realpath: on macOS the temporary directory sits under the /var symlink, and the state-path guards
// refuse a store under a symlinked ancestor.
const tempRoot = realpathSync(os.tmpdir());
const stateDir = join(tempRoot, `keiko-test-state-${randomUUID()}`);
const runnerHome = process.env.HOME;
const realHomedir = os.homedir.bind(os);
let privateHome: string | undefined;

os.homedir = (): string => {
  if (process.env.HOME !== runnerHome) return realHomedir();
  // Created on first use, so the many test files that never ask leave nothing behind.
  privateHome ??= mkdtempSync(join(tempRoot, "keiko-test-home-"));
  return privateHome;
};
syncBuiltinESMExports();

process.env.KEIKO_MEMORY_DIR = join(stateDir, "memory");
process.env.KEIKO_UI_DATA_DIR = join(stateDir, "ui");

process.once("exit", () => {
  rmSync(stateDir, { recursive: true, force: true, maxRetries: 3 });
  if (privateHome !== undefined)
    rmSync(privateHome, { recursive: true, force: true, maxRetries: 3 });
});
