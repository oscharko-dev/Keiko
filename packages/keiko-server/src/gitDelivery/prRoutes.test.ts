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
import type { AddressInfo } from "node:net";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitWorktreeSnapshot } from "@oscharko-dev/keiko-tools";
import type {
  GitPrCreateExecRequest,
  GitPrExecResult,
  GitPrUpdateExecRequest,
  GitPullRequestAdapter,
} from "@oscharko-dev/keiko-tools";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createUiServer, UI_HOST } from "../server.js";
import { buildCspHeader } from "../csp.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import type { RouteContext } from "../routes.js";
import { createHandlePrExecute, createHandlePrPreview } from "./prRoutes.js";
import type {
  GitDeliveryPrExecuteResponseBody,
  GitDeliveryPrPreviewBody,
  GitDeliveryPullRequestSeams,
} from "./prExecution.js";

const ENABLED_ENV = { KEIKO_GIT_DELIVERY_ENABLED: "true" } as const;
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
    env: ENABLED_ENV,
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

  it("404s preview + execute when governed git delivery is disabled", async () => {
    await closeServer();
    await startBound({ env: {} });
    for (const path of [PREVIEW, EXECUTE]) {
      const res = await fetch(`http://${UI_HOST}:${String(port)}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
        body: JSON.stringify(createBody()),
      });
      expect(res.status).toBe(404);
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
  });

  it("400s a credential-shaped body", async () => {
    const handler = createHandlePrPreview({ execution: seams() });
    const res = await handler(
      ctxFor(PREVIEW, createBody({ body: "see Authorization: Bearer abc123" })),
      deps(),
    );
    expect(res.status).toBe(400);
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

  it("blocks a base outside the allow-list, executing nothing yet recording evidence (AC2/AC5)", async () => {
    const adapter = recordingPrAdapter();
    const cap = capturingEvidenceStore();
    const handler = createHandlePrExecute({
      execution: seams({ prAdapterFactory: () => adapter.adapter }),
    });
    const res = await handler(
      ctxFor(EXECUTE, createBody({ baseBranchName: "random-base" })),
      deps({ evidenceStore: cap.store }),
    );
    const body = res.body as GitDeliveryPrExecuteResponseBody;
    expect(body.status).toBe("blocked");
    expect(body.blockReason).toBe("policy-pack-blocked");
    expect(adapter.creates()).toBe(0);
    expect(cap.count()).toBe(1);
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
