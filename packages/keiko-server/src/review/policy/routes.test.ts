// The review model-policy, settings and `enabled` guard routes (Issue #4137), through their route
// handlers and the guarded route group: AC2 (the locked policy stays readable, refusals at run start
// and at startup), AC6 (every outcome on the Activity Log) and AC7 (the rules path persists per
// repository and child 5's settings port reads it).

import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import {
  REVIEW_MODEL_POLICY_ROUTE,
  REVIEW_ROUTE_PREFIX,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import { captureActivityLog } from "../../activityLogCapture.test-support.js";
import { API_ROUTES, type RouteContext, type RouteResult } from "../../routes.js";
import { deriveRepositoryId } from "../../task-workspace/naming.js";
import { handleReviewRunStart } from "../routes.js";
import {
  capability,
  createReviewRunHarness,
  startBody,
  type ReviewRunHarness,
} from "../service/reviewRunHarness.test-support.js";
import {
  createReviewPolicyFixture,
  reviewGatewayConfig,
  type ReviewPolicyFixture,
} from "./policyFixtures.test-support.js";
import {
  reportReviewOperatorConfig,
  reviewRulesSettingsPort,
  reviewRunAdmission,
} from "./policy.js";
import {
  handleReviewModelPolicy,
  handleReviewSettingsGet,
  handleReviewSettingsPut,
} from "./routes.js";

const REPOSITORY_ROOT = "/fixture/repository";
const REPOSITORY = deriveRepositoryId(REPOSITORY_ROOT);
const MODELS: readonly ModelCapability[] = [
  capability("large", { contextWindow: 262_144 }),
  capability("medium", { contextWindow: 131_072 }),
];

const fixtures: ReviewPolicyFixture[] = [];
afterEach(() => {
  for (const entry of fixtures.splice(0)) entry.cleanup();
});

type PolicyFixture = ReviewPolicyFixture;

function fixture(review: unknown, withSettings = true): PolicyFixture {
  const created = createReviewPolicyFixture({ models: MODELS, review, withSettings });
  fixtures.push(created);
  return created;
}

function ctx(path: string, body?: unknown): RouteContext {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { headers: { "content-type": "application/json" } });
  return {
    correlationId: "corr-review-policy",
    req: req as unknown as IncomingMessage,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL(`http://localhost${path}`),
  };
}

const POLICY_PATH = `/api/git-review/model-policy?repositoryId=${REPOSITORY}`;
const SETTINGS_PATH = `/api/git-review/settings?repositoryId=${REPOSITORY}`;

function put(f: PolicyFixture, body: unknown): Promise<RouteResult> {
  return handleReviewSettingsPut(ctx(SETTINGS_PATH, body), f.deps);
}

describe("GET /api/git-review/model-policy", () => {
  it("reports a switched-off area without resolving anything", () => {
    const f = fixture(undefined);
    const result = handleReviewModelPolicy(ctx(POLICY_PATH), f.deps);
    expect(result).toEqual({ status: 200, body: { schemaVersion: 1, enabled: false } });
    expect(f.log.withOp("review.model-policy.resolved")).toMatchObject([
      { correlationId: "corr-review-policy", extra: { enabled: false } },
    ]);
  });

  it("resolves both roles with their sources, options and an unmeasured pair", () => {
    const f = fixture({ enabled: true });
    const result = handleReviewModelPolicy(ctx(POLICY_PATH), f.deps);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      enabled: true,
      repositoryId: REPOSITORY,
      locked: false,
      reviewer: { modelId: "large", source: "recommendation", state: { status: "eligible" } },
      counterChecker: { modelId: "medium", source: "recommendation" },
      singleModel: false,
      pair: { status: "unmeasured" },
    });
    const [line] = f.log.withOp("review.model-policy.resolved");
    expect(line?.extra).toMatchObject({
      enabled: true,
      reviewerSource: "recommendation",
      reviewerState: "eligible",
      pairStatus: "unmeasured",
      optionCount: 2,
      eligibleReviewerCount: 2,
    });
    expect(JSON.stringify(line)).not.toContain("large");
  });

  it("refuses an invalid repository id", () => {
    const f = fixture({ enabled: true });
    const result = handleReviewModelPolicy(
      ctx("/api/git-review/model-policy?repositoryId=../x"),
      f.deps,
    );
    expect(result.status).toBe(400);
  });
});

