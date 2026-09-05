// Route tests for the governed merge preview + execute routes (Issue #478, Epic #470).
//
// Proves the #478 acceptance criteria at the BFF seam with a FAKE merge adapter (no `gh`, no network):
//   * AC1 — merge cannot execute until policy + final approval + readiness all pass; preview surfaces the
//           readiness blockers and whether approval is required.
//   * AC2 — the eligible merge strategies are derived from policy ∩ provider capability, not a UI default.
//   * AC3 — a blocked merge reports its precise readiness blocker codes; a rejected merge reports its
//           typed rejection reason + recovery disposition/hint.
//   * AC4 — merge execution cannot bypass the gateway: blocked/approval-required attempts execute nothing
//           yet still record content-free evidence.
//   * AC5 — a not-mergeable PR is blocked before the merge adapter is ever called.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitMergeCommand, GitWorktreeSnapshot } from "@oscharko-dev/keiko-tools";
import type {
  GitMergeAdapter,
  GitMergeExecRequest,
  GitMergeExecResult,
  GitMergeProviderReadiness,
  GitMergeReadinessRequest,
} from "@oscharko-dev/keiko-tools";
import type { NodeGitMergeAdapterDeps } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type {
  GitDeliveryApprovalClaim,
  GitDeliveryPullRequestState,
} from "@oscharko-dev/keiko-contracts";
import { UI_HOST } from "../server.js";
import { buildCspHeader } from "../csp.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import { startUiTestServer } from "../ui-test-server/_support.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import type { RouteContext } from "../routes.js";
import type { ServerLogEvent } from "../observability/server-log.js";

// Spies on the default merge-adapter factory the F1 fix threads runCommand termination-evidence
// through (readMergeProviderReadiness / executeGovernedMerge's shared `mergeAdapterFor`, exercised
// below via a direct call to readMergeProviderReadiness). Delegates to the REAL implementation so
// the adapter this test file's OTHER suites inject via `mergeAdapterFactory` seams stays entirely
// unaffected. Mirrors the importOriginal-plus-delegating-wrapper pattern
// defaultPolicyPacks.test.ts and execution.test.ts already use for this exact module graph.
const createNodeGitMergeAdapterCalls: NodeGitMergeAdapterDeps[] = [];
vi.mock("@oscharko-dev/keiko-tools/internal/git-mutation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@oscharko-dev/keiko-tools/internal/git-mutation")>();
  return {
    ...actual,
    createNodeGitMergeAdapter: (deps: NodeGitMergeAdapterDeps): GitMergeAdapter => {
      createNodeGitMergeAdapterCalls.push(deps);
      return actual.createNodeGitMergeAdapter(deps);
    },
  };
});

import {
  createHandleMergeApprove,
  createHandleMergeExecute,
  createHandleMergePreview,
} from "./mergeRoutes.js";
import { createInMemoryGitDeliveryApprovalStore } from "./approvalStore.js";
import {
  readMergeProviderReadiness,
  type GitDeliveryMergeExecuteResponseBody,
  type GitDeliveryMergePreviewBody,
  type GitDeliveryMergeSeams,
} from "./mergeExecution.js";
import { permittedGitDeliveryAuthority } from "./runBoundAuthority.test-support.js";

const PREVIEW = "/api/git-delivery/merge/preview";
const APPROVE = "/api/git-delivery/merge/approve";
const EXECUTE = "/api/git-delivery/merge/execute";

const SNAPSHOT: GitWorktreeSnapshot = {
  headDetached: false,
  currentBranchName: "feat/x",
  stagedFileCount: 0,
  unstagedFileCount: 0,
  untrackedFileCount: 0,
  hasUpstream: true,
  aheadCount: 1,
  behindCount: 0,
  existingLocalBranchNames: ["feat/x", "main"],
  remoteAliases: ["origin"],
};

function prState(over: Partial<GitDeliveryPullRequestState> = {}): GitDeliveryPullRequestState {
  return {
    schemaVersion: "1",
    externalId: "42",
    status: "open",
    isDraft: false,
    headBranchName: "feat/x",
    baseBranchName: "main",
    mergeReadiness: { ready: true, requiredApprovalCount: 0, receivedApprovalCount: 0 },
    ...over,
  };
}

const READY_PROVIDER: GitMergeProviderReadiness = {
  pullRequest: prState(),
  providerCapableStrategies: ["squash", "merge-commit"],
};

