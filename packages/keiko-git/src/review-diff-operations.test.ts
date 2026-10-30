// Change listing, object sizes, prefixes and blob diffs for the review diff package, against real
// `git` in temporary repositories (Issue #4134). Names are written as bytes through `mktree -z`,
// so a name no file system could create is exact on every platform.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitEnv } from "./env.js";
import { createGitReviewProcessRunner } from "./review-runner.js";
import {
  diffGitReviewBlobs,
  GitReviewOperandError,
  GitReviewOutputError,
  listGitReviewChanges,
  readGitReviewBlobPrefix,
  readGitReviewObjectSizes,
  unquoteGitReviewPath,
  type GitReviewOperationContext,
} from "./review-operations.js";

let root: string;
let repo: string;

const ENV: NodeJS.ProcessEnv = {
  ...gitEnv(),
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function git(args: readonly string[], input?: Buffer | string): string {
  return execFileSync("git", args, { cwd: repo, env: ENV, input }).toString("latin1").trim();
}

function blob(content: string | Buffer): string {
  return git(["hash-object", "-w", "--stdin"], content);
}

function tree(entries: readonly (readonly [string, string, Buffer | string])[]): string {
  const records = entries.map(([mode, oid, name]) =>
    Buffer.concat([Buffer.from(`${mode} blob ${oid}\t`), Buffer.from(name), Buffer.from([0])]),
  );
  return git(["mktree", "-z"], Buffer.concat(records));
}

function commit(entries: readonly (readonly [string, string, Buffer | string])[]): string {
  return git(["commit-tree", tree(entries), "-m", "fixture"]);
}

function context(maxBytes = 1024 * 1024): GitReviewOperationContext {
  return { runner: createGitReviewProcessRunner({}), timeoutMs: 20_000, maxBytes };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-review-diff-")));
  repo = join(root, "repo");
  execFileSync("git", ["init", "-q", repo], { env: ENV });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("unquoteGitReviewPath", () => {
  it("reads plain and C-quoted names to their exact bytes", () => {
    expect(Buffer.from(unquoteGitReviewPath("src/a b.ts")).toString()).toBe("src/a b.ts");
    expect(Buffer.from(unquoteGitReviewPath('"a\\nb\\t\\"q\\"\\\\"'))).toEqual(
      Buffer.from('a\nb\t"q"\\'),
    );
    expect(Buffer.from(unquoteGitReviewPath('"caf\\303\\251\\377"'))).toEqual(
      Buffer.from([0x63, 0x61, 0x66, 0xc3, 0xa9, 0xff]),
    );
    expect(Buffer.from(unquoteGitReviewPath('"\\a\\b\\v\\f\\r"'))).toEqual(
      Buffer.from([7, 8, 11, 12, 13]),
    );
  });

  it.each([
    "",
    "café",
    '"',
    '""',
    '"unterminated',
    '"bad\\q"',
    '"bad\\400"',
    '"in"side"',
    '"tab\there"',
  ])("refuses output it cannot read exactly: %j", (text) => {
    expect(() => unquoteGitReviewPath(text)).toThrow(GitReviewOutputError);
  });
});

describe("listGitReviewChanges", () => {
  const NON_UTF8 = Buffer.from([0x6e, 0xff, 0xfe]);

  function hostilePair(): { readonly base: string; readonly head: string } {
    const kept = blob("same\n");
    const base = commit([
      ["100644", blob("a\nb\n"), "line\nbreak"],
      ["100644", kept, "old name"],
      ["100644", blob("x\n"), NON_UTF8],
      ["100644", blob("gone\n"), "-dash"],
    ]);
    const head = commit([
      ["100644", blob("a\nB\n"), "line\nbreak"],
      ["100644", kept, "new\tname"],
      ["100755", blob("x\n"), NON_UTF8],
      ["100644", blob("\u0000bin"), "bin.dat"],
    ]);
    return { base, head };
  }

  it("lists every change with exact name bytes even when the repository disables path quoting", async () => {
    const { base, head } = hostilePair();
    git(["config", "core.quotePath", "false"]);
    const listed = await listGitReviewChanges(context(), {
      cwd: repo,
      baseSha: base,
      headSha: head,
    });
    if (!listed.ok) throw new Error("listing failed");
    const changes = listed.value.map((change) => ({
      status: change.status,
      path: Buffer.from(change.path).toString("base64"),
      previous:
        change.previousPath === undefined ? undefined : Buffer.from(change.previousPath).toString(),
      counts: [change.addedLines, change.removedLines],
      modes: [change.oldMode, change.newMode],
    }));
    expect(changes).toEqual([
      {
        status: "D",
        path: Buffer.from("-dash").toString("base64"),
        previous: undefined,
        counts: [0, 1],
        modes: ["100644", "000000"],
      },
      {
        status: "A",
        path: Buffer.from("bin.dat").toString("base64"),
        previous: undefined,
        counts: [undefined, undefined],
        modes: ["000000", "100644"],
      },
      {
        status: "M",
        path: Buffer.from("line\nbreak").toString("base64"),
        previous: undefined,
        counts: [1, 1],
        modes: ["100644", "100644"],
      },
      {
        status: "R",
        path: Buffer.from("new\tname").toString("base64"),
        previous: "old name",
        counts: [0, 0],
        modes: ["100644", "100644"],
      },
      {
        status: "M",
        path: NON_UTF8.toString("base64"),
        previous: undefined,
        counts: [0, 0],
        modes: ["100644", "100755"],
      },
    ]);
  });

  it("returns the process result when the listing is cut at its byte cap", async () => {
    const { base, head } = hostilePair();
    const listed = await listGitReviewChanges(context(32), {
      cwd: repo,
      baseSha: base,
      headSha: head,
    });
    expect(listed.ok).toBe(false);
    expect(!listed.ok && listed.result.truncated).toBe(true);
  });

  it("refuses an operand that is not a full object id before any process", async () => {
    await expect(
      listGitReviewChanges(context(), { cwd: repo, baseSha: "HEAD", headSha: "a".repeat(40) }),
    ).rejects.toThrow(GitReviewOperandError);
  });
});

describe("object sizes and prefixes", () => {
  it("reads sizes without content and reports a missing object by its absence", async () => {
    const small = blob("12345");
    const sizes = await readGitReviewObjectSizes(context(), {
      cwd: repo,
      oids: [small, "e".repeat(40)],
    });
    expect(sizes.ok && [...sizes.value.entries()]).toEqual([[small, { type: "blob", size: 5 }]]);
    expect(await readGitReviewObjectSizes(context(), { cwd: repo, oids: [] })).toEqual({
      ok: true,
      value: new Map(),
    });
  });

  it("reads no more than the requested prefix of a large blob", async () => {
    const big = blob(Buffer.alloc(2 * 1024 * 1024, 0x61));
    const prefix = await readGitReviewBlobPrefix(context(), { cwd: repo, oid: big, bytes: 8_000 });
    expect(prefix.ok && prefix.value.length).toBeLessThanOrEqual(8_000);
    const whole = await readGitReviewBlobPrefix(context(), {
      cwd: repo,
      oid: blob("tiny"),
      bytes: 8_000,
    });
    expect(whole).toEqual({ ok: true, value: "tiny" });
    await expect(
      readGitReviewBlobPrefix(context(), { cwd: repo, oid: big, bytes: 0 }),
    ).rejects.toThrow(GitReviewOperandError);
  });
});

describe("diffGitReviewBlobs", () => {
  it("diffs two blobs with fixed context, never running the repository's diff commands", async () => {
    const marker = join(root, "executed");
    git(["config", "diff.external", `sh -c 'touch "${marker}"'`]);
    git(["config", "diff.suppressBlankEmpty", "true"]);
    git(["config", "diff.context", "0"]);
    const before = blob("one\n\nthree\nfour\n");
    const after = blob("one\n\nTHREE\nfour\n");
    const patch = await diffGitReviewBlobs(context(), {
      cwd: repo,
      oldOid: before,
      newOid: after,
      contextLines: 2,
    });
    if (!patch.ok) throw new Error("diff failed");
    expect(patch.value.split("\n").slice(4)).toEqual([
      "@@ -1,4 +1,4 @@",
      " one",
      " ",
      "-three",
      "+THREE",
      " four",
      "",
    ]);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses context outside its bound", async () => {
    const oid = blob("a\n");
    await expect(
      diffGitReviewBlobs(context(), { cwd: repo, oldOid: oid, newOid: oid, contextLines: 65 }),
    ).rejects.toThrow(GitReviewOperandError);
  });
});
