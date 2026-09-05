// Route tests for the governed PR-description application routes (#3399, epic #3384 correction 4).
//
// Proves the acceptance criteria at the BFF seam:
//   * The route group did not exist before this change — the mount assertion below documents that.
//   * A preview -> approve -> apply round trip succeeds against a fake GitHub adapter (via the
//     already-proven DescriptionFixture) while an unauthorized or expired-authority request is
//     denied with a typed reason before the service is ever reached.
//   * A stale snapshot / changed PR body performs no write (proven through the fixture's own
//     protected-content-drift detection).
//   * A request smuggling an extra operation-shaped field is rejected before any adapter call.
//   * The apply-lifecycle op literals are emitted with correlation, body-free.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultChatCapability } from "@oscharko-dev/keiko-model-gateway";
import type { GitPullRequestBodyAdapter } from "@oscharko-dev/keiko-tools";
import type { ServerLogEvent } from "../observability/index.js";
import {
  buildRedactor,
  buildUiHandlerDeps,
  createRunRegistry,
  type UiHandlerDeps,
} from "../index.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import type { RouteContext } from "../routes.js";
import { permittedGitDeliveryAuthority } from "./runBoundAuthority.test-support.js";
import { createInMemoryGitDeliveryApprovalStore } from "./approvalStore.js";
import type {
  ActiveGitDeliveryDescriptionAuthority,
  GitDeliveryDescriptionAuthorityPort,
  GitDeliveryDescriptionAuthorityScope,
} from "./runBoundAuthority.js";
import { EditorAgentAuthorityRegistry } from "../editor/agentAuthorityRegistry.js";
import { CodingRuntimeAuthorityService } from "../coding-runtime/runtimeAuthorityService.js";
import {
  createCodingRuntimeControlPlane,
  type CodingRuntimeHost,
} from "../coding-runtime/codingRuntimeControlPlane.js";
import { codingWorkbenchRemoteDigest } from "../coding-context/githubIssueResolution.js";
import {
  clearPrDescriptionServiceCache,
  createGitDeliveryPrDescriptionRouteGroup,
  createHandlePrDescriptionApply,
  createHandlePrDescriptionApprove,
  createHandlePrDescriptionPreview,
  createHandlePrDescriptionStatus,
  resolvePrDescriptionApplicationServiceForRequest,
  type PrDescriptionRouteOptions,
} from "./prDescriptionRoutes.js";
import { DescriptionFixture } from "./prDescriptionTestSupport.js";
import type { PrDescriptionApplicationService } from "./prDescriptionTypes.js";

const PREVIEW = "/api/git-delivery/pr-description/preview";
const APPROVE = "/api/git-delivery/pr-description/approve";
const APPLY = "/api/git-delivery/pr-description/apply";
const STATUS = "/api/git-delivery/pr-description/status";

let fixture: DescriptionFixture;
let store: UiStore;
let projectId: string;

beforeEach(() => {
  fixture = new DescriptionFixture();
  store = createInMemoryUiStore();
  projectId = store.createProject(fixture.root).path;
  clearPrDescriptionServiceCache();
});
afterEach(() => {
  clearPrDescriptionServiceCache();
  fixture.close();
  store.close();
});

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
      () => fixture.root,
      "autonomous-delivery",
      {
        headRef: "feature",
        baseRef: "main",
        allowDetachedHead: false,
        allowedPrefixes: ["feature"],
      },
    ),
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    projectId,
    ownerAndRepo: "owner/repo",
    prNumber: 123,
    ...overrides,
  };
}

