// R4130-058: a role model's forced tool-call proof expires after 24 hours, and a run start renews
// it at its launch. The settings write and the model-policy view judged the same stored proof
// without renewing it, so they refused a pair that a real start would have run. These pin the
// renewal in front of those two entry points and the rule of the helper itself. R4130-061 and
// R4130-062: the models asked are those that decide the policy, which for a role left to the
// recommendation is every configured chat model.

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
import { renewLapsedReviewToolProofs, REVIEW_TOOL_PROOF_RENEWAL_WAIT_MS } from "./policy.js";
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
  options: {
    readonly renews?: boolean;
    readonly fails?: readonly string[];
    /** A gate every renewal waits for before it answers. */
    readonly gate?: Promise<void>;
  } = {},
): Renewing {
  const created = createReviewPolicyFixture({ models, review });
  fixtures.push(created);
  const asked: string[] = [];
  let current = models;
  const deps: UiHandlerDeps = { ...created.deps };
  const renewToolProof = async (modelId: string): Promise<void> => {
    asked.push(modelId);
    await options.gate;
    if (options.fails?.includes(modelId) === true) throw new TypeError("probe");
    current = current.map((model) =>
      model.id === modelId ? capability(modelId, { contextWindow: model.contextWindow }) : model,
    );
    Object.assign(deps, { config: reviewGatewayConfig(current, review) });
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

describe("renewLapsedReviewToolProofs with a wait", () => {
  const MODELS = [lapsed("aged"), lapsed("other")];

  function gated(): { readonly gate: Promise<void>; readonly open: () => void } {
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { gate, open };
  }

  it("settles after the wait while the renewal goes on, and reports the elapsed wait", async () => {
    vi.useFakeTimers();
    try {
      const record = vi.spyOn(defaultServerDiagnosticSink, "record");
      const { gate, open } = gated();
      const { deps, asked } = renewing(MODELS, { enabled: true }, { gate });
      let settled = false;
      const waiting = renewLapsedReviewToolProofs(
        deps,
        ["aged", "other"],
        "corr-wait",
        30_000,
      ).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(asked).toEqual(["aged"]);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "review.run.model-readiness",
          correlationId: "corr-wait",
        }),
      );
      // The renewal was not dropped: once the gateway answers, the next model is asked.
      open();
      await vi.advanceTimersByTimeAsync(0);
      expect(asked).toEqual(["aged", "other"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles with the renewal when it is faster than the wait, and reports nothing", async () => {
    const record = vi.spyOn(defaultServerDiagnosticSink, "record");
    const { deps, asked } = renewing(MODELS, { enabled: true });
    await renewLapsedReviewToolProofs(deps, ["aged"], "corr-wait", 30_000);
    expect(asked).toEqual(["aged"]);
    expect(record).not.toHaveBeenCalled();
  });

  it("shares one running renewal of a model between concurrent askers", async () => {
    const { gate, open } = gated();
    const { deps, asked } = renewing(MODELS, { enabled: true }, { gate });
    const first = renewLapsedReviewToolProofs(deps, ["aged"], "corr-one");
    const second = renewLapsedReviewToolProofs(deps, ["aged"], "corr-two");
    await Promise.resolve();
    await Promise.resolve();
    open();
    await Promise.all([first, second]);
    expect(asked).toEqual(["aged"]);
  });

  it("waits no longer than a client keeps a request open", () => {
    // Node drops a request after 300 seconds by default; the handler would go on without a client.
    expect(REVIEW_TOOL_PROOF_RENEWAL_WAIT_MS).toBeLessThanOrEqual(60_000);
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

  // R4130-062: the write preflights both roles of the policy it would produce.
  it("renews the other role's model, which an operator preset names, on a write of one role", async () => {
    const { deps, asked } = renewing([capability("large"), lapsed("medium"), capability("small")], {
      enabled: true,
      counterCheckerModelId: "medium",
    });
    const result = await handleReviewSettingsPut(
      ctx(SETTINGS_PATH, { reviewerModelId: "large" }),
      deps,
    );
    expect(asked).toEqual(["medium"]);
    expect(result.status).toBe(200);
  });

  it("renews the other role's model, which earlier settings name, on a write of one role", async () => {
    const { deps, asked } = renewing([capability("large"), capability("medium")], {
      enabled: true,
    });
    const saved = await handleReviewSettingsPut(
      ctx(SETTINGS_PATH, { counterCheckerModelId: "medium" }),
      deps,
    );
    expect(saved.status).toBe(200);
    Object.assign(deps, {
      config: reviewGatewayConfig([capability("large"), lapsed("medium")], { enabled: true }),
    });
    const result = await handleReviewSettingsPut(
      ctx(SETTINGS_PATH, { reviewerModelId: "large" }),
      deps,
    );
    expect(asked).toEqual(["medium"]);
    expect(result.status).toBe(200);
  });

  it("renews the candidates of a role the write leaves to the recommendation", async () => {
    const { deps, asked } = renewing([capability("large"), lapsed("medium")], { enabled: true });
    const result = await handleReviewSettingsPut(
      ctx(SETTINGS_PATH, { reviewerModelId: "large" }),
      deps,
    );
    expect(asked).toEqual(["medium"]);
    expect(result.status).toBe(200);
  });

  it("asks nothing for a write that names no role model or is invalid", async () => {
    const { deps, asked } = renewing(MODELS, { enabled: true });
    await handleReviewSettingsPut(ctx(SETTINGS_PATH, { rulesFilePath: "docs/review.md" }), deps);
    await handleReviewSettingsPut(ctx(SETTINGS_PATH, { reviewerModelId: 7 }), deps);
    expect(asked).toEqual([]);
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

  // R4130-061: no saved settings and no operator preset is the most common setup. Both roles then
  // come from the recommendation, which names no model while every candidate's proof has lapsed.
  it("asks for the candidates' proofs when the recommendation names no model", async () => {
    const { deps, asked } = renewing([lapsed("large"), lapsed("medium")], { enabled: true });
    const first = handleReviewModelPolicy(ctx(POLICY_PATH), deps);
    expect(first.body).toMatchObject({
      reviewer: { modelId: null, source: "none" },
      counterChecker: { modelId: null, source: "none" },
    });
    await vi.waitFor(() => {
      expect(asked).toEqual(["large", "medium"]);
    });
    const second = handleReviewModelPolicy(ctx(POLICY_PATH), deps);
    expect(second.body).toMatchObject({
      reviewer: { source: "recommendation", state: { status: "eligible" } },
      counterChecker: { source: "recommendation", state: { status: "eligible" } },
    });
  });

  it("asks for a larger candidate whose proof lapsed although the recommendation names a model", async () => {
    const { deps, asked } = renewing([lapsed("large"), capability("medium")], { enabled: true });
    handleReviewModelPolicy(ctx(POLICY_PATH), deps);
    await vi.waitFor(() => {
      expect(asked).toEqual(["large"]);
    });
  });

  it("asks only for the chosen models when both roles are chosen", async () => {
    const { deps, asked } = renewing([lapsed("large"), capability("medium"), lapsed("small")], {
      enabled: true,
      reviewerModelId: "large",
      counterCheckerModelId: "medium",
    });
    handleReviewModelPolicy(ctx(POLICY_PATH), deps);
    await vi.waitFor(() => {
      expect(asked).toEqual(["large"]);
    });
    await Promise.resolve();
    expect(asked).toEqual(["large"]);
  });

  it("asks once while repeated reads find the same renewal running", async () => {
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { deps, asked } = renewing([lapsed("large")], { enabled: true }, { gate });
    handleReviewModelPolicy(ctx(POLICY_PATH), deps);
    handleReviewModelPolicy(ctx(POLICY_PATH), deps);
    handleReviewModelPolicy(ctx(POLICY_PATH), deps);
    await Promise.resolve();
    await Promise.resolve();
    open();
    await vi.waitFor(() => {
      expect(asked).toEqual(["large"]);
    });
  });
});
