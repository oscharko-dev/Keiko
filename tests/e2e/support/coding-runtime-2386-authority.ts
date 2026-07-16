// Shared, deterministic derivations for the #2386 real-authority Playwright journey. Mirrors the
// #2385 tracer support (tests/e2e/support/coding-runtime-2385-tracer.ts): the Playwright config
// (runner process), the test-only server entry (webServer child), and the spec (worker process) all
// derive the SAME hermetic state layout from these helpers, so the spec can locate the git fixture
// and the managed worktree the REAL server provisioned without any side channel. Distinct default
// state id and loopback port keep this journey isolated from the tracer journey.

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const AUTHORITY_DEFAULT_UI_PORT = 32486;

// Fixture file contents mirroring the functional pipeline scripted edit contract: the scripted model
// proposes exactly ORIGINAL -> EDITED for the target file after the required question is answered.
export const AUTHORITY_ORIGINAL_CONTENT = "export const value = 'ORIGINAL_AUTHORITY_2386';\n";
export const AUTHORITY_EDITED_CONTENT = "export const value = 'NEW_AUTHORITY_2386';\n";
export const AUTHORITY_TARGET_RELATIVE_PATH = "src/example.ts";

// Deterministic (pid-free) state id: the config, the webServer entry, and the workers each re-derive
// the identical directory. The config's prepare step wipes it before every boot.
export function authorityStateDir(): string {
  const override = process.env.KEIKO_E2E_STATE_DIR;
  if (override !== undefined && override.length > 0) return override;
  const runId = process.env.GITHUB_RUN_ID;
  const stateId =
    runId === undefined || runId.length === 0
      ? "code-task-2386-authority"
      : `code-task-2386-authority-${runId}`;
  return join(realpathSync(tmpdir()), "keiko-e2e", stateId);
}

// The local git checkout the journey binds through the Coding Workbench "Code setup" section.
export function authorityRepositoryRoot(stateDir: string): string {
  return join(stateDir, "repository");
}

// The Keiko-owned managed worktree root. MUST stay `<dirname(uiDbPath)>/task-workspaces` because
// buildUiHandlerDeps derives `deps.managedTaskWorkspaceRoot` from the ui-db path and the injected
// resolver/workspace services must agree with the routes on the same containment root.
export function authorityManagedWorkspaceRoot(stateDir: string): string {
  return join(stateDir, "bff-state", "ui-db", "task-workspaces");
}
