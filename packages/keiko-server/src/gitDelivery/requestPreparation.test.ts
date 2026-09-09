// Reviewer 3941877976 (#3384): `gitDeliveryRepositoryBindingMismatch`'s read-failure catch used to
// discard the exception entirely and report the same closed refusal a client sees for a genuinely
// different remote — losing the errorKind/stack evidence ADR-0173's no-silent-failures contract
// requires. These tests prove the read failure is now surfaced as body-free structured evidence
// (through the caller's `onReadFailure` hook, and through the activity log line
// `prepareGitDeliveryRequest` writes) while the client-visible refusal itself is unchanged.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
} from "../observability/index.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import type { RouteContext } from "../routes.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import type { ServerLogEvent } from "../observability/server-log.js";
import {
  gitDeliveryAuthorityContinuityGuard,
  gitDeliveryAuthorityGate,
  gitDeliveryRepositoryBindingMismatch,
  prepareGitDeliveryRequest,
  type GitDeliveryRepositoryReadFailure,
} from "./requestPreparation.js";
import { permittedGitDeliveryAuthority } from "./runBoundAuthority.test-support.js";

function workspaceAt(root: string): WorkspaceInfo {
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

let brokenRoot: string;

beforeEach(() => {
  // A FILE where the workspace root is expected: every `git` invocation underneath it fails to
  // spawn (ENOTDIR), which is exactly the "unreadable worktree" failure class this fix must not
  // discard. Deterministic and hermetic — no real `git` state is required to observe the failure.
  const dir = mkdtempSync(join(tmpdir(), "keiko-gd-reqprep-"));
  brokenRoot = join(dir, "not-a-directory");
  writeFileSync(brokenRoot, "not a git worktree");
});

afterEach(() => {
  rmSync(brokenRoot, { force: true });
});

describe("gitDeliveryRepositoryBindingMismatch — read-failure evidence", () => {
  it("fails closed (mismatch=true) and reports body-free structured evidence instead of discarding the exception", async () => {
    const captured: GitDeliveryRepositoryReadFailure[] = [];
    const mismatch = await gitDeliveryRepositoryBindingMismatch(
      workspaceAt(brokenRoot),
      "owner/repo",
      (failure) => captured.push(failure),
    );
    expect(mismatch).toBe(true);
    expect(captured).toHaveLength(1);
    const failure = captured[0];
    expect(failure).toBeDefined();
    // errorKind is a non-empty closed-vocabulary token, never absent.
    expect(typeof failure?.errorKind).toBe("string");
    expect(failure?.errorKind.length).toBeGreaterThan(0);
    // Body-free: the captured evidence never carries the broken root path or free-text message.
    expect(Array.isArray(failure?.frames)).toBe(true);
    expect(Array.isArray(failure?.causeChain)).toBe(true);
    for (const value of [...(failure?.frames ?? []), ...(failure?.causeChain ?? [])]) {
      expect(value).not.toContain(brokenRoot);
    }
  });

  it("does not report a read failure for a clean read that simply names a different remote", async () => {
    // A real Git worktree with NO origin remote configured → `readVerifiedGitHubOwnerAndRepo`
    // resolves cleanly to `undefined`, which is a mismatch WITHOUT a read failure — the two must
    // stay distinguishable (a bare non-Git directory would itself fail the `git remote` read, which
    // is not the case this assertion is about).
    const dir = mkdtempSync(join(tmpdir(), "keiko-gd-reqprep-clean-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      const captured: GitDeliveryRepositoryReadFailure[] = [];
      const mismatch = await gitDeliveryRepositoryBindingMismatch(
        workspaceAt(dir),
        "owner/repo",
        (failure) => captured.push(failure),
      );
      expect(mismatch).toBe(true);
      expect(captured).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function ctxFor(correlationId: string): RouteContext {
  const req = Readable.from([Buffer.from("{}", "utf8")]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  return {
    correlationId,
    req,
    res: {} as ServerResponse,
    params: {},
    url: new URL("http://127.0.0.1/api/git/pr"),
  };
}

describe("prepareGitDeliveryRequest — repository-mismatch activity log line", () => {
  let store: UiStore;
  let registeredDir: string;

  afterEach(() => {
    store.close();
    resetServerLogger();
    rmSync(registeredDir, { force: true });
  });

  it("logs errorKind, frames and causeChain when the repository-binding read itself failed", async () => {
    store = createInMemoryUiStore();
    // The store validates the path is a real directory AT CREATION TIME only — `resolveProjectWorkspace`
    // never re-stats it — so a valid directory is registered first, then replaced with a file to force
    // every subsequent `git` read underneath it to fail (ENOTDIR), exactly like `brokenRoot` above.
    registeredDir = mkdtempSync(join(tmpdir(), "keiko-gd-reqprep-registered-"));
    const projectId = store.createProject(registeredDir).path;
    rmSync(registeredDir, { recursive: true, force: true });
    writeFileSync(registeredDir, "not a git worktree");
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));

    const deps: UiHandlerDeps = {
      config: undefined,
      configPresent: false,
      evidenceStore: {
        put: () => "",
        list: () => [],
        get: () => undefined,
        delete: () => undefined,
      },
      env: {},
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      modelPortFactory: () => undefined,
      store,
    };

    const result = await prepareGitDeliveryRequest(
      ctxFor("11111111-1111-4111-8111-111111111111"),
      deps,
      {
        tooLarge: { status: 413, body: { error: { code: "TOO_LARGE" } } },
        badRequest: { status: 400, body: { error: { code: "BAD_REQUEST" } } },
        unknownProject: { status: 404, body: { error: { code: "UNKNOWN_PROJECT" } } },
        repositoryMismatch: { status: 403, body: { error: { code: "REPOSITORY_MISMATCH" } } },
      },
      () => ({ kind: "ok", value: { projectId } }),
      () => "owner/repo",
    );

    expect(result).toEqual({
      ok: false,
      result: { status: 403, body: { error: { code: "REPOSITORY_MISMATCH" } } },
    });
    const mismatchEvent = sink.events.find(
      (event) => event.op === "git.delivery.repository.mismatch",
    );
    expect(mismatchEvent).toBeDefined();
    expect(mismatchEvent?.level).toBe("warn");
    expect(mismatchEvent?.correlationId).toBe("11111111-1111-4111-8111-111111111111");
    expect(typeof mismatchEvent?.errorKind).toBe("string");
    const extra = mismatchEvent?.extra as
      { readonly frames?: readonly string[]; readonly causeChain?: readonly string[] } | undefined;
    expect(Array.isArray(extra?.frames)).toBe(true);
    expect(Array.isArray(extra?.causeChain)).toBe(true);
  });
});

// #3390: the continuity guard re-checks authority before EVERY remote dispatch of one operation --
// for a mark-ready or a merge that is every CI-reader poll (rehearsal run-12: 52 identical
// `admitted` lines for one mark-ready). One operation, one continuity admission line; the re-check
// still runs every time, and a denial is never suppressed.
describe("gitDeliveryAuthorityContinuityGuard — one admission line per operation", () => {
  const PROJECT_ID = "project-continuity";
  const ROOT = "/workspace/continuity";
  const NOW = "2026-09-08T09:00:00.000Z";
  const target = { headBranchName: "feature/test", remoteBranchName: "feature/test" };

  it("logs the first admitted re-check, suppresses identical repeats, and always logs a denial", () => {
    const events: ServerLogEvent[] = [];
    const logSink = { write: (event: ServerLogEvent): void => void events.push(event) };
    const workspace = { root: ROOT } as WorkspaceInfo;
    const authority = permittedGitDeliveryAuthority(
      () => PROJECT_ID,
      () => ROOT,
    );
    let revoked = false;
    const deps = {
      get gitDeliveryAuthority(): typeof authority | undefined {
        return revoked ? undefined : authority;
      },
    };
    const ctx = { correlationId: "correlation-continuity" } as never;
    const admission = gitDeliveryAuthorityGate(ctx, deps, PROJECT_ID, workspace, "push", target, {
      nowIso: NOW,
      logSink,
    });
    if (!admission.allowed) throw new Error("fixture admission must be allowed");
    const guard = gitDeliveryAuthorityContinuityGuard({
      ctx,
      deps,
      projectId: PROJECT_ID,
      workspace,
      operation: "push",
      target,
      admitted: { runId: admission.runId, envelopeDigest: admission.envelopeDigest },
      audit: { nowIso: NOW, logSink },
    });

    expect([guard(), guard(), guard()]).toEqual([true, true, true]);
    const admitted = events.filter((event) => event.op === "git.delivery.authority.admitted");
    expect(admitted.map((event) => event.extra?.phase)).toEqual(["admission", "continuity"]);

    revoked = true;
    expect(guard()).toBe(false);
    expect(events.filter((event) => event.op === "git.delivery.authority.denied")).toEqual([
      expect.objectContaining({
        extra: { operation: "push", phase: "continuity", reason: "accepted-run-unavailable" },
      }),
    ]);
  });
});
