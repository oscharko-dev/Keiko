// The one hermetic state layout the Code Task Playwright journeys (#2385 tracer, #2386 authority,
// #2387 research) share. Each journey's config (runner process), test-only server entry (webServer
// child) and spec (worker process) derive the SAME directories from these helpers, so the spec can
// locate the git fixture and the managed worktree the REAL server provisioned without any side
// channel. Each journey keeps its own state id and loopback port, which keeps them isolated.

import { join } from "node:path";
import { e2eStateDir } from "./e2e-state-dir.js";

// Deterministic (pid-free) state id: the config, the webServer entry, and the workers each
// re-derive the identical directory. The config's prepare step wipes it before every boot.
export function codingRuntimeJourneyStateDir(stateId: string): string {
  const runId = process.env.GITHUB_RUN_ID;
  return e2eStateDir(runId === undefined || runId.length === 0 ? stateId : `${stateId}-${runId}`);
}

// The local git checkout the journey binds through the Coding Workbench "Code setup" section.
export function codingRuntimeJourneyRepositoryRoot(stateDir: string): string {
  return join(stateDir, "repository");
}

// The Keiko-owned managed worktree root. MUST stay `<dirname(uiDbPath)>/task-workspaces` because
// buildUiHandlerDeps derives `deps.managedTaskWorkspaceRoot` from the ui-db path and the injected
// resolver/workspace services must agree with the routes on the same containment root.
export function codingRuntimeJourneyManagedWorkspaceRoot(stateDir: string): string {
  return join(stateDir, "bff-state", "ui-db", "task-workspaces");
}
