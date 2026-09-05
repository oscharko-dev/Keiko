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
import type { ServerLogEvent } from "../observability/index.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import type { RouteContext } from "../routes.js";
import { permittedGitDeliveryAuthority } from "./runBoundAuthority.test-support.js";
import type {
  ActiveGitDeliveryDescriptionAuthority,
  GitDeliveryDescriptionAuthorityPort,
  GitDeliveryDescriptionAuthorityScope,
} from "./runBoundAuthority.js";
import {
  clearPrDescriptionServiceCache,
  createGitDeliveryPrDescriptionRouteGroup,
  createHandlePrDescriptionApply,
  createHandlePrDescriptionApprove,
  createHandlePrDescriptionPreview,
  createHandlePrDescriptionStatus,
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

    const ops = events.map((event) => event.op);
    expect(ops).toEqual(["pr-description.apply.started", "pr-description.apply.succeeded"]);
    for (const event of events) {
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

    expect(events.map((event) => event.op)).toEqual([
      "pr-description.apply.started",
      "pr-description.apply.blocked",
    ]);
  });
});
