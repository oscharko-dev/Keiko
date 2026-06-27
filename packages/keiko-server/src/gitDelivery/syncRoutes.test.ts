// Route tests for the governed fetch/pull sync preview + execute routes (Issue #1573, Epic #1572).
//
// Drives the handlers at the BFF seam with an injected fake GitProcessRunner (no real git). Proves:
//   * fetch/pull preview readiness + executable gate + typed blockReason.
//   * fetch/pull execute outcome classification across the full taxonomy.
//   * request hardening (404 unknown project, 400 bad/forbidden/extra-key/unsafe-ref, 413 oversize).
//   * a content-free sync evidence record lands after execute (no URLs / secrets).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { GitSyncExecuteResponse, GitSyncPreview } from "@oscharko-dev/keiko-contracts";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import type { RouteContext } from "../routes.js";
import type { GitProcessResult, GitProcessRunner } from "../gitRoutes.js";
import { createHandleSyncExecute, createHandleSyncPreview } from "./syncRoutes.js";
import type { GitDeliverySyncSeams } from "./syncExecution.js";

const FETCH_PREVIEW = "/api/git-delivery/fetch/preview";
const FETCH_EXECUTE = "/api/git-delivery/fetch/execute";
const PULL_PREVIEW = "/api/git-delivery/pull/preview";
const PULL_EXECUTE = "/api/git-delivery/pull/execute";

// --- porcelain-v2 fixtures (NUL-separated) ---------------------------------

interface StatusFixture {
  readonly branch?: string;
  readonly detached?: boolean;
  readonly upstream?: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly dirty?: boolean;
}

function porcelain(fixture: StatusFixture = {}): string {
  const lines: string[] = [];
  lines.push(
    fixture.detached ? "# branch.head (detached)" : `# branch.head ${fixture.branch ?? "main"}`,
  );
  if (fixture.upstream !== undefined) lines.push(`# branch.upstream ${fixture.upstream}`);
  if (fixture.ahead !== undefined || fixture.behind !== undefined) {
    lines.push(`# branch.ab +${String(fixture.ahead ?? 0)} -${String(fixture.behind ?? 0)}`);
  }
  if (fixture.dirty === true) lines.push("1 M. N... 100644 100644 100644 aaa bbb file.txt");
  return `${lines.join("\0")}\0`;
}

function ok(stdout: string, stderr = ""): GitProcessResult {
  return { exitCode: 0, signal: null, stdout, stderr, truncated: false };
}

function fail(stderr: string, exitCode = 1, truncated = false): GitProcessResult {
  return { exitCode, signal: null, stdout: "", stderr, truncated };
}

// --- scripted runner -------------------------------------------------------

interface RunnerScript {
  readonly status?: GitProcessResult;
  readonly remote?: GitProcessResult;
  readonly fetch?: GitProcessResult;
  readonly pull?: GitProcessResult;
}

interface ScriptedRunner {
  readonly runner: GitProcessRunner;
  readonly calls: () => readonly string[];
  readonly args: () => readonly (readonly string[])[];
}

function subcommand(args: readonly string[]): string {
  // args = ["--no-pager","--no-optional-locks","-C",root, <subcommand>, ...]
  return args[4] ?? "";
}

function scriptedRunner(script: RunnerScript): ScriptedRunner {
  const calls: string[] = [];
  const argsSeen: string[][] = [];
  const runner: GitProcessRunner = (args) => {
    const cmd = subcommand(args);
    argsSeen.push([...args]);
    calls.push(cmd);
    if (cmd === "status") return Promise.resolve(script.status ?? ok(porcelain()));
    if (cmd === "remote") return Promise.resolve(script.remote ?? ok("origin\n"));
    if (cmd === "fetch") return Promise.resolve(script.fetch ?? ok(""));
    if (cmd === "pull") return Promise.resolve(script.pull ?? ok("Already up to date.\n"));
    return Promise.resolve(ok(""));
  };
  return { runner, calls: () => calls, args: () => argsSeen };
}

