// Shared, deterministic derivations for the #2386 real-authority Playwright journey. Mirrors the
// #2385 tracer support (tests/e2e/support/coding-runtime-2385-tracer.ts): the Playwright config
// (runner process), the test-only server entry (webServer child), and the spec (worker process) all
// derive the SAME hermetic state layout from these helpers, so the spec can locate the git fixture
// and the managed worktree the REAL server provisioned without any side channel. Distinct default
// state id and loopback port keep this journey isolated from the tracer journey.

import { join } from "node:path";
import { e2eStateDir } from "./e2e-state-dir.js";

export const AUTHORITY_DEFAULT_UI_PORT = 32486;

// #2478: the journey acts as the trusted launcher. The server entry provisions this process-scoped
// secret to the BFF environment, and the spec mints single-use pairing attestations with it through
// the REAL `mintLauncherPairingAttestation` (no fake pairing port on this journey). A deterministic
// test fixture, not a real credential.
export const AUTHORITY_APP_SESSION_LAUNCHER_SECRET =
  "authority-2386-app-session-launcher-secret-fixture";

// Fixture file contents mirroring the functional pipeline scripted edit contract: the scripted model
// proposes exactly ORIGINAL -> EDITED for the target file after the required question is answered.
export const AUTHORITY_ORIGINAL_CONTENT = "export const value = 'ORIGINAL_AUTHORITY_2386';\n";
export const AUTHORITY_EDITED_CONTENT = "export const value = 'NEW_AUTHORITY_2386';\n";
export const AUTHORITY_TARGET_RELATIVE_PATH = "src/example.ts";

// Deterministic (pid-free) state id: the config, the webServer entry, and the workers each re-derive
// the identical directory. The config's prepare step wipes it before every boot.
export function authorityStateDir(): string {
  const runId = process.env.GITHUB_RUN_ID;
  const stateId =
    runId === undefined || runId.length === 0
      ? "code-task-2386-authority"
      : `code-task-2386-authority-${runId}`;
  return e2eStateDir(stateId);
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
