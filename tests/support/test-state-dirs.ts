// Vitest setup that keeps product defaults away from the real state of whoever runs the suite.
//
// The memory vault and the UI database fall back to `~/.keiko/...` when no path is configured. A test
// that configures neither would otherwise open, migrate or fail on those real files: a vault written
// by a newer checkout once turned hundreds of unrelated tests red. Their own environment variables
// redirect them, one private directory per test process, created by a store only when it is opened.
//
// HOME stays untouched: other tools read it, and the macOS keychain reacts to a home without one by
// raising a dialog on the person's desktop. `KEIKO_STATE_DIR` stays unset too, because setting it
// selects the production Activity Log writer (see `activity-log-test-writer.ts`). A test that sets
// its own directory still gets it.
import { realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// realpath: on macOS the temporary directory sits under the /var symlink, and the state-path guards
// refuse a store under a symlinked ancestor.
const stateDir = join(realpathSync(tmpdir()), `keiko-test-state-${String(process.pid)}`);

process.env.KEIKO_MEMORY_DIR ??= join(stateDir, "memory");
process.env.KEIKO_UI_DATA_DIR ??= join(stateDir, "ui");

process.once("exit", () => {
  rmSync(stateDir, { recursive: true, force: true, maxRetries: 3 });
});