function seams(script: RunnerScript): GitDeliverySyncSeams {
  return { runner: scriptedRunner(script).runner, now: () => 1_700_000_000_000 };
}

// --- evidence capture ------------------------------------------------------

interface EvidenceCapture {
  readonly store: EvidenceStore;
  readonly records: () => readonly Record<string, unknown>[];
}

function capturingEvidenceStore(): EvidenceCapture {
  const docs = new Map<string, string>();
  return {
    store: {
      put: (runId, json): string => {
        docs.set(runId, json);
        return runId;
      },
      list: () => [...docs.keys()],
      get: (runId) => docs.get(runId),
      delete: (runId) => docs.delete(runId),
    },
    records: (): readonly Record<string, unknown>[] => {
      const out: Record<string, unknown>[] = [];
      for (const json of docs.values()) {
        const doc = JSON.parse(json) as { records?: Record<string, unknown>[] };
        if (Array.isArray(doc.records)) out.push(...doc.records);
      }
      return out;
    },
  };
}

// --- harness ---------------------------------------------------------------

let store: UiStore;
let projectId: string;

function deps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    ...overrides,
  };
}

function ctxFor(path: string, body: unknown): RouteContext {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw, "utf8")]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json", "x-keiko-csrf": "1" };
  return { req, res: {} as ServerResponse, params: {}, url: new URL(`http://127.0.0.1${path}`) };
}

function syncBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: "1", projectId, ...overrides };
}

beforeEach(() => {
  store = createInMemoryUiStore();
  projectId = store.createProject(mkdtempSync(join(tmpdir(), "keiko-gd-sync-proj-"))).path;
});

afterEach(() => {
  store.close();
});

// ─── fetch preview ──────────────────────────────────────────────────────────

describe("fetch preview — readiness", () => {
  it("is executable when a remote exists", async () => {
    const handler = createHandleSyncPreview("fetch", {
      execution: seams({ status: ok(porcelain({ ahead: 1, behind: 0, upstream: "origin/main" })) }),
    });
    const res = await handler(ctxFor(FETCH_PREVIEW, syncBody()), deps());
    expect(res.status).toBe(200);
    const body = res.body as GitSyncPreview;
    expect(body.operation).toBe("fetch");
    expect(body.hasRemote).toBe(true);
    expect(body.executable).toBe(true);
    expect(body.blockReason).toBeUndefined();
  });

  it("blocks with no-remote when there is no remote", async () => {
    const handler = createHandleSyncPreview("fetch", {
      execution: seams({ remote: ok("") }),
    });
    const res = await handler(ctxFor(FETCH_PREVIEW, syncBody()), deps());
    const body = res.body as GitSyncPreview;
    expect(body.hasRemote).toBe(false);
    expect(body.executable).toBe(false);
    expect(body.blockReason).toBe("no-remote");
  });

  it("blocks a requested remote that is not configured", async () => {
    const handler = createHandleSyncPreview("fetch", {
      execution: seams({ remote: ok("origin\n") }),
    });
    const res = await handler(ctxFor(FETCH_PREVIEW, syncBody({ remote: "upstream" })), deps());
    const body = res.body as GitSyncPreview;
    expect(body.remote).toBe("upstream");
    expect(body.hasRemote).toBe(false);
    expect(body.executable).toBe(false);
    expect(body.blockReason).toBe("no-remote");
  });

  it("accepts a requested remote only when it is configured", async () => {
    const handler = createHandleSyncPreview("fetch", {
      execution: seams({ remote: ok("origin\nupstream\n") }),
    });
    const res = await handler(ctxFor(FETCH_PREVIEW, syncBody({ remote: "upstream" })), deps());
    const body = res.body as GitSyncPreview;
    expect(body.remote).toBe("upstream");
    expect(body.hasRemote).toBe(true);
    expect(body.executable).toBe(true);
    expect(body.blockReason).toBeUndefined();
  });

  it("409s when the status read fails (not a repository)", async () => {
    const handler = createHandleSyncPreview("fetch", {
      execution: seams({ status: fail("fatal: not a git repository", 128) }),
    });
    const res = await handler(ctxFor(FETCH_PREVIEW, syncBody()), deps());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "GIT_DELIVERY_SYNC_WORKTREE_UNAVAILABLE" } });
  });
});

