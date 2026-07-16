// Shared, deterministic derivations for the #2385 Code Task OpenCode tracer harness. The Playwright
// config (runner process), the test-only server entry (webServer child), and the spec (worker
// process) all derive the SAME hermetic state layout from these helpers, so the spec can locate the
// git fixture and the managed worktree the REAL server provisioned without any side channel.

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TRACER_DEFAULT_UI_PORT = 32485;

// Fixture file contents mirroring the functional pipeline test's scripted edit contract
// (packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional.test.ts): the
// scripted model proposes exactly ORIGINAL -> EDITED for the target file.
export const TRACER_ORIGINAL_CONTENT = "export const value = 'ORIGINAL_TRACER_2385';\n";
export const TRACER_EDITED_CONTENT = "export const value = 'NEW_TRACER_2385';\n";
export const TRACER_TARGET_RELATIVE_PATH = "src/example.ts";

// Deterministic (pid-free) state id: the config, the webServer entry, and the workers each
// re-derive the identical directory. The config's prepare step wipes it before every boot.
export function tracerStateDir(): string {
  const override = process.env.KEIKO_E2E_STATE_DIR;
  if (override !== undefined && override.length > 0) return override;
  const runId = process.env.GITHUB_RUN_ID;
  const stateId =
    runId === undefined || runId.length === 0
      ? "code-task-opencode-tracer"
      : `code-task-opencode-tracer-${runId}`;
  return join(realpathSync(tmpdir()), "keiko-e2e", stateId);
}

// The local git checkout the tracer binds through the Coding Workbench "Code setup" section.
export function tracerRepositoryRoot(stateDir: string): string {
  return join(stateDir, "repository");
}

// The Keiko-owned managed worktree root. MUST stay `<dirname(uiDbPath)>/task-workspaces` because
// buildUiHandlerDeps derives `deps.managedTaskWorkspaceRoot` from the ui-db path and the injected
// resolver/workspace services must agree with the routes on the same containment root.
export function tracerManagedWorkspaceRoot(stateDir: string): string {
  return join(stateDir, "bff-state", "ui-db", "task-workspaces");
}
