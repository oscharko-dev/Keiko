import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// GEN-TEST-E2E-003: the CI-gated @smoke run overwrote tracked docs/**/evidence artifacts on every
// run, dirtying the working tree — which breaks clean-tree release gates and the owner directive to
// run CI gates locally (every local smoke left a dirty `git status`). These screenshots are
// EVIDENCE captures, not assertions (nothing compares against the committed bytes), so by default we
// redirect them into the gitignored test-results/ tree. Set KEIKO_WRITE_TRACKED_EVIDENCE=1 to
// regenerate the committed baseline on purpose (separating evidence generation from gating).
export function evidenceScreenshotPath(trackedRelPath: string): string {
  if (process.env.KEIKO_WRITE_TRACKED_EVIDENCE === "1") {
    mkdirSync(dirname(trackedRelPath), { recursive: true });
    return trackedRelPath;
  }
  const redirected = join("test-results", "e2e-evidence", trackedRelPath.replace(/^docs\//u, ""));
  mkdirSync(dirname(redirected), { recursive: true });
  return redirected;
}
