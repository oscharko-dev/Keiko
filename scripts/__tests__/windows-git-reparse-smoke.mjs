// Windows-only smoke: proves that the Git resolver rejects a PATH spelling controlled by the
// workspace even when a genuine directory junction redirects that spelling to an external
// git.exe. A simulated platform cannot establish the lexical-versus-realpath behaviour of an
// actual Windows reparse point, so the required Windows CI leg invokes this file directly.
//
// Not a `*.test.mjs` file on purpose: Vitest treats an entirely skipped file as success. Direct
// execution makes both the host requirement and every assertion fail closed instead.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveGitExecutable } from "../../packages/keiko-git/src/git-executable.ts";

assert.equal(
  process.platform,
  "win32",
  "windows-git-reparse-smoke: this smoke must run on a Windows host",
);

const cleanupRoots = [];

try {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-workspace-")));
  cleanupRoots.push(workspace);
  const externalBin = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-external-")));
  cleanupRoots.push(externalBin);

  writeFileSync(join(externalBin, "git.exe"), "MZ");
  const workspaceBin = join(workspace, "bin");
  symlinkSync(externalBin, workspaceBin, "junction");

  assert.notEqual(
    realpathSync(workspaceBin),
    workspaceBin,
    "the fixture did not create a real Windows directory junction",
  );
  assert.deepEqual(
    resolveGitExecutable({ PATH: workspaceBin }, workspace, "win32"),
    { ok: false, reason: "untrusted-location" },
    "a workspace-controlled lexical PATH junction escaped Git executable containment",
  );

  console.log("windows-git-reparse-smoke: PASS");
} finally {
  for (const root of cleanupRoots) rmSync(root, { force: true, recursive: true });
}
