// Convention detection (ADR-0008 D7) and the production-code guard predicate (D6). Pure except
// for the WorkspaceInfo/ContextPack values handed in (no IO, no clock, no RNG). ALL path and
// naming predicates use plain string ops (split('.'), startsWith, equality) — zero regex — so
// there is no ReDoS surface (CodeQL js/polynomial-redos, steering note F).

import { basename, dirname, extname } from "node:path";
import type { ContextPack, WorkspaceInfo } from "../../workspace/index.js";
import type { FileNamingStyle, TestConventions } from "./types.js";

const MAX_ASSERTION_SAMPLES = 2;
const TEST_SEGMENTS: readonly string[] = ["test", "spec"];

// Normalises a path to forward slashes so dir/segment checks are platform-independent.
function toPosix(path: string): string {
  return path.split("\\").join("/");
}

// True when the basename (without its final extension) contains "test" or "spec" as a
// dot-separated segment. `foo.test.ts` -> ["foo","test"] -> pass; `testUtils.ts` ->
// ["testUtils"] -> FAIL (prefix, not a segment); `foo.spec.utils.ts` -> ["foo","spec","utils"] -> pass.
function basenameMarksTest(path: string): boolean {
  const ext = extname(path);
  const stem = basename(path, ext);
  const segments = stem.split(".");
  return segments.some((segment) => TEST_SEGMENTS.includes(segment));
}

// True when the path's directory equals or sits under one of the configured testDirs.
function underTestDir(testDirs: readonly string[], posixPath: string): boolean {
  const dir = dirname(posixPath);
  return testDirs.some((rawTestDir) => {
    const testDir = toPosix(rawTestDir);
    return dir === testDir || dir.startsWith(`${testDir}/`) || posixPath.startsWith(`${testDir}/`);
  });
}

// A path containing a `..` segment or an absolute leading slash is traversal: it can resolve to a
// production file OUTSIDE the apparent test directory. `tests/../src/auth.ts` lexically starts with
// `tests/`, but #6 resolveWithinWorkspace collapses it to the in-workspace `src/auth.ts` and writes
// THAT. A legitimately generated test path is always a clean workspace-relative path, so we reject
// traversal fail-closed before any test/testDir check (security fix: D6 bypass via path traversal).
function isTraversal(posixPath: string): boolean {
  return posixPath.startsWith("/") || posixPath.split("/").includes("..");
}

// The production-code guard predicate (D6): a path passes if its basename marks it a test file OR
// it lies under a detected testDir. Used to reject any patch that touches a non-test path before
// renderDryRun/applyPatch — the second barrier against prompt-injected source modification. Any
// traversal/absolute path is rejected outright so the guarded path matches the path #6 would write.
export function isTestPath(workspace: WorkspaceInfo, relPath: string): boolean {
  const posixPath = toPosix(relPath);
  if (isTraversal(posixPath)) {
    return false;
  }
  return basenameMarksTest(posixPath) || underTestDir(workspace.testDirs, posixPath);
}

// The set of test excerpts already selected by #5 (redacted, bounded), capped to MAX_ASSERTION_SAMPLES.
function sampleAssertionStyle(pack: ContextPack): readonly string[] {
  return pack.selected
    .filter((entry) => entry.selectionReason === "test")
    .slice(0, MAX_ASSERTION_SAMPLES)
    .map((entry) => entry.excerpt);
}

// Whether any selected pack entry is a sibling test (a test file whose directory matches a
// non-test source path's directory). We approximate "sibling" as a test-marked path NOT under a
// configured testDir, and "mirrored" as a test-marked path under a testDir.
function hasSiblingTest(workspace: WorkspaceInfo, pack: ContextPack): boolean {
  return pack.selected.some(
    (entry) =>
      basenameMarksTest(toPosix(entry.path)) &&
      !underTestDir(workspace.testDirs, toPosix(entry.path)),
  );
}

function hasMirroredTest(workspace: WorkspaceInfo, pack: ContextPack): boolean {
  return pack.selected.some(
    (entry) =>
      basenameMarksTest(toPosix(entry.path)) &&
      underTestDir(workspace.testDirs, toPosix(entry.path)),
  );
}

function deriveNamingStyle(workspace: WorkspaceInfo, pack: ContextPack): FileNamingStyle {
  if (hasSiblingTest(workspace, pack)) {
    return "sibling";
  }
  if (workspace.testDirs.length > 0 && hasMirroredTest(workspace, pack)) {
    return "mirrored";
  }
  // testDirs present but no observed test sample: default to mirrored (the conventional placement
  // under tests/). Only when there is neither a testDir nor a sample is the style unknown.
  if (workspace.testDirs.length > 0) {
    return "mirrored";
  }
  return "unknown";
}

export function detectConventions(workspace: WorkspaceInfo, pack: ContextPack): TestConventions {
  return {
    framework: workspace.testFramework,
    testDirs: workspace.testDirs,
    fileNamingStyle: deriveNamingStyle(workspace, pack),
    assertionStyleSamples: sampleAssertionStyle(pack),
  };
}