// ─── pull preview ───────────────────────────────────────────────────────────

describe("pull preview — readiness", () => {
  it("is executable with ahead/behind reported when upstream is set", async () => {
    const handler = createHandleSyncPreview("pull", {
      execution: seams({ status: ok(porcelain({ upstream: "origin/main", ahead: 0, behind: 3 })) }),
    });
    const res = await handler(ctxFor(PULL_PREVIEW, syncBody()), deps());
    const body = res.body as GitSyncPreview;
    expect(body.executable).toBe(true);
    expect(body.hasUpstream).toBe(true);
    expect(body.behind).toBe(3);
    expect(body.upstream?.ref).toBe("origin/main");
    expect(body.blockReason).toBeUndefined();
  });

  it("blocks with detached-head on a detached HEAD", async () => {
    const handler = createHandleSyncPreview("pull", {
      execution: seams({ status: ok(porcelain({ detached: true })) }),
    });
    const res = await handler(ctxFor(PULL_PREVIEW, syncBody()), deps());
    const body = res.body as GitSyncPreview;
    expect(body.detached).toBe(true);
    expect(body.executable).toBe(false);
    expect(body.blockReason).toBe("detached-head");
  });

  it("blocks with no-upstream when no tracking branch is set", async () => {
    const handler = createHandleSyncPreview("pull", {
      execution: seams({ status: ok(porcelain({ branch: "main" })) }),
    });
    const res = await handler(ctxFor(PULL_PREVIEW, syncBody()), deps());
    const body = res.body as GitSyncPreview;
    expect(body.hasUpstream).toBe(false);
    expect(body.executable).toBe(false);
    expect(body.blockReason).toBe("no-upstream");
  });

  it("blocks with no-remote ahead of the upstream check", async () => {
    const handler = createHandleSyncPreview("pull", {
      execution: seams({ status: ok(porcelain({ upstream: "origin/main" })), remote: ok("") }),
    });
    const res = await handler(ctxFor(PULL_PREVIEW, syncBody()), deps());
    expect((res.body as GitSyncPreview).blockReason).toBe("no-remote");
  });

  it("stays executable with a dirty worktree when a tracking upstream exists", async () => {
    // A dirty worktree does not block the readiness gate (the pull may still fast-forward, and a
    // conflicting pull is reported at execute time as dirty-worktree, not blocked at preview).
    const handler = createHandleSyncPreview("pull", {
      execution: seams({
        status: ok(porcelain({ upstream: "origin/main", behind: 1, dirty: true })),
      }),
    });
    const res = await handler(ctxFor(PULL_PREVIEW, syncBody()), deps());
    const body = res.body as GitSyncPreview;
    expect(body.dirty).toBe(true);
    expect(body.executable).toBe(true);
    expect(body.blockReason).toBeUndefined();
  });
});

// ─── fetch execute ──────────────────────────────────────────────────────────

async function runFetch(
  script: RunnerScript,
  store?: EvidenceStore,
): Promise<GitSyncExecuteResponse> {
  const handler = createHandleSyncExecute("fetch", { execution: seams(script) });
  const res = await handler(
    ctxFor(FETCH_EXECUTE, syncBody()),
    deps(store ? { evidenceStore: store } : {}),
  );
  return res.body as GitSyncExecuteResponse;
}

