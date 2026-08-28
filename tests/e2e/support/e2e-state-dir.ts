import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The state directory one end-to-end suite boots its server against.
 *
 * `realpathSync` is the load-bearing part, not decoration. macOS resolves `os.tmpdir()` through a
 * symlink (`/var` → `/private/var`), and the UI store refuses a database path inside a symlinked
 * directory, so a config that builds this path from the raw value dies before a single test runs:
 *
 *   [WebServer] keiko ui: UI database path must not be inside a symlinked directory.
 *   Error: Process from config.webServer was not able to start. Exit code: 2
 *
 * On the Linux runners `realpathSync` returns the same path it was given, so the suite that only CI
 * ever ran looked healthy while being unrunnable on a developer machine. Twelve configs were in
 * exactly that state, each holding its own copy of the expression — which is why this is now one
 * function rather than a thirty-first copy (AGENTS.md §5). `e2e-state-dir.static.test.ts` fails if a
 * config builds the path itself again.
 *
 * An override is honoured only when it is non-empty. The `??` form the configs used before accepted
 * `KEIKO_E2E_STATE_DIR=""` and resolved the state directory to a relative path inside the checkout;
 * the code-task helpers already guarded against that, and consolidating settles on their contract.
 */
export function e2eStateDir(stateId: string): string {
  const override = process.env.KEIKO_E2E_STATE_DIR;
  if (override !== undefined && override.length > 0) return override;
  return join(realpathSync(tmpdir()), "keiko-e2e", stateId);
}
