import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  renameSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathDeniedError } from "./errors.js";
import { nodeWorkspaceFs } from "./fs.js";
import {
  GIT_STAGE_FILE_MAX_BYTES,
  GIT_SEQUENCER_STATE_UNAVAILABLE,
  assertGitStageFileUnchanged,
  gitSequencerOperationInProgress,
  inspectGitStageFile,
  observeGitIndexTransactions,
  isGitStageLargeFile,
  readGitStageFile,
  removeGitCommitState,
  repointSymbolicHead,
  streamGitStageFile,
  withGitBranchRefLocks,
  withGitIndexTransaction,
  type GitCleanupOptions,
  type GitIndexCleanupReport,
  type GitRefLockCleanupReport,
  type RemovePath,
} from "./gitIndexTransaction.js";
import { workspaceFsWithOwnedRootAuthority } from "./ownedRootMint.js";
let root: string;
function git(args: readonly string[], cwd = root, input?: string): string {
  return execFileSync("git", [...args], {
    cwd,
    ...(input === undefined ? {} : { input }),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-index-owner-")));
  git(["init", "-qb", "dev"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.test"]);
  writeFileSync(join(root, "file"), "base\n");
  git(["add", "file"]);
  git(["-c", "commit.gpgsign=false", "commit", "-qm", "base"]);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
describe("existing workspace Git metadata index owner", () => {
  // Owner review of PR #3452 (2026-09-10): a 64 KiB default kept a lockfile or a bundled asset from
  // ever being staged by a governed run. The default now equals the raw scan's content budget, and
  // a file beyond it is still refused rather than read in part.
  it("reads a stage file up to the raw scan's content budget and refuses one beyond it", async () => {
    writeFileSync(join(root, "lock.json"), Buffer.alloc(100 * 1024, 0x7b));
    const file = await readGitStageFile(root, "lock.json");
    expect(file.bytes.byteLength).toBe(100 * 1024);
    writeFileSync(join(root, "huge.bin"), Buffer.alloc(GIT_STAGE_FILE_MAX_BYTES + 1, 0x00));
    await expect(readGitStageFile(root, "huge.bin")).rejects.toThrow("git-stage-file-too-large");
  });

  // A file's size never fails an inspection: above the inline bound it is a handle (size and
  // identity) that is streamed in bounded chunks, whatever its size, and a change fails closed.
  it("inspects a file above the inline bound as a streamable handle, not an in-memory read", async () => {
    const bytes = Buffer.alloc(GIT_STAGE_FILE_MAX_BYTES + 5 * 1024 * 1024, 0x61);
    writeFileSync(join(root, "huge.bin"), bytes);
    writeFileSync(join(root, "small.txt"), "small\n");
    const small = await inspectGitStageFile(root, "small.txt");
    expect(isGitStageLargeFile(small)).toBe(false);
    const large = await inspectGitStageFile(root, "huge.bin");
    if (!isGitStageLargeFile(large)) throw new Error("expected a large handle");
    expect(large).toMatchObject({ path: "huge.bin", mode: "100644", size: bytes.length });
    let streamed = 0;
    let chunks = 0;
    await streamGitStageFile(root, large, {}, (chunk) => {
      streamed += chunk.byteLength;
      chunks += 1;
      expect(chunk.byteLength).toBeLessThanOrEqual(1024 * 1024);
    });
    expect(streamed).toBe(bytes.length);
    expect(chunks).toBeGreaterThan(1);
    expect(() => {
      assertGitStageFileUnchanged(root, large);
    }).not.toThrow();
  });

  it("fails closed with git-stage-file-changed when a large file changes or is swapped", async () => {
    writeFileSync(join(root, "huge.bin"), Buffer.alloc(200 * 1024, 0x61));
    const large = await inspectGitStageFile(root, "huge.bin");
    if (!isGitStageLargeFile(large)) throw new Error("expected a large handle");
    appendFileSync(join(root, "huge.bin"), "x");
    expect(() => {
      assertGitStageFileUnchanged(root, large);
    }).toThrow("git-stage-file-changed");
    await expect(streamGitStageFile(root, large, {}, () => undefined)).rejects.toThrow(
      "git-stage-file-changed",
    );
    const fresh = await inspectGitStageFile(root, "huge.bin");
    if (!isGitStageLargeFile(fresh)) throw new Error("expected a large handle");
    rmSync(join(root, "huge.bin"));
    symlinkSync("/etc/hosts", join(root, "huge.bin"));
    expect(() => {
      assertGitStageFileUnchanged(root, fresh);
    }).toThrow("git-stage-file-changed");
  });

  // A permanent refusal must not read as the transient `git-stage-file-changed` (which the model
  // retries): a directory or a hard-linked file above the inline bound can never be staged.
  it("names a non-regular or hard-linked entry above the inline bound with its own permanent code", async () => {
    mkdirSync(join(root, "folder"));
    await expect(inspectGitStageFile(root, "folder", { inlineMaxBytes: 0 })).rejects.toThrow(
      "git-stage-file-not-regular",
    );
    writeFileSync(join(root, "one.bin"), Buffer.alloc(100 * 1024, 0x61));
    linkSync(join(root, "one.bin"), join(root, "two.bin"));
    await expect(inspectGitStageFile(root, "one.bin")).rejects.toThrow(
      "git-stage-file-hard-linked",
    );
  });

  it("stops a streamed read at the next chunk once the signal is aborted", async () => {
    writeFileSync(join(root, "huge.bin"), Buffer.alloc(4 * 1024 * 1024, 0x61));
    const large = await inspectGitStageFile(root, "huge.bin");
    if (!isGitStageLargeFile(large)) throw new Error("expected a large handle");
    const controller = new AbortController();
    let chunks = 0;
    await expect(
      streamGitStageFile(root, large, { signal: controller.signal }, () => {
        chunks += 1;
        controller.abort();
      }),
    ).rejects.toThrow("git-stage-read-cancelled");
    expect(chunks).toBe(1);
  });

  // The staging write path keeps refusing a link that leaves the workspace; only the status read
  // (`symlinks: "read-only"`) compares the raw link bytes without following the target (#4491).
  it.each(["/etc/hosts", "../outside-target"])(
    "refuses staging a link to %s but reads its raw bytes in read-only mode",
    async (target) => {
      symlinkSync(target, join(root, "link"));
      await expect(readGitStageFile(root, "link")).rejects.toThrow();
      const file = await readGitStageFile(root, "link", { symlinks: "read-only" });
      expect(file.mode).toBe("120000");
      expect(Buffer.from(file.bytes).toString()).toBe(target);
    },
  );

  it("holds Git's own lock until the exact index transaction ends", async () => {
    const index = readFileSync(join(root, ".git/index"));
    await withGitIndexTransaction(
      root,
      (): Promise<boolean> => {
        expect(() => git(["add", "file"])).toThrow();
        return Promise.resolve(false);
      },
      (value) => value,
    );
    expect(readFileSync(join(root, ".git/index"))).toEqual(index);
    expect(existsSync(join(root, ".git/index.lock"))).toBe(false);
  });
  it("shows an observer the private index before the mutation and right before the swap, under the lock", async () => {
    const seen: string[] = [];
    const lockHeld = (): boolean => existsSync(join(root, ".git/index.lock"));
    const listing = (indexPath: string): string => {
      expect(lockHeld()).toBe(true);
      return execFileSync("git", ["ls-files", "--stage"], {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH, GIT_INDEX_FILE: indexPath },
      });
    };
    writeFileSync(join(root, "added"), "added\n");
    await observeGitIndexTransactions(
      {
        copied: (indexPath) => {
          seen.push(listing(indexPath));
          return Promise.resolve();
        },
        prepared: (indexPath) => {
          seen.push(listing(indexPath));
          return Promise.resolve();
        },
      },
      () =>
        withGitIndexTransaction(
          root,
          (transaction): Promise<boolean> => {
            execFileSync("git", ["add", "added"], {
              cwd: root,
              env: { PATH: process.env.PATH, GIT_INDEX_FILE: transaction.temporaryIndexPath },
            });
            return Promise.resolve(true);
          },
          (value) => value,
        ),
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toContain("added");
    expect(seen[1]).toContain("added");
    expect(git(["ls-files"])).toContain("added");
  });
  it("refuses to publish or promote when acceptance lapses while the observer is pending", async () => {
    let accepting = true;
    let published = false;
    const before = git(["ls-files", "--stage"]);
    writeFileSync(join(root, "added"), "added\n");
    await expect(
      observeGitIndexTransactions(
        {
          copied: () => Promise.resolve(),
          prepared: () => {
            accepting = false;
            return Promise.resolve();
          },
        },
        () =>
          withGitIndexTransaction(
            root,
            (transaction): Promise<boolean> => {
              execFileSync("git", ["add", "added"], {
                cwd: root,
                env: { PATH: process.env.PATH, GIT_INDEX_FILE: transaction.temporaryIndexPath },
              });
              const quarantine = transaction.openObjectQuarantine(40);
              const publish = quarantine.publish;
              (quarantine as { publish: () => void }).publish = (): void => {
                published = true;
                publish();
              };
              return Promise.resolve(true);
            },
            (value) => value && accepting,
          ),
      ),
    ).rejects.toThrow("git-index-authority-denied");
    expect(published).toBe(false);
    expect(git(["ls-files", "--stage"])).toBe(before);
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(false);
  });
  it("tells no observer about a transaction that was refused", async () => {
    let prepared = 0;
    await observeGitIndexTransactions(
      {
        copied: () => Promise.resolve(),
        prepared: () => {
          prepared += 1;
          return Promise.resolve();
        },
      },
      () =>
        withGitIndexTransaction(
          root,
          (): Promise<boolean> => Promise.resolve(false),
          (value) => value,
        ),
    );
    expect(prepared).toBe(0);
  });
  it("rechecks authority after asynchronous metadata validation before replacement", async () => {
    const index = readFileSync(join(root, ".git/index"));
    let checks = 0;
    await expect(
      withGitIndexTransaction(
        root,
        (): Promise<boolean> => Promise.resolve(true),
        () => ++checks === 1,
      ),
    ).rejects.toThrow("authority-denied");
    expect(readFileSync(join(root, ".git/index"))).toEqual(index);
  });
  it("accepts a genuine reciprocal managed worktree without widening metadata access", async () => {
    const workspace = join(root, "worktree");
    git(["worktree", "add", "-qb", "codex/task", workspace]);
    await expect(
      withGitIndexTransaction(
        workspace,
        (): Promise<boolean> => Promise.resolve(false),
        (value) => value,
      ),
    ).resolves.toBe(false);
    expect(git(["status", "--porcelain"], workspace)).toBe("");
  });
  it("refuses an index symlink and leaves its target untouched", async () => {
    const target = join(root, "target");
    writeFileSync(target, "private");
    rmSync(join(root, ".git/index"));
    symlinkSync(target, join(root, ".git/index"));
    await expect(
      withGitIndexTransaction(
        root,
        (): Promise<boolean> => Promise.resolve(true),
        (value) => value,
      ),
    ).rejects.toThrow("index-file-invalid");
    expect(readFileSync(target, "utf8")).toBe("private");
    expect(existsSync(join(root, ".git/index.lock"))).toBe(false);
  });
  it("refuses forged external Git metadata and escaping file parents", async () => {
    const outside = join(root, "outside");
    git(["init", "-q", outside]);
    const target = join(root, "linked");
    symlinkSync("/etc", target);
    await expect(readGitStageFile(root, "linked/passwd")).rejects.toThrow();
    const pointer = join(outside, ".git");
    rmSync(pointer, { recursive: true });
    writeFileSync(pointer, `gitdir: ${join(root, ".git")}\n`);
    await expect(
      withGitIndexTransaction(
        outside,
        (): Promise<boolean> => Promise.resolve(true),
        (value) => value,
      ),
    ).rejects.toThrow("metadata-unavailable");
  });
});

// A managed task worktree lives below the state directory's always-denied `.keiko` segment. The
// stage-file reader and the index transaction resolved the root through the plain node port, so
// the coding runtime's raw status read (and, one step later, its staging) were refused inside such a
// worktree (run 5, 2026-09-10). Both now take the port the prover bound to the root; the plain
// default keeps refusing the same root.
describe("a workspace root below an always-denied segment", () => {
  let base: string;
  let managed: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-index-denied-")));
    managed = join(base, ".keiko", "ui", "task-workspaces", "repo_1", "ws_1");
    mkdirSync(managed, { recursive: true });
    git(["init", "-qb", "dev"], managed);
    git(["config", "user.name", "Test"], managed);
    git(["config", "user.email", "test@example.test"], managed);
    writeFileSync(join(managed, "file"), "base\n");
    git(["add", "file"], managed);
    git(["-c", "commit.gpgsign=false", "commit", "-qm", "base"], managed);
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("refuses the plain port and reads the stage file through the owned-root port", async () => {
    await expect(readGitStageFile(managed, "file")).rejects.toBeInstanceOf(PathDeniedError);
    const fs = workspaceFsWithOwnedRootAuthority(nodeWorkspaceFs, managed);
    const file = await readGitStageFile(managed, "file", { fs });
    expect(file.mode).toBe("100644");
    expect(Buffer.from(file.bytes).toString("utf8")).toBe("base\n");
  });

  it("opens the index transaction only through the owned-root port", async () => {
    await expect(
      withGitIndexTransaction(
        managed,
        () => Promise.resolve(true),
        (result) => result,
      ),
    ).rejects.toThrow("git-index-metadata-unavailable");
    const fs = workspaceFsWithOwnedRootAuthority(nodeWorkspaceFs, managed);
    await expect(
      withGitIndexTransaction(
        managed,
        (transaction) => Promise.resolve(existsSync(transaction.temporaryIndexPath)),
        (result) => result,
        fs,
      ),
    ).resolves.toBe(true);
    expect(existsSync(join(managed, ".git", "index.lock"))).toBe(false);
  });
});

describe("the object quarantine of an index transaction", () => {
  const blobId = (text: string): string =>
    execFileSync("git", ["hash-object", "--stdin"], {
      cwd: root,
      input: text,
      encoding: "utf8",
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  const quarantined = (text: string, directory: string): string =>
    execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: text,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OBJECT_DIRECTORY: directory,
      },
    }).trim();

  it("keeps an object private until published and removes the quarantine afterwards", async () => {
    let id = "";
    let directory = "";
    await withGitIndexTransaction(
      root,
      (transaction) => {
        const quarantine = transaction.openObjectQuarantine(40);
        directory = quarantine.directory;
        id = quarantined("candidate\n", quarantine.directory);
        expect(existsSync(join(root, ".git", "objects", id.slice(0, 2), id.slice(2)))).toBe(false);
        quarantine.publish();
        expect(git(["cat-file", "-p", id])).toBe("candidate");
        return Promise.resolve(true);
      },
      () => false,
    );
    expect(id).toBe(blobId("candidate\n"));
    expect(existsSync(directory)).toBe(false);
  });

  it("refuses to publish an entry that is not a loose object", async () => {
    await expect(
      withGitIndexTransaction(
        root,
        (transaction) => {
          const quarantine = transaction.openObjectQuarantine(40);
          writeFileSync(join(quarantine.directory, "stray"), "x");
          quarantine.publish();
          return Promise.resolve(true);
        },
        () => false,
      ),
    ).rejects.toThrow("git-object-quarantine-invalid");
  });

  // Validation covers the whole tree before the first rename: a valid object listed before an
  // invalid one must not be published by a publication that then throws.
  it("publishes nothing when any entry of the quarantine is invalid", async () => {
    let id = "";
    await expect(
      withGitIndexTransaction(
        root,
        (transaction) => {
          const quarantine = transaction.openObjectQuarantine(40);
          id = quarantined("first\n", quarantine.directory);
          mkdirSync(join(quarantine.directory, "zz"));
          writeFileSync(join(quarantine.directory, "zz", "x".repeat(38)), "bad");
          quarantine.publish();
          return Promise.resolve(true);
        },
        () => false,
      ),
    ).rejects.toThrow("git-object-quarantine-invalid");
    expect(existsSync(join(root, ".git", "objects", id.slice(0, 2), id.slice(2)))).toBe(false);
  });

  it("refuses a loose object whose name does not fit the repository's object format", async () => {
    await expect(
      withGitIndexTransaction(
        root,
        (transaction) => {
          const quarantine = transaction.openObjectQuarantine(40);
          mkdirSync(join(quarantine.directory, "ab"));
          writeFileSync(join(quarantine.directory, "ab", "c".repeat(50)), "x");
          quarantine.publish();
          return Promise.resolve(true);
        },
        () => false,
      ),
    ).rejects.toThrow("git-object-quarantine-invalid");
  });

  it("skips an object a concurrent writer already published", async () => {
    await withGitIndexTransaction(
      root,
      (transaction) => {
        const quarantine = transaction.openObjectQuarantine(40);
        const id = quarantined("raced\n", quarantine.directory);
        git(["hash-object", "-w", "--stdin"], root, "raced\n");
        expect(() => {
          quarantine.publish();
        }).not.toThrow();
        expect(git(["cat-file", "-p", id])).toBe("raced");
        return Promise.resolve(true);
      },
      () => false,
    );
  });

  it("refuses a link standing where a quarantined object would be published", async () => {
    await expect(
      withGitIndexTransaction(
        root,
        (transaction) => {
          const quarantine = transaction.openObjectQuarantine(40);
          const id = quarantined("linked\n", quarantine.directory);
          const fanOut = join(root, ".git", "objects", id.slice(0, 2));
          mkdirSync(fanOut, { recursive: true });
          symlinkSync(join(root, "elsewhere"), join(fanOut, id.slice(2)));
          quarantine.publish();
          return Promise.resolve(true);
        },
        () => false,
      ),
    ).rejects.toThrow("git-object-quarantine-invalid");
  });

  it("publishes a pack with its index last and refuses a pack without an index", async () => {
    const make = (quarantine: string): void => {
      writeFileSync(join(root, "big.bin"), "x".repeat(4096));
      execFileSync("git", ["-c", "core.bigFileThreshold=1", "hash-object", "-w", "--", "big.bin"], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_OBJECT_DIRECTORY: quarantine,
        },
      });
    };
    let packed = "";
    await withGitIndexTransaction(
      root,
      (transaction) => {
        const quarantine = transaction.openObjectQuarantine(40);
        make(quarantine.directory);
        packed = readdirSync(join(quarantine.directory, "pack")).sort().join(",");
        quarantine.publish();
        return Promise.resolve(true);
      },
      () => false,
    );
    const names = packed.split(",");
    expect(names.some((n) => n.endsWith(".pack"))).toBe(true);
    expect(names.some((n) => n.endsWith(".idx"))).toBe(true);
    for (const name of names)
      expect(existsSync(join(root, ".git", "objects", "pack", name))).toBe(true);
    git(["fsck", "--strict"]);
    await expect(
      withGitIndexTransaction(
        root,
        (transaction) => {
          const quarantine = transaction.openObjectQuarantine(40);
          mkdirSync(join(quarantine.directory, "pack"));
          writeFileSync(join(quarantine.directory, "pack", `pack-${"a".repeat(40)}.pack`), "x");
          quarantine.publish();
          return Promise.resolve(true);
        },
        () => false,
      ),
    ).rejects.toThrow("git-object-quarantine-invalid");
  });

  it("publishes only when the transaction accepts the result, just before the index moves", async () => {
    let id = "";
    await withGitIndexTransaction(
      root,
      (transaction) => {
        id = quarantined("accepted\n", transaction.openObjectQuarantine(40).directory);
        return Promise.resolve(false);
      },
      (accepted) => accepted,
    );
    expect(existsSync(join(root, ".git", "objects", id.slice(0, 2), id.slice(2)))).toBe(false);
    await withGitIndexTransaction(
      root,
      (transaction) => {
        id = quarantined("accepted\n", transaction.openObjectQuarantine(40).directory);
        return Promise.resolve(true);
      },
      (accepted) => accepted,
    );
    expect(git(["cat-file", "-p", id])).toBe("accepted");
  });
  // A sharing violation (EBUSY) on exactly one removal, injected through the removal seam: it behaves
  // the same on every platform, unlike a permission trick.
  function busyOn(
    kinds: readonly ("file" | "directory" | "tree")[],
    match: (path: string) => boolean = () => true,
  ): RemovePath {
    return (path, kind) => {
      if (kinds.includes(kind) && match(path))
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      defaultRemove(path, kind);
    };
  }
  function defaultRemove(path: string, kind: "file" | "directory" | "tree"): void {
    if (kind === "directory") rmdirSync(path);
    else rmSync(path, { recursive: kind === "tree", force: true });
  }
  async function refusedWithQuarantine(
    options: GitCleanupOptions<GitIndexCleanupReport>,
  ): Promise<boolean> {
    return withGitIndexTransaction(
      root,
      (transaction) => {
        writeFileSync(join(transaction.openObjectQuarantine(40).directory, "kept"), "x");
        return Promise.resolve(false);
      },
      (accepted) => accepted,
      nodeWorkspaceFs,
      options,
    );
  }
  async function laterTransactionSucceeds(): Promise<void> {
    await expect(
      withGitIndexTransaction(
        root,
        () => Promise.resolve(true),
        (accepted) => accepted,
      ),
    ).resolves.toBe(true);
  }
  it("releases the index lock and descriptor when a quarantine cannot be removed, and reports it", async () => {
    const reports: GitIndexCleanupReport[] = [];
    const refused = await refusedWithQuarantine({
      removePath: busyOn(["tree"]),
      onCleanupFailure: (report) => reports.push(report),
    });
    expect(refused).toBe(false);
    expect(reports).toEqual([
      { quarantines: 1, temporaryIndex: false, lock: false, descriptor: false },
    ]);
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(false);
    await laterTransactionSucceeds();
  });
  it("removes the lock even when the private index cannot be removed, and reports it", async () => {
    const reports: GitIndexCleanupReport[] = [];
    const accepted = await withGitIndexTransaction(
      root,
      () => Promise.resolve(false),
      (value) => value,
      nodeWorkspaceFs,
      {
        removePath: busyOn(["file"], (path) => path.includes(".keiko-index-")),
        onCleanupFailure: (report) => reports.push(report),
      },
    );
    expect(accepted).toBe(false);
    expect(reports).toEqual([
      { quarantines: 0, temporaryIndex: true, lock: false, descriptor: false },
    ]);
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(false);
    await laterTransactionSucceeds();
  });
  it("reports a lock that cannot be removed without replacing the settled result", async () => {
    const reports: GitIndexCleanupReport[] = [];
    const accepted = await withGitIndexTransaction(
      root,
      () => Promise.resolve(false),
      (value) => value,
      nodeWorkspaceFs,
      {
        removePath: busyOn(["file"], (path) => path.endsWith("index.lock")),
        onCleanupFailure: (report) => reports.push(report),
      },
    );
    expect(accepted).toBe(false);
    expect(reports).toEqual([
      { quarantines: 0, temporaryIndex: false, lock: true, descriptor: false },
    ]);
    expect(readdirSync(join(root, ".git")).some((n) => n.startsWith(".keiko-index-"))).toBe(false);
    // The leftover is a real lock: it blocks the next transaction until it is removed.
    await expect(
      withGitIndexTransaction(
        root,
        () => Promise.resolve(true),
        (value) => value,
      ),
    ).rejects.toThrow();
    rmSync(join(root, ".git", "index.lock"));
    await laterTransactionSucceeds();
  });
  it("never replaces the settled result with a throwing report port", async () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error & { code?: string }): void => {
      warnings.push(warning.code ?? "");
    };
    process.on("warning", onWarning);
    try {
      const refused = await refusedWithQuarantine({
        removePath: busyOn(["tree"]),
        onCleanupFailure: () => {
          throw new Error("port failed");
        },
      });
      expect(refused).toBe(false);
      await refusedWithQuarantine({ removePath: busyOn(["tree"]) });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("warning", onWarning);
    }
    expect(warnings).toEqual(["KEIKO_GIT_CLEANUP_UNREPORTED", "KEIKO_GIT_CLEANUP_UNREPORTED"]);
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(false);
  });
  it("keeps what run settled when a created ref directory cannot be removed, and reports it", async () => {
    const reports: GitRefLockCleanupReport[] = [];
    const answer = await withGitBranchRefLocks(
      root,
      ["feature/first", "second"],
      () => Promise.resolve("settled"),
      nodeWorkspaceFs,
      {
        removePath: busyOn(["directory"]),
        onCleanupFailure: (report) => reports.push(report),
      },
    );
    expect(answer).toBe("settled");
    expect(reports).toEqual([{ refLocks: 0, descriptors: 0, directories: 1 }]);
    expect(existsSync(join(root, ".git", "refs", "heads", "second.lock"))).toBe(false);
    expect(existsSync(join(root, ".git", "refs", "heads", "feature", "first.lock"))).toBe(false);
  });
  it("releases every ref lock when one cannot be removed, and reports the one that stayed", async () => {
    const reports: GitRefLockCleanupReport[] = [];
    const answer = await withGitBranchRefLocks(
      root,
      ["alpha", "beta"],
      () => Promise.resolve("settled"),
      nodeWorkspaceFs,
      {
        removePath: busyOn(["file"], (path) => path.endsWith("beta.lock")),
        onCleanupFailure: (report) => reports.push(report),
      },
    );
    expect(answer).toBe("settled");
    expect(reports).toEqual([{ refLocks: 1, descriptors: 0, directories: 0 }]);
    expect(existsSync(join(root, ".git", "refs", "heads", "alpha.lock"))).toBe(false);
    expect(existsSync(join(root, ".git", "refs", "heads", "beta.lock"))).toBe(true);
  });
  it("keeps the failure of run when the cleanup also fails", async () => {
    await expect(
      withGitBranchRefLocks(
        root,
        ["feature/third"],
        () => Promise.reject(new Error("run failed")),
        nodeWorkspaceFs,
        { removePath: busyOn(["directory"]), onCleanupFailure: () => undefined },
      ),
    ).rejects.toThrow("run failed");
  });
});