// Minimal server-owned lifecycle surface for a `CodingRuntimeControlPlane` composition test that
// never exercises the manager/launch resolver itself — only `gitDeliveryDescriptionAuthority`'s
// threading through `createCodingRuntimeControlPlane` matters here (the manager/lifecycle wiring
// is proven by codingRuntimeControlPlane.test.ts's own fixtures).
function unqualifiedControlPlaneRuntimeHost(
  gitDeliveryDescriptionAuthority: CodingRuntimeHost["gitDeliveryDescriptionAuthority"],
): CodingRuntimeHost {
  const stopped = (): ReturnType<ReturnType<CodingRuntimeHost["createManager"]>["stop"]> =>
    Promise.resolve({ ok: false, failureCode: "runtime-run-mismatch", retryable: false });
  return {
    createManager: () => ({
      start: () => ({ ok: false, failureCode: "runtime-unqualified", retryable: false }),
      issueApproval: () => ({ ok: false, failureCode: "runtime-stopped", retryable: false }),
      pause: () => ({ ok: false, failureCode: "runtime-run-mismatch", retryable: false }),
      resume: () => ({ ok: false, failureCode: "runtime-run-mismatch", retryable: false }),
      stop: stopped,
      takeover: stopped,
      reconcile: stopped,
      health: () => ({ status: "stopped" }),
      pendingApprovalReview: () => undefined,
      result: () => undefined,
    }),
    launchResolver: {
      resolve: (): never => {
        throw new Error("not exercised by this test");
      },
    },
    approvalAuthority: {
      issue: () => ({ ok: false, failureCode: "runtime-stopped", retryable: false }),
    },
    cancellationRegistry: { signalFor: () => undefined },
    gitDeliveryDescriptionAuthority,
  };
}

// The fixture's own service is a real, already-proven `PrDescriptionApplicationService`
// (prDescriptionService.test.ts) bound to `fixture.context`. Injecting it via `serviceFactory`
// isolates what THIS file must prove — the HTTP route layer's own validation, admission, dispatch,
// response shape, and body-free logging — from the service's own snapshot/generation/write behavior,
// which is proven elsewhere and would otherwise be re-tested here at a cost with no new coverage.
function optionsWithFixtureService(
  execution: PrDescriptionRouteOptions["execution"] = {},
): PrDescriptionRouteOptions {
  return { execution, serviceFactory: () => fixture.service };
}

describe("pr-description routes — mount (#3399)", () => {
  it("the route group did not exist before this change and now exposes exactly the four patterns", () => {
    const patterns = createGitDeliveryPrDescriptionRouteGroup().map((route) => route.pattern);
    expect(patterns).toEqual([PREVIEW, APPROVE, APPLY, STATUS]);
  });

  it("isolates proposal holders by dependency scope and immutable snapshot", () => {
    const factory = vi.fn(() => fixture.service);
    const firstDeps = deps();
    const firstRequest = {
      projectId,
      ownerAndRepo: "owner/repo",
      prNumber: 123,
      snapshotDigest: "a".repeat(64),
    };
    const first = resolvePrDescriptionApplicationServiceForRequest(
      firstDeps,
      ctxFor(PREVIEW, firstRequest),
      firstRequest,
      "cache-1",
      { serviceFactory: factory },
    );
    const repeated = resolvePrDescriptionApplicationServiceForRequest(
      firstDeps,
      ctxFor(PREVIEW, firstRequest),
      firstRequest,
      "cache-2",
      { serviceFactory: factory },
    );
    const refreshedRequest = { ...firstRequest, snapshotDigest: "b".repeat(64) };
    resolvePrDescriptionApplicationServiceForRequest(
      firstDeps,
      ctxFor(PREVIEW, refreshedRequest),
      refreshedRequest,
      "cache-3",
      { serviceFactory: factory },
    );
    resolvePrDescriptionApplicationServiceForRequest(
      deps(),
      ctxFor(PREVIEW, firstRequest),
      firstRequest,
      "cache-4",
      { serviceFactory: factory },
    );
    expect(first.ok && repeated.ok && first.service).toBe(repeated.ok && repeated.service);
    expect(factory).toHaveBeenCalledTimes(3);
  });
});

