// Route tests for the governed GitHub pull request preview + execute routes (Issue #477, Epic #470).
//
// Proves the #477 acceptance criteria at the BFF seam with a FAKE PR adapter (no `gh`, no network):
//   * AC1 — preview surfaces an editable metadata draft + readiness + recommendation; execute opens a PR.
//   * AC2 — the synthesized metadata is derived from real branch/risk context, not generic filler.
//   * AC3 — readiness distinguishes "object exists" from "review ready"; a rejected op reports its state.
//   * AC4 — provider failures normalize into a typed rejection reason + recovery disposition.
//   * AC5 — PR execution cannot bypass the gateway: blocked attempts execute nothing yet still record
//           content-free evidence (title/body never enter the ledger).

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
import type { GitPullRequestCommand, GitWorktreeSnapshot } from "@oscharko-dev/keiko-tools";
import type {
  GitPrCreateExecRequest,
  GitPrExecResult,
  GitPrMarkReadyExecRequest,
  GitPrMarkReadyExecResult,
  GitPrUpdateExecRequest,
  GitPullRequestAdapter,
  GitPullRequestMarkReadyAdapter,
} from "@oscharko-dev/keiko-tools";
import {
  assessGitCiFacts,
  type GitCiFactsResult,
  type GitCiProviderFacts,
  type GitCiProviderReader,
  type NodeGitPullRequestAdapterDeps,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { UI_HOST } from "../server.js";
import { buildCspHeader } from "../csp.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import { startUiTestServer } from "../ui-test-server/_support.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import { matchRoute, type RouteContext } from "../routes.js";
import type { ServerLogEvent } from "../observability/server-log.js";
import type { ServerDiagnosticRecord, ServerDiagnosticSink } from "../diagnostics-log.js";

// Spies on the default PR-adapter factory the F1 fix threads runCommand termination-evidence
// through (executeGovernedPullRequest's `prAdapterFor`, exercised below via direct calls to
// executeGovernedPullRequest itself). Delegates to the REAL implementation so the adapter this
// test file's OTHER suites inject via `prAdapterFactory` seams stays entirely unaffected. Mirrors
// the importOriginal-plus-delegating-wrapper pattern defaultPolicyPacks.test.ts and
// execution.test.ts already use for this exact module graph.
const createNodeGitPullRequestAdapterCalls: NodeGitPullRequestAdapterDeps[] = [];
vi.mock("@oscharko-dev/keiko-tools/internal/git-mutation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@oscharko-dev/keiko-tools/internal/git-mutation")>();
  return {
    ...actual,
    createNodeGitPullRequestAdapter: (
      deps: NodeGitPullRequestAdapterDeps,
    ): GitPullRequestAdapter => {
      createNodeGitPullRequestAdapterCalls.push(deps);
      return actual.createNodeGitPullRequestAdapter(deps);
    },
  };
});

import {
  createGitDeliveryPrRouteGroup,
  createHandlePrApprove,
  createHandlePrExecute,
  createHandlePrPreview,
} from "./prRoutes.js";
import {
  createHandlePrMarkReadyApprove,
  createHandlePrMarkReadyExecute,
  type GitDeliveryPrMarkReadyApproveResponseBody,
  type GitDeliveryPrMarkReadyExecuteResponseBody,
} from "./prMarkReadyExecution.js";
import {
  executeGovernedPullRequest,
  type GitDeliveryPrExecuteResponseBody,
  type GitDeliveryPrPreviewBody,
  type GitDeliveryPullRequestSeams,
} from "./prExecution.js";
import { createInMemoryGitDeliveryApprovalStore } from "./approvalStore.js";
import { permittedGitDeliveryAuthority } from "./runBoundAuthority.test-support.js";

const PREVIEW = "/api/git-delivery/pr/preview";
const EXECUTE = "/api/git-delivery/pr/execute";

const SNAPSHOT: GitWorktreeSnapshot = {
  headDetached: false,
  currentBranchName: "claude/issue-477-github-pr-command-center",
  stagedFileCount: 3,
  unstagedFileCount: 0,
  untrackedFileCount: 0,
  hasUpstream: true,
  aheadCount: 2,
  behindCount: 0,
  existingLocalBranchNames: ["claude/issue-477-github-pr-command-center", "dev"],
  remoteAliases: ["origin"],
};

interface RecordingPrAdapter {
  readonly adapter: GitPullRequestAdapter;
  readonly creates: () => number;
  readonly updates: () => number;
}

function recordingPrAdapter(result?: GitPrExecResult): RecordingPrAdapter {
  let c = 0;
  let u = 0;
  const r: GitPrExecResult = result ?? {
    schemaVersion: "1",
    outcome: "succeeded",
    durationMs: 2,
    createdPrExternalId: "1499",
  };
  return {
    adapter: {
      createPullRequest: (_req: GitPrCreateExecRequest): Promise<GitPrExecResult> => {
        c += 1;
        return Promise.resolve(r);
      },
      updatePullRequest: (_req: GitPrUpdateExecRequest): Promise<GitPrExecResult> => {
        u += 1;
        return Promise.resolve(r);
      },
    },
    creates: (): number => c,
    updates: (): number => u,
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
        headRef: "claude/issue-477-github-pr-command-center",
        baseRef: "dev",
        allowDetachedHead: false,
        allowedPrefixes: ["claude/"],
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

// No policyPacks override → the route applies KEIKO_DEFAULT_PR_POLICY_PACK (the AC2 default).
function seams(overrides: Partial<GitDeliveryPullRequestSeams> = {}): GitDeliveryPullRequestSeams {
  return {
    snapshotReader: () => Promise.resolve(SNAPSHOT),
    now: () => 1_700_000_000_000,
    newActionId: () => "action-pr-test-1",
    ...overrides,
  };
}

function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    projectId,
    kind: "pr-create",
    ownerAndRepo: "oscharko-dev/Keiko",
    headBranchName: "claude/issue-477-github-pr-command-center",
    baseBranchName: "dev",
    title: "feat: governed pull request command center",
    body: "Implements the #477 governed pull request command center.",
    isDraft: false,
    ...overrides,
  };
}

// #3387 (ADR-0138 D2): an accepted run's PR create/update now requires an actually consumed,
// server-issued claim — mirrors commitRoutes.test.ts's issueCommitApproval, minting into a
// caller-supplied store against the SAME binding handlePrExecute resolves at consume time
// (projectId, operation "pr", the exact typed command, and the default test authority's
// runId/envelopeDigest).
function issuePrApproval(
  approvalStore: ReturnType<typeof createInMemoryGitDeliveryApprovalStore>,
  command: GitPullRequestCommand,
  authority: { readonly runId?: string; readonly envelopeDigest?: string } = {},
): GitDeliveryApprovalClaim {
  return approvalStore.issue({
    binding: {
      projectId,
      operation: "pr",
      command,
      runId: authority.runId ?? "test-run",
      envelopeDigest: authority.envelopeDigest ?? "c".repeat(64),
    },
    approvedByUserId: "u-1",
    nowMs: 1_700_000_000_000,
    ttlMs: 60_000,
  }).approval;
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
  staticRoot = mkdtempSync(join(tmpdir(), "keiko-gd-pr-static-"));
  store = createInMemoryUiStore();
  projectId = store.createProject(mkdtempSync(join(tmpdir(), "keiko-gd-pr-proj-"))).path;
});

afterEach(() => {
  store.close();
  rmSync(staticRoot, { recursive: true, force: true });
});

