// Route tests for the governed fetch/pull sync preview + execute routes (Issue #1573, Epic #1572).
//
// Drives the handlers at the BFF seam with an injected fake GitProcessRunner (no real git). Proves:
//   * fetch/pull preview readiness + executable gate + typed blockReason.
//   * fetch/pull execute outcome classification across the full taxonomy.
//   * request hardening (404 unknown project, 400 bad/forbidden/extra-key/unsafe-ref, 413 oversize).
//   * a content-free sync evidence record lands after execute (no URLs / secrets).

import { captureActivityLog } from "../activityLogCapture.test-support.js";
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
import { permittedGitDeliveryAuthority } from "./runBoundAuthority.test-support.js";
import { createInMemoryGitDeliveryApprovalStore } from "./approvalStore.js";

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
    fixture.detached
      ? "# branch.head (detached)"
      : `# branch.head ${fixture.branch ?? "feature/test"}`,
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
  return { exitCode, signal: null, stdout: "", stderr, truncated, timedOut: false };
}

// The runner sets `truncated` for BOTH of its stops and `timedOut` for the wall-clock stop only, so
// the two must be constructible independently here or the classifier's distinction is untestable.
function cutOffByTimeout(): GitProcessResult {
  return {
    exitCode: null,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
    truncated: true,
    timedOut: true,
  };
}

function cutOffByOutputCap(): GitProcessResult {
  return {
    exitCode: null,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
    truncated: true,
    timedOut: false,
  };
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
    gitDeliveryAuthority: permittedGitDeliveryAuthority(() => projectId),
    ...overrides,
  };
}

