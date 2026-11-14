// R4130-058: a role model's forced tool-call proof expires after 24 hours, and a run start renews
// it at its launch. The settings write and the model-policy view judged the same stored proof
// without renewing it, so they refused a pair that a real start would have run. These pin the
// renewal in front of those two entry points and the rule of the helper itself.

import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { TOOL_CALLING_VERIFICATION_MAX_AGE_MS } from "@oscharko-dev/keiko-contracts/runtime/gateway";

import { defaultServerDiagnosticSink } from "../../diagnostics-log.js";
import type { UiHandlerDeps } from "../../index.js";
import type { RouteContext } from "../../routes.js";
import { deriveRepositoryId } from "../../task-workspace/naming.js";
import { capability } from "../service/reviewRunHarness.test-support.js";
import { renewLapsedReviewToolProofs } from "./policy.js";
import {
  createReviewPolicyFixture,
  reviewGatewayConfig,
  type ReviewPolicyFixture,
} from "./policyFixtures.test-support.js";
import { handleReviewModelPolicy, handleReviewSettingsPut } from "./routes.js";

const REPOSITORY = deriveRepositoryId("/fixture/repository");
const POLICY_PATH = `/api/git-review/model-policy?repositoryId=${REPOSITORY}`;
const SETTINGS_PATH = `/api/git-review/settings?repositoryId=${REPOSITORY}`;

/** A capability whose proof was verified and is older than its lifetime. */
function lapsed(id: string): ModelCapability {
  const fresh = capability(id, { contextWindow: 262_144 });
  const verification = fresh.toolCallingVerification;
  if (verification === undefined) throw new TypeError("expected a verified fixture capability");
  return {
    ...fresh,
    toolCallingVerification: {
      ...verification,
      checkedAt: new Date(Date.now() - TOOL_CALLING_VERIFICATION_MAX_AGE_MS - 60_000).toISOString(),
    },
  };
}

function neverProven(id: string): ModelCapability {
  const { toolCallingVerification: _dropped, ...rest } = capability(id, { contextWindow: 262_144 });
  return { ...rest, toolCalling: false };
}

const fixtures: ReviewPolicyFixture[] = [];
afterEach(() => {
  for (const entry of fixtures.splice(0)) entry.cleanup();
  vi.restoreAllMocks();
});

interface Renewing {
  readonly deps: UiHandlerDeps;
  /** The models the entry point asked to renew, in order. */
  readonly asked: string[];
}

/**
 * Deps over `models` whose renewal answers like the gateway: the asked model's proof is current
 * afterwards. `renews: false` composes the deps without a renewal, as before the fix.
 */
function renewing(
  models: readonly ModelCapability[],
  review: unknown,
  options: { readonly renews?: boolean; readonly fails?: readonly string[] } = {},
): Renewing {
  const created = createReviewPolicyFixture({ models, review });
  fixtures.push(created);
  const asked: string[] = [];
  let current = models;
  const deps: UiHandlerDeps = { ...created.deps };
  const renewToolProof = (modelId: string): Promise<void> => {
    asked.push(modelId);
    if (options.fails?.includes(modelId) === true) return Promise.reject(new TypeError("probe"));
    current = current.map((model) =>
      model.id === modelId ? capability(modelId, { contextWindow: model.contextWindow }) : model,
    );
    Object.assign(deps, { config: reviewGatewayConfig(current, review) });
    return Promise.resolve();
  };
  Object.assign(deps, {
    reviewPolicy: {
      ...created.deps.reviewPolicy,
      ...(options.renews === false ? {} : { renewToolProof }),
    },
  });
  return { deps, asked };
}

function ctx(path: string, body?: unknown): RouteContext {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { headers: { "content-type": "application/json" } });
  return {
    correlationId: "corr-proof-renewal",
    req: req as unknown as IncomingMessage,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL(`http://localhost${path}`),
  };
}