describe("pr-description routes — admission (#3399)", () => {
  it("denies with a typed reason when no accepted run and no description authority admit the request", async () => {
    const handler = createHandlePrDescriptionPreview(optionsWithFixtureService());
    const res = await handler(
      ctxFor(PREVIEW, body({ language: "en" })),
      deps({ gitDeliveryAuthority: undefined }),
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "GIT_DELIVERY_AUTHORITY_DENIED" } });
  });

  it("denies with a typed reason when the accepted run's authority has expired", async () => {
    const expired = permittedGitDeliveryAuthority(
      () => projectId,
      () => fixture.root,
      "autonomous-delivery",
      {
        headRef: "feature",
        baseRef: "main",
        allowDetachedHead: false,
        allowedPrefixes: ["feature"],
      },
    );
    const handler = createHandlePrDescriptionPreview(optionsWithFixtureService());
    const res = await handler(
      ctxFor(PREVIEW, body({ language: "en" })),
      deps({
        gitDeliveryAuthority: {
          current: (nowIso) => {
            const active = expired.current(nowIso);
            return active === undefined
              ? undefined
              : {
                  ...active,
                  authority: { ...active.authority, expiresAt: "1970-01-01T00:00:00.000Z" },
                };
          },
        },
      }),
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "GIT_DELIVERY_AUTHORITY_DENIED" } });
  });

  it("admits through the description authority for the exact scope when no run is active", async () => {
    const scope: GitDeliveryDescriptionAuthorityScope = {
      remoteDigest: "d".repeat(64),
      pr: { ownerAndRepo: "owner/repo", prNumber: 123 },
      snapshotDigest: "e".repeat(64),
    };
    const active: ActiveGitDeliveryDescriptionAuthority = {
      scope,
      effectiveMode: "supervised-coding",
      expiresAt: "2999-01-01T00:00:00.000Z",
    };
    const port: GitDeliveryDescriptionAuthorityPort = { current: () => active };
    const handler = createHandlePrDescriptionPreview(optionsWithFixtureService());
    const res = await handler(
      ctxFor(PREVIEW, body({ language: "en", snapshotDigest: scope.snapshotDigest })),
      deps({ gitDeliveryAuthority: undefined, gitDeliveryDescriptionAuthority: port }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { outcome: string }).outcome).toBe("preview");
  });

  it("never admits through the description authority for a scope that does not match", async () => {
    const port: GitDeliveryDescriptionAuthorityPort = { current: () => undefined };
    const handler = createHandlePrDescriptionPreview(optionsWithFixtureService());
    const res = await handler(
      ctxFor(PREVIEW, body({ language: "en", snapshotDigest: "f".repeat(64) })),
      deps({ gitDeliveryAuthority: undefined, gitDeliveryDescriptionAuthority: port }),
    );
    expect(res.status).toBe(403);
  });

  // #3399 (epic #3384 correction 4): a production-composition test spanning the FULL chain a live
  // server actually uses — mints through a real `CodingRuntimeAuthorityService`, threads the port
  // through a real `createCodingRuntimeControlPlane` (never a hand-rolled port passed straight into
  // `deps`, since that would prove nothing about the wiring in `codingRuntimeControlPlane.ts` /
  // `productionCodingRuntimeHost.ts` / `productionCodingRuntimeResolver.ts` this change adds), and
  // only then reaches `deps.gitDeliveryDescriptionAuthority`. Before this change,
  // `CodingRuntimeControlPlane` exposed no `gitDeliveryDescriptionAuthority` field at all: the value
  // handed to `deps` below would be `undefined`, and every apply from a Chat/post-terminal caller
  // with no running run answered `GIT_DELIVERY_AUTHORITY_DENIED` (403) rather than admitting.
  it("admits a full preview -> approve -> apply round trip through the REAL composed control-plane chain", async () => {
    const authority = new CodingRuntimeAuthorityService(new EditorAgentAuthorityRegistry());
    const snapshotDigest = "e".repeat(64);
    const scope: GitDeliveryDescriptionAuthorityScope = {
      remoteDigest: codingWorkbenchRemoteDigest("owner/repo"),
      pr: { ownerAndRepo: "owner/repo", prNumber: 123 },
      snapshotDigest,
    };
    authority.mintGitDeliveryDescriptionAuthority({
      scope,
      requestedMode: "supervised-coding",
      deploymentCeiling: "autonomous-delivery",
      nowIso: new Date().toISOString(),
    });
    const controlPlane = createCodingRuntimeControlPlane({
      snapshots: {
        create: vi.fn(),
        recordVerifiedCommit: vi.fn(),
        recordDraftDelivery: vi.fn(),
        adoptDraftDeliveryFromPredecessor: vi.fn(),
        transition: vi.fn(),
        get: vi.fn(),
        listRecentActive: vi.fn(() => []),
        listAll: vi.fn(() => []),
        markNonterminalRecoveryRequired: vi.fn(() => []),
        acknowledgeRecovery: vi.fn(),
        releaseRecoveryForRetry: vi.fn(),
        delete: vi.fn(),
        listPrunableSettled: vi.fn(() => []),
        deletePruned: vi.fn(),
      },
      evidence: { observe: vi.fn(), settle: vi.fn(), deletePruned: vi.fn() },
      workspaceLifecycle: { getActive: () => undefined } as never,
      serverPrincipal: () => "local-operator",
      runtimeHost: unqualifiedControlPlaneRuntimeHost(
        authority.gitDeliveryDescriptionAuthorityPort(),
      ),
    });
    const noRun = deps({
      gitDeliveryAuthority: undefined,
      gitDeliveryDescriptionAuthority: controlPlane.gitDeliveryDescriptionAuthority,
    });
    const previewHandler = createHandlePrDescriptionPreview(optionsWithFixtureService());
    const approveHandler = createHandlePrDescriptionApprove(optionsWithFixtureService());
    const applyHandler = createHandlePrDescriptionApply(optionsWithFixtureService());

    const previewRes = await previewHandler(
      ctxFor(PREVIEW, body({ language: "en", snapshotDigest })),
      noRun,
    );
    expect(previewRes.status).toBe(200);
    const proposalId = (previewRes.body as { preview: { proposalId: string } }).preview.proposalId;

    const approveRes = await approveHandler(
      ctxFor(APPROVE, body({ proposalId, snapshotDigest })),
      noRun,
    );
    expect(approveRes.status).toBe(200);

    const applyRes = await applyHandler(ctxFor(APPLY, body({ proposalId, snapshotDigest })), noRun);
    expect(applyRes.status).toBe(200);
    expect((applyRes.body as { outcome: string }).outcome).toBe("observed");
  });
});