describe("fetch execute — outcomes", () => {
  it("reports succeeded on a clean fetch", async () => {
    const body = await runFetch({ fetch: ok("") });
    expect(body.status).toBe("succeeded");
    expect(body.operation).toBe("fetch");
  });

  it("reports auth-failed on a credential rejection", async () => {
    const body = await runFetch({
      fetch: fail("fatal: Authentication failed for 'https://x'", 128),
    });
    expect(body.status).toBe("auth-failed");
  });

  it("reports untrusted-host-key when SSH host verification fails", async () => {
    const body = await runFetch({
      fetch: fail("Host key verification failed.", 128),
    });
    expect(body.status).toBe("untrusted-host-key");
  });

  it("reports no-remote on an unknown remote", async () => {
    const body = await runFetch({
      fetch: fail("fatal: 'up' does not appear to be a git repository", 128),
    });
    expect(body.status).toBe("no-remote");
  });

  it("reports timeout when the process truncated", async () => {
    const body = await runFetch({ fetch: fail("", null as unknown as number, true) });
    expect(body.status).toBe("timeout");
    expect(body.truncated).toBe(true);
  });

  it("reports git-missing on exit code 127", async () => {
    const body = await runFetch({ fetch: fail("git executable unavailable", 127) });
    expect(body.status).toBe("git-missing");
  });

  it("reports unsafe-repository on dubious ownership", async () => {
    const body = await runFetch({
      fetch: fail("fatal: detected dubious ownership in repository", 128),
    });
    expect(body.status).toBe("unsafe-repository");
  });

  it("reports git-error when a non-zero fetch matches no known stderr pattern", async () => {
    const body = await runFetch({ fetch: fail("fatal: unknown internal error", 1) });
    expect(body.status).toBe("git-error");
  });

  it("does not run fetch when preview blocks with no-remote", async () => {
    const scripted = scriptedRunner({ remote: ok("") });
    const cap = capturingEvidenceStore();
    const handler = createHandleSyncExecute("fetch", {
      execution: { runner: scripted.runner, now: () => 1_700_000_000_000 },
    });
    const res = await handler(ctxFor(FETCH_EXECUTE, syncBody()), deps({ evidenceStore: cap.store }));
    const body = res.body as GitSyncExecuteResponse;
    expect(body.status).toBe("no-remote");
    expect(scripted.calls()).toEqual(["status", "remote"]);
    expect(cap.records()[0]?.outcome).toBe("no-remote");
  });

  it("does not run fetch for a requested remote that is not configured", async () => {
    const scripted = scriptedRunner({ remote: ok("origin\n") });
    const handler = createHandleSyncExecute("fetch", {
      execution: { runner: scripted.runner, now: () => 1_700_000_000_000 },
    });
    const res = await handler(ctxFor(FETCH_EXECUTE, syncBody({ remote: "upstream" })), deps());
    const body = res.body as GitSyncExecuteResponse;
    expect(body.status).toBe("no-remote");
    expect(scripted.calls()).toEqual(["status", "remote"]);
  });

  it("passes a configured requested remote as a remote alias", async () => {
    const scripted = scriptedRunner({ remote: ok("origin\nupstream\n"), fetch: ok("") });
    const handler = createHandleSyncExecute("fetch", {
      execution: { runner: scripted.runner, now: () => 1_700_000_000_000 },
    });
    const res = await handler(ctxFor(FETCH_EXECUTE, syncBody({ remote: "upstream" })), deps());
    const body = res.body as GitSyncExecuteResponse;
    expect(body.status).toBe("succeeded");
    const fetchArgs = scripted.args().find((args) => subcommand(args) === "fetch");
    expect(fetchArgs).toBeDefined();
    expect(fetchArgs?.slice(-2)).toEqual(["--no-tags", "upstream"]);
  });

  it("does not run fetch when preview status fails", async () => {
    const scripted = scriptedRunner({ status: fail("fatal: not a git repository", 128) });
    const handler = createHandleSyncExecute("fetch", {
      execution: { runner: scripted.runner, now: () => 1_700_000_000_000 },
    });
    const res = await handler(ctxFor(FETCH_EXECUTE, syncBody()), deps());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "GIT_DELIVERY_SYNC_WORKTREE_UNAVAILABLE" } });
    expect(scripted.calls()).toEqual(["status"]);
  });
});

// ─── pull execute ───────────────────────────────────────────────────────────

