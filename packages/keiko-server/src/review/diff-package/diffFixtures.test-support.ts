// Fixture repositories for the review diff package suites (Issue #4134).
//
// Commits are built from objects (`hash-object`, `mktree -z`, `commit-tree`, or `fast-import` for
// large fixtures) with every name passed as BYTES on standard input, never through a file system:
// names with newlines, tabs, backslashes or invalid UTF-8 that macOS, Windows or a normalizing file
// system could not even create are therefore exact and identical on every platform. A gitlink may
// name a commit that does not exist, which is what a submodule pointer is to the reviewed repository.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGitReviewProcessRunner,
  gitEnv,
  type GitProcessRunner,
} from "@oscharko-dev/keiko-git";
import type { ReviewDiffPackageDeps, ReviewDiffPackageLimits } from "./types.js";

type FixtureMode = "100644" | "100755" | "120000" | "160000";

export interface FixtureEntry {
  /** A `/`-separated path; a `Buffer` keeps arbitrary bytes. */
  readonly path: string | Buffer;
  /** Blob content (a link's target for `120000`); ignored for a gitlink. */
  readonly content?: string | Buffer;
  readonly mode?: FixtureMode;
  /** The commit a gitlink (`160000`) points at. */
  readonly gitlink?: string;
}

const FIXTURE_ENV: NodeJS.ProcessEnv = {
  ...gitEnv(),
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

function toBuffer(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
}

interface TreeNode {
  readonly files: { name: Buffer; mode: FixtureMode; oid: string }[];
  readonly dirs: Map<string, { name: Buffer; node: TreeNode }>;
}

function emptyNode(): TreeNode {
  return { files: [], dirs: new Map() };
}

function splitPath(path: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let index = 0; index <= path.length; index += 1) {
    if (index === path.length || path[index] === 0x2f) {
      parts.push(path.subarray(start, index));
      start = index + 1;
    }
  }
  return parts;
}

export class DiffFixtureRepository {
  public readonly root: string;
  public readonly repo: string;

  public constructor(prefix = "keiko-review-diff-") {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    this.repo = join(this.root, "repo");
    mkdirSync(this.repo);
    this.git(["init", "-q", "-b", "main"]);
  }

  public git(args: readonly string[], input?: Buffer | string): string {
    return execFileSync("git", args, {
      cwd: this.repo,
      env: FIXTURE_ENV,
      input,
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).toString("latin1");
  }

  public gitBytes(args: readonly string[]): Buffer {
    return execFileSync("git", args, {
      cwd: this.repo,
      env: FIXTURE_ENV,
      maxBuffer: 512 * 1024 * 1024,
    });
  }

  public blob(content: string | Buffer): string {
    return this.git(["hash-object", "-w", "--stdin"], toBuffer(content)).trim();
  }

  private writeTree(node: TreeNode): string {
    const records: Buffer[] = [];
    for (const file of node.files) {
      const type = file.mode === "160000" ? "commit" : "blob";
      records.push(Buffer.from(`${file.mode} ${type} ${file.oid}\t`), file.name, Buffer.from([0]));
    }
    for (const { name, node: child } of node.dirs.values()) {
      records.push(Buffer.from(`040000 tree ${this.writeTree(child)}\t`), name, Buffer.from([0]));
    }
    return this.git(["mktree", "-z", "--missing"], Buffer.concat(records)).trim();
  }

  private insert(root: TreeNode, entry: FixtureEntry): void {
    const parts = splitPath(toBuffer(entry.path));
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const key = part.toString("base64");
      let next = node.dirs.get(key);
      if (next === undefined) {
        next = { name: part, node: emptyNode() };
        node.dirs.set(key, next);
      }
      node = next.node;
    }
    const mode = entry.mode ?? "100644";
    const oid =
      mode === "160000" ? (entry.gitlink ?? "1".repeat(40)) : this.blob(entry.content ?? "");
    node.files.push({ name: parts.at(-1) ?? Buffer.alloc(0), mode, oid });
  }

  /** A commit whose tree holds exactly these entries. */
  public commit(entries: readonly FixtureEntry[], parent?: string): string {
    const root = emptyNode();
    for (const entry of entries) this.insert(root, entry);
    const tree = this.writeTree(root);
    const args = [
      "commit-tree",
      tree,
      "-m",
      "fixture",
      ...(parent === undefined ? [] : ["-p", parent]),
    ];
    return this.git(args).trim();
  }

  /** A commit built by one `fast-import` stream; for fixtures with thousands of files. */
  public fastCommit(
    files: readonly { readonly path: string; readonly content: string }[],
    parent?: string,
  ): string {
    const ref = `refs/fixture/${String(Date.now())}${String(Math.random()).slice(2)}`;
    const lines = [
      `commit ${ref}`,
      "committer Fixture <fixture@example.invalid> 1767225600 +0000",
      "data 7",
      "fixture",
    ];
    if (parent !== undefined) lines.push(`from ${parent}`);
    lines.push("deleteall");
    const chunks = [Buffer.from(`${lines.join("\n")}\n`)];
    for (const file of files) {
      const data = Buffer.from(file.content);
      chunks.push(
        Buffer.from(`M 100644 inline ${file.path}\ndata ${String(data.length)}\n`),
        data,
        Buffer.from("\n"),
      );
    }
    chunks.push(Buffer.from("\n"));
    this.git(
      ["fast-import", "--quiet", "--done"],
      Buffer.concat([...chunks, Buffer.from("done\n")]),
    );
    return this.git(["rev-parse", ref]).trim();
  }

  public cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** Deps with the real hardened review runner and optional lowered limits. */
export function realRunnerDeps(
  limits: Partial<ReviewDiffPackageLimits> = {},
  wrap: (runner: GitProcessRunner) => GitProcessRunner = (runner) => runner,
): ReviewDiffPackageDeps {
  return { runner: (options) => wrap(createGitReviewProcessRunner(options)), limits };
}
