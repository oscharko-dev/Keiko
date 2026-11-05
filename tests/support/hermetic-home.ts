// Vitest setup that keeps product defaults away from the developer's real home directory.
//
// Several stores fall back to `homedir()` when no path is configured: the memory vault, the UI
// database and the workspace index all resolve `~/.keiko/...`. A test that configures none of them
// would otherwise open, migrate or fail on the real files of whoever runs the suite, so a vault
// written by a newer checkout turned hundreds of unrelated tests red and every run touched real
// customer-shaped state. `os.homedir()` honours HOME (USERPROFILE on Windows), and child processes
// inherit it, so one private directory per worker process closes the whole class. A test that
// needs another home still sets its own.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// realpath: on macOS the temporary directory sits under the /var symlink, and the state-path
// guards refuse a store under a symlinked ancestor.
const home = mkdtempSync(join(realpathSync(tmpdir()), "keiko-test-home-"));

process.env.HOME = home;
process.env.USERPROFILE = home;

process.once("exit", () => {
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});