describe("repointSymbolicHead cleanup", () => {
  const headLock = (): string => join(root, ".git", "HEAD.lock");
  const branch = (): string => git(["symbolic-ref", "HEAD"]);
  function failingClose(): { close: (fd: number) => void; calls: number[] } {
    const calls: number[] = [];
    return {
      calls,
      close: (fd: number): void => {
        calls.push(fd);
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
    };
  }

  it("closes the descriptor once, removes HEAD.lock and keeps HEAD when the close throws", async () => {
    const reports: GitRefLockCleanupReport[] = [];
    const close = failingClose();
    await expect(
      repointSymbolicHead(root, "dev", "next", nodeWorkspaceFs, {
        closeDescriptor: close.close,
        onCleanupFailure: (report) => reports.push(report),
      }),
    ).rejects.toThrow();
    expect(close.calls).toHaveLength(1);
    expect(existsSync(headLock())).toBe(false);
    expect(branch()).toBe("refs/heads/dev");
    expect(reports).toEqual([{ refLocks: 0, descriptors: 1, directories: 0 }]);
  });

  it("reports a HEAD.lock that cannot be removed and keeps the failure that ended the write", async () => {
    const reports: GitRefLockCleanupReport[] = [];
    await expect(
      repointSymbolicHead(root, "other", "next", nodeWorkspaceFs, {
        removePath: () => {
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        },
        onCleanupFailure: (report) => reports.push(report),
      }),
    ).rejects.toThrow("git-head-changed");
    expect(reports).toEqual([{ refLocks: 1, descriptors: 0, directories: 0 }]);
    rmSync(headLock());
  });

  it("publishes and leaves no lock on the normal path", async () => {
    await repointSymbolicHead(root, "dev", "next");
    expect(existsSync(headLock())).toBe(false);
    expect(branch()).toBe("refs/heads/next");
  });
});

describe("cleanup ownership and distinct facts", () => {
  it("never removes a ref lock whose ownership cannot be proved, and counts it", async () => {
    const reports: GitRefLockCleanupReport[] = [];
    await withGitBranchRefLocks(
      root,
      ["alpha"],
      () => Promise.resolve("settled"),
      nodeWorkspaceFs,
      {
        ownsLock: () => {
          throw new Error("EIO");
        },
        onCleanupFailure: (report) => reports.push(report),
      },
    );
    expect(existsSync(join(root, ".git", "refs", "heads", "alpha.lock"))).toBe(true);
    expect(reports).toEqual([{ refLocks: 1, descriptors: 0, directories: 0 }]);
    rmSync(join(root, ".git", "refs", "heads", "alpha.lock"));
  });

  it("reports a descriptor that cannot be closed as a descriptor, not as a lock", async () => {
    const reports: GitIndexCleanupReport[] = [];
    await withGitIndexTransaction(
      root,
      () => Promise.resolve(false),
      (value) => value,
      nodeWorkspaceFs,
      {
        closeDescriptor: (fd) => {
          closeSync(fd);
          throw new Error("EBUSY");
        },
        onCleanupFailure: (report) => reports.push(report),
      },
    );
    expect(reports).toEqual([
      { quarantines: 0, temporaryIndex: false, lock: false, descriptor: true },
    ]);
    expect(existsSync(join(root, ".git", "index.lock"))).toBe(false);
  });

  it("counts a ref lock descriptor that cannot be closed separately", async () => {
    const reports: GitRefLockCleanupReport[] = [];
    await withGitBranchRefLocks(root, ["alpha"], () => Promise.resolve(1), nodeWorkspaceFs, {
      closeDescriptor: (fd) => {
        closeSync(fd);
        throw new Error("EBUSY");
      },
      onCleanupFailure: (report) => reports.push(report),
    });
    expect(reports).toEqual([{ refLocks: 0, descriptors: 1, directories: 0 }]);
  });

  it("counts a private index that stays because the gitdir is no longer the locked one", async () => {
    const reports: GitIndexCleanupReport[] = [];
    await withGitIndexTransaction(
      root,
      (transaction) => {
        const moved = `${root}-moved`;
        renameSync(join(root, ".git"), moved);
        mkdirSync(join(root, ".git"));
        // The private index lives in the moved directory; the replaced one is another directory.
        expect(existsSync(transaction.temporaryIndexPath)).toBe(false);
        return Promise.resolve(false);
      },
      (value) => value,
      nodeWorkspaceFs,
      { onCleanupFailure: (report) => reports.push(report) },
    ).catch(() => undefined);
    rmSync(`${root}-moved`, { recursive: true, force: true });
    expect(reports.some((r) => r.temporaryIndex || r.lock)).toBe(true);
  });
});

describe("gitSequencerOperationInProgress", () => {
  it("reads the sequencer files through the injected port and fails closed when it throws", async () => {
    // The Node port's `exists` reads every lstat error as "absent"; the probe must not.
    writeFileSync(join(root, ".git", "MERGE_HEAD"), "x\n");
    const statFails = {
      ...nodeWorkspaceFs,
      stat: (path: string): ReturnType<typeof nodeWorkspaceFs.stat> => {
        if (path.endsWith("MERGE_HEAD"))
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return nodeWorkspaceFs.stat(path);
      },
    };
    await expect(gitSequencerOperationInProgress(root, statFails)).rejects.toThrow(
      GIT_SEQUENCER_STATE_UNAVAILABLE,
    );
    await expect(gitSequencerOperationInProgress(root)).resolves.toBe(true);
  });

  it("counts a merge state file it cannot examine and removes the others", async () => {
    writeFileSync(join(root, ".git", "MERGE_MSG"), "m\n");
    writeFileSync(join(root, ".git", "SQUASH_MSG"), "s\n");
    const statFails = {
      ...nodeWorkspaceFs,
      stat: (path: string): ReturnType<typeof nodeWorkspaceFs.stat> => {
        if (path.endsWith("MERGE_MSG")) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        return nodeWorkspaceFs.stat(path);
      },
    };
    await expect(removeGitCommitState(root, statFails)).resolves.toBe(1);
    expect(existsSync(join(root, ".git", "MERGE_MSG"))).toBe(true);
    expect(existsSync(join(root, ".git", "SQUASH_MSG"))).toBe(false);
  });

  it.each(["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"])(
    "reports %s as an operation in progress, whatever it holds",
    async (name) => {
      await expect(gitSequencerOperationInProgress(root)).resolves.toBe(false);
      writeFileSync(join(root, ".git", name), "not a commit id\n");
      await expect(gitSequencerOperationInProgress(root)).resolves.toBe(true);
    },
  );

  it("fails closed when the repository metadata cannot be resolved", async () => {
    const unreadable = {
      ...nodeWorkspaceFs,
      realPath: (): string => {
        throw new Error("EACCES");
      },
    };
    await expect(gitSequencerOperationInProgress(root, unreadable)).rejects.toThrow(
      GIT_SEQUENCER_STATE_UNAVAILABLE,
    );
  });
});
