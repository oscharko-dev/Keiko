// Shared, deterministic derivations for the #2387 governed-research Playwright journey. Mirrors the
// #2386 authority support (tests/e2e/support/coding-runtime-2386-authority.ts): the Playwright
// config (runner process), the test-only server entry (webServer child), and the spec (worker
// process) all derive the SAME hermetic state layout from these helpers. Distinct default state id
// and loopback port keep this journey isolated from the tracer and authority journeys.

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RESEARCH_DEFAULT_UI_PORT = 32487;

// The public host the scripted model asks to research; the hermetic transport answers for it, no
// real network is ever touched (the server entry injects the research fetch seam).
export const RESEARCH_JOURNEY_HOST = "docs.example.org";

// Deterministic (pid-free) state id: the config, the webServer entry, and the workers each
// re-derive the identical directory. The config's prepare step wipes it before every boot.
export function researchStateDir(): string {
  const override = process.env.KEIKO_E2E_STATE_DIR;
  if (override !== undefined && override.length > 0) return override;
  const runId = process.env.GITHUB_RUN_ID;
  const stateId =
    runId === undefined || runId.length === 0
      ? "code-task-2387-research"
      : `code-task-2387-research-${runId}`;
  return join(realpathSync(tmpdir()), "keiko-e2e", stateId);
}

// The local git checkout the journey binds through the Coding Workbench "Code setup" section.
export function researchRepositoryRoot(stateDir: string): string {
  return join(stateDir, "repository");
}

// The Keiko-owned managed worktree root. MUST stay `<dirname(uiDbPath)>/task-workspaces` because
// buildUiHandlerDeps derives `deps.managedTaskWorkspaceRoot` from the ui-db path and the injected
// resolver/workspace services must agree with the routes on the same containment root.
export function researchManagedWorkspaceRoot(stateDir: string): string {
  return join(stateDir, "bff-state", "ui-db", "task-workspaces");
}