describe("GET/PUT /api/git-review/settings (AC7)", () => {
  it("persists the rules path per repository and child 5's settings port reads it", async () => {
    const f = fixture({ enabled: true });
    const saved = await put(f, {
      rulesFilePath: "docs/review-rules.md",
      reviewerModelId: "medium",
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      settings: { revision: 1, rulesFilePath: "docs/review-rules.md", reviewerModelId: "medium" },
      effectiveRulesFilePath: "docs/review-rules.md",
      rulesFilePathSource: "user",
    });
    const read = handleReviewSettingsGet(ctx(SETTINGS_PATH), f.deps);
    expect(read.body).toMatchObject({ settings: { revision: 1 } });
    const port = reviewRulesSettingsPort(
      () => f.deps,
      () => f.deps.reviewPolicy?.settings,
    );
    expect(port.rulesPath(REPOSITORY_ROOT)).toBe("docs/review-rules.md");
    expect(port.rulesPath("/another/repository")).toBe(".keiko/review-rules.md");
    expect(f.log.withOp("review.model-policy.updated")).toMatchObject([
      {
        extra: { revision: 1, modelsChanged: true, rulesPathChanged: true, reviewerSource: "user" },
      },
    ]);
    const conflict = await put(f, { expectedRevision: 0, rulesFilePath: "x.md" });
    expect(conflict.status).toBe(409);
  });

  it("refuses a path outside the repository or with .. segments", async () => {
    const f = fixture({ enabled: true });
    for (const rulesFilePath of ["../rules.md", "docs/../../rules.md", "/etc/rules.md"]) {
      const result = await put(f, { rulesFilePath });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({
        error: { code: "REVIEW_SETTINGS_INVALID" },
        reason: "rules-path-invalid",
      });
    }
    expect(f.log.withOp("review.model-policy.refused")).toHaveLength(3);
    expect(handleReviewSettingsGet(ctx(SETTINGS_PATH), f.deps).body).toMatchObject({
      settings: { revision: 0 },
    });
  });

  it("lets the operator preset win over the user value while locked", async () => {
    const preset = { [REPOSITORY]: { rulesFilePath: "ops/rules.md" } };
    const open = fixture({ enabled: true, repositories: preset });
    await put(open, { rulesFilePath: "user/rules.md" });
    const locked: PolicyFixture = {
      ...open,
      deps: {
        ...open.deps,
        config: reviewGatewayConfig(MODELS, {
          enabled: true,
          lockModelPolicy: true,
          repositories: preset,
        }),
      },
    };
    expect(handleReviewSettingsGet(ctx(SETTINGS_PATH), locked.deps).body).toMatchObject({
      settings: { rulesFilePath: "user/rules.md" },
      effectiveRulesFilePath: "ops/rules.md",
      rulesFilePathSource: "operator",
      locked: true,
    });
    const port = reviewRulesSettingsPort(
      () => locked.deps,
      () => locked.deps.reviewPolicy?.settings,
    );
    expect(port.rulesPath(REPOSITORY_ROOT)).toBe("ops/rules.md");
  });

  it("refuses model changes while locked and keeps the policy readable (AC2)", async () => {
    const f = fixture({ enabled: true, lockModelPolicy: true, reviewerModelId: "medium" });
    const refused = await put(f, { reviewerModelId: "large" });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      error: { code: "REVIEW_POLICY_LOCKED" },
      reason: "policy-locked",
    });
    expect(f.log.withOp("review.model-policy.refused")).toMatchObject([
      {
        extra: { reason: "policy-locked", role: "none", stage: "settings-update" },
        errorKind: "authority-denied",
      },
    ]);
    expect(handleReviewModelPolicy(ctx(POLICY_PATH), f.deps).body).toMatchObject({
      locked: true,
      reviewer: { modelId: "medium", source: "operator" },
    });
  });

  it("answers 503 without a settings store and 400 without a repository id", async () => {
    const f = fixture({ enabled: true }, false);
    expect(handleReviewSettingsGet(ctx(SETTINGS_PATH), f.deps).status).toBe(503);
    expect((await put(f, {})).status).toBe(503);
    expect(handleReviewSettingsGet(ctx("/api/git-review/settings"), fixture({}).deps).status).toBe(
      400,
    );
  });
});