describe("renewLapsedReviewToolProofs", () => {
  const MODELS = [lapsed("aged"), capability("current"), neverProven("unproven"), lapsed("other")];

  it("asks once for each named model whose proof lapsed, and for no other", async () => {
    const { deps, asked } = renewing(MODELS, { enabled: true });
    await renewLapsedReviewToolProofs(
      deps,
      ["aged", "current", "unproven", "aged", null, undefined, 7, "missing"],
      "corr-proof-renewal",
    );
    expect(asked).toEqual(["aged"]);
  });

  // R4130-003: a model the policy refuses receives no traffic.
  it("asks nothing for a model outside the allowlist", async () => {
    const { deps, asked } = renewing(MODELS, { enabled: true, allowedReviewModelIds: ["other"] });
    await renewLapsedReviewToolProofs(deps, ["aged", "other"], "corr-proof-renewal");
    expect(asked).toEqual(["other"]);
  });

  it("asks nothing while the review area is switched off", async () => {
    const { deps, asked } = renewing(MODELS, undefined);
    await renewLapsedReviewToolProofs(deps, ["aged"], "corr-proof-renewal");
    expect(asked).toEqual([]);
  });

  it("reports a renewal that fails, goes on to the next model and never rejects", async () => {
    const record = vi.spyOn(defaultServerDiagnosticSink, "record");
    const { deps, asked } = renewing(MODELS, { enabled: true }, { fails: ["aged"] });
    await expect(
      renewLapsedReviewToolProofs(deps, ["aged", "other"], "corr-proof-renewal"),
    ).resolves.toBeUndefined();
    expect(asked).toEqual(["aged", "other"]);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "review.run.model-readiness",
        correlationId: "corr-proof-renewal",
      }),
    );
  });
});

describe("PUT /api/git-review/settings with a lapsed tool-call proof", () => {
  const MODELS = [lapsed("large"), capability("medium")];
  const BODY = { reviewerModelId: "large", counterCheckerModelId: "medium" };

  it("renews the named model's proof and then saves it", async () => {
    const { deps, asked } = renewing(MODELS, { enabled: true });
    const result = await handleReviewSettingsPut(ctx(SETTINGS_PATH, BODY), deps);
    expect(asked).toEqual(["large"]);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ settings: { reviewerModelId: "large" } });
  });

  it("refused the same write while nothing renewed the proof", async () => {
    const { deps } = renewing(MODELS, { enabled: true }, { renews: false });
    const result = await handleReviewSettingsPut(ctx(SETTINGS_PATH, BODY), deps);
    expect(result.status).not.toBe(200);
    expect(result.body).toMatchObject({ reason: "tool-verification-stale", role: "reviewer" });
  });

  it("asks nothing under a locked policy, which refuses every model change", async () => {
    const { deps, asked } = renewing(MODELS, { enabled: true, lockModelPolicy: true });
    const result = await handleReviewSettingsPut(ctx(SETTINGS_PATH, BODY), deps);
    expect(asked).toEqual([]);
    expect(result.body).toMatchObject({ reason: "policy-locked" });
  });
});

describe("GET /api/git-review/model-policy with a lapsed tool-call proof", () => {
  it("asks for the role models' proofs without waiting, so a later read shows them eligible", async () => {
    const { deps, asked } = renewing([capability("medium"), lapsed("large")], {
      enabled: true,
      reviewerModelId: "large",
      counterCheckerModelId: "medium",
    });
    const first = handleReviewModelPolicy(ctx(POLICY_PATH), deps);
    expect(first.body).toMatchObject({
      reviewer: {
        modelId: "large",
        state: { status: "refused", reason: "tool-verification-stale" },
      },
    });
    await vi.waitFor(() => {
      expect(asked).toEqual(["large"]);
    });
    const second = handleReviewModelPolicy(ctx(POLICY_PATH), deps);
    expect(second.body).toMatchObject({
      reviewer: { modelId: "large", state: { status: "eligible" } },
    });
  });
});
