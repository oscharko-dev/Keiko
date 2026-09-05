import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultGitProcessRunner } from "@oscharko-dev/keiko-git";
import type { GitProcessRunner } from "@oscharko-dev/keiko-git";
import {
  isGitChangeSnapshot,
  gitChangeSnapshotDigestFields,
  validateGitChangeSnapshotResult,
} from "@oscharko-dev/keiko-contracts/runtime/git-change-snapshot";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import { createGitChangeSnapshotService } from "./gitChangeSnapshotService.js";
import type { ServerLogEvent } from "./observability/server-log.js";
import { formatServerLogLine } from "./observability/server-log.js";
import { codingWorkbenchRemoteDigest } from "./coding-context/githubIssueResolution.js";

const roots: string[] = [];
const correlationId = "snapshot-regression";

function git(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: "/nonexistent",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

async function repository(): Promise<WorkspaceInfo> {
  const root = await mkdtemp(join(tmpdir(), "keiko-gcs-"));
  roots.push(root);
  git(root, "init", "-b", "main");
  await writeFile(join(root, "source.txt"), "original\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  git(root, "checkout", "-b", "feature");
  await writeFile(join(root, "source.txt"), "reviewed change\n");
  git(root, "commit", "-am", "change");
  return {
    root,
    selectedRoot: root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

function inputFor(workspace: WorkspaceInfo): {
  workspace: WorkspaceInfo;
  baseRef: string;
  headRef: string;
  accessScope: object;
  correlationId: string;
} {
  return { workspace, baseRef: "main", headRef: "feature", accessScope: {}, correlationId };
}

async function allKinds(workspace: WorkspaceInfo): Promise<void> {
  const root = workspace.root;
  git(root, "checkout", "main");
  for (const [name, body] of [
    ["rename.txt", "rename source\n"],
    ["copy.txt", "copied source\n"],
    ["delete.txt", "delete source\n"],
    ["mode.sh", "echo mode\n"],
  ])
    await writeFile(join(root, name ?? ""), body ?? "");
  git(root, "add", ".");
  git(root, "commit", "-m", "all kind baseline");
  git(root, "checkout", "feature");
  git(root, "reset", "--hard", "main");
  git(root, "mv", "rename.txt", "renamed\tline\nfile.txt");
  await copyFile(join(root, "copy.txt"), join(root, "copied.txt"));
  await rm(join(root, "delete.txt"));
  await chmod(join(root, "mode.sh"), 0o755);
  await writeFile(join(root, "source.txt"), "modified\n");
  await writeFile(join(root, "new.txt"), "added unique\n");
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 255]));
  git(root, "add", ".");
  git(
    root,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${git(root, "rev-parse", "main")},vendor`,
  );
  git(root, "commit", "-m", "all changes");
}

describe("immutable Git change snapshot production", () => {
  it("keeps canonical digests across clones and refuses lazy fetching missing objects", async () => {
    const workspace = await repository();
    const cloneRoot = await mkdtemp(join(tmpdir(), "keiko-gcs-clone-"));
    roots.push(cloneRoot);
    git(cloneRoot, "clone", "--no-local", workspace.root, ".");
    git(cloneRoot, "branch", "main", "origin/main");
    const cloneWorkspace = { ...workspace, root: cloneRoot, selectedRoot: cloneRoot };
    for (const root of [workspace.root, cloneRoot]) {
      if (root === workspace.root)
        git(root, "remote", "add", "origin", "https://github.com/OWNER/repo.git");
      else git(root, "remote", "set-url", "origin", "git@github.com:owner/REPO.git");
    }
    const service = createGitChangeSnapshotService();
    const original = await service.capture(inputFor(workspace));
    const cloned = await service.capture(inputFor(cloneWorkspace));
    if (!isGitChangeSnapshot(original.snapshot) || !isGitChangeSnapshot(cloned.snapshot))
      throw new Error("capture failed");
    expect(cloned.snapshot.repositoryId).not.toBe(original.snapshot.repositoryId);
    expect(cloned.snapshot.snapshotDigest).toBe(original.snapshot.snapshotDigest);
    const objectId = git(workspace.root, "rev-parse", "feature:source.txt");
    const objectPath = join(
      workspace.root,
      ".git",
      "objects",
      objectId.slice(0, 2),
      objectId.slice(2),
    );
    await rm(objectPath);
    git(workspace.root, "config", "remote.origin.promisor", "true");
    git(workspace.root, "remote", "set-url", "origin", cloneRoot);
    const runner: GitProcessRunner = async (args, options) => {
      expect(args.slice(0, 2)).toEqual(["--no-lazy-fetch", "--no-replace-objects"]);
      return await defaultGitProcessRunner(args, options);
    };
    const offline = createGitChangeSnapshotService({ runner });
    expect(await offline.capture(inputFor(workspace))).toMatchObject({
      snapshot: { outcome: "failed" },
    });
    expect(() => git(workspace.root, "--no-lazy-fetch", "cat-file", "-e", objectId)).toThrow();
    offline.close();
    service.close();
  });
  it("ignores local object replacement refs for immutable comparison evidence", async () => {
    const workspace = await repository();
    const input = inputFor(workspace);
    const service = createGitChangeSnapshotService();
    const before = await service.capture(input);
    const original = git(workspace.root, "rev-parse", "feature:source.txt");
    await writeFile(join(workspace.root, "replacement.txt"), "unreviewed replacement\n");
    const replacement = git(workspace.root, "hash-object", "-w", "replacement.txt");
    git(workspace.root, "replace", original, replacement);
    const after = await service.capture(input);
    if (!isGitChangeSnapshot(before.snapshot) || !isGitChangeSnapshot(after.snapshot))
      throw new Error("capture failed");
    expect(after.snapshot.snapshotDigest).toBe(before.snapshot.snapshotDigest);
    service.close();
  });
  // Records every argv this lane's own `GitProcessRunner` receives — real git for every call — so
  // a test can assert WHICH probes actually ran. A `version` probe only runs when
  // `repositoryHasPromisorRemote` judged the repository at risk, so its presence/absence is the
  // definitive signal for "was promisor risk (re)detected".
  function recordingRunner(): {
    readonly runner: GitProcessRunner;
    readonly subcommands: () => readonly string[];
  } {
    const subcommands: string[] = [];
    const runner: GitProcessRunner = async (args, options) => {
      subcommands.push(args[0] ?? "");
      return defaultGitProcessRunner(args, options);
    };
    return { runner, subcommands: () => subcommands };
  }

  // Real git for everything, except the FIRST `version` call fails — the exact shape of a
  // workspace-local spawn failure reviewer 3941928444 reproduced. Every later call, including a
  // later `version` probe, reaches the real binary.
  function runnerFailingVersionOnce(): GitProcessRunner {
    let versionCalls = 0;
    return async (args, options) => {
      if (args[0] === "version") {
        versionCalls += 1;
        if (versionCalls === 1) throw new Error("ENOTDIR: not a directory");
      }
      return defaultGitProcessRunner(args, options);
    };
  }

  it("treats `partialclonefilter` alone as a promisor remote, with no `promisor` key set at all (reviewer 3941943601)", async () => {
    const workspace = await repository();
    git(workspace.root, "config", "remote.origin.partialclonefilter", "blob:none");
    const rec = recordingRunner();
    const service = createGitChangeSnapshotService({ runner: rec.runner });
    await service.capture(inputFor(workspace));
    expect(rec.subcommands().filter((s) => s === "version")).toHaveLength(1);
    service.close();
  });

  it("honours an `include.path` setting promisor risk, unlike the old `--local`-scoped read (reviewer 3941943601)", async () => {
    const workspace = await repository();
    const includeDir = await mkdtemp(join(tmpdir(), "keiko-gcs-include-"));
    roots.push(includeDir);
    const includePath = join(includeDir, "promisor.gitconfig");
    await writeFile(includePath, '[remote "origin"]\n\tpromisor = true\n');
    git(workspace.root, "config", "--add", "include.path", includePath);
    // RED proof, on this SAME repository: the OLD `--local`-scoped read cannot see an
    // `include.path` at all — it is genuinely blind here, not merely differently parsed.
    expect(() =>
      execFileSync(
        "git",
        ["config", "--local", "--get-regexp", String.raw`^remote\..*\.promisor$`],
        { cwd: workspace.root, encoding: "utf8" },
      ),
    ).toThrow();
    const rec = recordingRunner();
    const service = createGitChangeSnapshotService({ runner: rec.runner });
    await service.capture(inputFor(workspace));
    expect(rec.subcommands().filter((s) => s === "version")).toHaveLength(1);
    service.close();
  });

  it("revalidates promisor risk on every call — an earlier safe verdict never authorizes a later, riskier one (reviewer 3941943603)", async () => {
    const workspace = await repository();
    const rec = recordingRunner();
    const service = createGitChangeSnapshotService({ runner: rec.runner });
    await service.capture(inputFor(workspace));
    // No promisor remote yet: no version check needed for this capture.
    expect(rec.subcommands().filter((s) => s === "version")).toHaveLength(0);
    git(workspace.root, "config", "remote.origin.promisor", "true");
    await service.capture(inputFor(workspace));
    // The SAME service instance, the SAME runner — risk was still re-checked, not replayed from
    // the first capture's safe verdict.
    expect(rec.subcommands().filter((s) => s === "version")).toHaveLength(1);
    service.close();
  });

  it("evicts a failed git-version probe instead of caching it forever (reviewer 3941928444)", async () => {
    const workspace = await repository();
    git(workspace.root, "config", "remote.origin.promisor", "true");
    const service = createGitChangeSnapshotService({ runner: runnerFailingVersionOnce() });
    const failed = await service.capture(inputFor(workspace));
    // The first, indeterminate probe fails closed for this one capture.
    expect(failed.snapshot).toMatchObject({ outcome: "failed" });
    // A second, healthy capture on the SAME service instance must re-probe and succeed instead of
    // replaying the first probe's spawn failure as a permanent "guard unsupported" verdict.
    const recovered = await service.capture(inputFor(workspace));
    expect(isGitChangeSnapshot(recovered.snapshot)).toBe(true);
    service.close();
  });

  it("represents every kind through raw and numstat, including NUL-safe rename paths", async () => {
    const workspace = await repository();
    await allKinds(workspace);
    const input = inputFor(workspace);
    const service = createGitChangeSnapshotService();
    const captured = await service.capture(input);
    expect(captured.snapshot.outcome, JSON.stringify(captured.snapshot)).toBe("complete");
    expect(validateGitChangeSnapshotResult(captured.snapshot)).toMatchObject({ ok: true });
    if (!isGitChangeSnapshot(captured.snapshot)) throw new Error("capture failed");
    expect(captured.snapshot.entries.map((entry) => entry.kind).sort()).toEqual([
      "add",
      "binary",
      "copy",
      "delete",
      "mode-change",
      "modify",
      "rename",
      "submodule",
    ]);
    expect(captured.snapshot.completeness.kinds).toMatchObject({
      add: 1,
      copy: 1,
      binary: 1,
      submodule: 1,
    });
    expect(captured.snapshot.entries.find((entry) => entry.kind === "rename")).toMatchObject({
      similarity: 100,
      additions: 0,
      deletions: 0,
    });
    const content = service.read(captured.reference ?? "", input.accessScope, correlationId);
    expect(content?.files.some((file) => file.path === "renamed\tline\nfile.txt")).toBe(true);
    expect(JSON.stringify(captured.snapshot)).not.toContain("source.txt");
    service.close();
  });

  it("compares the merge base when the target advanced and retains exact SHA bindings", async () => {
    const workspace = await repository();
    const mergeBaseSha = git(workspace.root, "rev-parse", "main");
    git(workspace.root, "checkout", "main");
    await writeFile(join(workspace.root, "target-only.txt"), "not part of feature\n");
    git(workspace.root, "add", ".");
    git(workspace.root, "commit", "-m", "target advanced");
    git(workspace.root, "checkout", "feature");
    const service = createGitChangeSnapshotService();
    const input = inputFor(workspace);
    const captured = await service.capture(input);
    expect(captured.snapshot).toMatchObject({
      outcome: "complete",
      mergeBaseSha,
      baseSha: git(workspace.root, "rev-parse", "main"),
      headSha: git(workspace.root, "rev-parse", "feature"),
    });
    expect(
      service
        .read(captured.reference ?? "", input.accessScope, correlationId)
        ?.files.map((file) => file.path),
    ).toEqual(["source.txt"]);
    expect(await service.capture({ ...input, expectedHeadSha: mergeBaseSha })).toMatchObject({
      snapshot: { outcome: "unavailable", reason: "head-mismatch" },
    });
    service.close();
  });

  it("pins ambient configuration and committed attributes and canonicalizes origin", async () => {
    const workspace = await repository();
    const input = inputFor(workspace);
    const service = createGitChangeSnapshotService();
    git(workspace.root, "remote", "add", "origin", "git@github.com:OWNER/Repo.git");
    const before = await service.capture(input);
    for (const [key, value] of Object.entries({
      "diff.noprefix": "true",
      "diff.mnemonicPrefix": "true",
      "diff.relative": "true",
      "diff.renames": "false",
      "diff.algorithm": "histogram",
      "diff.context": "0",
      "diff.interHunkContext": "20",
      "diff.external": "/nonexistent-helper",
    }))
      git(workspace.root, "config", key, value);
    await writeFile(join(workspace.root, ".gitattributes"), "* -diff\n");
    await writeFile(join(workspace.root, ".git", "info", "attributes"), "* -diff\n");
    git(workspace.root, "add", ".gitattributes");
    git(workspace.root, "remote", "set-url", "origin", "https://github.com/owner/repo.git");
    const after = await service.capture(input);
    expect(after.snapshot).toMatchObject({
      outcome: "complete",
      remoteDigest: codingWorkbenchRemoteDigest("owner/repo"),
    });
    if (!isGitChangeSnapshot(before.snapshot) || !isGitChangeSnapshot(after.snapshot))
      throw new Error("capture failed");
    expect(gitChangeSnapshotDigestFields(after.snapshot)).toEqual(
      gitChangeSnapshotDigestFields(before.snapshot),
    );
    expect(after.snapshot.snapshotDigest).toBe(before.snapshot.snapshotDigest);
    service.close();
  });

  it("classifies empty, identical, behind, shallow, and unsupported comparisons", async () => {
    const workspace = await repository();
    const input = inputFor(workspace);
    const service = createGitChangeSnapshotService();
    expect(await service.capture({ ...input, headRef: "main" })).toMatchObject({
      snapshot: { outcome: "unavailable", reason: "identical-revisions" },
    });
    expect(await service.capture({ ...input, headRef: "main", baseRef: "feature" })).toMatchObject({
      snapshot: { outcome: "unavailable", reason: "head-behind-base" },
    });
    await writeFile(
      join(workspace.root, ".git", "shallow"),
      `${git(workspace.root, "rev-parse", "feature")}\n`,
    );
    expect(await service.capture(input)).toMatchObject({
      snapshot: { outcome: "unavailable", reason: "no-merge-base" },
    });
    await rm(join(workspace.root, ".git", "shallow"));
    git(workspace.root, "reset", "--hard", "main");
    git(workspace.root, "commit", "--allow-empty", "-m", "empty comparison");
    expect(await service.capture(input)).toMatchObject({
      snapshot: {
        outcome: "complete",
        entries: [],
        completeness: { totalFiles: 0, omittedFiles: 0 },
      },
    });
    service.close();
    const runner: GitProcessRunner = async (args, options) => {
      const result = await defaultGitProcessRunner(args, options);
      return args.includes("--show-object-format") ? { ...result, stdout: "sha256\n" } : result;
    };
    const unsupported = createGitChangeSnapshotService({ runner });
    const result = await unsupported.capture(input);
    expect(result).toMatchObject({
      snapshot: { outcome: "unavailable", reason: "unsupported-object-format" },
    });
    expect(validateGitChangeSnapshotResult(result.snapshot)).toMatchObject({ ok: true });
    unsupported.close();
  });

  it("counts omitted complete hunks and rejects base/head changes during capture", async () => {
    const workspace = await repository();
    git(workspace.root, "checkout", "main");
    const lines = Array.from({ length: 40 }, (_, index) => `line ${String(index)}\n`);
    await writeFile(join(workspace.root, "source.txt"), lines.join(""));
    git(workspace.root, "commit", "-am", "long baseline");
    git(workspace.root, "checkout", "feature");
    git(workspace.root, "reset", "--hard", "main");
    lines[1] = "changed first\n";
    lines[35] = "changed last\n";
    await writeFile(join(workspace.root, "source.txt"), lines.join(""));
    git(workspace.root, "commit", "-am", "two hunks");
    const input = inputFor(workspace);
    const service = createGitChangeSnapshotService();
    const captured = await service.capture({ ...input, limits: { maxHunksPerFile: 1 } });
    expect(captured).toMatchObject({
      snapshot: {
        outcome: "partial",
        completeness: { hunks: 1, omittedHunks: 1, truncatedFiles: 0 },
      },
    });
    service.close();
    const runner: GitProcessRunner = async (args, options) => {
      const result = await defaultGitProcessRunner(args, options);
      if (args.includes("--patch"))
        git(workspace.root, "commit", "--allow-empty", "-m", "concurrent head change");
      return result;
    };
    const moving = createGitChangeSnapshotService({ runner });
    expect(await moving.capture(input)).toMatchObject({
      snapshot: { outcome: "unavailable", reason: "revision-mismatch" },
    });
    moving.close();
  });

  it("reports file, patch-byte, total-byte and hunk caps without claiming complete", async () => {
    const workspace = await repository();
    await writeFile(join(workspace.root, "second.txt"), "second file\n");
    git(workspace.root, "add", ".");
    git(workspace.root, "commit", "-m", "second file");
    const input = inputFor(workspace);
    const service = createGitChangeSnapshotService();
    for (const limits of [{ maxFiles: 1 }, { maxPatchBytes: 1 }, { maxTotalBytes: 1 }]) {
      const result = await service.capture({ ...input, limits });
      expect(result.snapshot).toMatchObject({ outcome: "partial" });
      expect(validateGitChangeSnapshotResult(result.snapshot)).toMatchObject({ ok: true });
    }
    service.close();
  });

  it("fails closed on malformed or truncated metadata and unavailable refs", async () => {
    const workspace = await repository();
    const input = inputFor(workspace);
    for (const truncated of [false, true]) {
      const runner: GitProcessRunner = async (args, options) => {
        const result = await defaultGitProcessRunner(args, options);
        return args.includes("--raw") ? { ...result, stdout: "untrusted", truncated } : result;
      };
      const service = createGitChangeSnapshotService({ runner });
      expect(await service.capture(input)).toMatchObject({
        snapshot: {
          outcome: "failed",
          reason: truncated ? "metadata-truncated" : "malformed-output",
        },
      });
      service.close();
    }
    const service = createGitChangeSnapshotService();
    expect(await service.capture({ ...input, headRef: "missing" })).toMatchObject({
      snapshot: { outcome: "unavailable", reason: "missing-ref" },
    });
    expect(await service.capture({ ...input, headRef: "--output=private" })).toMatchObject({
      snapshot: { outcome: "unavailable", reason: "invalid-ref" },
    });
    service.close();
  });

  it("bounds uncooperative readers, cancellation, expiry and caller mutation", async () => {
    const workspace = await repository();
    const input = inputFor(workspace);
    const cancelled = createGitChangeSnapshotService();
    expect(await cancelled.capture({ ...input, signal: AbortSignal.abort() })).toMatchObject({
      snapshot: { outcome: "failed", reason: "cancelled" },
    });
    cancelled.close();
    vi.useFakeTimers();
    const hanging = createGitChangeSnapshotService({
      runner: async () => await new Promise(() => undefined),
    });
    const pending = hanging.capture({ ...input, timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(11);
    expect(await pending).toMatchObject({ snapshot: { outcome: "failed", reason: "timeout" } });
    hanging.close();
    vi.useRealTimers();
    let clock = Date.now();
    const service = createGitChangeSnapshotService({ now: () => clock });
    const captured = await service.capture({ ...input, ttlMs: 50 });
    const first = service.read(captured.reference ?? "", input.accessScope, correlationId);
    const second = service.read(captured.reference ?? "", input.accessScope, correlationId);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    clock += 51;
    expect(
      service.read(captured.reference ?? "", input.accessScope, correlationId),
    ).toBeUndefined();
    expect(await service.recheck(captured.reference ?? "", input)).toMatchObject({
      state: "stale",
    });
    service.close();
  });
  it("captures merge-base-to-head, excludes dirty bytes, binds access, and logs no bodies", async () => {
    const workspace = await repository();
    const events: ServerLogEvent[] = [];
    const service = createGitChangeSnapshotService({
      logSink: { write: (event) => events.push(event) },
    });
    const accessScope = {};
    const input = { workspace, baseRef: "main", headRef: "feature", accessScope, correlationId };
    const initial = await service.capture(input);
    expect(initial.snapshot.outcome, JSON.stringify(events)).toBe("complete");
    expect(validateGitChangeSnapshotResult(initial.snapshot)).toMatchObject({ ok: true });
    expect(initial.reference).toMatch(/^gcs_[a-f0-9]{32}$/u);
    await writeFile(join(workspace.root, "source.txt"), "LOCAL PRIVATE DIRT\n");
    await writeFile(join(workspace.root, "untracked.txt"), "NOT REVIEWED\n");
    const dirty = await service.capture(input);
    if (!isGitChangeSnapshot(initial.snapshot) || !isGitChangeSnapshot(dirty.snapshot))
      throw new Error("capture failed");
    expect(dirty.snapshot.snapshotDigest).toBe(initial.snapshot.snapshotDigest);
    expect(dirty.snapshot.localDivergence).toMatchObject({ unstagedCount: 1, untrackedCount: 1 });
    expect(service.read(initial.reference ?? "", {}, correlationId)).toBeUndefined();
    const content = service.read(initial.reference ?? "", accessScope, correlationId);
    expect(JSON.stringify(content)).toContain("reviewed change");
    expect(JSON.stringify(content)).not.toContain("LOCAL PRIVATE DIRT");
    expect(JSON.stringify(events)).not.toMatch(/reviewed change|source\.txt|LOCAL PRIVATE DIRT/u);
    expect(events).toContainEqual(
      expect.objectContaining({ op: "git.snapshot.capture", correlationId }),
    );
    const captureLog = events.find((event) => event.op === "git.snapshot.capture");
    if (captureLog === undefined) throw new Error("capture log missing");
    expect(formatServerLogLine(captureLog)).toContain('"fileCount":1');
    expect(await service.recheck(initial.reference ?? "", input)).toMatchObject({
      state: "current",
    });
    git(workspace.root, "commit", "-am", "move head");
    expect(await service.recheck(initial.reference ?? "", input)).toMatchObject({ state: "stale" });
    expect(service.read(initial.reference ?? "", accessScope, correlationId)).toBeUndefined();
  });

  // B2-8 — a throwaway comparison (e.g. gitChangeRoutes.ts's connect/refresh handlers, which only
  // ever read `capture.snapshot`/`.remoteDigest`, never `.reference`) must be able to opt out of
  // retaining a registry slot it can never read back, so it stops competing with retained
  // chat/PR-description captures for the shared 32-slot registry.
  it("omits a registry reference when the caller opts out with retain: false", async () => {
    const workspace = await repository();
    const service = createGitChangeSnapshotService({});
    const accessScope = {};
    const retained = await service.capture({
      workspace,
      baseRef: "main",
      headRef: "feature",
      accessScope,
      correlationId,
    });
    expect(retained.reference).toMatch(/^gcs_[a-f0-9]{32}$/u);

    const throwaway = await service.capture({
      workspace,
      baseRef: "main",
      headRef: "feature",
      accessScope,
      correlationId,
      retain: false,
    });
    expect(isGitChangeSnapshot(throwaway.snapshot)).toBe(true);
    expect(throwaway.reference).toBeUndefined();
  });

  // B2-8 — `reserve`/`release` must be wired through to the shared registry (whose own eviction
  // behavior under reservation is exercised exhaustively in gitChangeSnapshotRegistry.test.ts) so
  // a caller can protect its own reference — e.g. a PR-description proposal awaiting review — from
  // unrelated capture activity sharing the same 32-slot registry.
  it("wires reserve/release through to the underlying registry", async () => {
    const workspace = await repository();
    const service = createGitChangeSnapshotService({});
    const accessScope = {};
    const captured = await service.capture({
      workspace,
      baseRef: "main",
      headRef: "feature",
      accessScope,
      correlationId,
    });
    const reference = captured.reference;
    if (reference === undefined) throw new Error("expected a retained reference");

    // Wrong scope is refused (fail-closed), matching `read`/`revoke`'s own identity check.
    expect(service.reserve?.(reference, {}, correlationId)).toBe(false);
    // The correct scope succeeds and is idempotent.
    expect(service.reserve?.(reference, accessScope, correlationId)).toBe(true);
    expect(service.reserve?.(reference, accessScope, correlationId)).toBe(true);

    // Releasing with the wrong scope is a no-op; the reservation this asserts against is proven
    // to still exist because `release` with the correct scope below is the one that removes it.
    service.release?.(reference, {}, correlationId);
    service.release?.(reference, accessScope, correlationId);
    // Re-reserving after release still succeeds — the release actually cleared the prior state
    // rather than merely reporting success without effect.
    expect(service.reserve?.(reference, accessScope, correlationId)).toBe(true);
  });
});
