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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitWorktreeSnapshot } from "@oscharko-dev/keiko-tools";
import type { GitPublishExecResult, GitRemotePublishAdapter } from "@oscharko-dev/keiko-tools";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { UI_HOST } from "../server.js";
import { buildCspHeader } from "../csp.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import type { RouteContext } from "../routes.js";
import { startUiTestServer } from "../ui-test-server/_support.js";
import { createHandlePushExecute, createHandlePushPreview } from "./pushRoutes.js";
import type {
  GitDeliveryPushExecuteResponseBody,
  GitDeliveryPushPreviewBody,
  GitDeliveryPublishSeams,
} from "./pushExecution.js";
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

function capturingEvidenceStore(): { store: EvidenceStore; count: () => number } {
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
  return { req, res: {} as ServerResponse, params: {}, url: new URL(`http://127.0.0.1${path}`) };
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
      const res = await fetch(`http://${UI_HOST}:${String(port)}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
        body: JSON.stringify(pushBody()),
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
    const handler = createHandlePushExecute({
      execution: seams({ publishAdapterFactory: () => adapter.adapter }),
    });
    const res = await handler(
      ctxFor(EXECUTE, pushBody({ setUpstreamTracking: true })),
      deps({ evidenceStore: cap.store }),
    );
    expect((res.body as GitDeliveryPushExecuteResponseBody).status).toBe("succeeded");
    expect(adapter.calls()).toBe(1);
    expect(cap.count()).toBe(1);
  });

  it("aborts dispatch when another allowed runtime authority replaces the admitted run", async () => {
    const adapter = recordingPublishAdapter();
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
    const handler = createHandlePushExecute({
      execution: seams({ publishAdapterFactory: () => adapter.adapter }),
    });

    const res = await handler(
      ctxFor(EXECUTE, pushBody()),
      deps({ gitDeliveryAuthority: authority }),
    );

    expect((res.body as GitDeliveryPushExecuteResponseBody).status).toBe("failed");
    expect(reads).toBe(2);
    expect(adapter.calls()).toBe(0);
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
    const handler = createHandlePushExecute({
      execution: seams({ publishAdapterFactory: () => adapter.adapter }),
    });
    const res = await handler(
      ctxFor(EXECUTE, pushBody({ remoteBranchName: "my-work", sourceBranchName: "my-work" })),
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
    const handler = createHandlePushExecute({
      execution: seams({ publishAdapterFactory: () => adapter.adapter }),
    });
    const res = await handler(ctxFor(EXECUTE, pushBody({ forcePush: true })), deps());
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
    const handler = createHandlePushExecute({
      execution: seams({
        publishAdapterFactory: () => adapter.adapter,
        snapshotReader: () => Promise.resolve({ ...SNAPSHOT, behindCount: 3 }),
      }),
    });
    const res = await handler(ctxFor(EXECUTE, pushBody()), deps());
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
    const handler = createHandlePushExecute({
      execution: seams({ publishAdapterFactory: () => adapter.adapter }),
    });
    const res = await handler(ctxFor(EXECUTE, pushBody()), deps({ evidenceStore: cap.store }));
    const body = res.body as GitDeliveryPushExecuteResponseBody;
    expect(body.status).toBe("failed");
    expect(body.publishRejectionReason).toBe("permission-denied");
    expect(body.recoveryDisposition).toBe("user-fixable");
    expect(cap.count()).toBe(1);
  });
});
