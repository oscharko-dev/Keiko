import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  REVIEWED_INSTALL_SCRIPTS,
  findInstallScriptApprovalProblems,
  packageNameFromLockPath,
  runCli,
} from "../check-install-script-approvals.mjs";

// KEIKO-0314: npm's allow-scripts governance was unconfigured, so third-party lifecycle scripts ran
// unreviewed on every install behind a warning that fails nothing. .npmrc's strict-allow-scripts now
// fails `npm ci` closed, but only for what resolves on THAT host, and npm 11.16.0 ignores a pinned
// name@version key for unrs-resolver — so its npm-level approval has to be unpinned, which would
// bless any future version. This gate reads package-lock.json instead: every platform, exact
// versions. These tests are what keep it from becoming decorative.

const reviewed = new Map([["pkg", { version: "1.0.0" }]]);
const lockWith = (entries) => ({ packages: Object.fromEntries(entries) });

describe("packageNameFromLockPath", () => {
  it("takes the name after the final node_modules segment", () => {
    expect(packageNameFromLockPath("node_modules/pkg")).toBe("pkg");
    expect(packageNameFromLockPath("node_modules/a/node_modules/b")).toBe("b");
  });

  it("keeps a scoped name intact", () => {
    expect(packageNameFromLockPath("node_modules/@scope/name")).toBe("@scope/name");
    expect(packageNameFromLockPath("node_modules/a/node_modules/@scope/name")).toBe("@scope/name");
  });
});

describe("findInstallScriptApprovalProblems", () => {
  const ok = lockWith([["node_modules/pkg", { hasInstallScript: true, version: "1.0.0" }]]);
  const manifest = { allowScripts: { pkg: true } };

  it("passes a reviewed package at the reviewed version with an npm approval", () => {
    const { problems, lockedCount } = findInstallScriptApprovalProblems(ok, manifest, reviewed);
    expect(problems).toEqual([]);
    expect(lockedCount).toBe(1);
  });

  it("accepts a pinned name@version approval as well as an unpinned one", () => {
    const pinned = { allowScripts: { "pkg@1.0.0": true } };
    expect(findInstallScriptApprovalProblems(ok, pinned, reviewed).problems).toEqual([]);
  });

  it("fails a package that runs an install script and was never reviewed", () => {
    const lock = lockWith([["node_modules/evil", { hasInstallScript: true, version: "9.9.9" }]]);
    const { problems } = findInstallScriptApprovalProblems(lock, manifest, reviewed);
    expect(problems.join("\n")).toContain(
      "evil@9.9.9 runs an install script and has never been reviewed",
    );
  });

  it("fails a version bump under an already-reviewed name", () => {
    // The whole point of the lockfile read: npm's unpinned approval would let this through.
    const lock = lockWith([["node_modules/pkg", { hasInstallScript: true, version: "1.1.0" }]]);
    const { problems } = findInstallScriptApprovalProblems(lock, manifest, reviewed);
    expect(problems.join("\n")).toContain(
      "pkg was reviewed at 1.0.0 but the lockfile now resolves 1.1.0",
    );
  });

  it("fails when the reviewed record exists but npm would refuse the install", () => {
    const { problems } = findInstallScriptApprovalProblems(ok, { allowScripts: {} }, reviewed);
    expect(problems.join("\n")).toContain("is not in package.json allowScripts");
  });

  it("fails a stale record for a package that no longer runs an install script", () => {
    const { problems } = findInstallScriptApprovalProblems(lockWith([]), manifest, reviewed);
    expect(problems.join("\n")).toContain("no longer appears in the");
  });

  it("ignores lockfile entries that declare no install script", () => {
    const lock = lockWith([
      ["node_modules/pkg", { hasInstallScript: true, version: "1.0.0" }],
      ["node_modules/quiet", { version: "2.0.0" }],
    ]);
    const { problems, lockedCount } = findInstallScriptApprovalProblems(lock, manifest, reviewed);
    expect(problems).toEqual([]);
    expect(lockedCount).toBe(1);
  });

  it("tolerates a manifest with no allowScripts block at all", () => {
    const { problems } = findInstallScriptApprovalProblems(ok, {}, reviewed);
    expect(problems.join("\n")).toContain("is not in package.json allowScripts");
  });
});

describe("the repository's own reviewed set", () => {
  it("records a reason for every approved package, not just a version", () => {
    expect(REVIEWED_INSTALL_SCRIPTS.size).toBeGreaterThan(0);
    for (const [name, record] of REVIEWED_INSTALL_SCRIPTS) {
      expect(record.version, `${name} must record the exact reviewed version`).toMatch(
        /^\d+\.\d+\.\d+/u,
      );
      expect(record.reason.length, `${name} must say what its script does`).toBeGreaterThan(60);
    }
  });

  it("passes against the real lockfile and manifest", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(runCli(resolve(import.meta.dirname, "..", ".."))).toBe(0);
      expect(log.mock.calls.flat().join(" ")).toContain("all reviewed at the exact locked version");
    } finally {
      log.mockRestore();
    }
  });
});
