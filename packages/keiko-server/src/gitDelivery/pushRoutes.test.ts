// Route tests for the governed remote publish preview + execute routes (Issue #476, Epic #470).
//
// Proves the #476 publish acceptance criteria at the BFF seam:
//   * AC1 — the read-only preview surfaces the remote target, risk class, and policy decision.
//   * AC2 — a protected/shared remote target is blocked by the DEFAULT publish policy pack; an ordinary
//           user-namespace branch is permitted.
//   * AC3 — an executed push that is rejected reports a typed publish-rejection reason + recovery hint.
//   * AC4 — a force push is blocked and the remote adapter is never invoked.
//   * AC5 — push execution cannot bypass the gateway: blocked attempts execute nothing yet still record
//           content-free evidence for allowed AND blocked outcomes.

import { captureActivityLog } from "../activityLogCapture.test-support.js";
import type { ServerLogEvent, ServerLogSink } from "../observability/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitDeliveryApprovalClaim,
  GitDeliveryRepoPolicyPack,
} from "@oscharko-dev/keiko-contracts";
import { GIT_DELIVERY_POLICY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-policy";
import type { GitPushCommand, GitWorktreeSnapshot } from "@oscharko-dev/keiko-tools";
import type { GitPublishExecResult, GitRemotePublishAdapter } from "@oscharko-dev/keiko-tools";
import type { NodeGitPublishAdapterDeps } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { UI_HOST } from "../server.js";
import { buildCspHeader } from "../csp.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import type { RouteContext } from "../routes.js";
import { startUiTestServer } from "../ui-test-server/_support.js";

// Spies on the default remote publish-adapter factory the F1 fix threads runCommand
// termination-evidence through (executeGovernedPublish's `publishAdapterFor`, exercised below via
// direct calls to executeGovernedPublish itself). Delegates to the REAL implementation so the
// adapter this test file's OTHER suites inject via `publishAdapterFactory` seams stays entirely
// unaffected. Mirrors the importOriginal-plus-delegating-wrapper pattern
// defaultPolicyPacks.test.ts and execution.test.ts already use for this exact module graph.
const createNodeGitPublishAdapterCalls: NodeGitPublishAdapterDeps[] = [];
vi.mock("@oscharko-dev/keiko-tools/internal/git-mutation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@oscharko-dev/keiko-tools/internal/git-mutation")>();
  return {
    ...actual,
    createNodeGitPublishAdapter: (deps: NodeGitPublishAdapterDeps): GitRemotePublishAdapter => {
      createNodeGitPublishAdapterCalls.push(deps);
      return actual.createNodeGitPublishAdapter(deps);
    },
  };
});

import {
  createHandlePushApprove,
  createHandlePushExecute,
  createHandlePushPreview,
} from "./pushRoutes.js";
import {
  executeGovernedPublish,
  type GitDeliveryPushExecuteResponseBody,
  type GitDeliveryPushPreviewBody,
  type GitDeliveryPublishSeams,
} from "./pushExecution.js";
import { createInMemoryGitDeliveryApprovalStore } from "./approvalStore.js";
import { permittedGitDeliveryAuthority } from "./runBoundAuthority.test-support.js";

const PREVIEW = "/api/git-delivery/push/preview";
const EXECUTE = "/api/git-delivery/push/execute";

const SNAPSHOT: GitWorktreeSnapshot = {
  headDetached: false,
  currentBranchName: "feat/x",
  stagedFileCount: 0,
  unstagedFileCount: 0,
  untrackedFileCount: 0,
  hasUpstream: true,
  aheadCount: 1,
  behindCount: 0,
  existingLocalBranchNames: ["feat/x", "dev"],
  remoteAliases: ["origin"],
};

interface RecordingPublishAdapter {
  readonly adapter: GitRemotePublishAdapter;
  readonly calls: () => number;
}

function recordingPublishAdapter(result?: GitPublishExecResult): RecordingPublishAdapter {
  let n = 0;
  const r: GitPublishExecResult = result ?? {
    schemaVersion: "1",
    outcome: "succeeded",
    durationMs: 2,
  };
  return {
    adapter: {
      publish: (): Promise<GitPublishExecResult> => {
        n += 1;
        return Promise.resolve(r);
      },
    },
    calls: (): number => n,
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
      {
        headRef: "feat/x",
        baseRef: "dev",
        allowDetachedHead: false,
        allowedPrefixes: ["feat/"],
      },
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

// No policyPacks override → the route applies KEIKO_DEFAULT_PUBLISH_POLICY_PACK (the AC2 default).
function seams(overrides: Partial<GitDeliveryPublishSeams> = {}): GitDeliveryPublishSeams {
  return {
    snapshotReader: () => Promise.resolve(SNAPSHOT),
    branchProtectionReader: () => Promise.resolve({ outcome: "unprotected" }),
    now: () => 1_700_000_000_000,
    newActionId: () => "action-test-1",
    ...overrides,
  };
}

function pushBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    projectId,
    remoteAlias: "origin",
    remoteBranchName: "feat/x",
    sourceBranchName: "feat/x",
    ...overrides,
  };
}