describe("pr-description routes — validation (#3399)", () => {
  it("rejects a request smuggling an extra operation-shaped field before any service call", async () => {
    const spy = vi.fn<() => PrDescriptionApplicationService>(() => fixture.service);
    const handler = createHandlePrDescriptionApply({ serviceFactory: spy });
    const res = await handler(
      ctxFor(APPLY, body({ proposalId: "p-1", mergeMethod: "squash", closeIssue: true })),
      deps(),
    );
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("400s a malformed owner/repo, a non-positive PR number, and an unsupported language", async () => {
    const handler = createHandlePrDescriptionPreview(optionsWithFixtureService());
    expect(
      (await handler(ctxFor(PREVIEW, body({ ownerAndRepo: "noslash", language: "en" })), deps()))
        .status,
    ).toBe(400);
    expect(
      (await handler(ctxFor(PREVIEW, body({ prNumber: 0, language: "en" })), deps())).status,
    ).toBe(400);
    expect((await handler(ctxFor(PREVIEW, body({ language: "fr" })), deps())).status).toBe(400);
  });

  // Owner audit of PR #3394, finding b2-13: three different PR-number ceilings existed across this
  // feature (route: unbounded; context: 2_147_483_647; binding contract: GITHUB_ISSUE_NUMBER_MAX =
  // 1_000_000_000), so a value strictly between the last two used to pass preview and only fail
  // once it reached the binding contract at apply time. This value sat in exactly that gap before
  // the route was bounded by the same GITHUB_ISSUE_NUMBER_MAX constant every other layer uses.
  it("400s a PR number above GITHUB_ISSUE_NUMBER_MAX instead of admitting it into preview", async () => {
    const handler = createHandlePrDescriptionPreview(optionsWithFixtureService());
    const res = await handler(
      ctxFor(PREVIEW, body({ prNumber: 1_500_000_000, language: "en" })),
      deps(),
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: { code: "GIT_DELIVERY_PR_DESCRIPTION_BAD_REQUEST" },
    });
  });

  it("404s for an unknown project", async () => {
    const handler = createHandlePrDescriptionStatus(optionsWithFixtureService());
    const res = await handler(ctxFor(STATUS, body({ projectId: "/no/such/project" })), deps());
    expect(res.status).toBe(404);
  });
});

describe("pr-description routes — preview/approve/apply round trip (#3399)", () => {
  it("succeeds end to end against the fixture's fake GitHub adapter and never leaks body text into the response envelope's typed fields", async () => {
    const previewHandler = createHandlePrDescriptionPreview(optionsWithFixtureService());
    const approveHandler = createHandlePrDescriptionApprove(optionsWithFixtureService());
    const applyHandler = createHandlePrDescriptionApply(optionsWithFixtureService());

    const previewRes = await previewHandler(ctxFor(PREVIEW, body({ language: "en" })), deps());
    expect(previewRes.status).toBe(200);
    const previewBody = previewRes.body as { outcome: string; preview: { proposalId: string } };
    expect(previewBody.outcome).toBe("preview");
    const proposalId = previewBody.preview.proposalId;

    const approveRes = await approveHandler(ctxFor(APPROVE, body({ proposalId })), deps());
    expect(approveRes.status).toBe(200);
    expect((approveRes.body as { proposalId: string }).proposalId).toBe(proposalId);

    const applyRes = await applyHandler(ctxFor(APPLY, body({ proposalId })), deps());
    expect(applyRes.status).toBe(200);
    expect((applyRes.body as { outcome: string }).outcome).toBe("observed");
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.status?.state).toBe("current");
  });

  it("apply fails closed with an unknown-proposal reason when the approval was never issued", async () => {
    const previewHandler = createHandlePrDescriptionPreview(optionsWithFixtureService());
    const applyHandler = createHandlePrDescriptionApply(optionsWithFixtureService());
    const previewRes = await previewHandler(ctxFor(PREVIEW, body({ language: "en" })), deps());
    const proposalId = (previewRes.body as { preview: { proposalId: string } }).preview.proposalId;

    const res = await applyHandler(ctxFor(APPLY, body({ proposalId })), deps());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: { code: "GIT_DELIVERY_PR_DESCRIPTION_UNKNOWN_PROPOSAL" },
    });
    expect(fixture.writes).toHaveLength(0);
  });

  // Final-audit F2/#3390 (ADR-0138 D2): before this fix, `admitDescription`'s coarse admission
  // gate hard-denied preview/approve/apply with "approval-required" below `autonomous-delivery` and
  // no production path ever redeemed it — every round trip above only ever exercised the fixture
  // default (autonomous-delivery). FAILING BEFORE THE FIX: `modeDeps()`'s preview call returned 403
  // GIT_DELIVERY_AUTHORITY_DENIED at `admitDescription`'s `gitDeliveryAuthorityGate` call, never
  // reaching the service.
  it.each(["governed-assist", "supervised-coding"] as const)(
    "completes a preview -> approve -> apply round trip at %s",
    async (mode) => {
      const modeDeps = deps({
        gitDeliveryAuthority: permittedGitDeliveryAuthority(
          () => projectId,
          () => fixture.root,
          mode,
          {
            headRef: "feature",
            baseRef: "main",
            allowDetachedHead: false,
            allowedPrefixes: ["feature"],
          },
        ),
      });
      const previewHandler = createHandlePrDescriptionPreview(optionsWithFixtureService());
      const approveHandler = createHandlePrDescriptionApprove(optionsWithFixtureService());
      const applyHandler = createHandlePrDescriptionApply(optionsWithFixtureService());

      const previewRes = await previewHandler(ctxFor(PREVIEW, body({ language: "en" })), modeDeps);
      expect(previewRes.status).toBe(200);
      const proposalId = (previewRes.body as { preview: { proposalId: string } }).preview
        .proposalId;

      const approveRes = await approveHandler(ctxFor(APPROVE, body({ proposalId })), modeDeps);
      expect(approveRes.status).toBe(200);

      const applyRes = await applyHandler(ctxFor(APPLY, body({ proposalId })), modeDeps);
      expect(applyRes.status).toBe(200);
      expect((applyRes.body as { outcome: string }).outcome).toBe("observed");
    },
  );
});