interface RecordingMergeAdapter {
  readonly adapter: GitMergeAdapter;
  readonly merges: () => number;
}

function recordingMergeAdapter(
  provider: GitMergeProviderReadiness,
  mergeResult?: GitMergeExecResult,
): RecordingMergeAdapter {
  let m = 0;
  const r: GitMergeExecResult = mergeResult ?? {
    schemaVersion: "1",
    outcome: "succeeded",
    durationMs: 2,
    merged: true,
  };
  return {
    adapter: {
      readMergeReadiness: (_req: GitMergeReadinessRequest): Promise<GitMergeProviderReadiness> =>
        Promise.resolve(provider),
      mergePullRequest: (_req: GitMergeExecRequest): Promise<GitMergeExecResult> => {
        m += 1;
        return Promise.resolve(r);
      },
    },
    merges: (): number => m,
  };
}

function capturingEvidenceStore(): {
  store: EvidenceStore;
  count: () => number;
  raw: () => string;
} {
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
    count: (): number => {
      let n = 0;
      for (const json of docs.values()) {
        const doc = JSON.parse(json) as { records?: unknown[] };
        n += Array.isArray(doc.records) ? doc.records.length : 0;
      }
      return n;
    },
    raw: (): string => [...docs.values()].join("\n"),
  };
}

let server: Server;
let port: number;
let staticRoot: string;
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
    gitDeliveryAuthority: permittedGitDeliveryAuthority(
      () => projectId,
      () => projectId,
      "autonomous-delivery",
      { headRef: "feat/x", baseRef: "main", allowDetachedHead: false, allowedPrefixes: ["feat/"] },
    ),
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

function seams(overrides: Partial<GitDeliveryMergeSeams> = {}): GitDeliveryMergeSeams {
  return {
    snapshotReader: () => Promise.resolve(SNAPSHOT),
    now: () => 1_700_000_000_000,
    newActionId: () => "action-merge-test-1",
    ...overrides,
  };
}

function mergeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    projectId,
    kind: "merge",
    ownerAndRepo: "oscharko-dev/Keiko",
    prExternalId: "42",
    baseBranchName: "main",
    headBranchName: "feat/x",
    mergeStrategy: "squash",
    deleteBranchAfterMerge: false,
    ...overrides,
  };
}

function mergeCommand(overrides: Record<string, unknown> = {}): GitMergeCommand {
  const body = mergeBody(overrides);
  return {
    kind: "merge",
    ownerAndRepo: body.ownerAndRepo as string,
    prExternalId: body.prExternalId as string,
    baseBranchName: body.baseBranchName as string,
    headBranchName: body.headBranchName as string,
    mergeStrategy: body.mergeStrategy as GitMergeCommand["mergeStrategy"],
    deleteBranchAfterMerge: body.deleteBranchAfterMerge as boolean,
    ...(typeof body.expectedHeadRefHash === "string"
      ? { expectedHeadRefHash: body.expectedHeadRefHash }
      : {}),
  };
}

function issueMergeApproval(
  approvalStore: ReturnType<typeof createInMemoryGitDeliveryApprovalStore>,
  overrides: Record<string, unknown> = {},
): GitDeliveryApprovalClaim {
  return approvalStore.issue({
    binding: {
      projectId,
      operation: "merge",
      command: mergeCommand(overrides),
      runId: "test-run",
      envelopeDigest: "c".repeat(64),
    },
    approvedByUserId: "u-1",
    nowMs: 1_700_000_000_000,
    ttlMs: 60_000,
  }).approval;
}

async function closeServer(): Promise<void> {
  await new Promise<void>((res) => {
    server.close(() => {
      res();
    });
  });
}

async function startBound(overrides: Partial<UiHandlerDeps> = {}): Promise<void> {
  const started = await startUiTestServer({
    staticRoot,
    csp: buildCspHeader([]),
    handlerDeps: deps(overrides),
  });
  server = started.server;
  port = started.port;
}

beforeEach(() => {
  staticRoot = mkdtempSync(join(tmpdir(), "keiko-gd-merge-static-"));
  store = createInMemoryUiStore();
  projectId = store.createProject(mkdtempSync(join(tmpdir(), "keiko-gd-merge-proj-"))).path;
});

afterEach(() => {
  store.close();
  rmSync(staticRoot, { recursive: true, force: true });
});