// Mints a real HTTP approval against the running test server's mount (the SHARED default approval
// store the production route table falls back to, since these HTTP-level tests never inject a
// seams.approvalStore override) and returns the request body with that claim attached — proves the
// mint route end to end for the one HTTP-fetch-level test that needs it.
async function approveThenBody(
  body: Record<string, unknown>,
  approvePath: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`http://${UI_HOST}:${String(port)}${approvePath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
    body: JSON.stringify(body),
  });
  const approved = (await res.json()) as { approval: GitDeliveryApprovalClaim };
  return { ...body, approval: approved.approval };
}

// #3387 (ADR-0138 D2): an accepted run's push now requires an actually consumed, server-issued
// claim — mirrors commitRoutes.test.ts's issueCommitApproval, minting into a caller-supplied store
// against the SAME binding runPushMutation resolves at consume time (projectId, operation "push",
// the exact typed command, and the default test authority's runId/envelopeDigest).
function issuePushApproval(
  approvalStore: ReturnType<typeof createInMemoryGitDeliveryApprovalStore>,
  command: GitPushCommand,
  authority: { readonly runId?: string; readonly envelopeDigest?: string } = {},
): GitDeliveryApprovalClaim {
  return approvalStore.issue({
    binding: {
      projectId,
      operation: "push",
      command,
      runId: authority.runId ?? "test-run",
      envelopeDigest: authority.envelopeDigest ?? "c".repeat(64),
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
  staticRoot = mkdtempSync(join(tmpdir(), "keiko-gd-push-static-"));
  store = createInMemoryUiStore();
  projectId = store.createProject(mkdtempSync(join(tmpdir(), "keiko-gd-push-proj-"))).path;
});

afterEach(() => {
  store.close();
  rmSync(staticRoot, { recursive: true, force: true });
});

describe("push routes — central enforcement", () => {
  beforeEach(async () => {
    await startBound();
  });
  afterEach(async () => {
    await closeServer();
  });

  it("does not require a deployment enable flag before checking the worktree", async () => {
    await closeServer();
    await startBound({ env: {} });
    for (const path of [PREVIEW, EXECUTE]) {
      const body =
        path === EXECUTE
          ? await approveThenBody(pushBody(), "/api/git-delivery/push/approve")
          : pushBody();
      const res = await fetch(`http://${UI_HOST}:${String(port)}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: { code: "GIT_DELIVERY_PUSH_WORKTREE_UNAVAILABLE" },
      });
    }
  });

  it("403s without the central CSRF header", async () => {
    const res = await fetch(`http://${UI_HOST}:${String(port)}${EXECUTE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pushBody()),
    });
    expect(res.status).toBe(403);
  });
});

describe("push preview — read-only risk context (AC1/AC2)", () => {
  it("surfaces the remote target, risk class, and a permitting policy for a user-namespace branch", async () => {
    const handler = createHandlePushPreview({ execution: seams() });
    const res = await handler(ctxFor(PREVIEW, pushBody({ setUpstreamTracking: true })), deps());
    expect(res.status).toBe(200);
    const body = res.body as GitDeliveryPushPreviewBody;
    expect(body.remoteAlias).toBe("origin");
    expect(body.remoteBranchName).toBe("feat/x");
    expect(body.riskClass).toBe("publish");
    expect(body.wouldCreateRemoteBranch).toBe(false); // hasUpstream === true
    expect(body.policyOutcome).toBe("allowed"); // effective: feat/ passes the default pack's constraints
  });

  it("discloses the trusted target branch signed-commit requirement before push", async () => {
    const handler = createHandlePushPreview({
      execution: seams({
        branchProtectionReader: (_workspace, remoteAlias, branchName) => {
          expect(remoteAlias).toBe("origin");
          expect(branchName).toBe("feat/x");
          return Promise.resolve({
            outcome: "protected",
            protection: {
              deletionAllowed: false,
              forcePushAllowed: false,
              linearHistoryRequired: true,
              signaturesRequired: true,
              requiredReviewCount: 0,
              requiredStatusCheckCount: 1,
            },
          });
        },
      }),
    });
    const res = await handler(ctxFor(PREVIEW, pushBody()), deps());
    const body = res.body as GitDeliveryPushPreviewBody;
    expect(body.signatureRequirement).toBe("required");
    expect(body.preflightAdvisoryCodes).toContain("signed-commits-required");
  });

  it("keeps an unavailable protection read distinct from no signature requirement", async () => {
    const handler = createHandlePushPreview({
      execution: seams({
        branchProtectionReader: () => Promise.reject(new Error("provider unavailable")),
      }),
    });
    const res = await handler(ctxFor(PREVIEW, pushBody()), deps());
    const body = res.body as GitDeliveryPushPreviewBody;
    expect(body.signatureRequirement).toBe("unavailable");
    expect(body.preflightAdvisoryCodes).toContain("branch-protection-unavailable");
  });

  // The invariant this pins — a shared/protected remote target is blocked by the DEFAULT pack — is
  // unchanged and now covers more names. The reason is the precise `protected-branch` rather than the
  // generic `policy-pack-blocked` because the default pack states the protection directly instead of
  // deriving it from an allow-list of Keiko's own branch prefixes; both map to the same evidence
  // category (`policy-forbidden`) and the same remediation (`adjust-policy-target`).
  it.each([
    "dev",
    "develop",
    "main",
    "master",
    "trunk",
    "production",
    "release/0.3.0",
    "releases/x",
  ])(
    "shows the protected/shared target %s as policy-blocked in the preview (AC2)",
    async (remoteBranchName) => {
      const handler = createHandlePushPreview({ execution: seams() });
      const res = await handler(ctxFor(PREVIEW, pushBody({ remoteBranchName })), deps());
      const body = res.body as GitDeliveryPushPreviewBody;
      expect(body.policyOutcome).toBe("blocked");
      expect(body.policyBlockReason).toBe("protected-branch");
    },
  );

  // The other half of the same rule: the default pack must not impose Keiko's own branch-naming
  // convention on the user's repository. Before this, a push to any branch outside
  // claude|feat|fix|chore|docs was blocked with no configuration path, so the Push control was
  // unusable in a repository that names branches any other way.
  it.each(["my-work", "bugfix-123", "wip", "oscharko/experiment", "release-notes"])(
    "shows the ordinary user branch %s as allowed in the preview",
    async (remoteBranchName) => {
      const handler = createHandlePushPreview({ execution: seams() });
      const res = await handler(ctxFor(PREVIEW, pushBody({ remoteBranchName })), deps());
      const body = res.body as GitDeliveryPushPreviewBody;
      expect(body.policyOutcome).toBe("allowed");
    },
  );

  it("400s a refspec-injection in a ref operand", async () => {
    const handler = createHandlePushPreview({ execution: seams() });
    const res = await handler(ctxFor(PREVIEW, pushBody({ remoteBranchName: "a:b" })), deps());
    expect(res.status).toBe(400);
  });

  it("400s a force flag that is not a boolean", async () => {
    const handler = createHandlePushPreview({ execution: seams() });
    const res = await handler(ctxFor(PREVIEW, pushBody({ forcePush: "yes" })), deps());
    expect(res.status).toBe(400);
  });
});

describe("push execute — governed publish + no-bypass (AC2/AC3/AC4/AC5)", () => {
  it("executes a permitted user-namespace push and records evidence (AC5)", async () => {
    const adapter = recordingPublishAdapter();
    const cap = capturingEvidenceStore();
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const handler = createHandlePushExecute({
      execution: seams({ publishAdapterFactory: () => adapter.adapter, approvalStore }),
    });
    const command: GitPushCommand = {
      kind: "push",
      sourceBranchName: "feat/x",
      remoteAlias: "origin",
      remoteBranchName: "feat/x",
      forcePush: false,
      setUpstreamTracking: true,
    };
    const res = await handler(
      ctxFor(
        EXECUTE,
        pushBody({ setUpstreamTracking: true, approval: issuePushApproval(approvalStore, command) }),
      ),
      deps({ evidenceStore: cap.store }),
    );
    expect((res.body as GitDeliveryPushExecuteResponseBody).status).toBe("succeeded");
    expect(adapter.calls()).toBe(1);
    expect(cap.count()).toBe(1);
  });

  // #3387: proves the mandatory-approval check is unconditional — previously "honoured"
  // `{ required: false }` — a request-supplied claim of NO approval — as sufficient to push. Mirrors
  // commitRoutes.test.ts's equivalent pin for the commit route (#3386).
  it.each([
    ["an absent approval field", undefined],
    ["an explicit { required: false }", { required: false }],
  ] as const)(
    "does not push an accepted run's direct HTTP request that carries %s",
    async (_label, approval) => {
      const adapter = recordingPublishAdapter();
      const handler = createHandlePushExecute({
        execution: seams({ publishAdapterFactory: () => adapter.adapter }),
      });
      const res = await handler(
        ctxFor(EXECUTE, pushBody({ ...(approval === undefined ? {} : { approval }) })),
        deps(),
      );
      expect((res.body as GitDeliveryPushExecuteResponseBody).status).toBe("approval-required");
      expect(adapter.calls()).toBe(0);
    },
  );

  // The continuity guard re-checks authority right before remote dispatch (a TOCTOU gap: policy/preflight
  // evaluation takes time, and the admitted authority can change or be revoked while that runs). Before
  // this fix, a denial here fell through to a misleading 200 body — `status: "failed"`,
  // `executionErrorCode: "internal-error"` — telling the client an internal fault happened and is safe to
  // retry, and persisted the SAME misleading record to the evidence ledger, even though the F4 no-spawn
  // marker (git.delivery.dispatch.no-spawn) and the authority-denial security line had already correctly
  // recorded a refusal. Proven red against the pre-fix code: this test asserted `status).toBe("failed")`
  // and passed with no HTTP-status or evidence assertion at all.
  it("returns the SAME 403 authority-denied response the up-front gate returns, not a misleading internal failure (#3350)", async () => {
    const adapter = recordingPublishAdapter();
    const cap = capturingEvidenceStore();
    const activity = captureActivityLog();
    const baseAuthority = permittedGitDeliveryAuthority(
      () => projectId,
      () => projectId,
      "autonomous-delivery",
      {
        headRef: "feat/x",
        baseRef: "dev",
        allowDetachedHead: false,
        allowedPrefixes: ["feat/"],
      },
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
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const handler = createHandlePushExecute({
      execution: seams({
        publishAdapterFactory: () => adapter.adapter,
        activityLog: activity.sink,
        approvalStore,
      }),
    });
    const command: GitPushCommand = {
      kind: "push",
      sourceBranchName: "feat/x",
      remoteAlias: "origin",
      remoteBranchName: "feat/x",
      forcePush: false,
      setUpstreamTracking: false,
    };

    const res = await handler(
      {
        ...ctxFor(EXECUTE, pushBody({ approval: issuePushApproval(approvalStore, command) })),
        correlationId: "request-correlation-push-continuity",
      },
      deps({ gitDeliveryAuthority: authority, evidenceStore: cap.store }),
    );

    // HTTP contract: the SAME 403 envelope the up-front admission gate returns — never a 200 claiming an
    // internal, retryable failure for a request that was refused before anything was dispatched.
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: {
        code: "GIT_DELIVERY_AUTHORITY_DENIED",
        message: "The accepted runtime authority does not admit this Git delivery operation.",
        correlationId: "request-correlation-push-continuity",
      },
    });
    expect(res.headers).toEqual({
      "X-Keiko-Correlation-Id": "request-correlation-push-continuity",
    });
    expect(reads).toBe(2);
    expect(adapter.calls()).toBe(0);
    // Audit contract: the synthetic adapter failure is replaced by one typed policy-forbidden block.
    expect(cap.count()).toBe(1);
    expect(cap.raw()).toContain('"outcomeClass":"blocked"');
    expect(cap.raw()).toContain('"blockReason":"authority-denied"');
    expect(cap.raw()).toContain('"disposition":"policy-forbidden"');
    expect(cap.raw()).not.toContain('"execution":');
    expect(
      activity.events.filter((event) => event.op === "git.delivery.dispatch.no-spawn"),
    ).toHaveLength(1);
    const completed = activity.events.find(
      (event) => event.op === "git.delivery.mutation.completed",
    );
    expect(completed).toMatchObject({
      correlationId: "request-correlation-push-continuity",
    });
    expect(completed?.extra).toMatchObject({
      status: "blocked",
      phaseReached: "execute",
      blockReason: "authority-denied",
    });
    expect(
      activity.events
        .filter((event) => event.op.startsWith("git.delivery.authority."))
        .map((event) => event.extra?.phase),
    ).toEqual(["admission", "continuity"]);
  });

  it("denies a protected target outside the active authority envelope", async () => {
    const adapter = recordingPublishAdapter();
    const cap = capturingEvidenceStore();
    const handler = createHandlePushExecute({
      execution: seams({ publishAdapterFactory: () => adapter.adapter }),
    });
    const res = await handler(
      ctxFor(EXECUTE, pushBody({ remoteBranchName: "dev" })),
      deps({ evidenceStore: cap.store }),
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "GIT_DELIVERY_AUTHORITY_DENIED" } });
    expect(adapter.calls()).toBe(0);
    expect(cap.count()).toBe(0);
  });

  // The no-direct-push-to-dev denial is the load-bearing half of the default pack; it must hold for
  // every protected name, with the remote adapter never invoked.
  it.each(["dev", "main", "master", "release/0.3.0"])(
    "never invokes the remote adapter for the protected target %s",
    async (remoteBranchName) => {
      const adapter = recordingPublishAdapter();
      const handler = createHandlePushExecute({
        execution: seams({ publishAdapterFactory: () => adapter.adapter }),
      });
      const res = await handler(ctxFor(EXECUTE, pushBody({ remoteBranchName })), deps());
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: { code: "GIT_DELIVERY_AUTHORITY_DENIED" } });
      expect(adapter.calls()).toBe(0);
    },
  );

  it("executes a push to an ordinary user branch that follows no Keiko naming convention", async () => {
    const adapter = recordingPublishAdapter();
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const handler = createHandlePushExecute({
      execution: seams({ publishAdapterFactory: () => adapter.adapter, approvalStore }),
    });
    const command: GitPushCommand = {
      kind: "push",
      sourceBranchName: "my-work",
      remoteAlias: "origin",
      remoteBranchName: "my-work",
      forcePush: false,
      setUpstreamTracking: false,
    };
    const res = await handler(
      ctxFor(
        EXECUTE,
        pushBody({
          remoteBranchName: "my-work",
          sourceBranchName: "my-work",
          approval: issuePushApproval(approvalStore, command),
        }),
      ),
      deps({
        gitDeliveryAuthority: permittedGitDeliveryAuthority(
          () => projectId,
          () => projectId,
          "autonomous-delivery",
          {
            headRef: "my-work",
            baseRef: "my-work",
            allowDetachedHead: false,
            allowedPrefixes: ["my-"],
          },
        ),
      }),
    );
    expect((res.body as GitDeliveryPushExecuteResponseBody).status).toBe("succeeded");
    expect(adapter.calls()).toBe(1);
  });

  it("blocks a force push and never invokes the remote adapter (AC4)", async () => {
    const adapter = recordingPublishAdapter();
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const handler = createHandlePushExecute({
      execution: seams({ publishAdapterFactory: () => adapter.adapter, approvalStore }),
    });
    const command: GitPushCommand = {
      kind: "push",
      sourceBranchName: "feat/x",
      remoteAlias: "origin",
      remoteBranchName: "feat/x",
      forcePush: true,
      setUpstreamTracking: false,
    };
    const res = await handler(
      ctxFor(
        EXECUTE,
        pushBody({ forcePush: true, approval: issuePushApproval(approvalStore, command) }),
      ),
      deps(),
    );
    const body = res.body as GitDeliveryPushExecuteResponseBody;
    expect(body.status).toBe("blocked");
    expect(body.blockReason).toBe("risk-class-ceiling");
    expect(adapter.calls()).toBe(0);
  });

  it("rejects a forged browser-supplied approval object before publishing", async () => {
    const adapter = recordingPublishAdapter();
    const handler = createHandlePushExecute({
      execution: seams({ publishAdapterFactory: () => adapter.adapter }),
    });
    const res = await handler(
      ctxFor(
        EXECUTE,
        pushBody({
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
    expect(adapter.calls()).toBe(0);
  });

  it("blocks a non-fast-forward push at preflight, executing nothing (AC5)", async () => {
    const adapter = recordingPublishAdapter();
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const handler = createHandlePushExecute({
      execution: seams({
        publishAdapterFactory: () => adapter.adapter,
        snapshotReader: () => Promise.resolve({ ...SNAPSHOT, behindCount: 3 }),
        approvalStore,
      }),
    });
    const command: GitPushCommand = {
      kind: "push",
      sourceBranchName: "feat/x",
      remoteAlias: "origin",
      remoteBranchName: "feat/x",
      forcePush: false,
      setUpstreamTracking: false,
    };
    const res = await handler(
      ctxFor(EXECUTE, pushBody({ approval: issuePushApproval(approvalStore, command) })),
      deps(),
    );
    const body = res.body as GitDeliveryPushExecuteResponseBody;
    expect(body.status).toBe("blocked");
    expect(body.preflightFindingCodes).toContain("non-fast-forward");
    expect(adapter.calls()).toBe(0);
  });

  it("surfaces a remote rejection with its typed reason and recovery hint (AC3)", async () => {
    const adapter = recordingPublishAdapter({
      schemaVersion: "1",
      outcome: "failed",
      durationMs: 7,
      errorCode: "provider-rejected",
      rejectionReason: "permission-denied",
    });
    const cap = capturingEvidenceStore();
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const handler = createHandlePushExecute({
      execution: seams({ publishAdapterFactory: () => adapter.adapter, approvalStore }),
    });
    const command: GitPushCommand = {
      kind: "push",
      sourceBranchName: "feat/x",
      remoteAlias: "origin",
      remoteBranchName: "feat/x",
      forcePush: false,
      setUpstreamTracking: false,
    };
    const res = await handler(
      ctxFor(EXECUTE, pushBody({ approval: issuePushApproval(approvalStore, command) })),
      deps({ evidenceStore: cap.store }),
    );
    const body = res.body as GitDeliveryPushExecuteResponseBody;
    expect(body.status).toBe("failed");
    expect(body.publishRejectionReason).toBe("permission-denied");
    expect(body.recoveryDisposition).toBe("user-fixable");
    expect(cap.count()).toBe(1);
  });
});

// #3387 — before this route existed, no HTTP path could mint a push approval claim: the route did
// not exist. Proves the mint route end to end: redeemable exactly once, refused for another
// operation or run, and reachable from a running accepted run regardless of mode (ADR-0138 D2 — a
// delivery effect is approval-required in every mode, never mode-denied merely because the mode is
// lower; the coarse admission gate this route's own authority check runs through already resolves
// "approval-required" rather than "mode-denied" below autonomous-delivery, per #3386).
describe("push approve — mints the server-issued claim execute consumes (#3387)", () => {
  const COMMAND: GitPushCommand = {
    kind: "push",
    sourceBranchName: "feat/x",
    remoteAlias: "origin",
    remoteBranchName: "feat/x",
    forcePush: false,
    setUpstreamTracking: false,
  };

  it("mints a claim that execute accepts for the exact same push, letting an approval-required push proceed", async () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approveHandler = createHandlePushApprove({ execution: seams({ approvalStore }) });
    const minted = await approveHandler(ctxFor("/api/git-delivery/push/approve", pushBody()), deps());
    expect(minted.status).toBe(200);
    const approval = (minted.body as { approval: GitDeliveryApprovalClaim }).approval;

    const adapter = recordingPublishAdapter();
    const executeHandler = createHandlePushExecute({
      execution: seams({ publishAdapterFactory: () => adapter.adapter, approvalStore }),
    });
    const res = await executeHandler(ctxFor(EXECUTE, pushBody({ approval })), deps());
    expect((res.body as GitDeliveryPushExecuteResponseBody).status).toBe("succeeded");
    expect(adapter.calls()).toBe(1);
  });

  it("mints a claim redeemable only once", async () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = issuePushApproval(approvalStore, COMMAND);
    const adapter = recordingPublishAdapter();
    const executeHandler = createHandlePushExecute({
      execution: seams({ publishAdapterFactory: () => adapter.adapter, approvalStore }),
    });
    const first = await executeHandler(ctxFor(EXECUTE, pushBody({ approval })), deps());
    expect((first.body as GitDeliveryPushExecuteResponseBody).status).toBe("succeeded");
    // The claim was consumed by the first execute: a second redemption attempt no longer matches any
    // stored record, so resolveGitDeliveryApprovalRequirement refuses it as a malformed/unknown claim
    // (400), never re-honouring it as a fresh "approval-required" disposition.
    const second = await executeHandler(ctxFor(EXECUTE, pushBody({ approval })), deps());
    expect(second.status).toBe(400);
    expect(adapter.calls()).toBe(1);
  });

  it("refuses a claim minted for a different push command", async () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = issuePushApproval(approvalStore, { ...COMMAND, remoteBranchName: "other" });
    const adapter = recordingPublishAdapter();
    const handler = createHandlePushExecute({
      execution: seams({ publishAdapterFactory: () => adapter.adapter, approvalStore }),
    });
    const res = await handler(ctxFor(EXECUTE, pushBody({ approval })), deps());
    expect(res.status).toBe(400);
    expect(adapter.calls()).toBe(0);
  });

  it("refuses a claim minted for a different run", async () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = issuePushApproval(approvalStore, COMMAND, { runId: "another-run" });
    const adapter = recordingPublishAdapter();
    const handler = createHandlePushExecute({
      execution: seams({ publishAdapterFactory: () => adapter.adapter, approvalStore }),
    });
    const res = await handler(ctxFor(EXECUTE, pushBody({ approval })), deps());
    expect(res.status).toBe(400);
    expect(adapter.calls()).toBe(0);
  });

  it("denies the mint itself when no accepted run authority is active", async () => {
    const handler = createHandlePushApprove({ execution: seams() });
    const res = await handler(
      ctxFor("/api/git-delivery/push/approve", pushBody()),
      deps({ gitDeliveryAuthority: { current: () => undefined } }),
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "GIT_DELIVERY_AUTHORITY_DENIED" } });
  });

  it("logs a body-free line when the mint issues a claim", async () => {
    const activity = captureActivityLog();
    const handler = createHandlePushApprove({
      execution: seams({ activityLog: activity.sink }),
    });
    await handler(
      { ...ctxFor("/api/git-delivery/push/approve", pushBody()), correlationId: "corr-push-mint-1" },
      deps(),
    );
    const events = activity.events.filter((event) => event.op === "git.delivery.push.approval.minted");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ correlationId: "corr-push-mint-1", extra: { runId: "test-run" } });
    expect(JSON.stringify(events[0])).not.toContain("feat/x");
  });
});

// ─── F1: the default publish adapter (no publishAdapterFactory seam) — audit finding: this branch
// previously hard-coded UNKNOWN_CORRELATION_ID and an uninjectable processServerLogSink(),
// silently dropping BOTH the caller's real correlationId and its activityLog seam. Exercises
// executeGovernedPublish directly (bypassing HTTP) with a policy pack that BLOCKS every action, so
// the kernel never reaches the adapter's real `.publish()` — the only fact under test is what deps
// object the default factory receives. ────────────────────────────────────────────────────────

const BLOCK_ALL_PUBLISH_PACK: GitDeliveryRepoPolicyPack = {
  schemaVersion: GIT_DELIVERY_POLICY_SCHEMA_VERSION,
  repoId: "repo",
  rules: [],
  defaultRule: { decision: "blocked" },
};

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

const WIRING_COMMAND: GitPushCommand = {
  kind: "push",
  sourceBranchName: "feat/x",
  remoteAlias: "origin",
  remoteBranchName: "feat/x",
  forcePush: false,
  setUpstreamTracking: false,
};

describe("executeGovernedPublish — default publish-adapter termination wiring (F1)", () => {
  beforeEach(() => {
    createNodeGitPublishAdapterCalls.length = 0;
  });

  it("wires the caller's activityLog + correlationId into the default createNodeGitPublishAdapter call", async () => {
    const activity: ServerLogEvent[] = [];
    await executeGovernedPublish(
      WIRING_COMMAND,
      { required: false },
      testWorkspace("/nonexistent/keiko-gd-push-wiring"),
      {
        evidenceStore: {
          put: () => "",
          list: () => [],
          get: () => undefined,
          delete: () => undefined,
        },
        redactor: buildRedactor({}),
      },
      {
        snapshotReader: () => Promise.resolve(SNAPSHOT),
        policyPacks: { repoPack: BLOCK_ALL_PUBLISH_PACK },
        activityLog: {
          write: (event): void => {
            activity.push(event);
          },
        },
      },
      "request-correlation-push-wiring",
    );
    expect(createNodeGitPublishAdapterCalls).toHaveLength(1);
    const onTerminated = createNodeGitPublishAdapterCalls[0]?.onTerminated;
    expect(onTerminated).toBeTypeOf("function");
    onTerminated?.({ reason: "timeout", childPid: 4321, windowsTreeKill: "not-attempted" });
    const terminationEvents = activity.filter((event) => event.op === "command.terminated");
    expect(terminationEvents).toHaveLength(1);
    expect(terminationEvents[0]?.correlationId).toBe("request-correlation-push-wiring");
    expect(terminationEvents[0]?.extra?.childPid).toBe(4321);
  });
});

// F4: a `beforeRemoteDispatch` refusal (the accepted authority changed mid-flight, between admission
// and this attempt's actual dispatch) never reaches the real remote adapter — the synthetic
// `{ outcome: "aborted" }` result the adapter wrapper returns instead must be explicitly marked as a
// no-spawn refusal, so it cannot be confused in the evidence stream with a genuine dispatch that DID
// spawn a push and was then cancelled mid-flight (both would otherwise share the identical
// `{ outcome: "aborted", errorCode: undefined }` shape).
describe("executeGovernedPublish — no-spawn refusal is marked, never reaches the real adapter (F4)", () => {
  it("logs git.delivery.dispatch.no-spawn and never calls the real publish adapter when beforeRemoteDispatch refuses", async () => {
    const activity: ServerLogEvent[] = [];
    let realAdapterCalls = 0;
    await executeGovernedPublish(
      WIRING_COMMAND,
      { required: false },
      testWorkspace("/nonexistent/keiko-gd-push-no-spawn"),
      {
        evidenceStore: {
          put: () => "",
          list: () => [],
          get: () => undefined,
          delete: () => undefined,
        },
        redactor: buildRedactor({}),
      },
      {
        snapshotReader: () => Promise.resolve(SNAPSHOT),
        publishAdapterFactory: (): GitRemotePublishAdapter => ({
          publish: (): Promise<GitPublishExecResult> => {
            realAdapterCalls += 1;
            return Promise.resolve({ schemaVersion: "1", outcome: "succeeded", durationMs: 5 });
          },
        }),
        beforeRemoteDispatch: () => false,
        activityLog: {
          write: (event): void => {
            activity.push(event);
          },
        },
      },
      "request-correlation-push-no-spawn",
    );
    expect(realAdapterCalls).toBe(0);
    const marker = activity.find((event) => event.op === "git.delivery.dispatch.no-spawn");
    expect(marker).toBeDefined();
    expect(marker?.correlationId).toBe("request-correlation-push-no-spawn");
    expect(marker?.extra?.operation).toBe("push");
    expect(marker?.status).toBe(403);
  });
});

describe("push execute activity log (AGENTS.md §8 Rule 1)", () => {
  // A governed push answers every outcome with a content-free typed body, so before this wiring a
  // completed push, a policy rejection and an authority-guard abort were indistinguishable in
  // `server.log` — the remote half of the gap `logGitDeliveryMutation` already closed for local
  // mutations. Reuses that same logger: `actionKind: "push"` is what separates the two.

  function ctxWithCorrelation(path: string, body: unknown, correlationId: string): RouteContext {
    return { ...ctxFor(path, body), correlationId };
  }

  it("emits a FAILED push at warn with a top-level errorKind, so a warn threshold keeps it", async () => {
    // Without an explicit level this line defaulted to `info` and was filtered out entirely under
    // `KEIKO_LOG_LEVEL=warn` — the threshold an operator investigating a failed delivery runs at.
    // Asserted through a THRESHOLDING sink, not just the raw event, so the filter is what decides.
    const activity = captureActivityLog();
    const warnOnly: ServerLogSink = {
      write: (event: ServerLogEvent): void => {
        if (event.level === "warn" || event.level === "error") activity.sink.write(event);
      },
    };
    const adapter = recordingPublishAdapter({
      schemaVersion: "1",
      outcome: "failed",
      durationMs: 7,
      errorCode: "provider-rejected",
      rejectionReason: "permission-denied",
    });
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const handler = createHandlePushExecute({
      execution: {
        ...seams({ publishAdapterFactory: () => adapter.adapter, approvalStore }),
        activityLog: warnOnly,
      },
    });
    const command: GitPushCommand = {
      kind: "push",
      sourceBranchName: "feat/x",
      remoteAlias: "origin",
      remoteBranchName: "feat/x",
      forcePush: false,
      setUpstreamTracking: true,
    };

    await handler(
      ctxWithCorrelation(
        EXECUTE,
        pushBody({ setUpstreamTracking: true, approval: issuePushApproval(approvalStore, command) }),
        "corr-push-failed-1",
      ),
      deps(),
    );

    const events = activity.events.filter(
      (event) => event.op === "git.delivery.mutation.completed",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "warn",
      correlationId: "corr-push-failed-1",
      extra: { actionKind: "push" },
    });
    // `errorKind` on the envelope, not buried in `extra` — it is what an operator greps and what
    // `keiko support analyze` clusters on.
    expect(events[0]?.errorKind).toBeDefined();
  });

  it("reports a governed push under the request's correlation id, marked as a push", async () => {
    const adapter = recordingPublishAdapter();
    const activity = captureActivityLog();
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const handler = createHandlePushExecute({
      execution: seams({
        publishAdapterFactory: () => adapter.adapter,
        activityLog: activity.sink,
        approvalStore,
      }),
    });
    const command: GitPushCommand = {
      kind: "push",
      sourceBranchName: "feat/x",
      remoteAlias: "origin",
      remoteBranchName: "feat/x",
      forcePush: false,
      setUpstreamTracking: true,
    };

    const res = await handler(
      ctxWithCorrelation(
        EXECUTE,
        pushBody({ setUpstreamTracking: true, approval: issuePushApproval(approvalStore, command) }),
        "corr-push-000001",
      ),
      deps(),
    );

    expect((res.body as GitDeliveryPushExecuteResponseBody).status).toBe("succeeded");
    const events = activity.events.filter(
      (event) => event.op === "git.delivery.mutation.completed",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "diagnostic",
      correlationId: "corr-push-000001",
      // `actionKind` is the leg that separates a remote push from a local mutation in one
      // vocabulary — without it this line would be indistinguishable from a branch-create.
      extra: { actionKind: "push", status: "succeeded" },
    });
    // Body-free: no branch name, no remote alias, no repository path on the line.
    expect(JSON.stringify(events[0])).not.toContain("feat/x");
    expect(JSON.stringify(events[0])).not.toContain("origin");
  });
});