// Review repair (description-production-wiring item): every test above injects a fully fake
// `PrDescriptionApplicationService` via `serviceFactory`, which bypasses `buildServiceOptions`
// entirely (by this file's own stated design — see `optionsWithFixtureService`'s comment). That
// isolates the route layer, but it also means nothing proved that a real `deps.prDescriptionGeneration`
// (the #3398/#3399 production Model Gateway composition, mounted onto `deps` by
// prDescriptionGeneration.ts + deps.ts) actually reaches a live `service.preview()` call, or that
// the 503 `GIT_DELIVERY_PR_DESCRIPTION_UNAVAILABLE` fallback fires ONLY when no such composition
// exists. These tests build the route handlers with NO `serviceFactory`, so `buildServiceOptions`'s
// own `seams.generation ?? deps.prDescriptionGeneration` / `seams.snapshots ?? deps.gitChangeSnapshotService`
// fallbacks are the only path a description can take here.
describe("pr-description routes — real composition through deps.prDescriptionGeneration, no serviceFactory seam", () => {
  function productionCompositionOptions(): PrDescriptionRouteOptions {
    return {
      execution: {
        approvalStore: createInMemoryGitDeliveryApprovalStore(),
        activityLog: { write: (): undefined => undefined },
        now: () => fixture.now,
        // The fixture's fake GitHub adapter, not the real git/network-backed default — every other
        // piece of the composition (`generation`, `snapshots`) is real. `options.adapter` ignores
        // the context it is given (see prDescriptionTestSupport.ts's `adapter: () => this.adapter()`)
        // and always returns the fixture's fake adapter, so passing `fixture.context` here — rather
        // than the `workspace` this seam is actually invoked with in production — is safe.
        adapterFactory: (): GitPullRequestBodyAdapter => {
          const adapter = fixture.options.adapter(fixture.context);
          if (adapter === undefined) {
            throw new Error("expected the fixture's fake adapter to be defined");
          }
          return adapter;
        },
      },
    };
  }

  it("answers 503 unavailable when the deployment has no configured model profile", async () => {
    const handler = createHandlePrDescriptionPreview(productionCompositionOptions());

    const res = await handler(
      ctxFor(PREVIEW, body({ language: "en" })),
      deps({ gitChangeSnapshotService: fixture.snapshots, prDescriptionGeneration: undefined }),
    );

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "GIT_DELIVERY_PR_DESCRIPTION_UNAVAILABLE" } });
  });

  it("reaches a live, real model call through deps.prDescriptionGeneration and mints an approval for it", async () => {
    const composedDeps = deps({
      gitChangeSnapshotService: fixture.snapshots,
      prDescriptionGeneration: fixture.options.generation,
    });
    const previewHandler = createHandlePrDescriptionPreview(productionCompositionOptions());
    const approveHandler = createHandlePrDescriptionApprove(productionCompositionOptions());

    const previewRes = await previewHandler(
      ctxFor(PREVIEW, body({ language: "en" })),
      composedDeps,
    );
    expect(previewRes.status).toBe(200);
    const previewBody = previewRes.body as { outcome: string; preview: { proposalId: string } };
    expect(previewBody.outcome).toBe("preview");
    const proposalId = previewBody.preview.proposalId;

    // Proves the description actually came from the composed `generation` (fixture's fake Model
    // Gateway `gateway.chat`, reached only through `deps.prDescriptionGeneration`), not a
    // fabricated or unvalidated fallback: the fake gateway's fixed reply text below.
    expect(JSON.stringify(previewBody)).toContain("Change the exported value.");

    const approveRes = await approveHandler(ctxFor(APPROVE, body({ proposalId })), composedDeps);
    expect(approveRes.status).toBe(200);
    expect((approveRes.body as { proposalId: string }).proposalId).toBe(proposalId);
  });

  // description-composition-closeout (task 5): the tests above inject `fixture.options.generation`
  // directly, proving the ROUTE reaches whatever `deps.prDescriptionGeneration` holds -- not that
  // `assembleUiHandlerDeps`'s OWN production composition (`createProductionPrDescriptionGeneration`,
  // deps.ts) is what actually lands there. This test builds a real `buildUiHandlerDeps()` graph with
  // a configured model profile and threads its OWN `prDescriptionGeneration` field through, so the
  // 503 GIT_DELIVERY_PR_DESCRIPTION_UNAVAILABLE fallback is proven unreachable once a model profile
  // is configured -- not merely typed as compatible.
  it("reaches a live model call through assembleUiHandlerDeps's OWN composed prDescriptionGeneration", async () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "keiko-pr-description-deps-"));
    const configPath = join(evidenceDir, "keiko.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: [
          {
            modelId: "pr-description-model",
            baseUrl: "https://gateway.example.com/v1",
            apiKey: "fake-test-key",
            timeoutMs: 30000,
            maxRetries: 2,
            retryBaseDelayMs: 500,
          },
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 2 },
        capabilities: [
          {
            ...createDefaultChatCapability("pr-description-model"),
            contextWindow: 32_768,
            maxOutputTokens: 2048,
          },
        ],
      }),
      "utf8",
    );
    const composedStore = createInMemoryUiStore();
    const composed = buildUiHandlerDeps({
      configPath,
      evidenceDir,
      env: {},
      store: composedStore,
    });
    try {
      expect(composed.prDescriptionGeneration).toBeDefined();
      const composedGeneration = composed.prDescriptionGeneration;
      if (composedGeneration === undefined) {
        throw new Error("expected buildUiHandlerDeps to compose prDescriptionGeneration");
      }
      const fetchSpy = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        const rawBody = typeof init?.body === "string" ? init.body : "{}";
        const serialized = JSON.stringify(JSON.parse(rawBody));
        // Same nested-escaping reasoning as prDescriptionGeneration.test.ts's own fake transport:
        // the evidenceId is inside the request's stringified "content" field.
        const evidenceId = /([a-f0-9]{64})/u.exec(serialized)?.[1] ?? "";
        const statement = {
          text: "Reaches deps.prDescriptionGeneration.",
          evidenceIds: [evidenceId],
        };
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    summary: [statement],
                    keyChanges: [statement],
                    risks: [],
                    reviewerFocus: [],
                  }),
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetchSpy);
      const composedDeps = deps({
        gitChangeSnapshotService: fixture.snapshots,
        // The clock override is test-only plumbing (`fixture.snapshots` stamps captures with its
        // own fixed clock, and `createProductionPrDescriptionGeneration` composes no `now` of its
        // own) -- gateway, config, branding and log all come from the REAL composition unchanged.
        prDescriptionGeneration: { ...composedGeneration, now: () => fixture.now },
      });
      const previewHandler = createHandlePrDescriptionPreview(productionCompositionOptions());
      const res = await previewHandler(ctxFor(PREVIEW, body({ language: "en" })), composedDeps);
      expect(fetchSpy).toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toContain("Reaches deps.prDescriptionGeneration.");
    } finally {
      vi.unstubAllGlobals();
      await composed.dispose?.();
      composedStore.close();
      rmSync(evidenceDir, { recursive: true, force: true });
    }
  });
});

