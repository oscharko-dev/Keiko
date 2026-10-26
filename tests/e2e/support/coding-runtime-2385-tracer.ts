// Shared, deterministic derivations for the #2385 Code Task OpenCode tracer harness. The Playwright
// config (runner process), the test-only server entry (webServer child), and the spec (worker
// process) all derive the SAME hermetic state layout from these helpers, so the spec can locate the
// git fixture and the managed worktree the REAL server provisioned without any side channel.

import {
  codingRuntimeJourneyManagedWorkspaceRoot,
  codingRuntimeJourneyRepositoryRoot,
  codingRuntimeJourneyStateId,
} from "./coding-runtime-journey-state.js";
import { e2eStateDir } from "./e2e-state-dir.js";

export const TRACER_DEFAULT_UI_PORT = 32485;

// #2802: a run starts only from a paired app session, so the journey acts as the trusted launcher.
// The server entry provisions this process-scoped secret to the BFF environment, and the spec mints
// single-use pairing attestations with it through the REAL `mintLauncherPairingAttestation`. A
// deterministic test fixture, not a real credential.
export const TRACER_APP_SESSION_LAUNCHER_SECRET = "tracer-2385-app-session-launcher-secret-fixture";

// Fixture file contents mirroring the functional pipeline test's scripted edit contract
// (packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.functional.test.ts): the
// scripted model proposes exactly ORIGINAL -> EDITED for the target file.
export const TRACER_ORIGINAL_CONTENT = "export const value = 'ORIGINAL_TRACER_2385';\n";
export const TRACER_EDITED_CONTENT = "export const value = 'NEW_TRACER_2385';\n";
export const TRACER_TARGET_RELATIVE_PATH = "src/example.ts";

export function tracerStateDir(): string {
  return e2eStateDir(codingRuntimeJourneyStateId("code-task-opencode-tracer"));
}

export const tracerRepositoryRoot = codingRuntimeJourneyRepositoryRoot;

export const tracerManagedWorkspaceRoot = codingRuntimeJourneyManagedWorkspaceRoot;