async function runPull(
  script: RunnerScript,
  store?: EvidenceStore,
): Promise<GitSyncExecuteResponse> {
  const readyScript: RunnerScript = {
    status: ok(porcelain({ upstream: "origin/main", ahead: 0, behind: 1 })),
    ...script,
  };
  const handler = createHandleSyncExecute("pull", { execution: seams(readyScript) });
  const res = await handler(
    ctxFor(PULL_EXECUTE, syncBody()),
    deps(store ? { evidenceStore: store } : {}),
  );
  return res.body as GitSyncExecuteResponse;
}

describe("pull execute — outcomes", () => {
  it("reports succeeded on a fast-forward pull", async () => {
    const body = await runPull({
      pull: ok("Updating a1b2..c3d4\nFast-forward\n"),
      status: ok(porcelain({ upstream: "origin/main", ahead: 0, behind: 0 })),
    });
    expect(body.status).toBe("succeeded");
    expect(body.behind).toBe(0);
  });

  it("reports up-to-date when already up to date", async () => {
    const body = await runPull({ pull: ok("Already up to date.\n") });
    expect(body.status).toBe("up-to-date");
  });

  it("reports not-fast-forward when ff-only refuses", async () => {
    const body = await runPull({
      pull: fail("fatal: Not possible to fast-forward, aborting.", 128),
    });
    expect(body.status).toBe("not-fast-forward");
  });

  it("reports dirty-worktree when local changes would be overwritten", async () => {
    const body = await runPull({
      pull: fail(
        "error: Your local changes to the following files would be overwritten by merge",
        1,
      ),
    });
    expect(body.status).toBe("dirty-worktree");
  });

  it("reports no-upstream when there is no tracking information", async () => {
    const body = await runPull({
      pull: fail("There is no tracking information for the current branch.", 1),
    });
    expect(body.status).toBe("no-upstream");
  });

  it("reports auth-failed on a credential rejection", async () => {
    const body = await runPull({
      pull: fail("fatal: could not read Username for 'https://x'", 128),
    });
    expect(body.status).toBe("auth-failed");
  });

  it("reports untrusted-host-key when SSH host identity changes", async () => {
    const body = await runPull({
      pull: fail("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!", 128),
    });
    expect(body.status).toBe("untrusted-host-key");
  });

  it("reports timeout when the process truncated", async () => {
    const body = await runPull({ pull: fail("", null as unknown as number, true) });
    expect(body.status).toBe("timeout");
  });

  it("reports git-missing on exit code 127", async () => {
    const body = await runPull({ pull: fail("git executable unavailable", 127) });
    expect(body.status).toBe("git-missing");
  });

  it("reports unsafe-repository on dubious ownership", async () => {
    const body = await runPull({
      pull: fail("fatal: detected dubious ownership in repository", 128),
    });
    expect(body.status).toBe("unsafe-repository");
  });

  it("reports detached-head when the pull aborts off a branch", async () => {
    const body = await runPull({
      pull: fail("fatal: You are not currently on a branch.", 1),
    });
    expect(body.status).toBe("detached-head");
  });

  it("reports git-error when a non-zero pull matches no known stderr pattern", async () => {
    const body = await runPull({ pull: fail("fatal: unknown internal error", 1) });
    expect(body.status).toBe("git-error");
  });

  it("does not run pull when preview blocks with no-upstream", async () => {
    const scripted = scriptedRunner({ status: ok(porcelain({ branch: "main" })) });
    const handler = createHandleSyncExecute("pull", {
      execution: { runner: scripted.runner, now: () => 1_700_000_000_000 },
    });
    const res = await handler(ctxFor(PULL_EXECUTE, syncBody()), deps());
    const body = res.body as GitSyncExecuteResponse;
    expect(body.status).toBe("no-upstream");
    expect(scripted.calls()).toEqual(["status", "remote"]);
  });

  it("does not run pull when preview blocks with detached-head", async () => {
    const scripted = scriptedRunner({ status: ok(porcelain({ detached: true })) });
    const handler = createHandleSyncExecute("pull", {
      execution: { runner: scripted.runner, now: () => 1_700_000_000_000 },
    });
    const res = await handler(ctxFor(PULL_EXECUTE, syncBody()), deps());
    const body = res.body as GitSyncExecuteResponse;
    expect(body.status).toBe("detached-head");
    expect(scripted.calls()).toEqual(["status", "remote"]);
  });
});