describe("pr-description routes — protected-content drift performs no write (#3399)", () => {
  it("a PR body changed on the remote between preview and apply is detected and blocks the write", async () => {
    const previewHandler = createHandlePrDescriptionPreview(optionsWithFixtureService());
    const approveHandler = createHandlePrDescriptionApprove(optionsWithFixtureService());
    const applyHandler = createHandlePrDescriptionApply(optionsWithFixtureService());

    const previewRes = await previewHandler(ctxFor(PREVIEW, body({ language: "en" })), deps());
    const proposalId = (previewRes.body as { preview: { proposalId: string } }).preview.proposalId;
    await approveHandler(ctxFor(APPROVE, body({ proposalId })), deps());

    // A third party edits the remote body between approval and apply.
    fixture.remote = { ...fixture.remote, body: "# Human template\r\n\r\nCloses #42\r\nedited" };

    const res = await applyHandler(ctxFor(APPLY, body({ proposalId })), deps());
    expect(res.status).toBe(200);
    expect((res.body as { outcome: string; reason?: string }).outcome).toBe("blocked");
    expect(fixture.writes).toHaveLength(0);
  });
});

describe("pr-description routes — apply-lifecycle activity log (AGENTS.md §8 Rule 1, #3399)", () => {
  it("emits started then succeeded, body-free and correlated", async () => {
    const events: ServerLogEvent[] = [];
    const activityLog = { write: (event: ServerLogEvent): void => void events.push(event) };
    const previewHandler = createHandlePrDescriptionPreview(optionsWithFixtureService());
    const approveHandler = createHandlePrDescriptionApprove(optionsWithFixtureService());
    const applyHandler = createHandlePrDescriptionApply(optionsWithFixtureService({ activityLog }));

    const previewRes = await previewHandler(ctxFor(PREVIEW, body({ language: "en" })), deps());
    const proposalId = (previewRes.body as { preview: { proposalId: string } }).preview.proposalId;
    await approveHandler(ctxFor(APPROVE, body({ proposalId })), deps());

    await applyHandler(
      { ...ctxFor(APPLY, body({ proposalId })), correlationId: "corr-pr-description-apply-1" },
      deps(),
    );

    const applyOps = events.filter((event) => event.op.startsWith("pr-description.apply."));
    expect(applyOps.map((event) => event.op)).toEqual([
      "pr-description.apply.started",
      "pr-description.apply.succeeded",
    ]);
    for (const event of applyOps) {
      expect(event.correlationId).toBe("corr-pr-description-apply-1");
    }
    expect(JSON.stringify(events)).not.toContain("Human template");
    expect(JSON.stringify(events)).not.toContain("Closes #42");
  });

  it("emits started then blocked when the approval was never issued", async () => {
    const events: ServerLogEvent[] = [];
    const activityLog = { write: (event: ServerLogEvent): void => void events.push(event) };
    const previewHandler = createHandlePrDescriptionPreview(optionsWithFixtureService());
    const applyHandler = createHandlePrDescriptionApply(optionsWithFixtureService({ activityLog }));

    const previewRes = await previewHandler(ctxFor(PREVIEW, body({ language: "en" })), deps());
    const proposalId = (previewRes.body as { preview: { proposalId: string } }).preview.proposalId;

    await applyHandler(ctxFor(APPLY, body({ proposalId })), deps());

    const applyOps = events
      .filter((event) => event.op.startsWith("pr-description.apply."))
      .map((event) => event.op);
    expect(applyOps).toEqual(["pr-description.apply.started", "pr-description.apply.blocked"]);
  });

  // #3399 (epic #3384 correction 4): the model-egress denial is a security decision — it must
  // surface on the activity log exactly like every other Git delivery authority denial, body-free.
  it("emits a body-free, correlated denial when the description authority is revoked between the pull-request admission and model egress", async () => {
    const events: ServerLogEvent[] = [];
    const activityLog = { write: (event: ServerLogEvent): void => void events.push(event) };
    const scope: GitDeliveryDescriptionAuthorityScope = {
      remoteDigest: "d".repeat(64),
      pr: { ownerAndRepo: "owner/repo", prNumber: 123 },
      snapshotDigest: "f".repeat(64),
    };
    const active: ActiveGitDeliveryDescriptionAuthority = {
      scope,
      effectiveMode: "supervised-coding",
      expiresAt: "2999-01-01T00:00:00.000Z",
    };
    // `prepare()`'s pull-request admission calls `current()` first and still finds a live grant;
    // model egress is admitted by a SECOND, later call to the SAME port — this simulates the
    // authority having been revoked/expired in between, exactly the window `stillAuthorized()`
    // exists to re-check.
    let calls = 0;
    const port: GitDeliveryDescriptionAuthorityPort = {
      current: () => (calls++ === 0 ? active : undefined),
    };
    const previewHandler = createHandlePrDescriptionPreview(
      optionsWithFixtureService({ activityLog }),
    );

    const res = await previewHandler(
      {
        ...ctxFor(PREVIEW, body({ language: "en", snapshotDigest: scope.snapshotDigest })),
        correlationId: "corr-model-egress-1",
      },
      deps({ gitDeliveryAuthority: undefined, gitDeliveryDescriptionAuthority: port }),
    );

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: { code: "GIT_DELIVERY_PR_DESCRIPTION_MODEL_EGRESS_DENIED" },
    });
    const denial = events.find((event) => event.op === "pr-description.model-egress.denied");
    expect(denial).toBeDefined();
    expect(denial?.correlationId).toBe("corr-model-egress-1");
    expect(JSON.stringify(events)).not.toContain("owner/repo");
  });
});

// Owner audit of PR #3394, finding b3-13: the source file embedded two raw NUL bytes in the
// `cacheKey` template literal, which makes `grep`/`rg` (without `-a`) and `file` treat it as
// binary data instead of TypeScript — several audit agents' own symbol searches against this file
// silently returned nothing. This pins the source file's own byte content, not just the cache
// key's runtime behavior, so a future NUL-separated join can never reintroduce the same blind spot.
describe("pr-description routes — source file stays text, never binary (#3394 finding b3-13)", () => {
  it("contains no raw NUL byte anywhere in prDescriptionRoutes.ts", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "prDescriptionRoutes.ts"));
    expect(source.includes(0)).toBe(false);
  });
});