describe("merge routes — central enforcement", () => {
  beforeEach(async () => {
    await startBound();
  });
  afterEach(async () => {
    await closeServer();
  });

  it("does not require a deployment enable flag before project validation", async () => {
    await closeServer();
    await startBound({ env: {} });
    for (const path of [PREVIEW, APPROVE, EXECUTE]) {
      const res = await fetch(`http://${UI_HOST}:${String(port)}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
        body: JSON.stringify(mergeBody({ projectId: "/no/such/project" })),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        error: { code: "GIT_DELIVERY_MERGE_UNKNOWN_PROJECT" },
      });
    }
  });

  it("403s without the central CSRF header", async () => {
    const res = await fetch(`http://${UI_HOST}:${String(port)}${EXECUTE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mergeBody()),
    });
    expect(res.status).toBe(403);
  });
});

describe("merge preview (read-only)", () => {
  it("surfaces eligible strategies (policy ∩ provider) and requires final approval (AC1/AC2)", async () => {
    const handler = createHandleMergePreview({
      execution: seams({
        mergeAdapterFactory: () => recordingMergeAdapter(READY_PROVIDER).adapter,
      }),
    });
    const res = await handler(ctxFor(PREVIEW, mergeBody()), deps());
    expect(res.status).toBe(200);
    const body = res.body as GitDeliveryMergePreviewBody;
    expect(body.readiness.mergeable).toBe(true);
    // squash ∈ policy(all) ∩ provider(squash, merge-commit); rebase is provider-incapable here.
    // provider-default is eligible because the policy permits it and a concrete strategy exists.
    expect(body.eligibleStrategies).toEqual(["squash", "merge-commit", "provider-default"]);
    expect(body.requestedStrategyEligible).toBe(true);
    expect(body.requiresApproval).toBe(true);
    expect(body.recommendation).toBe("needs-approval");
  });

  it("reports the precise readiness blockers for a not-mergeable PR (AC3)", async () => {
    const blocked = recordingMergeAdapter({
      pullRequest: prState({
        mergeReadiness: {
          ready: false,
          blockingReason: "conflicts",
          requiredApprovalCount: 0,
          receivedApprovalCount: 0,
        },
      }),
      providerCapableStrategies: ["squash"],
    });
    const handler = createHandleMergePreview({
      execution: seams({ mergeAdapterFactory: () => blocked.adapter }),
    });
    const res = await handler(ctxFor(PREVIEW, mergeBody()), deps());
    const body = res.body as GitDeliveryMergePreviewBody;
    expect(body.readiness.mergeable).toBe(false);
    expect(body.readiness.blockers.map((b) => b.code)).toContain("conflicts");
    // AC3: each readiness blocker carries its recovery information (remediation + action hint).
    const conflictsBlocker = body.readiness.blockers.find((b) => b.code === "conflicts");
    expect(conflictsBlocker?.remediation).toBe("user-actionable");
    expect(conflictsBlocker?.actionHint).toBe("resolve-conflicts");
    expect(body.recommendation).toBe("blocked");
  });

  it("marks a provider-incapable strategy as not eligible (AC2)", async () => {
    const handler = createHandleMergePreview({
      execution: seams({
        mergeAdapterFactory: () =>
          recordingMergeAdapter({
            pullRequest: prState(),
            providerCapableStrategies: ["merge-commit"],
          }).adapter,
      }),
    });
    const res = await handler(ctxFor(PREVIEW, mergeBody({ mergeStrategy: "squash" })), deps());
    const body = res.body as GitDeliveryMergePreviewBody;
    expect(body.requestedStrategyEligible).toBe(false);
    expect(body.eligibleStrategies).toEqual(["merge-commit", "provider-default"]);
    expect(body.readiness.blockers.map((b) => b.code)).toContain("strategy-unavailable");
  });
});