describe("pr routes — central enforcement", () => {
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
          ? await approveThenBody(createBody(), "/api/git-delivery/pr/approve")
          : createBody();
      const res = await fetch(`http://${UI_HOST}:${String(port)}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: { code: "GIT_DELIVERY_PR_WORKTREE_UNAVAILABLE" },
      });
    }
  });

  it("403s without the central CSRF header", async () => {
    const res = await fetch(`http://${UI_HOST}:${String(port)}${EXECUTE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createBody()),
    });
    expect(res.status).toBe(403);
  });
});

describe("pr preview — read-only metadata + readiness (AC1/AC2/AC3)", () => {
  it("synthesizes an editable title from real branch context and a permitting policy for a dev base", async () => {
    const handler = createHandlePrPreview({ execution: seams() });
    const res = await handler(ctxFor(PREVIEW, createBody()), deps());
    expect(res.status).toBe(200);
    const body = res.body as GitDeliveryPrPreviewBody;
    expect(body.policyOutcome).toBe("allowed");
    // Derived from the actual branch slug, not generic filler (AC2).
    expect(body.composedTitle).toContain("github pr command center");
    expect(body.suggestedIssueRefs).toContain("#477");
    // No PR object yet → not review-ready (AC3 distinction).
    expect(body.readiness.objectExists).toBe(false);
    expect(body.recommendation).toBe("create-as-ready");
  });

  it("shows a base outside the integration allow-list as policy-blocked (AC2)", async () => {
    const handler = createHandlePrPreview({ execution: seams() });
    const res = await handler(
      ctxFor(PREVIEW, createBody({ baseBranchName: "random-base" })),
      deps(),
    );
    const body = res.body as GitDeliveryPrPreviewBody;
    expect(body.policyOutcome).toBe("blocked");
    expect(body.policyBlockReason).toBe("policy-pack-blocked");
  });

  it("surfaces a head-unpublished readiness blocker when the head has no upstream", async () => {
    const handler = createHandlePrPreview({
      execution: seams({
        snapshotReader: () => Promise.resolve({ ...SNAPSHOT, hasUpstream: false }),
      }),
    });
    const res = await handler(ctxFor(PREVIEW, createBody()), deps());
    const body = res.body as GitDeliveryPrPreviewBody;
    expect(body.readiness.blockerCodes).toContain("head-unpublished");
    expect(body.recommendation).toBe("blocked");
  });

  it("400s a malformed owner/repo, a bad ref, and a missing title", async () => {
    const handler = createHandlePrPreview({ execution: seams() });
    expect(
      (await handler(ctxFor(PREVIEW, createBody({ ownerAndRepo: "noslash" })), deps())).status,
    ).toBe(400);
    expect(
      (await handler(ctxFor(PREVIEW, createBody({ headBranchName: "a:b" })), deps())).status,
    ).toBe(400);
    expect((await handler(ctxFor(PREVIEW, createBody({ title: "" })), deps())).status).toBe(400);
    expect(
      (
        await handler(
          ctxFor(PREVIEW, {
            schemaVersion: "1",
            projectId,
            kind: "pr-update",
            ownerAndRepo: "oscharko-dev/Keiko",
            prExternalId: "１２",
            headBranchName: "claude/issue-477-github-pr-command-center",
            baseBranchName: "dev",
            title: "feat: updated title",
            body: "Updated body",
          }),
          deps(),
        )
      ).status,
    ).toBe(400);
  });

  // The invariant: a PR body carrying a credential is refused at the boundary. The sample is a
  // realistic token because the guard now matches a credential VALUE rather than the bare word
  // "Bearer" — the substring test rejected ordinary prose (see the accepted cases below), which made
  // the PR surface unusable for any description that mentioned auth at all.
  it("400s a credential-shaped body", async () => {
    const handler = createHandlePrPreview({ execution: seams() });
    const res = await handler(
      ctxFor(
        PREVIEW,
        createBody({
          body: "see Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghij",
        }),
      ),
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it.each([
    "Rejects a malformed bearer token before the retry loop.",
    "Documents the api_key rotation runbook and the basic auth fallback.",
    "Drops the set-cookie header on redirect.",
  ])("accepts an ordinary description that merely mentions auth: %s", async (body) => {
    const handler = createHandlePrPreview({ execution: seams() });
    const res = await handler(ctxFor(PREVIEW, createBody({ body })), deps());
    expect(res.status).toBe(200);
  });
});

const DEFAULT_CREATE_COMMAND: GitPullRequestCommand = {
  kind: "pr-create",
  ownerAndRepo: "oscharko-dev/Keiko",
  headBranchName: "claude/issue-477-github-pr-command-center",
  baseBranchName: "dev",
  title: "feat: governed pull request command center",
  body: "Implements the #477 governed pull request command center.",
  isDraft: false,
};

describe("pr execute — governed create + no-bypass (AC1/AC4/AC5)", () => {
  it("opens a permitted PR, returns the provider PR number, and records content-free evidence (AC5)", async () => {
    const adapter = recordingPrAdapter();
    const cap = capturingEvidenceStore();
    const activity: ServerLogEvent[] = [];
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const handler = createHandlePrExecute({
      execution: seams({
        prAdapterFactory: () => adapter.adapter,
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
        ...ctxFor(
          EXECUTE,
          createBody({ approval: issuePrApproval(approvalStore, DEFAULT_CREATE_COMMAND) }),
        ),
        correlationId: "request-correlation-pr-success",
      },
      deps({ evidenceStore: cap.store }),
    );
    const body = res.body as GitDeliveryPrExecuteResponseBody;
    expect(body.status).toBe("succeeded");
    expect(body.createdPrExternalId).toBe("1499");
    expect(adapter.creates()).toBe(1);
    expect(cap.count()).toBe(1);
    // Content-free: the PR title/body strings never enter the evidence ledger.
    expect(cap.raw()).not.toContain("governed pull request command center");
    expect(cap.raw()).not.toContain("Implements the #477");
    const completed = activity.find((event) => event.op === "git.delivery.mutation.completed");
    expect(completed).toMatchObject({ correlationId: "request-correlation-pr-success" });
    expect(completed?.extra).toMatchObject({ actionKind: "pr-create", status: "succeeded" });
  });

  // The continuity guard re-checks authority right before remote dispatch (a TOCTOU gap: policy/preflight
  // evaluation takes time, and the admitted authority can change or be revoked while that runs). Before
  // this fix, a denial here fell through to a misleading 200 body — `status: "failed"`,
  // `executionErrorCode: "internal-error"` — telling the client an internal fault happened and is safe to
  // retry, and persisted the SAME misleading record to the evidence ledger, even though the F4 no-spawn
  // marker (git.delivery.dispatch.no-spawn) and the authority-denial security line had already correctly
  // recorded a refusal. Proven red against the pre-fix code: this test asserted `status).toBe("failed")`
  // and passed with no HTTP-status or evidence assertion at all.
  it("returns the SAME 403 authority-denied response the up-front gate returns, not a misleading internal failure (#3350)", async () => {
    const adapter = recordingPrAdapter();
    const cap = capturingEvidenceStore();
    const activity: ServerLogEvent[] = [];
    const baseAuthority = permittedGitDeliveryAuthority(
      () => projectId,
      () => projectId,
      "autonomous-delivery",
      {
        headRef: "claude/issue-477-github-pr-command-center",
        baseRef: "dev",
        allowDetachedHead: false,
        allowedPrefixes: ["claude/"],
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
    const handler = createHandlePrExecute({
      execution: seams({
        prAdapterFactory: () => adapter.adapter,
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
        ...ctxFor(
          EXECUTE,
          createBody({ approval: issuePrApproval(approvalStore, DEFAULT_CREATE_COMMAND) }),
        ),
        correlationId: "request-correlation-pr-continuity",
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
        correlationId: "request-correlation-pr-continuity",
      },
    });
    expect(res.headers).toEqual({
      "X-Keiko-Correlation-Id": "request-correlation-pr-continuity",
    });
    expect(reads).toBe(2);
    expect(adapter.creates()).toBe(0);
    expect(cap.count()).toBe(1);
    expect(cap.raw()).toContain('"outcomeClass":"blocked"');
    expect(cap.raw()).toContain('"blockReason":"authority-denied"');
    expect(cap.raw()).toContain('"disposition":"policy-forbidden"');
    expect(cap.raw()).not.toContain('"execution":');
    expect(
      activity
        .filter((event) => event.op.startsWith("git.delivery.authority."))
        .map((event) => event.extra?.phase),
    ).toEqual(["admission", "continuity"]);
    const completed = activity.find((event) => event.op === "git.delivery.mutation.completed");
    expect(completed).toMatchObject({ correlationId: "request-correlation-pr-continuity" });
    expect(completed?.extra).toMatchObject({
      status: "blocked",
      phaseReached: "execute",
      blockReason: "authority-denied",
    });
  });

  it("denies a base outside the active authority envelope before execution", async () => {
    const adapter = recordingPrAdapter();
    const cap = capturingEvidenceStore();
    const handler = createHandlePrExecute({
      execution: seams({ prAdapterFactory: () => adapter.adapter }),
    });
    const res = await handler(
      ctxFor(EXECUTE, createBody({ baseBranchName: "random-base" })),
      deps({ evidenceStore: cap.store }),
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "GIT_DELIVERY_AUTHORITY_DENIED" } });
    expect(adapter.creates()).toBe(0);
    expect(cap.count()).toBe(0);
  });

  it("normalizes a provider rejection into a typed reason + recovery disposition (AC4)", async () => {
    const adapter = recordingPrAdapter({
      schemaVersion: "1",
      outcome: "failed",
      durationMs: 4,
      errorCode: "provider-rejected",
      rejectionReason: "validation-error",
    });
    const cap = capturingEvidenceStore();
    const activity: ServerLogEvent[] = [];
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const handler = createHandlePrExecute({
      execution: seams({
        prAdapterFactory: () => adapter.adapter,
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
        ...ctxFor(
          EXECUTE,
          createBody({ approval: issuePrApproval(approvalStore, DEFAULT_CREATE_COMMAND) }),
        ),
        correlationId: "request-correlation-pr-rejected",
      },
      deps({ evidenceStore: cap.store }),
    );
    const body = res.body as GitDeliveryPrExecuteResponseBody;
    expect(body.status).toBe("failed");
    expect(body.prRejectionReason).toBe("validation-error");
    expect(body.recoveryDisposition).toBe("user-fixable");
    expect(cap.count()).toBe(1);
    const completed = activity.find((event) => event.op === "git.delivery.mutation.completed");
    expect(completed).toMatchObject({
      level: "warn",
      correlationId: "request-correlation-pr-rejected",
      errorKind: "provider-rejected",
    });
    expect(completed?.extra).toMatchObject({ status: "failed" });
  });

  // #3387 (ADR-0138 D2): an accepted run's PR now requires an actually consumed, server-issued
  // claim regardless of what the repo/org pack decides (mirrors commitRoutes.test.ts's equivalent
  // pin for the commit route, #3386) — a request carrying no claim is refused before this
  // approval-gated override pack is even consulted, so this now pins the SAME unconditional
  // disposition the "carries no approval" case below pins, rather than the pack's own
  // requiredApprovers evaluation.
  it("holds for approval under an approval-gated override pack, executing nothing", async () => {
    const adapter = recordingPrAdapter();
    const handler = createHandlePrExecute({
      execution: seams({
        prAdapterFactory: () => adapter.adapter,
        policyPacks: {
          repoPack: {
            schemaVersion: "1",
            repoId: "approval-pack",
            rules: [
              { actionKind: "pr-create", decision: "approval-gated", requiredApprovers: ["lead"] },
            ],
            defaultRule: { decision: "blocked" },
          },
        },
      }),
    });
    const res = await handler(
      { ...ctxFor(EXECUTE, createBody()), correlationId: "request-correlation-pr-held" },
      deps(),
    );
    const body = res.body as GitDeliveryPrExecuteResponseBody;
    expect(body.status).toBe("approval-required");
    expect(adapter.creates()).toBe(0);
  });

  it("logs a snapshot precondition throw with the request correlation id", async () => {
    const activity: ServerLogEvent[] = [];
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const handler = createHandlePrExecute({
      execution: seams({
        snapshotReader: () => Promise.reject(new Error("host path must stay private")),
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
        ...ctxFor(
          EXECUTE,
          createBody({ approval: issuePrApproval(approvalStore, DEFAULT_CREATE_COMMAND) }),
        ),
        correlationId: "request-correlation-pr-snapshot",
      },
      deps(),
    );

    expect(res.status).toBe(409);
    const failed = activity.find((event) => event.op === "git.delivery.mutation.failed");
    expect(failed).toMatchObject({
      level: "error",
      correlationId: "request-correlation-pr-snapshot",
    });
    expect(typeof failed?.errorKind).toBe("string");
    expect(failed?.extra).toEqual({ actionKind: "pr-create", phaseReached: "snapshot" });
    expect(JSON.stringify(activity)).not.toContain("host path must stay private");
  });

  it("rejects a forged browser-supplied approval object before creating a PR", async () => {
    const adapter = recordingPrAdapter();
    const handler = createHandlePrExecute({
      execution: seams({ prAdapterFactory: () => adapter.adapter }),
    });
    const res = await handler(
      ctxFor(
        EXECUTE,
        createBody({
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
    expect(adapter.creates()).toBe(0);
  });

  it("routes a pr-update through the update adapter method", async () => {
    const adapter = recordingPrAdapter();
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const handler = createHandlePrExecute({
      execution: seams({ prAdapterFactory: () => adapter.adapter, approvalStore }),
    });
    const updateCommand: GitPullRequestCommand = {
      kind: "pr-update",
      ownerAndRepo: "oscharko-dev/Keiko",
      prExternalId: "1499",
      headBranchName: "claude/issue-477-github-pr-command-center",
      baseBranchName: "dev",
      title: "feat: updated title",
      body: "Updated body",
      convertToDraft: false,
      convertFromDraft: false,
    };
    const res = await handler(
      ctxFor(EXECUTE, {
        schemaVersion: "1",
        projectId,
        kind: "pr-update",
        ownerAndRepo: "oscharko-dev/Keiko",
        prExternalId: "1499",
        headBranchName: "claude/issue-477-github-pr-command-center",
        baseBranchName: "dev",
        title: "feat: updated title",
        body: "Updated body",
        approval: issuePrApproval(approvalStore, updateCommand),
      }),
      deps(),
    );
    const body = res.body as GitDeliveryPrExecuteResponseBody;
    expect(body.status).toBe("succeeded");
    expect(adapter.updates()).toBe(1);
    expect(adapter.creates()).toBe(0);
  });

  // #3389 (epic #3384 correction 1): the approval-less draft->ready transition through the generic
  // pr-update command is closed. Before this change, this exact request (convertFromDraft: true, no
  // pr-mark-ready claim, only the generic "pr" approval) executed and returned "succeeded" — the
  // approval-less path AC3 requires closed. The transition is reachable ONLY through the dedicated
  // POST /api/git-delivery/pr/mark-ready/execute route (prMarkReadyExecution.ts).
  it("refuses convertFromDraft on the generic pr-update command even with a valid generic pr approval (#3389)", async () => {
    const adapter = recordingPrAdapter();
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const handler = createHandlePrExecute({
      execution: seams({ prAdapterFactory: () => adapter.adapter, approvalStore }),
    });
    const updateCommand: GitPullRequestCommand = {
      kind: "pr-update",
      ownerAndRepo: "oscharko-dev/Keiko",
      prExternalId: "1499",
      headBranchName: "claude/issue-477-github-pr-command-center",
      baseBranchName: "dev",
      title: "feat: updated title",
      body: "Updated body",
      convertToDraft: false,
      convertFromDraft: true,
    };
    const res = await handler(
      ctxFor(EXECUTE, {
        schemaVersion: "1",
        projectId,
        kind: "pr-update",
        ownerAndRepo: "oscharko-dev/Keiko",
        prExternalId: "1499",
        headBranchName: "claude/issue-477-github-pr-command-center",
        baseBranchName: "dev",
        title: "feat: updated title",
        body: "Updated body",
        convertFromDraft: true,
        // A valid, correctly-bound generic "pr" approval is minted and attached — proving the
        // refusal is NOT merely "no approval was supplied" but that convertFromDraft is rejected
        // at request validation, before any approval is even consulted.
        approval: issuePrApproval(approvalStore, updateCommand),
      }),
      deps(),
    );
    expect(res.status).toBe(400);
    expect(adapter.updates()).toBe(0);
    expect(adapter.creates()).toBe(0);
  });
});

// #3387 — before this route existed, no HTTP path could mint a PR approval claim: the route did not
// exist. Proves the mint route end to end: redeemable exactly once, refused for another operation or
// run, and reachable from a running accepted run regardless of mode (ADR-0138 D2 — a delivery effect
// is approval-required in every mode, never mode-denied merely because the mode is lower; the coarse
// admission gate this route's own authority check runs through already resolves "approval-required"
// rather than "mode-denied" below autonomous-delivery, per #3386).
describe("pr approve — mints the server-issued claim execute consumes (#3387)", () => {
  it("mints a claim that execute accepts for the exact same PR proposal, letting an approval-required PR proceed", async () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approveHandler = createHandlePrApprove({ execution: seams({ approvalStore }) });
    const minted = await approveHandler(
      ctxFor("/api/git-delivery/pr/approve", createBody()),
      deps(),
    );
    expect(minted.status).toBe(200);
    const approval = (minted.body as { approval: GitDeliveryApprovalClaim }).approval;

    const adapter = recordingPrAdapter();
    const executeHandler = createHandlePrExecute({
      execution: seams({ prAdapterFactory: () => adapter.adapter, approvalStore }),
    });
    const res = await executeHandler(ctxFor(EXECUTE, createBody({ approval })), deps());
    expect((res.body as GitDeliveryPrExecuteResponseBody).status).toBe("succeeded");
    expect(adapter.creates()).toBe(1);
  });

  it("mints a claim redeemable only once", async () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = issuePrApproval(approvalStore, DEFAULT_CREATE_COMMAND);
    const adapter = recordingPrAdapter();
    const executeHandler = createHandlePrExecute({
      execution: seams({ prAdapterFactory: () => adapter.adapter, approvalStore }),
    });
    const first = await executeHandler(ctxFor(EXECUTE, createBody({ approval })), deps());
    expect((first.body as GitDeliveryPrExecuteResponseBody).status).toBe("succeeded");
    // The claim was consumed by the first execute: a second redemption attempt no longer matches any
    // stored record, so resolveGitDeliveryApprovalRequirement refuses it as a malformed/unknown claim
    // (400), never re-honouring it as a fresh "approval-required" disposition.
    const second = await executeHandler(ctxFor(EXECUTE, createBody({ approval })), deps());
    expect(second.status).toBe(400);
    expect(adapter.creates()).toBe(1);
  });

  it("refuses a claim minted for a different PR command", async () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = issuePrApproval(approvalStore, {
      ...DEFAULT_CREATE_COMMAND,
      title: "a different title entirely",
    });
    const adapter = recordingPrAdapter();
    const handler = createHandlePrExecute({
      execution: seams({ prAdapterFactory: () => adapter.adapter, approvalStore }),
    });
    const res = await handler(ctxFor(EXECUTE, createBody({ approval })), deps());
    expect(res.status).toBe(400);
    expect(adapter.creates()).toBe(0);
  });

  it("refuses a claim minted for a different run", async () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = issuePrApproval(approvalStore, DEFAULT_CREATE_COMMAND, {
      runId: "another-run",
    });
    const adapter = recordingPrAdapter();
    const handler = createHandlePrExecute({
      execution: seams({ prAdapterFactory: () => adapter.adapter, approvalStore }),
    });
    const res = await handler(ctxFor(EXECUTE, createBody({ approval })), deps());
    expect(res.status).toBe(400);
    expect(adapter.creates()).toBe(0);
  });

  it("denies the mint itself when no accepted run authority is active", async () => {
    const handler = createHandlePrApprove({ execution: seams() });
    const res = await handler(
      ctxFor("/api/git-delivery/pr/approve", createBody()),
      deps({ gitDeliveryAuthority: { current: () => undefined } }),
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "GIT_DELIVERY_AUTHORITY_DENIED" } });
  });

  it("logs a body-free line when the mint issues a claim", async () => {
    const activity: ServerLogEvent[] = [];
    const handler = createHandlePrApprove({
      execution: seams({
        activityLog: {
          write: (event): void => {
            activity.push(event);
          },
        },
      }),
    });
    await handler(
      { ...ctxFor("/api/git-delivery/pr/approve", createBody()), correlationId: "corr-pr-mint-1" },
      deps(),
    );
    const events = activity.filter((event) => event.op === "git.delivery.pr.approval.minted");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      correlationId: "corr-pr-mint-1",
      extra: { runId: "test-run" },
    });
    expect(JSON.stringify(events[0])).not.toContain("governed pull request command center");
  });

  // Final-audit F2/#3390 (ADR-0138 D2): before this fix, the coarse admission gate hard-denied both
  // pr/approve and pr/execute with "approval-required" below `autonomous-delivery` and no
  // production path ever redeemed it — every test above only ever exercised the fixture default
  // (autonomous-delivery). FAILING BEFORE THE FIX: `modeDeps()`'s approve call returned 403
  // GIT_DELIVERY_AUTHORITY_DENIED at the `gitDeliveryAuthorityGate` call inside
  // `createHandlePrApprove`, never reaching `store.issue()`.
  it.each(["governed-assist", "supervised-coding"] as const)(
    "mints and consumes a pr approval end to end at %s",
    async (mode) => {
      const modeDeps = deps({
        gitDeliveryAuthority: permittedGitDeliveryAuthority(
          () => projectId,
          () => projectId,
          mode,
          {
            headRef: "claude/issue-477-github-pr-command-center",
            baseRef: "dev",
            allowDetachedHead: false,
            allowedPrefixes: ["claude/"],
          },
        ),
      });
      const approvalStore = createInMemoryGitDeliveryApprovalStore();
      const approveHandler = createHandlePrApprove({ execution: seams({ approvalStore }) });
      const minted = await approveHandler(
        ctxFor("/api/git-delivery/pr/approve", createBody()),
        modeDeps,
      );
      expect(minted.status).toBe(200);
      const approval = (minted.body as { approval: GitDeliveryApprovalClaim }).approval;

      const adapter = recordingPrAdapter();
      const executeHandler = createHandlePrExecute({
        execution: seams({ prAdapterFactory: () => adapter.adapter, approvalStore }),
      });
      const res = await executeHandler(ctxFor(EXECUTE, createBody({ approval })), modeDeps);
      expect((res.body as GitDeliveryPrExecuteResponseBody).status).toBe("succeeded");
      expect(adapter.creates()).toBe(1);
    },
  );

  it.each(["governed-assist", "supervised-coding"] as const)(
    "still returns approval-required (never mode-denied) at %s when execute carries no approval",
    async (mode) => {
      const modeDeps = deps({
        gitDeliveryAuthority: permittedGitDeliveryAuthority(
          () => projectId,
          () => projectId,
          mode,
          {
            headRef: "claude/issue-477-github-pr-command-center",
            baseRef: "dev",
            allowDetachedHead: false,
            allowedPrefixes: ["claude/"],
          },
        ),
      });
      const adapter = recordingPrAdapter();
      const executeHandler = createHandlePrExecute({
        execution: seams({ prAdapterFactory: () => adapter.adapter }),
      });
      const res = await executeHandler(ctxFor(EXECUTE, createBody()), modeDeps);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "approval-required" });
      expect(adapter.creates()).toBe(0);
    },
  );
});

// ─── F1: the default PR adapter (no prAdapterFactory seam) — audit finding: this branch
// previously hard-coded UNKNOWN_CORRELATION_ID and an uninjectable processServerLogSink(),
// silently dropping BOTH the caller's real correlationId and its activityLog seam. Exercises
// executeGovernedPullRequest directly (bypassing HTTP) with a policy pack that BLOCKS every
// action, so the kernel never reaches the adapter's real `.createPullRequest()` — the only fact
// under test is what deps object the default factory receives. ──────────────────────────────

const BLOCK_ALL_PR_PACK: GitDeliveryRepoPolicyPack = {
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

const WIRING_COMMAND: GitPullRequestCommand = {
  kind: "pr-create",
  ownerAndRepo: "oscharko-dev/Keiko",
  headBranchName: "feat/x",
  baseBranchName: "dev",
  title: "wiring probe",
  body: "",
  isDraft: false,
};

describe("executeGovernedPullRequest — default PR-adapter termination wiring (F1)", () => {
  beforeEach(() => {
    createNodeGitPullRequestAdapterCalls.length = 0;
  });

  it("wires the caller's activityLog + correlationId into the default createNodeGitPullRequestAdapter call", async () => {
    const activity: ServerLogEvent[] = [];
    await executeGovernedPullRequest(
      WIRING_COMMAND,
      { required: false },
      testWorkspace("/nonexistent/keiko-gd-pr-wiring"),
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
        policyPacks: { repoPack: BLOCK_ALL_PR_PACK },
        activityLog: {
          write: (event): void => {
            activity.push(event);
          },
        },
      },
      "request-correlation-pr-wiring",
    );
    expect(createNodeGitPullRequestAdapterCalls).toHaveLength(1);
    const onTerminated = createNodeGitPullRequestAdapterCalls[0]?.onTerminated;
    expect(onTerminated).toBeTypeOf("function");
    onTerminated?.({ reason: "abort", childPid: 5678, windowsTreeKill: "not-attempted" });
    const termination = activity.find((event) => event.op === "command.terminated");
    expect(termination?.correlationId).toBe("request-correlation-pr-wiring");
    expect(activity).toContainEqual(
      expect.objectContaining({
        op: "git.delivery.mutation.completed",
        correlationId: "request-correlation-pr-wiring",
      }),
    );
    expect(termination?.extra?.childPid).toBe(5678);
  });
});

// F4: a `beforeRemoteDispatch` refusal (the accepted authority changed mid-flight, between admission
// and this attempt's actual dispatch) never reaches the real `gh api` adapter — the synthetic
// `{ outcome: "aborted" }` result the adapter wrapper returns instead must be explicitly marked as a
// no-spawn refusal, so it cannot be confused in the evidence stream with a genuine dispatch that DID
// spawn `gh` and was then cancelled mid-flight (both would otherwise share the identical
// `{ outcome: "aborted", errorCode: undefined }` shape).
describe("executeGovernedPullRequest — no-spawn refusal is marked, never reaches the real adapter (F4)", () => {
  it("logs git.delivery.dispatch.no-spawn and never calls the real gh adapter when beforeRemoteDispatch refuses", async () => {
    const activity: ServerLogEvent[] = [];
    let realAdapterCalls = 0;
    await executeGovernedPullRequest(
      WIRING_COMMAND,
      { required: false },
      testWorkspace("/nonexistent/keiko-gd-pr-no-spawn"),
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
        prAdapterFactory: (): GitPullRequestAdapter => ({
          createPullRequest: (): Promise<GitPrExecResult> => {
            realAdapterCalls += 1;
            return Promise.resolve({ schemaVersion: "1", outcome: "succeeded", durationMs: 5 });
          },
          updatePullRequest: (): Promise<GitPrExecResult> => {
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
      "request-correlation-pr-no-spawn",
    );
    expect(realAdapterCalls).toBe(0);
    const marker = activity.find((event) => event.op === "git.delivery.dispatch.no-spawn");
    expect(marker).toBeDefined();
    expect(marker?.correlationId).toBe("request-correlation-pr-no-spawn");
    expect(marker?.extra?.operation).toBe("pr-create");
    expect(marker?.status).toBe(403);
  });
});

// #3389 (epic #3384 correction 7): the pr-mark-ready mint and execute routes. Reuses the exact
// approval-store primitives the generic PR routes above already exercise, bound to a SEPARATE
// "pr-mark-ready" operation so a claim minted here can never redeem the generic pr-update admission
// (and vice versa — approvalStore.test.ts pins the store-level half of this).
describe("pr mark-ready routes (#3389)", () => {
  const MARK_READY_APPROVE = "/api/git-delivery/pr/mark-ready/approve";
  const MARK_READY_EXECUTE = "/api/git-delivery/pr/mark-ready/execute";
  const HEAD_SHA = "a".repeat(40);
  const BASE_SHA = "b".repeat(40);
  const BASE_REF = "dev";

  function page(values: readonly unknown[] = []): {
    readonly values: readonly unknown[];
    readonly completeness: {
      readonly complete: true;
      readonly pages: number;
      readonly entries: number;
      readonly bytes: number;
    };
  } {
    return { values, completeness: { complete: true, pages: 1, entries: values.length, bytes: 0 } };
  }

  // A minimal, complete, unprotected, conflict-free live CI-facts read — head/base/draft match the
  // approval's bound facts exactly. `requirements.digest`/`workflowDefinitions` are inert inputs to
  // assessGitCiFacts's OWN requirementsDigest formula (not the value under test); READINESS_DIGEST
  // below is derived by calling that real producer, never hand-rolled, so it can never drift from
  // what the production code actually computes (AGENTS.md §7: import the producer, don't restate it).
  function readyCiFacts(overrides: Partial<GitCiProviderFacts> = {}): GitCiProviderFacts {
    return {
      status: "observed",
      identity: {
        number: 1499,
        externalId: "PR_kwDO123",
        url: "https://github.com/oscharko-dev/Keiko/pull/1499",
        repository: "oscharko-dev/Keiko",
        headRepository: "oscharko-dev/Keiko",
        headRef: "claude/issue-3389-x",
        headSha: HEAD_SHA,
        baseRef: BASE_REF,
        baseSha: BASE_SHA,
        state: "open",
        isDraft: true,
      },
      repositoryId: 1499,
      mergeable: true,
      mergeState: "clean",
      merged: false,
      protection: { outcome: "unprotected" },
      requirements: {
        status: "observed",
        requirements: [],
        strict: false,
        digest: "fixture-requirements-digest",
      },
      workflowDefinitions: { status: "observed", definitions: [] },
      lists: {
        "branch-rules": page(),
        "check-runs": page(),
        "commit-statuses": page(),
        "workflow-runs": page(),
        reviews: page(),
      },
      ...overrides,
    };
  }
  const READY_CI_FACTS = readyCiFacts();
  const requirementsDigest = assessGitCiFacts(READY_CI_FACTS).requirementsDigest;
  if (requirementsDigest === null) throw new Error("fixture must produce a requirements digest");
  const READINESS_DIGEST = requirementsDigest;

  function ciReaderReturning(facts: GitCiFactsResult): GitCiProviderReader {
    return { readFacts: (): Promise<GitCiFactsResult> => Promise.resolve(facts) };
  }
  // The default, happy-path live read every test that expects the adapter to be reached uses.
  const cleanCiReaderFactory = (): GitCiProviderReader => ciReaderReturning(READY_CI_FACTS);

  function markReadyBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: "1",
      projectId,
      ownerAndRepo: "oscharko-dev/Keiko",
      prExternalId: "1499",
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      baseRef: BASE_REF,
      readinessDigest: READINESS_DIGEST,
      ...overrides,
    };
  }

  function recordingMarkReadyAdapter(result: GitPrMarkReadyExecResult): {
    readonly adapter: GitPullRequestMarkReadyAdapter;
    readonly calls: () => readonly GitPrMarkReadyExecRequest[];
  } {
    const calls: GitPrMarkReadyExecRequest[] = [];
    return {
      adapter: {
        markPullRequestReady: (req): Promise<GitPrMarkReadyExecResult> => {
          calls.push(req);
          return Promise.resolve(result);
        },
      },
      calls: () => calls,
    };
  }

  async function mintMarkReadyApproval(
    approvalStore: ReturnType<typeof createInMemoryGitDeliveryApprovalStore>,
    overrides: Record<string, unknown> = {},
  ): Promise<GitDeliveryApprovalClaim> {
    const res = await createHandlePrMarkReadyApprove({
      approvalStore,
      now: () => 1_700_000_000_000,
    })(ctxFor(MARK_READY_APPROVE, markReadyBody(overrides)), deps());
    return (res.body as GitDeliveryPrMarkReadyApproveResponseBody).approval;
  }

  it("mints a claim, then executes the draft->ready transition through the adapter — no PATCH", async () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = await mintMarkReadyApproval(approvalStore);
    const succeeded: GitPrMarkReadyExecResult = {
      schemaVersion: "1",
      outcome: "succeeded",
      durationMs: 5,
    };
    const adapter = recordingMarkReadyAdapter(succeeded);
    const res = await createHandlePrMarkReadyExecute({
      approvalStore,
      now: () => 1_700_000_000_001,
      adapterFactory: () => adapter.adapter,
      ciReaderFactory: cleanCiReaderFactory,
    })(ctxFor(MARK_READY_EXECUTE, markReadyBody({ approval })), deps());
    const body = res.body as GitDeliveryPrMarkReadyExecuteResponseBody;
    expect(body).toMatchObject({ actionKind: "pr-mark-ready", status: "succeeded" });
    expect(adapter.calls()).toEqual([
      {
        ownerAndRepo: "oscharko-dev/Keiko",
        prExternalId: "1499",
        expectedHeadSha: HEAD_SHA,
        expectedBaseSha: BASE_SHA,
      },
    ]);
  });

  it("refuses execute with approval-required when no claim is attached, and never calls the adapter", async () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const adapter = recordingMarkReadyAdapter({
      schemaVersion: "1",
      outcome: "succeeded",
      durationMs: 5,
    });
    const res = await createHandlePrMarkReadyExecute({
      approvalStore,
      adapterFactory: () => adapter.adapter,
    })(ctxFor(MARK_READY_EXECUTE, markReadyBody()), deps());
    const body = res.body as GitDeliveryPrMarkReadyExecuteResponseBody;
    expect(body.status).toBe("approval-required");
    expect(adapter.calls()).toHaveLength(0);
  });

  // #3389 (correction 1/7): the failing-before-fix case — a claim minted for the GENERIC "pr"
  // operation (the same claim GovernedPullRequestCard's old convertFromDraft path consumed) must
  // never redeem the dedicated pr-mark-ready execute route.
  it("refuses execute when the approval was minted for the generic pr operation, not pr-mark-ready", async () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const genericPrCommand: GitPullRequestCommand = {
      kind: "pr-update",
      ownerAndRepo: "oscharko-dev/Keiko",
      prExternalId: "1499",
      headBranchName: "claude/issue-3389-x",
      baseBranchName: "dev",
      title: "t",
      body: "b",
      convertToDraft: false,
      convertFromDraft: false,
    };
    const foreignApproval = issuePrApproval(approvalStore, genericPrCommand);
    const adapter = recordingMarkReadyAdapter({
      schemaVersion: "1",
      outcome: "succeeded",
      durationMs: 5,
    });
    const res = await createHandlePrMarkReadyExecute({
      approvalStore,
      adapterFactory: () => adapter.adapter,
    })(ctxFor(MARK_READY_EXECUTE, markReadyBody({ approval: foreignApproval })), deps());
    expect(res.status).toBe(400);
    expect(adapter.calls()).toHaveLength(0);
  });

  it("reports drift (precondition-failed) when the adapter observes the PR has moved, and revokes the claim", async () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = await mintMarkReadyApproval(approvalStore);
    const drifted: GitPrMarkReadyExecResult = {
      schemaVersion: "1",
      outcome: "failed",
      durationMs: 3,
      errorCode: "precondition-failed",
    };
    const adapter = recordingMarkReadyAdapter(drifted);
    const res = await createHandlePrMarkReadyExecute({
      approvalStore,
      now: () => 1_700_000_000_001,
      adapterFactory: () => adapter.adapter,
      ciReaderFactory: cleanCiReaderFactory,
    })(ctxFor(MARK_READY_EXECUTE, markReadyBody({ approval })), deps());
    const body = res.body as GitDeliveryPrMarkReadyExecuteResponseBody;
    expect(body).toMatchObject({ status: "failed", executionErrorCode: "precondition-failed" });
    // The claim is one-use: a second execute against the identical binding no longer redeems it
    // (the store already consumed it on the first attempt above) — a bad request, not a retry.
    const secondRes = await createHandlePrMarkReadyExecute({
      approvalStore,
      now: () => 1_700_000_000_002,
      adapterFactory: () => adapter.adapter,
      ciReaderFactory: cleanCiReaderFactory,
    })(ctxFor(MARK_READY_EXECUTE, markReadyBody({ approval })), deps());
    expect(secondRes.status).toBe(400);
    expect(adapter.calls()).toHaveLength(1);
  });

  // #3389 repair (review finding, correction 2): failing-before-fix — previously the execute path
  // never re-read requirements/conflict facts at all, so ANY syntactically-valid readinessDigest
  // (including one with no relationship to the live PR) redeemed the claim and reached the adapter,
  // which this fixture would have reported as "succeeded". Now a live read that disagrees with the
  // claim's bound digest revokes the claim before the adapter is ever called.
  it("reports drift and never calls the adapter when the live requirements digest no longer matches the claim", async () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = await mintMarkReadyApproval(approvalStore);
    const adapter = recordingMarkReadyAdapter({
      schemaVersion: "1",
      outcome: "succeeded",
      durationMs: 5,
    });
    // Same head/base/draft, but the live required-checks configuration has since changed — a
    // different requirements.digest input yields a different requirementsDigest output.
    const driftedFacts = readyCiFacts({
      requirements: {
        status: "observed",
        requirements: [],
        strict: false,
        digest: "a-different-requirements-configuration",
      },
    });
    const res = await createHandlePrMarkReadyExecute({
      approvalStore,
      now: () => 1_700_000_000_001,
      adapterFactory: () => adapter.adapter,
      ciReaderFactory: () => ciReaderReturning(driftedFacts),
    })(ctxFor(MARK_READY_EXECUTE, markReadyBody({ approval })), deps());
    const body = res.body as GitDeliveryPrMarkReadyExecuteResponseBody;
    expect(body).toMatchObject({ status: "failed", executionErrorCode: "precondition-failed" });
    expect(adapter.calls()).toHaveLength(0);
  });

  it("reports drift and never calls the adapter when the live PR now has a merge conflict", async () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = await mintMarkReadyApproval(approvalStore);
    const adapter = recordingMarkReadyAdapter({
      schemaVersion: "1",
      outcome: "succeeded",
      durationMs: 5,
    });
    const conflictingFacts = readyCiFacts({ mergeable: false, mergeState: "dirty" });
    const res = await createHandlePrMarkReadyExecute({
      approvalStore,
      now: () => 1_700_000_000_001,
      adapterFactory: () => adapter.adapter,
      ciReaderFactory: () => ciReaderReturning(conflictingFacts),
    })(ctxFor(MARK_READY_EXECUTE, markReadyBody({ approval })), deps());
    const body = res.body as GitDeliveryPrMarkReadyExecuteResponseBody;
    expect(body).toMatchObject({ status: "failed", executionErrorCode: "precondition-failed" });
    expect(adapter.calls()).toHaveLength(0);
  });

  it("reports drift and never calls the adapter when the live requirements/conflict read is unavailable or incomplete", async () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = await mintMarkReadyApproval(approvalStore);
    const adapter = recordingMarkReadyAdapter({
      schemaVersion: "1",
      outcome: "succeeded",
      durationMs: 5,
    });
    // The "unavailable" branch of GitCiFactsResult (never a synthesized green — correction 4/AC5).
    const unavailable: GitCiFactsResult = {
      status: "unavailable",
      failure: { reason: "rate-limited", state: "pending" },
    };
    const res = await createHandlePrMarkReadyExecute({
      approvalStore,
      now: () => 1_700_000_000_001,
      adapterFactory: () => adapter.adapter,
      ciReaderFactory: () => ciReaderReturning(unavailable),
    })(ctxFor(MARK_READY_EXECUTE, markReadyBody({ approval })), deps());
    const body = res.body as GitDeliveryPrMarkReadyExecuteResponseBody;
    expect(body).toMatchObject({ status: "failed", executionErrorCode: "precondition-failed" });
    expect(adapter.calls()).toHaveLength(0);
  });

  it("emits a correlation-keyed diagnostic when the live CI read throws", async () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = await mintMarkReadyApproval(approvalStore);
    const activity: ServerLogEvent[] = [];
    const diagnostics: ServerDiagnosticRecord[] = [];
    const diagnosticSink: ServerDiagnosticSink = {
      record: (record): void => void diagnostics.push(record),
    };
    const res = await createHandlePrMarkReadyExecute({
      approvalStore,
      now: () => 1_700_000_000_001,
      activityLog: { write: (event): void => void activity.push(event) },
      ciReaderFactory: () => ({
        readFacts: (): Promise<GitCiFactsResult> =>
          Promise.reject(new Error("provider response contained a secret")),
      }),
    })(
      { ...ctxFor(MARK_READY_EXECUTE, markReadyBody({ approval })), correlationId: "corr-ci-read" },
      deps({ diagnostics: diagnosticSink }),
    );
    expect(res).toMatchObject({ status: 200, body: { status: "failed" } });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      correlationId: "corr-ci-read",
      operation: "POST /api/git-delivery/pr/mark-ready/execute",
      source: "pr-mark-ready-ci-read",
      message: "The bounded status read was unavailable.",
    });
    expect(JSON.stringify(diagnostics[0])).not.toContain("provider response contained a secret");
    const failure = activity.find((event) => event.op === "git.delivery.mutation.failed");
    expect(failure).toMatchObject({
      correlationId: "corr-ci-read",
      level: "error",
      errorKind: "Error",
      extra: { actionKind: "pr-mark-ready", phaseReached: "readiness" },
    });
    expect(failure?.extra?.frames).toBeDefined();
    expect(failure?.extra?.causeChain).toBeDefined();
    expect(JSON.stringify(failure)).not.toContain("provider response contained a secret");
  });

  it("reports and logs an unexpected mark-ready adapter failure without mislabelling the worktree", async () => {
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const approval = await mintMarkReadyApproval(approvalStore);
    const activity: ServerLogEvent[] = [];
    const diagnostics: ServerDiagnosticRecord[] = [];
    const res = await createHandlePrMarkReadyExecute({
      approvalStore,
      now: () => 1_700_000_000_001,
      activityLog: { write: (event): void => void activity.push(event) },
      ciReaderFactory: cleanCiReaderFactory,
      adapterFactory: (): GitPullRequestMarkReadyAdapter => ({
        markPullRequestReady: (): Promise<GitPrMarkReadyExecResult> =>
          Promise.reject(new Error("provider response contained another secret")),
      }),
    })(
      {
        ...ctxFor(MARK_READY_EXECUTE, markReadyBody({ approval })),
        correlationId: "corr-mark-ready-failed",
      },
      deps({ diagnostics: { record: (record): void => void diagnostics.push(record) } }),
    );

    expect(res).toMatchObject({
      status: 502,
      body: { error: { code: "GIT_DELIVERY_PR_MARK_READY_EXECUTION_FAILED" } },
    });
    expect(activity.find((event) => event.op === "git.delivery.mutation.failed")).toMatchObject({
      correlationId: "corr-mark-ready-failed",
      level: "error",
      errorKind: "Error",
      extra: { actionKind: "pr-mark-ready", phaseReached: "dispatch" },
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      correlationId: "corr-mark-ready-failed",
      source: "pr-mark-ready-dispatch",
    });
    expect(JSON.stringify({ activity, diagnostics })).not.toContain(
      "provider response contained another secret",
    );
  });

  it.each([
    { headSha: "not-a-sha" },
    { baseSha: "0".repeat(39) },
    { baseRef: "refs/heads/dev" },
    { baseRef: "bad ref" },
    { readinessDigest: "too-short" },
    { prExternalId: "not-numeric" },
    { ownerAndRepo: "not-owner-repo" },
  ])("rejects a malformed mark-ready request %j", async (overrides) => {
    const res = await createHandlePrMarkReadyApprove()(
      ctxFor(MARK_READY_APPROVE, markReadyBody(overrides)),
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a request smuggling a merge or issue-close field", async () => {
    const res = await createHandlePrMarkReadyApprove()(
      ctxFor(MARK_READY_APPROVE, { ...markReadyBody(), mergeMethod: "squash", closeIssue: true }),
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("logs body-free git.delivery.pr-mark-ready.approval.minted and .required lines with correlation", async () => {
    const activity: ServerLogEvent[] = [];
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const activityLog = { write: (event: ServerLogEvent): void => void activity.push(event) };
    await createHandlePrMarkReadyApprove({ approvalStore, activityLog })(
      { ...ctxFor(MARK_READY_APPROVE, markReadyBody()), correlationId: "corr-mark-ready-mint" },
      deps(),
    );
    const minted = activity.filter(
      (event) => event.op === "git.delivery.pr-mark-ready.approval.minted",
    );
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({ correlationId: "corr-mark-ready-mint" });
    expect(JSON.stringify(minted[0])).not.toContain("Keiko");

    await createHandlePrMarkReadyExecute({ approvalStore, activityLog })(
      { ...ctxFor(MARK_READY_EXECUTE, markReadyBody()), correlationId: "corr-mark-ready-noclaim" },
      deps(),
    );
    const required = activity.filter(
      (event) => event.op === "git.delivery.pr-mark-ready.approval.required",
    );
    expect(required).toHaveLength(1);
    expect(required[0]).toMatchObject({ correlationId: "corr-mark-ready-noclaim" });
  });

  it("logs a body-free git.delivery.pr-mark-ready.executed line on success and .drift on precondition failure", async () => {
    const activity: ServerLogEvent[] = [];
    const activityLog = { write: (event: ServerLogEvent): void => void activity.push(event) };
    const approvalStore = createInMemoryGitDeliveryApprovalStore();
    const succeeded = await mintMarkReadyApproval(approvalStore);
    const adapter = recordingMarkReadyAdapter({
      schemaVersion: "1",
      outcome: "succeeded",
      durationMs: 4,
    });
    await createHandlePrMarkReadyExecute({
      approvalStore,
      activityLog,
      now: () => 1_700_000_000_001,
      adapterFactory: () => adapter.adapter,
      ciReaderFactory: cleanCiReaderFactory,
    })(
      {
        ...ctxFor(MARK_READY_EXECUTE, markReadyBody({ approval: succeeded })),
        correlationId: "corr-mark-ready-exec",
      },
      deps(),
    );
    const executed = activity.filter((event) => event.op === "git.delivery.pr-mark-ready.executed");
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({
      correlationId: "corr-mark-ready-exec",
      extra: { outcome: "succeeded" },
    });

    const drifted = await mintMarkReadyApproval(approvalStore);
    const driftAdapter = recordingMarkReadyAdapter({
      schemaVersion: "1",
      outcome: "failed",
      durationMs: 2,
      errorCode: "precondition-failed",
    });
    await createHandlePrMarkReadyExecute({
      approvalStore,
      activityLog,
      now: () => 1_700_000_000_002,
      adapterFactory: () => driftAdapter.adapter,
      ciReaderFactory: cleanCiReaderFactory,
    })(
      {
        ...ctxFor(MARK_READY_EXECUTE, markReadyBody({ approval: drifted })),
        correlationId: "corr-mark-ready-drift",
      },
      deps(),
    );
    const drift = activity.filter((event) => event.op === "git.delivery.pr-mark-ready.drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ correlationId: "corr-mark-ready-drift" });
  });

  // Final-audit F2/#3390 (ADR-0138 D2): before this fix, the coarse admission gate hard-denied both
  // pr/mark-ready/approve and pr/mark-ready/execute with "approval-required" below
  // `autonomous-delivery` and no production path ever redeemed it — every test above only ever
  // exercised the fixture default (autonomous-delivery). FAILING BEFORE THE FIX: `modeDeps()`'s
  // approve call returned 403 GIT_DELIVERY_AUTHORITY_DENIED at the `gitDeliveryAuthorityGate` call
  // inside `createHandlePrMarkReadyApprove`, never reaching `store.issue()`.
  it.each(["governed-assist", "supervised-coding"] as const)(
    "mints and consumes a pr-mark-ready approval end to end at %s",
    async (mode) => {
      const modeDeps = deps({
        gitDeliveryAuthority: permittedGitDeliveryAuthority(
          () => projectId,
          () => projectId,
          mode,
        ),
      });
      const approvalStore = createInMemoryGitDeliveryApprovalStore();
      const approveRes = await createHandlePrMarkReadyApprove({
        approvalStore,
        now: () => 1_700_000_000_000,
      })(ctxFor(MARK_READY_APPROVE, markReadyBody()), modeDeps);
      expect(approveRes.status).toBe(200);
      const approval = (approveRes.body as GitDeliveryPrMarkReadyApproveResponseBody).approval;

      const adapter = recordingMarkReadyAdapter({
        schemaVersion: "1",
        outcome: "succeeded",
        durationMs: 5,
      });
      const executeRes = await createHandlePrMarkReadyExecute({
        approvalStore,
        now: () => 1_700_000_000_001,
        adapterFactory: () => adapter.adapter,
        ciReaderFactory: cleanCiReaderFactory,
      })(ctxFor(MARK_READY_EXECUTE, markReadyBody({ approval })), modeDeps);
      const body = executeRes.body as GitDeliveryPrMarkReadyExecuteResponseBody;
      expect(body).toMatchObject({ actionKind: "pr-mark-ready", status: "succeeded" });
      expect(adapter.calls()).toHaveLength(1);
    },
  );

  it.each(["governed-assist", "supervised-coding"] as const)(
    "still returns approval-required (never mode-denied) at %s when execute carries no approval",
    async (mode) => {
      const modeDeps = deps({
        gitDeliveryAuthority: permittedGitDeliveryAuthority(
          () => projectId,
          () => projectId,
          mode,
        ),
      });
      const approvalStore = createInMemoryGitDeliveryApprovalStore();
      const adapter = recordingMarkReadyAdapter({
        schemaVersion: "1",
        outcome: "succeeded",
        durationMs: 5,
      });
      const res = await createHandlePrMarkReadyExecute({
        approvalStore,
        adapterFactory: () => adapter.adapter,
      })(ctxFor(MARK_READY_EXECUTE, markReadyBody()), modeDeps);
      const body = res.body as GitDeliveryPrMarkReadyExecuteResponseBody;
      expect(body.status).toBe("approval-required");
      expect(adapter.calls()).toHaveLength(0);
    },
  );

  // AC4 (epic #3384): the coding runtime exposes neither merge nor auto-merge scheduling nor
  // issue-close mutations. The full PR route group (create/update/preview/mark-ready) carries no
  // such endpoint — this is a structural pin on the route table itself, independent of any single
  // handler's behaviour.
  it("the PR route group (including mark-ready) exposes no merge or issue-close endpoint", () => {
    const patterns = createGitDeliveryPrRouteGroup().map((route) => route.pattern);
    expect(patterns).toEqual(
      expect.arrayContaining([
        "/api/git-delivery/pr/preview",
        "/api/git-delivery/pr/approve",
        "/api/git-delivery/pr/execute",
        "/api/git-delivery/pr/mark-ready/approve",
        "/api/git-delivery/pr/mark-ready/execute",
      ]),
    );
    for (const pattern of patterns) {
      expect(pattern.toLowerCase()).not.toMatch(/merge|close/u);
    }
  });

  // Owner audit of PR #3394, finding b2-19: every test above resolves a route group's own factory
  // output (`createGitDeliveryPrRouteGroup()`, called fresh) rather than the real, module-level
  // `API_ROUTES`/`matchRoute` `routes.ts` actually serves requests through. Three earlier review
  // threads found the pr-description, journey, and mark-ready groups unmounted at intermediate
  // checkpoints (imported into `routes.ts` but never spread into `API_ROUTES`) — a defect this
  // group's own factory-output tests could never catch, since a group that is never wired in still
  // returns a perfectly well-formed array from its own factory. Resolving through `matchRoute` is
  // the only way to prove these patterns are actually reachable by an inbound request.
  it("resolves the pr-description, journey, and mark-ready patterns through the real API_ROUTES (b2-19)", () => {
    const postOnly = [
      "/api/git-delivery/pr-description/preview",
      "/api/git-delivery/pr-description/review",
      "/api/git-delivery/pr-description/approve",
      "/api/git-delivery/pr-description/apply",
      "/api/git-delivery/pr-description/status",
      "/api/git-change/review-description",
      "/api/git-delivery/journey/refresh",
      "/api/git-delivery/pr/mark-ready/approve",
      "/api/git-delivery/pr/mark-ready/execute",
    ];
    for (const pattern of postOnly) {
      const match = matchRoute("POST", pattern);
      if (match === undefined || match === "method-not-allowed") {
        throw new Error(`expected ${pattern} to resolve through the real API_ROUTES`);
      }
      expect(match.definition.pattern).toBe(pattern);
      // Every one of these is a mutation/refresh surface — never reachable by GET.
      expect(matchRoute("GET", pattern)).toBe("method-not-allowed");
    }
  });
});