function ctxFor(path: string, body: unknown): RouteContext {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw, "utf8")]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json", "x-keiko-csrf": "1" };
  return {
    correlationId: undefined,
    req,
    res: {} as ServerResponse,
    params: {},
    url: new URL(`http://127.0.0.1${path}`),
  };
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

  it("does not fetch and records authority denial when admitted authority is replaced", async () => {
    const scripted = scriptedRunner({ fetch: ok("") });
    const evidence = capturingEvidenceStore();
    const activity = captureActivityLog();
    const baseAuthority = permittedGitDeliveryAuthority(() => projectId);
    let reads = 0;
    const authority = {
      current: (nowIso: string): ReturnType<typeof baseAuthority.current> => {
        reads += 1;
        const active = baseAuthority.current(nowIso);
        if (active === undefined || reads === 1) return active;
        return { ...active, runId: "replacement-run", envelopeDigest: "d".repeat(64) };
      },
    };
    const handler = createHandleSyncExecute("fetch", {
      execution: {
        runner: scripted.runner,
        now: () => 1_700_000_000_000,
        activityLog: activity.sink,
      },
    });

    const res = await handler(
      {
        ...ctxFor(FETCH_EXECUTE, syncBody()),
        correlationId: "request-correlation-fetch-continuity",
      },
      deps({ gitDeliveryAuthority: authority, evidenceStore: evidence.store }),
    );

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: {
        code: "GIT_DELIVERY_AUTHORITY_DENIED",
        message: "The accepted runtime authority does not admit this Git delivery operation.",
        correlationId: "request-correlation-fetch-continuity",
      },
    });
    expect(res.headers).toEqual({
      "X-Keiko-Correlation-Id": "request-correlation-fetch-continuity",
    });
    expect(reads).toBe(2);
    expect(scripted.calls()).toEqual(["status", "remote"]);
    expect(evidence.records()).toHaveLength(1);
    expect(evidence.records()[0]).toMatchObject({
      operation: "fetch",
      outcome: "authority-denied",
      recordedAtMs: 1_700_000_000_000,
    });
    expect(activity.events).toContainEqual(
      expect.objectContaining({
        op: "git.delivery.dispatch.no-spawn",
        status: 403,
        correlationId: "request-correlation-fetch-continuity",
        extra: { operation: "fetch" },
      }),
    );
    expect(
      activity.events
        .filter((event) => event.op.startsWith("git.delivery.authority."))
        .map((event) => event.extra?.phase),
    ).toEqual(["admission", "continuity"]);
  });

  it("does not fetch when the live branch is outside the active branch envelope", async () => {
    const scripted = scriptedRunner({
      status: ok(porcelain({ branch: "release/v9" })),
      fetch: ok(""),
    });
    const handler = createHandleSyncExecute("fetch", {
      execution: { runner: scripted.runner, now: () => 1_700_000_000_000 },
    });

    const res = await handler(ctxFor(FETCH_EXECUTE, syncBody()), deps());

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "GIT_DELIVERY_AUTHORITY_DENIED" } });
    expect(scripted.calls()).toEqual(["status", "remote"]);
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

  // Strengthened from a single "truncated ⇒ timeout" assertion: `truncated` is set for the byte cap
  // as well as for the wall clock, so the old shape could not tell a real timeout from a capped run
  // and reported both as "timeout". Both stops still refuse to report success; they now report WHICH.
  it("reports timeout only when the wall-clock budget fired", async () => {
    const body = await runFetch({ fetch: cutOffByTimeout() });
    expect(body.status).toBe("timeout");
    expect(body.truncated).toBe(true);
  });

  it("reports output-truncated when the byte cap cut the run", async () => {
    const body = await runFetch({ fetch: cutOffByOutputCap() });
    expect(body.status).toBe("output-truncated");
    expect(body.truncated).toBe(true);
  });

  it("reports remote-unavailable when the host cannot be reached", async () => {
    for (const stderr of [
      "ssh: Could not resolve hostname github.com: Name or service not known\nfatal: Could not read from remote repository.",
      "ssh: connect to host github.com port 22: Connection refused",
      "fatal: unable to access 'https://example.invalid/x.git/': Could not resolve host: example.invalid",
    ]) {
      const body = await runFetch({ fetch: fail(stderr, 128) });
      expect(body.status).toBe("remote-unavailable");
    }
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
    const res = await handler(
      ctxFor(FETCH_EXECUTE, syncBody()),
      deps({ evidenceStore: cap.store }),
    );
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

  it("returns 403 and records authority denial when continuity authority changes", async () => {
    const scripted = scriptedRunner({
      status: ok(porcelain({ upstream: "origin/main", behind: 1 })),
      pull: ok("Updating a1b2..c3d4\nFast-forward\n"),
    });
    const evidence = capturingEvidenceStore();
    const baseAuthority = permittedGitDeliveryAuthority(() => projectId);
    let reads = 0;
    const authority = {
      current: (nowIso: string): ReturnType<typeof baseAuthority.current> => {
        reads += 1;
        const active = baseAuthority.current(nowIso);
        if (active === undefined || reads === 1) return active;
        return { ...active, runId: "replacement-run", envelopeDigest: "d".repeat(64) };
      },
    };
    const handler = createHandleSyncExecute("pull", {
      execution: { runner: scripted.runner, now: () => 1_700_000_000_000 },
    });

    const res = await handler(
      ctxFor(PULL_EXECUTE, syncBody()),
      deps({ gitDeliveryAuthority: authority, evidenceStore: evidence.store }),
    );

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "GIT_DELIVERY_AUTHORITY_DENIED" } });
    expect(scripted.calls()).toEqual(["status", "remote"]);
    expect(evidence.records()).toHaveLength(1);
    expect(evidence.records()[0]).toMatchObject({
      operation: "pull",
      outcome: "authority-denied",
      recordedAtMs: 1_700_000_000_000,
    });
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

  it("reports timeout only when the wall-clock budget fired", async () => {
    const body = await runPull({ pull: cutOffByTimeout() });
    expect(body.status).toBe("timeout");
  });

  it("reports output-truncated when the byte cap cut the run", async () => {
    const body = await runPull({ pull: cutOffByOutputCap() });
    expect(body.status).toBe("output-truncated");
  });

  it("reports remote-unavailable when the host cannot be reached", async () => {
    const body = await runPull({
      pull: fail(
        "ssh: connect to host github.com port 22: Operation timed out\nfatal: Could not read from remote repository.",
        128,
      ),
    });
    expect(body.status).toBe("remote-unavailable");
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

// ─── admission redemption below autonomous-delivery (final-audit F2 repair, #3390) ────────────────
//
// Before this fix, fetch/pull below `autonomous-delivery` were the one gap `deliveryApprovalDeferred`
// could not close: unlike push/pr/merge/commit, they have no `GitDeliveryActionKind` / kernel policy
// pack of their own to defer approval enforcement to (syncExecution.ts's header comment), so the
// coarse admission gate's "approval-required" disposition was permanently unredeemable for them.
// Redeemed the SAME way `localMutationRoutes.ts` redeems local mutations: a non-consuming peek
// against a claim bound to `{projectId, operation, command}` (no run identity), minted directly
// through the approval store (there is no dedicated `/approve` HTTP route for fetch/pull, exactly
// like local mutations). FAILING BEFORE THE FIX: every case in the first `it.each` below returned
// 403 GIT_DELIVERY_AUTHORITY_DENIED at `gitDeliveryAuthorityGate`, never reaching `runSyncExecute`
// — reproduced by temporarily dropping this describe's `approval`/`approvalStore`/`approvalBinding`
// wiring from `syncAuthorityGate` and rerunning (see the item's report for the exact command).

describe("sync execute — admission redemption below autonomous-delivery", () => {
  const MODES = ["governed-assist", "supervised-coding"] as const;
  const OPERATIONS = ["fetch", "pull"] as const;
  const CASES = MODES.flatMap((mode) => OPERATIONS.map((operation) => [mode, operation] as const));

  function pathFor(operation: (typeof OPERATIONS)[number]): string {
    return operation === "fetch" ? FETCH_EXECUTE : PULL_EXECUTE;
  }

  it.each(CASES)("mints and consumes a %s approval end to end at %s", async (mode, operation) => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const issued = approvalStore.issue({
      binding: { projectId, operation, command: { kind: operation, remote: undefined } },
      approvedByUserId: "local-operator",
      nowMs: 1_700_000_000_000,
    });
    const scripted = scriptedRunner({
      status: ok(porcelain({ upstream: "origin/main" })),
      fetch: ok(""),
      pull: ok("Already up to date.\n"),
    });
    const handler = createHandleSyncExecute(operation, {
      execution: { runner: scripted.runner, now: () => 1_700_000_000_000, approvalStore },
    });
    const modeDeps = deps({
      gitDeliveryAuthority: permittedGitDeliveryAuthority(
        () => projectId,
        () => projectId,
        mode,
      ),
    });
    const res = await handler(
      ctxFor(pathFor(operation), syncBody({ approval: issued.approval })),
      modeDeps,
    );
    expect(res.status).toBe(200);
    expect((res.body as GitSyncExecuteResponse).operation).toBe(operation);
    expect(scripted.calls()).toContain(operation);
  });

  it.each(CASES)(
    "still returns approval-required (never mode-denied) at %s for %s when execute carries no approval",
    async (mode, operation) => {
      const scripted = scriptedRunner({});
      const activity = captureActivityLog();
      const handler = createHandleSyncExecute(operation, {
        execution: {
          runner: scripted.runner,
          now: () => 1_700_000_000_000,
          activityLog: activity.sink,
        },
      });
      const modeDeps = deps({
        gitDeliveryAuthority: permittedGitDeliveryAuthority(
          () => projectId,
          () => projectId,
          mode,
        ),
      });
      const res = await handler(ctxFor(pathFor(operation), syncBody()), modeDeps);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: { code: "GIT_DELIVERY_AUTHORITY_DENIED" } });
      expect(scripted.calls()).toEqual([]);
      // Distinguishes this from a hard, non-redeemable "mode-denied" — the activity log line is the
      // only place the two 403s (identical response body) differ.
      const denials = activity.events.filter(
        (event) => event.op === "git.delivery.authority.denied",
      );
      expect(denials).toHaveLength(1);
      expect(denials[0]).toMatchObject({ extra: { reason: "approval-required", operation } });
    },
  );

  it("does not let a claim minted for fetch redeem a pull (bound to the exact operation)", async () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const issued = approvalStore.issue({
      binding: { projectId, operation: "fetch", command: { kind: "fetch", remote: undefined } },
      approvedByUserId: "local-operator",
      nowMs: 1_700_000_000_000,
    });
    const scripted = scriptedRunner({});
    const handler = createHandleSyncExecute("pull", {
      execution: { runner: scripted.runner, now: () => 1_700_000_000_000, approvalStore },
    });
    const modeDeps = deps({
      gitDeliveryAuthority: permittedGitDeliveryAuthority(
        () => projectId,
        () => projectId,
        "governed-assist",
      ),
    });
    const res = await handler(
      ctxFor(PULL_EXECUTE, syncBody({ approval: issued.approval })),
      modeDeps,
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "GIT_DELIVERY_AUTHORITY_DENIED" } });
    expect(scripted.calls()).toEqual([]);
  });

  it("autonomous-delivery still executes without any approval (unaffected by the redemption wiring)", async () => {
    const scripted = scriptedRunner({ fetch: ok("") });
    const handler = createHandleSyncExecute("fetch", {
      execution: { runner: scripted.runner, now: () => 1_700_000_000_000 },
    });
    const res = await handler(ctxFor(FETCH_EXECUTE, syncBody()), deps());
    expect(res.status).toBe(200);
    expect((res.body as GitSyncExecuteResponse).status).toBe("succeeded");
    expect(scripted.calls()).toContain("fetch");
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

describe("sync route activity log (AGENTS.md §8 Rule 1)", () => {
  // A fetch/pull answers every failure with a content-free typed code (GIT_DELIVERY_SYNC_*), by
  // design. Before this wiring that meant an auth failure, an unreachable remote, a
  // non-fast-forward or a spawn-boundary refusal on the sync path left NOTHING in `server.log` —
  // the operator's whole record of a failed sync was one `http`/`request` line and a status code.

  function ctxWithCorrelation(path: string, body: unknown, correlationId: string): RouteContext {
    return { ...ctxFor(path, body), correlationId };
  }

  it("reports a failed sync read under the request's correlation id", async () => {
    const activity = captureActivityLog();
    const handler = createHandleSyncPreview("fetch", {
      execution: {
        ...seams({ status: fail("fatal: not a git repository", 128) }),
        activityLog: activity.sink,
      },
    });

    await handler(ctxWithCorrelation(FETCH_PREVIEW, syncBody(), "corr-sync-000001"), deps());

    const failures = activity.events.filter((event) => event.op === "git.process.failed");
    expect(failures).not.toHaveLength(0);
    expect(failures[0]).toMatchObject({
      category: "diagnostic",
      correlationId: "corr-sync-000001",
      errorKind: "not-a-repository",
      extra: { subcommand: "status" },
    });
    // The response stays content-free; the log is where the reason lives.
    expect(JSON.stringify(failures[0])).not.toContain("not a git repository");
  });

  it("observes the NETWORK runner, not only the local reads", async () => {
    // normalizeSeams wraps two runners: the config-isolated local reads and the credential-capable
    // fetch/pull command. Wrapping only the first would leave the actual remote dispatch — the one
    // that can fail on auth, host keys or a non-fast-forward — unobserved, and a preview-only test
    // could not tell the difference.
    const activity = captureActivityLog();
    const handler = createHandleSyncExecute("fetch", {
      execution: {
        ...seams({
          status: ok(porcelain({ ahead: 0, behind: 0, upstream: "origin/main" })),
          remote: ok("origin\n"),
          fetch: fail("fatal: Authentication failed for 'https://example.invalid/r.git'", 128),
        }),
        activityLog: activity.sink,
      },
    });

    await handler(ctxWithCorrelation(FETCH_EXECUTE, syncBody(), "corr-sync-network-1"), deps());

    const failures = activity.events.filter((event) => event.op === "git.process.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      correlationId: "corr-sync-network-1",
      extra: { subcommand: "fetch" },
    });
    // The remote URL and git's auth message are in the runner's own output; neither may appear.
    const serialized = JSON.stringify(failures[0]);
    expect(serialized).not.toContain("example.invalid");
    expect(serialized).not.toContain("Authentication failed");
  });

  it.each([
    {
      label: "a non-fast-forward pull",
      stderr: "fatal: Not possible to fast-forward, aborting.",
      kind: "not-fast-forward",
    },
    {
      label: "a dirty worktree",
      stderr: "error: Your local changes would be overwritten by merge.",
      kind: "dirty-worktree",
    },
    {
      label: "a missing upstream",
      stderr: "There is no tracking information for the current branch.",
      kind: "no-upstream",
    },
  ])(
    "names $label in the log with the same outcome the response reports",
    async ({ stderr, kind }) => {
      // `classifyGitRemoteFailure` has no member for any of these — they are Keiko-side sync
      // vocabulary derived from git's stderr, not remote-facing phrases — so the observer would
      // report the generic remote kind while the response and the evidence ledger already named the
      // specific outcome. The call site threads its OWN classifier through `classifyFailure` so all
      // three artifacts agree about one event.
      const activity = captureActivityLog();
      const handler = createHandleSyncExecute("pull", {
        execution: {
          ...seams({
            status: ok(porcelain({ ahead: 0, behind: 2, upstream: "origin/main" })),
            remote: ok("origin\n"),
            pull: fail(stderr, 1),
          }),
          activityLog: activity.sink,
        },
      });

      await handler(ctxWithCorrelation(PULL_EXECUTE, syncBody(), "corr-sync-pullkind"), deps());

      const failures = activity.events.filter((event) => event.op === "git.process.failed");
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ correlationId: "corr-sync-pullkind", errorKind: kind });
      // Still body-free. The closed-vocabulary KIND (`not-fast-forward`) is the point of the line;
      // what must never appear is git's own prose, which is what the classifier read to derive it.
      const serialized = JSON.stringify(failures[0]);
      expect(serialized).not.toContain("aborting");
      expect(serialized).not.toContain("would be overwritten");
      expect(serialized).not.toContain("tracking information");
      expect(serialized).not.toContain("Your local changes");
    },
  );

  it("threads the correlation id on the execute route too, not only preview", async () => {
    const activity = captureActivityLog();
    const handler = createHandleSyncExecute("fetch", {
      execution: {
        ...seams({ status: fail("fatal: not a git repository", 128) }),
        activityLog: activity.sink,
      },
    });

    await handler(ctxWithCorrelation(FETCH_EXECUTE, syncBody(), "corr-sync-000002"), deps());

    expect(activity.events.map((event) => event.correlationId)).toContain("corr-sync-000002");
  });
});