describe("merge execute (governed)", () => {
  it("returns approval-required and executes NOTHING without an approval token, still recording evidence (AC1/AC4)", async () => {
    const adapter = recordingMergeAdapter(READY_PROVIDER);
    const evidence = capturingEvidenceStore();
    const activity: ServerLogEvent[] = [];
    const handler = createHandleMergeExecute({
      execution: seams({
        mergeAdapterFactory: () => adapter.adapter,
        activityLog: {
          write: (event): void => {
            activity.push(event);
          },
        },
      }),
    });
    const res = await handler(
      {
        ...ctxFor(EXECUTE, mergeBody()),
        correlationId: "request-correlation-merge-approval-held",
      },
      deps({ evidenceStore: evidence.store }),
    );
    const body = res.body as GitDeliveryMergeExecuteResponseBody;
    expect(body.status).toBe("approval-required");
    expect(adapter.merges()).toBe(0);
    expect(evidence.count()).toBeGreaterThan(0);
    const completed = activity.find((event) => event.op === "git.delivery.mutation.completed");
    expect(completed).toMatchObject({ correlationId: "request-correlation-merge-approval-held" });
    expect(completed?.extra).toMatchObject({ status: "approval-required" });
  });

  it("rejects a forged browser-supplied approval object before merge execution", async () => {
    const adapter = recordingMergeAdapter(READY_PROVIDER);
    const handler = createHandleMergeExecute({
      execution: seams({ mergeAdapterFactory: () => adapter.adapter }),
    });
    const res = await handler(
      ctxFor(
        EXECUTE,
        mergeBody({
          approval: {
            required: true,
            approvalTokenHash: "a".repeat(64),
            approvedByUserId: "u-1",
            approvedAtMs: 1_700_000_000_000,
          },
        }),
      ),
      deps(),
    );
    expect(res.status).toBe(400);
    expect(adapter.merges()).toBe(0);
  });

  it("rejects a server-issued approval claim replayed against a different merge binding", async () => {
    const adapter = recordingMergeAdapter(READY_PROVIDER);
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = issueMergeApproval(approvalStore, { headBranchName: "feat/other" });
    const handler = createHandleMergeExecute({
      execution: seams({ mergeAdapterFactory: () => adapter.adapter, approvalStore }),
    });
    const res = await handler(ctxFor(EXECUTE, mergeBody({ approval })), deps());
    expect(res.status).toBe(400);
    expect(adapter.merges()).toBe(0);
  });

  it("blocks a not-mergeable PR BEFORE calling merge, still recording evidence (AC1/AC5)", async () => {
    const adapter = recordingMergeAdapter({
      pullRequest: prState({
        mergeReadiness: {
          ready: false,
          blockingReason: "conflicts",
          requiredApprovalCount: 0,
          receivedApprovalCount: 0,
        },
      }),
      providerCapableStrategies: ["squash"],
    });
    const evidence = capturingEvidenceStore();
    const activity: ServerLogEvent[] = [];
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = issueMergeApproval(approvalStore);
    const handler = createHandleMergeExecute({
      execution: seams({
        mergeAdapterFactory: () => adapter.adapter,
        approvalStore,
        activityLog: {
          write: (event): void => {
            activity.push(event);
          },
        },
      }),
    });
    const res = await handler(
      {
        ...ctxFor(EXECUTE, mergeBody({ approval })),
        correlationId: "request-correlation-merge-blocked",
      },
      deps({ evidenceStore: evidence.store }),
    );
    const body = res.body as GitDeliveryMergeExecuteResponseBody;
    expect(body.status).toBe("blocked");
    expect((body.readinessBlockers ?? []).map((b) => b.code)).toContain("conflicts");
    expect(adapter.merges()).toBe(0);
    expect(evidence.count()).toBeGreaterThan(0);
    const completed = activity.find((event) => event.op === "git.delivery.mutation.completed");
    expect(completed).toMatchObject({ correlationId: "request-correlation-merge-blocked" });
    expect(completed?.extra).toMatchObject({ status: "blocked" });
  });

  it("executes the merge when policy, approval, and readiness all pass (AC1)", async () => {
    const adapter = recordingMergeAdapter(READY_PROVIDER);
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = issueMergeApproval(approvalStore);
    const activity: ServerLogEvent[] = [];
    const handler = createHandleMergeExecute({
      execution: seams({
        mergeAdapterFactory: () => adapter.adapter,
        approvalStore,
        activityLog: {
          write: (event): void => {
            activity.push(event);
          },
        },
      }),
    });
    const res = await handler(
      {
        ...ctxFor(EXECUTE, mergeBody({ approval })),
        correlationId: "request-correlation-merge-success",
      },
      deps(),
    );
    const body = res.body as GitDeliveryMergeExecuteResponseBody;
    expect(body.status).toBe("succeeded");
    expect(body.merged).toBe(true);
    expect(adapter.merges()).toBe(1);
    const completed = activity.find((event) => event.op === "git.delivery.mutation.completed");
    expect(completed).toMatchObject({ correlationId: "request-correlation-merge-success" });
    expect(completed?.extra).toMatchObject({ actionKind: "merge", status: "succeeded" });
  });

  // The continuity guard re-checks authority right before remote dispatch (a TOCTOU gap: policy/preflight
  // evaluation takes time, and the admitted authority can change or be revoked while that runs). Before
  // this fix, a denial here fell through to a misleading 200 body — `status: "failed"`,
  // `executionErrorCode: "internal-error"` — telling the client an internal fault happened and is safe to
  // retry, and persisted the SAME misleading record to the evidence ledger, even though the F4 no-spawn
  // marker (git.delivery.dispatch.no-spawn, proven in the next test) and the authority-denial security
  // line had already correctly recorded a refusal. Proven red against the pre-fix code: this test
  // asserted `status).toBe("failed")` and passed with no HTTP-status or evidence assertion at all.
  it("returns the SAME 403 authority-denied response the up-front gate returns, not a misleading internal failure (#3350)", async () => {
    const adapter = recordingMergeAdapter(READY_PROVIDER);
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = issueMergeApproval(approvalStore);
    const evidence = capturingEvidenceStore();
    const activity: ServerLogEvent[] = [];
    const baseAuthority = permittedGitDeliveryAuthority(
      () => projectId,
      () => projectId,
      "autonomous-delivery",
      { headRef: "feat/x", baseRef: "main", allowDetachedHead: false, allowedPrefixes: ["feat/"] },
    );
    let reads = 0;
    const authority = {
      current: (nowIso: string): ReturnType<typeof baseAuthority.current> => {
        reads += 1;
        const active = baseAuthority.current(nowIso);
        if (active === undefined || reads === 1) return active;
        return { ...active, runId: "replacement-run", envelopeDigest: "d".repeat(64) };
      },
    };
    const handler = createHandleMergeExecute({
      execution: seams({
        mergeAdapterFactory: () => adapter.adapter,
        approvalStore,
        activityLog: {
          write: (event): void => {
            activity.push(event);
          },
        },
      }),
    });

    const res = await handler(
      {
        ...ctxFor(EXECUTE, mergeBody({ approval })),
        correlationId: "request-correlation-merge-continuity",
      },
      deps({ gitDeliveryAuthority: authority, evidenceStore: evidence.store }),
    );

    // HTTP contract: the SAME 403 envelope the up-front admission gate returns — never a 200 claiming an
    // internal, retryable failure for a request that was refused before anything was dispatched.
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: {
        code: "GIT_DELIVERY_AUTHORITY_DENIED",
        message: "The accepted runtime authority does not admit this Git delivery operation.",
        correlationId: "request-correlation-merge-continuity",
      },
    });
    expect(res.headers).toEqual({
      "X-Keiko-Correlation-Id": "request-correlation-merge-continuity",
    });
    expect(reads).toBe(2);
    expect(adapter.merges()).toBe(0);
    expect(evidence.count()).toBe(1);
    expect(evidence.raw()).toContain('"outcomeClass":"blocked"');
    expect(evidence.raw()).toContain('"blockReason":"authority-denied"');
    expect(evidence.raw()).toContain('"disposition":"policy-forbidden"');
    expect(evidence.raw()).not.toContain('"execution":');
    expect(
      activity
        .filter((event) => event.op.startsWith("git.delivery.authority."))
        .map((event) => event.extra?.phase),
    ).toEqual(["admission", "continuity"]);
    const completed = activity.find((event) => event.op === "git.delivery.mutation.completed");
    expect(completed).toMatchObject({ correlationId: "request-correlation-merge-continuity" });
    expect(completed?.extra).toMatchObject({
      status: "blocked",
      phaseReached: "execute",
      blockReason: "authority-denied",
    });
  });

  // F4: the SAME mid-flight authority-replacement scenario as the previous test, but asserting the
  // activity-log shape rather than just the response status. The continuity guard's refusal never
  // reaches the real merge adapter (adapter.merges() stays 0, proven above) — the kernel still gets
  // SOME result back from the adapter wrapper (a synthetic { outcome: "aborted" }), and without an
  // explicit marker that synthetic, never-spawned result is indistinguishable in the evidence stream
  // from a genuine `gh api` merge call that was itself cancelled mid-flight. This line is that marker.
  it("logs git.delivery.dispatch.no-spawn when authority replacement stops the merge before dispatch", async () => {
    const adapter = recordingMergeAdapter(READY_PROVIDER);
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = issueMergeApproval(approvalStore);
    const baseAuthority = permittedGitDeliveryAuthority(
      () => projectId,
      () => projectId,
      "autonomous-delivery",
      { headRef: "feat/x", baseRef: "main", allowDetachedHead: false, allowedPrefixes: ["feat/"] },
    );
    let reads = 0;
    const authority = {
      current: (nowIso: string): ReturnType<typeof baseAuthority.current> => {
        reads += 1;
        const active = baseAuthority.current(nowIso);
        if (active === undefined || reads === 1) return active;
        return { ...active, runId: "replacement-run", envelopeDigest: "d".repeat(64) };
      },
    };
    const activity: ServerLogEvent[] = [];
    const handler = createHandleMergeExecute({
      execution: seams({
        mergeAdapterFactory: () => adapter.adapter,
        approvalStore,
        activityLog: {
          write: (event): void => {
            activity.push(event);
          },
        },
      }),
    });

    const res = await handler(
      {
        ...ctxFor(EXECUTE, mergeBody({ approval })),
        correlationId: "request-correlation-merge-no-spawn",
      },
      deps({ gitDeliveryAuthority: authority }),
    );

    // The route now answers this refusal with the SAME 403 the up-front admission gate returns (see the
    // previous test); the F4 marker below is logged on the SAME path regardless, since it fires inside
    // the adapter wrapper before the route ever sees a result to project.
    expect(res.status).toBe(403);
    expect(adapter.merges()).toBe(0);
    const marker = activity.find((event) => event.op === "git.delivery.dispatch.no-spawn");
    expect(marker).toBeDefined();
    expect(marker?.correlationId).toBe("request-correlation-merge-no-spawn");
    expect(marker?.extra?.operation).toBe("merge");
    expect(marker?.status).toBe(403);
  });

  it("normalizes a provider rejection into a typed reason + recovery disposition (AC3/AC4)", async () => {
    const adapter = recordingMergeAdapter(READY_PROVIDER, {
      schemaVersion: "1",
      outcome: "failed",
      durationMs: 3,
      errorCode: "conflict",
      rejectionReason: "conflict",
    });
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = issueMergeApproval(approvalStore);
    const activity: ServerLogEvent[] = [];
    const handler = createHandleMergeExecute({
      execution: seams({
        mergeAdapterFactory: () => adapter.adapter,
        approvalStore,
        activityLog: {
          write: (event): void => {
            activity.push(event);
          },
        },
      }),
    });
    const res = await handler(
      {
        ...ctxFor(EXECUTE, mergeBody({ approval })),
        correlationId: "request-correlation-merge-rejected",
      },
      deps(),
    );
    const body = res.body as GitDeliveryMergeExecuteResponseBody;
    expect(body.mergeRejectionReason).toBe("conflict");
    expect(body.recoveryDisposition).toBe("user-fixable");
    expect(body.recoveryActionHint).toBe("resolve-conflicts");
    const completed = activity.find((event) => event.op === "git.delivery.mutation.completed");
    expect(completed).toMatchObject({
      level: "warn",
      correlationId: "request-correlation-merge-rejected",
      errorKind: "conflict",
    });
    expect(completed?.extra).toMatchObject({ status: "recovery-required" });
  });

  it("logs a snapshot precondition throw with the request correlation id", async () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = issueMergeApproval(approvalStore);
    const activity: ServerLogEvent[] = [];
    const handler = createHandleMergeExecute({
      execution: seams({
        approvalStore,
        snapshotReader: () => Promise.reject(new Error("host path must stay private")),
        activityLog: {
          write: (event): void => {
            activity.push(event);
          },
        },
      }),
    });

    const res = await handler(
      {
        ...ctxFor(EXECUTE, mergeBody({ approval })),
        correlationId: "request-correlation-merge-snapshot",
      },
      deps(),
    );

    expect(res.status).toBe(409);
    const failed = activity.find((event) => event.op === "git.delivery.mutation.failed");
    expect(failed).toMatchObject({
      level: "error",
      correlationId: "request-correlation-merge-snapshot",
    });
    expect(typeof failed?.errorKind).toBe("string");
    expect(failed?.extra).toEqual({ actionKind: "merge", phaseReached: "snapshot" });
    expect(JSON.stringify(activity)).not.toContain("host path must stay private");
  });
});

