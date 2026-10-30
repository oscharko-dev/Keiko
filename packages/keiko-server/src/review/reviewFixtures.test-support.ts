// Shared fixtures for the review target and review worktree suites (Issue #4133): real `git` in a
// temporary directory, a hostile pull request head, a fixture-owned loopback HTTP Git remote served
// by `git http-backend` (so the pull request fetch crosses a real transport with every review
// hardening setting, `protocol.file.allow=never` included), and a byte-level snapshot of the
// user's repository state.

import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { gitEnv, resolveGitExecutable } from "@oscharko-dev/keiko-git";
import { resolveWindowsSystemDirectory } from "@oscharko-dev/keiko-security";

export const LFS_POINTER =
  "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 12\n";

export interface ReviewFixtureRoot {
  readonly root: string;
  readonly markers: string;
  cleanup(): void;
}

export function createFixtureRoot(prefix: string): ReviewFixtureRoot {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const markers = join(root, "markers");
  mkdirSync(markers);
  return {
    root,
    markers,
    cleanup: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// The fixture runs Git by the absolute path the product's own trusted-executable resolver
// (keiko-git `resolveGitExecutable`) chooses, never by a PATH lookup, and gives `git http-backend`
// a fixed system PATH (javascript:S4036).
function trustedGit(): string {
  const resolution = resolveGitExecutable(gitEnv(), tmpdir());
  if (!resolution.ok) throw new TypeError("no trusted git executable for the review fixtures");
  return resolution.path;
}

const GIT = trustedGit();
// The CGI child needs no PATH lookup (Git runs its own helpers from its exec path); it gets the
// fixed system directory only, on Windows from the one trusted keiko-security decision.
function fixedSystemPath(): string {
  if (process.platform !== "win32") return "/usr/bin:/bin";
  return win32.join(resolveWindowsSystemDirectory(), "System32");
}

// The fixture's own Git: config-isolated like the local reads, but allowed to push to and clone
// from the fixture remotes (the product's review runners never receive this environment).
function fixtureGitEnv(): NodeJS.ProcessEnv {
  return { ...gitEnv(), GIT_ALLOW_PROTOCOL: "file:http" };
}

export function git(cwd: string, ...args: string[]): string {
  try {
    return execFileSync(GIT, args, {
      cwd,
      encoding: "utf8",
      env: fixtureGitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = (error as { readonly stderr?: unknown }).stderr;
    throw new Error(`git ${args[0] ?? ""} failed: ${typeof stderr === "string" ? stderr : ""}`, {
      cause: error,
    });
  }
}

/** Non-blocking Git for commands that talk to the in-process loopback remote. */
export function gitAsync(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(GIT, args, { cwd, encoding: "utf8", env: fixtureGitEnv() }, (error, stdout) => {
      if (error === null) resolve(stdout.trim());
      else reject(new Error(`git ${args[0] ?? ""} failed`, { cause: error }));
    });
  });
}

export function initRepository(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  git(path, "config", "user.email", "fixture@example.invalid");
  git(path, "config", "user.name", "Fixture");
  git(path, "config", "commit.gpgsign", "false");
}

export function commitFile(
  repo: string,
  path: string,
  content: string | Buffer,
  message: string,
): string {
  const target = join(repo, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function marker(markers: string, name: string): string {
  return `touch '${join(markers, name)}'`;
}

/**
 * Turns `repo` into a repository whose own configuration wires a Husky-style hook directory, a
 * required filter driver, an LFS driver and an fsmonitor hook, and commits a head (on branch
 * `hostile`) that ships the hook, the attributes, an LFS pointer and a symbolic link escaping the
 * worktree. Returns the hostile head SHA; `main` stays at the base commit.
 */
export function addHostileHead(repo: string, markers: string, fsmonitorDir: string): string {
  git(repo, "checkout", "-q", "-b", "hostile");
  mkdirSync(join(repo, ".githooks"), { recursive: true });
  writeFileSync(
    join(repo, ".githooks", "post-checkout"),
    `#!/bin/sh\n${marker(markers, "hook")}\n`,
  );
  chmodSync(join(repo, ".githooks", "post-checkout"), 0o755);
  writeFileSync(join(repo, ".gitattributes"), "*.txt filter=marker\n*.bin filter=lfs\n");
  writeFileSync(join(repo, "notes.txt"), "plain text\n");
  writeFileSync(join(repo, "asset.bin"), LFS_POINTER);
  symlinkSync("../../outside-secret", join(repo, "escape"));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "hostile head");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  git(repo, "config", "core.hooksPath", ".githooks");
  git(repo, "config", "filter.marker.smudge", `sh -c "${marker(markers, "filter")}; cat"`);
  git(repo, "config", "filter.marker.clean", "cat");
  git(repo, "config", "filter.marker.required", "true");
  git(repo, "config", "filter.lfs.smudge", `sh -c "${marker(markers, "lfs")}; echo smudged"`);
  git(repo, "config", "filter.lfs.required", "true");
  const fsmonitor = join(fsmonitorDir, "fsmonitor.sh");
  writeFileSync(fsmonitor, `#!/bin/sh\n${marker(markers, "fsmonitor")}\n`);
  chmodSync(fsmonitor, 0o755);
  git(repo, "config", "core.fsmonitor", fsmonitor);
  return head;
}

/** A byte-level digest of every piece of user state AC2 protects. */
export function repositoryStateDigest(repo: string): Readonly<Record<string, string>> {
  const gitDir = join(repo, ".git");
  const file = (name: string): string =>
    existsSync(join(gitDir, name))
      ? createHash("sha256")
          .update(readFileSync(join(gitDir, name)))
          .digest("hex")
      : "absent";
  return {
    branches: git(
      repo,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads/",
      "refs/remotes/",
      "refs/tags/",
    ),
    head: readFileSync(join(gitDir, "HEAD"), "utf8"),
    index: file("index"),
    fetchHead: file("FETCH_HEAD"),
    stash: git(repo, "for-each-ref", "--format=%(objectname)", "refs/stash"),
    workingTree: git(repo, "status", "--porcelain=v1", "--untracked-files=all", "--ignored"),
    workingTreeBytes: git(repo, "ls-files", "-s"),
  };
}

export interface LoopbackGitRemote {
  readonly url: string;
  close(): Promise<void>;
}

function cgiEnvironment(
  projectRoot: string,
  request: IncomingMessage,
  url: URL,
): NodeJS.ProcessEnv {
  return {
    PATH: fixedSystemPath(),
    GIT_PROJECT_ROOT: projectRoot,
    GIT_HTTP_EXPORT_ALL: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    PATH_INFO: url.pathname,
    QUERY_STRING: url.search.slice(1),
    REQUEST_METHOD: request.method ?? "GET",
    CONTENT_TYPE: request.headers["content-type"] ?? "",
    HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
    GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
    REMOTE_ADDR: "127.0.0.1",
  };
}

function relayCgiResponse(output: Buffer, response: ServerResponse): void {
  const split = output.indexOf("\r\n\r\n");
  const header = output.subarray(0, split).toString("utf8");
  let status = 200;
  for (const line of header.split("\r\n")) {
    const colon = line.indexOf(":");
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
    else if (name.length > 0) response.setHeader(name, value);
  }
  response.statusCode = status;
  response.end(output.subarray(split + 4));
}

/** Serves the bare repositories below `projectRoot` over loopback HTTP with `git http-backend`. */
export function startLoopbackGitRemote(projectRoot: string): Promise<LoopbackGitRemote> {
  const server: Server = createServer((request, response) => {
    serveWithHttpBackend(projectRoot, request, response);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(loopbackRemote(server));
    });
  });
}

/** One CGI exchange: the request body to `git http-backend`, its response back to the client. */
function serveWithHttpBackend(
  projectRoot: string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const child = spawn(GIT, ["http-backend"], { env: cgiEnvironment(projectRoot, request, url) });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.on("close", () => {
    relayCgiResponse(Buffer.concat(chunks), response);
  });
  request.pipe(child.stdin);
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((done) => {
    server.close(() => {
      done();
    });
  });
}

function loopbackRemote(server: Server): LoopbackGitRemote {
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("expected TCP");
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () => closeServer(server),
  };
}

/** Writes a raw object without Git's own validation (`hash-object --literally`). */
export function writeRawObject(repo: string, type: "blob" | "tree", content: Buffer): string {
  return execFileSync(GIT, ["hash-object", "-w", "--literally", "-t", type, "--stdin"], {
    cwd: repo,
    env: gitEnv(),
    input: content,
  })
    .toString("utf8")
    .trim();
}

/** A raw tree of regular-file entries, in the given order, duplicates allowed. */
export function rawTree(
  repo: string,
  entries: readonly (readonly [string, string, string])[],
): string {
  const body = Buffer.concat(
    entries.map(([mode, name, oid]) =>
      Buffer.concat([Buffer.from(`${mode} ${name}\0`, "utf8"), Buffer.from(oid, "hex")]),
    ),
  );
  return writeRawObject(repo, "tree", body);
}

/** A commit of `tree` on top of `parent`, without touching any branch. */
export function commitTree(repo: string, tree: string, parent: string): string {
  return git(repo, "commit-tree", tree, "-p", parent, "-m", "crafted");
}