// ─── request hardening ────────────────────────────────────────────────────────

describe("request hardening", () => {
  it("404s an unknown project", async () => {
    const handler = createHandleSyncPreview("fetch", { execution: seams({}) });
    const res = await handler(ctxFor(FETCH_PREVIEW, syncBody({ projectId: "/nope" })), deps());
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "GIT_DELIVERY_SYNC_UNKNOWN_PROJECT" } });
  });

  it("400s a forbidden secret-shape payload", async () => {
    const handler = createHandleSyncExecute("fetch", { execution: seams({}) });
    const res = await handler(ctxFor(FETCH_EXECUTE, syncBody({ remote: "api_keyleak" })), deps());
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "GIT_DELIVERY_SYNC_FORBIDDEN_PAYLOAD" } });
  });

  it("413s an oversize payload", async () => {
    const handler = createHandleSyncExecute("fetch", { execution: seams({}) });
    const huge = "x".repeat(65 * 1024);
    const res = await handler(ctxFor(FETCH_EXECUTE, syncBody({ projectId: huge })), deps());
    expect(res.status).toBe(413);
  });

  it("400s invalid JSON", async () => {
    const handler = createHandleSyncExecute("fetch", { execution: seams({}) });
    const res = await handler(ctxFor(FETCH_EXECUTE, "{not json"), deps());
    expect(res.status).toBe(400);
  });

  it("400s an extra key outside the allowed set", async () => {
    const handler = createHandleSyncExecute("fetch", { execution: seams({}) });
    const res = await handler(ctxFor(FETCH_EXECUTE, syncBody({ extra: 1 })), deps());
    expect(res.status).toBe(400);
  });

  it("400s a flag-injection remote ref (leading dash)", async () => {
    const handler = createHandleSyncExecute("fetch", { execution: seams({}) });
    const res = await handler(ctxFor(FETCH_EXECUTE, syncBody({ remote: "-x" })), deps());
    expect(res.status).toBe(400);
  });

  it("400s a refspec-injection remote ref (contains colon)", async () => {
    const handler = createHandleSyncExecute("fetch", { execution: seams({}) });
    const res = await handler(ctxFor(FETCH_EXECUTE, syncBody({ remote: "a:b" })), deps());
    expect(res.status).toBe(400);
  });

  it("400s a remote ref carrying a control character", async () => {
    const handler = createHandleSyncExecute("fetch", { execution: seams({}) });
    const withControl = `origin${String.fromCharCode(0x1f)}`;
    const res = await handler(ctxFor(FETCH_EXECUTE, syncBody({ remote: withControl })), deps());
    expect(res.status).toBe(400);
  });
});

// ─── evidence ───────────────────────────────────────────────────────────────

describe("evidence — content-free recording", () => {
  it("records a content-free outcome after a fetch execute", async () => {
    const cap = capturingEvidenceStore();
    await runFetch(
      { fetch: ok(""), status: ok(porcelain({ upstream: "origin/main" })) },
      cap.store,
    );
    const records = cap.records();
    expect(records).toHaveLength(1);
    const rec = records[0] ?? {};
    expect(rec.operation).toBe("fetch");
    expect(rec.outcome).toBe("succeeded");
    expect(typeof rec.repoIdHash).toBe("string");
    // No URL / secret leaf — the record carries hashes, counts, and branch/remote NAMES only.
    const serialized = JSON.stringify(rec);
    expect(serialized).not.toContain("http");
    expect(serialized).not.toContain(projectId);
  });

  it("records evidence even when the op fails", async () => {
    const cap = capturingEvidenceStore();
    await runPull({ pull: fail("fatal: Authentication failed", 128) }, cap.store);
    const records = cap.records();
    expect(records).toHaveLength(1);
    expect(records[0]?.outcome).toBe("auth-failed");
    expect(records[0]?.operation).toBe("pull");
  });
});