describe("merge approve (mints the approval execute consumes)", () => {
  // Before this route existed, `GitDeliveryApprovalStore.issue()` had no HTTP caller anywhere in the
  // product: the default merge policy pack is approval-gated (KEIKO_DEFAULT_MERGE_POLICY_PACK) and no
  // route could ever produce a claim satisfying it, so every merge execute call fell through to
  // "approval-required" forever — merge was unreachable by construction from any UI path. These tests
  // prove the mint route closes that gap end-to-end: mint, then redeem via execute.
  it("mints a claim that execute accepts for the exact same target, letting a previously-unreachable merge proceed", async () => {
    const adapter = recordingMergeAdapter(READY_PROVIDER);
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approveHandler = createHandleMergeApprove({
      execution: seams({ approvalStore, mergeAdapterFactory: () => adapter.adapter }),
    });
    const approveRes = await approveHandler(ctxFor(APPROVE, mergeBody()), deps());
    expect(approveRes.status).toBe(200);
    const approveBody = approveRes.body as {
      approval: GitDeliveryApprovalClaim;
      expiresAt: string;
    };
    expect(approveBody.approval.approvalId).toBeTruthy();
    expect(approveBody.approval.approvalToken).toBeTruthy();
    expect(new Date(approveBody.expiresAt).getTime()).toBeGreaterThan(1_700_000_000_000);

    const executeHandler = createHandleMergeExecute({
      execution: seams({ approvalStore, mergeAdapterFactory: () => adapter.adapter }),
    });
    const executeRes = await executeHandler(
      ctxFor(EXECUTE, mergeBody({ approval: approveBody.approval })),
      deps(),
    );
    const executeBody = executeRes.body as GitDeliveryMergeExecuteResponseBody;
    expect(executeBody.status).toBe("succeeded");
    expect(executeBody.merged).toBe(true);
    expect(adapter.merges()).toBe(1);
  });

  it("mints a claim redeemable only for the exact merge target it was issued against", async () => {
    const adapter = recordingMergeAdapter(READY_PROVIDER);
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approveHandler = createHandleMergeApprove({ execution: seams({ approvalStore }) });
    const approveRes = await approveHandler(ctxFor(APPROVE, mergeBody()), deps());
    const approveBody = approveRes.body as { approval: GitDeliveryApprovalClaim };

    const executeHandler = createHandleMergeExecute({
      execution: seams({ approvalStore, mergeAdapterFactory: () => adapter.adapter }),
    });
    const executeRes = await executeHandler(
      ctxFor(EXECUTE, mergeBody({ prExternalId: "99", approval: approveBody.approval })),
      deps(),
    );
    expect(executeRes.status).toBe(400);
    expect(adapter.merges()).toBe(0);
  });

  it("rejects a claim when a different runtime Authority Envelope is active at execute", async () => {
    const adapter = recordingMergeAdapter(READY_PROVIDER);
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const baseAuthority = permittedGitDeliveryAuthority(
      () => projectId,
      () => projectId,
      "autonomous-delivery",
      { headRef: "feat/x", baseRef: "main", allowDetachedHead: false, allowedPrefixes: ["feat/"] },
    );
    let runId = "run-a";
    let envelopeDigest = "a".repeat(64);
    const authority = {
      current: (nowIso: string): ReturnType<typeof baseAuthority.current> => {
        const active = baseAuthority.current(nowIso);
        return active === undefined ? undefined : { ...active, runId, envelopeDigest };
      },
    };
    const approveHandler = createHandleMergeApprove({ execution: seams({ approvalStore }) });
    const approveRes = await approveHandler(
      ctxFor(APPROVE, mergeBody()),
      deps({ gitDeliveryAuthority: authority }),
    );
    const approveBody = approveRes.body as { approval: GitDeliveryApprovalClaim };

    runId = "run-b";
    envelopeDigest = "b".repeat(64);
    const executeHandler = createHandleMergeExecute({
      execution: seams({ approvalStore, mergeAdapterFactory: () => adapter.adapter }),
    });
    const executeRes = await executeHandler(
      ctxFor(EXECUTE, mergeBody({ approval: approveBody.approval })),
      deps({ gitDeliveryAuthority: authority }),
    );

    expect(executeRes.status).toBe(400);
    expect(adapter.merges()).toBe(0);
  });

  it("404s for an unknown project instead of minting an approval", async () => {
    const approveHandler = createHandleMergeApprove({ execution: seams() });
    const res = await approveHandler(
      ctxFor(APPROVE, mergeBody({ projectId: "/no/such/project" })),
      deps(),
    );
    expect(res.status).toBe(404);
  });
});

