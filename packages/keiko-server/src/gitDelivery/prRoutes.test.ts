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
import type { GitDeliveryRepoPolicyPack } from "@oscharko-dev/keiko-contracts";
import { GIT_DELIVERY_POLICY_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-policy";
import type { GitPullRequestCommand, GitWorktreeSnapshot } from "@oscharko-dev/keiko-tools";
import type {
  GitPrCreateExecRequest,
  GitPrExecResult,
  GitPrUpdateExecRequest,
  GitPullRequestAdapter,
} from "@oscharko-dev/keiko-tools";
import type { NodeGitPullRequestAdapterDeps } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { UI_HOST } from "../server.js";
import { buildCspHeader } from "../csp.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import { startUiTestServer } from "../ui-test-server/_support.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import type { RouteContext } from "../routes.js";
import type { ServerLogEvent } from "../observability/server-log.js";

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

import { createHandlePrExecute, createHandlePrPreview } from "./prRoutes.js";
import {
  executeGovernedPullRequest,
  type GitDeliveryPrExecuteResponseBody,
  type GitDeliveryPrPreviewBody,
  type GitDeliveryPullRequestSeams,
} from "./prExecution.js";
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
  return { req, res: {} as ServerResponse, params: {}, url: new URL(`http://127.0.0.1${path}`) };
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
      const res = await fetch(`http://${UI_HOST}:${String(port)}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
        body: JSON.stringify(createBody()),
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

describe("pr execute — governed create + no-bypass (AC1/AC4/AC5)", () => {
  it("opens a permitted PR, returns the provider PR number, and records content-free evidence (AC5)", async () => {
    const adapter = recordingPrAdapter();
    const cap = capturingEvidenceStore();
    const handler = createHandlePrExecute({
      execution: seams({ prAdapterFactory: () => adapter.adapter }),
    });
    const res = await handler(ctxFor(EXECUTE, createBody()), deps({ evidenceStore: cap.store }));
    const body = res.body as GitDeliveryPrExecuteResponseBody;
    expect(body.status).toBe("succeeded");
    expect(body.createdPrExternalId).toBe("1499");
    expect(adapter.creates()).toBe(1);
    expect(cap.count()).toBe(1);
    // Content-free: the PR title/body strings never enter the evidence ledger.
    expect(cap.raw()).not.toContain("governed pull request command center");
    expect(cap.raw()).not.toContain("Implements the #477");
  });

  it("aborts PR dispatch when another allowed authority replaces the admitted run", async () => {
    const adapter = recordingPrAdapter();
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
    const handler = createHandlePrExecute({
      execution: seams({ prAdapterFactory: () => adapter.adapter }),
    });

    const res = await handler(
      ctxFor(EXECUTE, createBody()),
      deps({ gitDeliveryAuthority: authority }),
    );

    expect((res.body as GitDeliveryPrExecuteResponseBody).status).toBe("failed");
    expect(reads).toBe(2);
    expect(adapter.creates()).toBe(0);
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
    const handler = createHandlePrExecute({
      execution: seams({ prAdapterFactory: () => adapter.adapter }),
    });
    const res = await handler(ctxFor(EXECUTE, createBody()), deps({ evidenceStore: cap.store }));
    const body = res.body as GitDeliveryPrExecuteResponseBody;
    expect(body.status).toBe("failed");
    expect(body.prRejectionReason).toBe("validation-error");
    expect(body.recoveryDisposition).toBe("user-fixable");
    expect(cap.count()).toBe(1);
  });

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
    const res = await handler(ctxFor(EXECUTE, createBody()), deps());
    const body = res.body as GitDeliveryPrExecuteResponseBody;
    expect(body.status).toBe("approval-required");
    expect(body.requiredApprovers).toContain("lead");
    expect(adapter.creates()).toBe(0);
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
    const handler = createHandlePrExecute({
      execution: seams({ prAdapterFactory: () => adapter.adapter }),
    });
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
      }),
      deps(),
    );
    const body = res.body as GitDeliveryPrExecuteResponseBody;
    expect(body.status).toBe("succeeded");
    expect(adapter.updates()).toBe(1);
    expect(adapter.creates()).toBe(0);
  });
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
    expect(activity).toHaveLength(1);
    expect(activity[0]?.op).toBe("command.terminated");
    expect(activity[0]?.correlationId).toBe("request-correlation-pr-wiring");
    expect(activity[0]?.extra?.childPid).toBe(5678);
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
    expect(marker?.extra?.actionKind).toBe("pr-create");
  });
});
