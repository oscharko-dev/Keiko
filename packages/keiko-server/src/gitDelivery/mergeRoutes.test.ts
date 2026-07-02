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
import type { AddressInfo } from "node:net";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitWorktreeSnapshot } from "@oscharko-dev/keiko-tools";
import type {
  GitMergeAdapter,
  GitMergeCommand,
  GitMergeExecRequest,
  GitMergeExecResult,
  GitMergeProviderReadiness,
  GitMergeReadinessRequest,
} from "@oscharko-dev/keiko-tools";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type {
  GitDeliveryApprovalClaim,
  GitDeliveryPullRequestState,
} from "@oscharko-dev/keiko-contracts";
import { createUiServer, UI_HOST } from "../server.js";
import { buildCspHeader } from "../csp.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import type { RouteContext } from "../routes.js";
import { createHandleMergeExecute, createHandleMergePreview } from "./mergeRoutes.js";
import { createInMemoryGitDeliveryApprovalStore } from "./approvalStore.js";
import type {
  GitDeliveryMergeExecuteResponseBody,
  GitDeliveryMergePreviewBody,
  GitDeliveryMergeSeams,
} from "./mergeExecution.js";

const PREVIEW = "/api/git-delivery/merge/preview";
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
    binding: { projectId, operation: "merge", command: mergeCommand(overrides) },
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
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0 });
  await new Promise<void>((res) => server.listen(0, UI_HOST, res));
  port = (server.address() as AddressInfo).port;
  await closeServer();
  server = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port,
    handlerDeps: deps(overrides),
  });
  await new Promise<void>((res) => server.listen(port, UI_HOST, res));
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
    for (const path of [PREVIEW, EXECUTE]) {
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
    const handler = createHandleMergeExecute({
      execution: seams({ mergeAdapterFactory: () => adapter.adapter }),
    });
    const res = await handler(
      ctxFor(EXECUTE, mergeBody()),
      deps({ evidenceStore: evidence.store }),
    );
    const body = res.body as GitDeliveryMergeExecuteResponseBody;
    expect(body.status).toBe("approval-required");
    expect(adapter.merges()).toBe(0);
    expect(evidence.count()).toBeGreaterThan(0);
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
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = issueMergeApproval(approvalStore);
    const handler = createHandleMergeExecute({
      execution: seams({ mergeAdapterFactory: () => adapter.adapter, approvalStore }),
    });
    const res = await handler(
      ctxFor(EXECUTE, mergeBody({ approval })),
      deps({ evidenceStore: evidence.store }),
    );
    const body = res.body as GitDeliveryMergeExecuteResponseBody;
    expect(body.status).toBe("blocked");
    expect((body.readinessBlockers ?? []).map((b) => b.code)).toContain("conflicts");
    expect(adapter.merges()).toBe(0);
    expect(evidence.count()).toBeGreaterThan(0);
  });

  it("executes the merge when policy, approval, and readiness all pass (AC1)", async () => {
    const adapter = recordingMergeAdapter(READY_PROVIDER);
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = issueMergeApproval(approvalStore);
    const handler = createHandleMergeExecute({
      execution: seams({ mergeAdapterFactory: () => adapter.adapter, approvalStore }),
    });
    const res = await handler(ctxFor(EXECUTE, mergeBody({ approval })), deps());
    const body = res.body as GitDeliveryMergeExecuteResponseBody;
    expect(body.status).toBe("succeeded");
    expect(body.merged).toBe(true);
    expect(adapter.merges()).toBe(1);
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
    const handler = createHandleMergeExecute({
      execution: seams({ mergeAdapterFactory: () => adapter.adapter, approvalStore }),
    });
    const res = await handler(ctxFor(EXECUTE, mergeBody({ approval })), deps());
    const body = res.body as GitDeliveryMergeExecuteResponseBody;
    expect(body.mergeRejectionReason).toBe("conflict");
    expect(body.recoveryDisposition).toBe("user-fixable");
    expect(body.recoveryActionHint).toBe("resolve-conflicts");
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