describe("merge request validation", () => {
  it("rejects an unknown merge strategy", async () => {
    const handler = createHandleMergePreview({ execution: seams() });
    const res = await handler(
      ctxFor(PREVIEW, mergeBody({ mergeStrategy: "fast-forward" })),
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a malformed PR number and owner/repo", async () => {
    const handler = createHandleMergePreview({ execution: seams() });
    expect((await handler(ctxFor(PREVIEW, mergeBody({ prExternalId: "0" })), deps())).status).toBe(
      400,
    );
    expect(
      (await handler(ctxFor(PREVIEW, mergeBody({ ownerAndRepo: "no-slash" })), deps())).status,
    ).toBe(400);
    expect(
      (await handler(ctxFor(PREVIEW, mergeBody({ prExternalId: "１２" })), deps())).status,
    ).toBe(400);
  });

  it("rejects a malformed expected head sha", async () => {
    const handler = createHandleMergePreview({ execution: seams() });
    const res = await handler(ctxFor(PREVIEW, mergeBody({ expectedHeadRefHash: "zz" })), deps());
    expect(res.status).toBe(400);
  });

  it("404s when the project is unknown", async () => {
    const handler = createHandleMergePreview({ execution: seams() });
    const res = await handler(ctxFor(PREVIEW, mergeBody({ projectId: "/nope" })), deps());
    expect(res.status).toBe(404);
  });
});

// ─── F1: the default merge adapter (no mergeAdapterFactory seam) — audit finding: this branch
// previously hard-coded UNKNOWN_CORRELATION_ID and an uninjectable processServerLogSink(),
// silently dropping BOTH the caller's real correlationId and its activityLog seam. Exercises
// readMergeProviderReadiness directly (bypassing HTTP): it wraps the adapter's real
// `.readMergeReadiness()` call in its own try/catch and reports a provider-error readiness on any
// failure, so no policy-block trick is needed here — the only fact under test is what deps object
// the default factory receives. ─────────────────────────────────────────────────────────────

function testWorkspace(root: string): WorkspaceInfo {
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

const WIRING_COMMAND: GitMergeCommand = {
  kind: "merge",
  ownerAndRepo: "oscharko-dev/Keiko",
  prExternalId: "42",
  baseBranchName: "dev",
  headBranchName: "feat/x",
  mergeStrategy: "squash",
  deleteBranchAfterMerge: false,
};

describe("readMergeProviderReadiness — default merge-adapter termination wiring (F1)", () => {
  beforeEach(() => {
    createNodeGitMergeAdapterCalls.length = 0;
  });

  it("records unknown readiness and structured throws without provider bodies", async () => {
    const events: ServerLogEvent[] = [];
    const result = await readMergeProviderReadiness(
      WIRING_COMMAND,
      testWorkspace("/repo"),
      {
        activityLog: {
          write: (event): void => {
            events.push(event);
          },
        },
        mergeAdapterFactory: () => ({
          readMergeReadiness: (): Promise<never> =>
            Promise.reject(new Error("private provider body")),
          mergePullRequest: (): Promise<never> => Promise.reject(new Error("must not merge")),
        }),
      },
      () => 1,
      "readiness-correlation",
    );
    expect(result.providerError).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      op: "git.delivery.readiness.observed",
      correlationId: "readiness-correlation",
      errorKind: "internal",
      extra: { state: "unknown", providerError: true },
    });
    expect(JSON.stringify(events)).not.toContain("private provider body");
  });

  it("wires the caller's activityLog + correlationId into the default createNodeGitMergeAdapter call", async () => {
    const activity: ServerLogEvent[] = [];
    await readMergeProviderReadiness(
      WIRING_COMMAND,
      testWorkspace("/nonexistent/keiko-gd-merge-wiring"),
      {
        activityLog: {
          write: (event): void => {
            activity.push(event);
          },
        },
      },
      () => 1,
      "request-correlation-merge-wiring",
    );
    expect(createNodeGitMergeAdapterCalls).toHaveLength(1);
    const onTerminated = createNodeGitMergeAdapterCalls[0]?.onTerminated;
    expect(onTerminated).toBeTypeOf("function");
    onTerminated?.({
      reason: "spawn-callback-error",
      childPid: 9012,
      windowsTreeKill: "not-attempted",
    });
    const terminated = activity.filter((event) => event.op === "command.terminated");
    expect(terminated).toHaveLength(1);
    expect(terminated[0]?.correlationId).toBe("request-correlation-merge-wiring");
    expect(terminated[0]?.extra?.childPid).toBe(9012);
  });
});