describe("the enabled guard", () => {
  it("answers every Pull requests route except model-policy with 404 REVIEW_DISABLED", async () => {
    const f = fixture(undefined);
    const guarded = API_ROUTES.filter((route) => route.pattern.startsWith(REVIEW_ROUTE_PREFIX));
    // Pull request reads (2), runs (7) and this child's model policy, settings and qualification (7).
    expect(guarded).toHaveLength(16);
    for (const route of guarded) {
      const result = (await route.handler(ctx(route.pattern), f.deps)) as RouteResult;
      if (route.pattern === REVIEW_MODEL_POLICY_ROUTE) {
        expect(result.body).toEqual({ schemaVersion: 1, enabled: false });
        continue;
      }
      expect(result.status).toBe(404);
      expect(result.body).toMatchObject({ error: { code: "REVIEW_DISABLED" } });
    }
  });

  it("lets the routes through once the operator switch is on", async () => {
    const f = fixture({ enabled: true });
    for (const route of API_ROUTES.filter((entry) =>
      entry.pattern.startsWith(REVIEW_ROUTE_PREFIX),
    )) {
      const result = (await route.handler(ctx(route.pattern), f.deps)) as RouteResult;
      expect(result.body).not.toMatchObject({ error: { code: "REVIEW_DISABLED" } });
    }
  });
});

describe("the policy at run start and at startup (AC1, AC2)", () => {
  let harness: ReviewRunHarness | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it("refuses a dry run and settles a run outside the allowlist with the closed reason", async () => {
    const policy = fixture({ enabled: true, allowedReviewModelIds: ["large"] });
    const log = captureActivityLog();
    harness = createReviewRunHarness({
      capabilities: { large: MODELS[0], medium: MODELS[1] },
      admit: reviewRunAdmission(() => policy.deps, log.sink),
    });
    const h = harness;
    const path = `/api/git-review/runs?root=${encodeURIComponent(h.repo)}`;
    const start = (body: Record<string, unknown>): Promise<RouteResult> =>
      handleReviewRunStart(h.ctx(path, { body }), h.deps());
    const outside = { reviewerModelId: "large", counterCheckerModelId: "medium" };
    const dry = await start(startBody({ ...outside, dryRun: true }));
    expect(dry.status).toBe(422);
    const started = await start(startBody({ ...outside, clientRequestId: "client-request-2" }));
    expect(started.status).toBe(202);
    const runId = (started.body as { readonly run: { readonly runId: string } }).run.runId;
    await h.service.whenSettled(runId);
    expect((await h.service.get(runId))?.settlement).toEqual({
      kind: "skipped",
      reason: "policy-invalid",
    });
    expect(h.runtimeRequests).toEqual([]);
    const refusals = log.withOp("review.model-policy.refused");
    expect(refusals).toHaveLength(2);
    expect(refusals[0]).toMatchObject({
      correlationId: "corr-review-run",
      extra: { reason: "outside-allowlist", role: "counter-checker", stage: "run-start" },
    });
    const inside = startBody({
      reviewerModelId: "large",
      counterCheckerModelId: "large",
      dryRun: true,
    });
    expect((await start(inside)).status).toBe(200);
  });

  it("reports every invalid operator value at startup by key and source", () => {
    const f = fixture({ enabled: true, reviewerModelId: "", lockModelPolicy: "yes" });
    reportReviewOperatorConfig(f.deps, f.log.sink, "corr-startup");
    expect(f.log.withOp("review.model-policy.refused")).toMatchObject([
      {
        correlationId: "corr-startup",
        extra: {
          reason: "invalid-operator-value",
          stage: "startup",
          operatorKey: "lockModelPolicy",
        },
      },
      { extra: { operatorKey: "reviewerModelId", operatorKeySource: "file" } },
    ]);
  });
});
