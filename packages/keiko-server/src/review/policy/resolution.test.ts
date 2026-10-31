// Review model-policy resolution, admission and the settings write decision (Issue #4137): AC1
// (eligibility refusals at save and again at run start), AC2 (allowlist, lock, invalid operator
// values fail closed) and AC3 (recommendation of two different models, single-model fallback).

import { describe, expect, it } from "vitest";

import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import type {
  ReviewOperatorConfig,
  ReviewSettingsDocument,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { parseReviewOperatorConfig } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-validation";

import { capability } from "../service/reviewRunHarness.test-support.js";
import { effectiveRulesFilePath } from "./policy.js";
import {
  admitReviewRoleModels,
  checkReviewRoleModels,
  resolveReviewPolicy,
  reviewModelOptions,
  type ReviewPolicyContext,
} from "./resolution.js";
import { updateReviewSettings } from "./settingsUpdate.js";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const STALE = new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString();
const FRESH = new Date(NOW - 60_000).toISOString();
const REPOSITORY = "repo_0123456789abcdef";

function verified(id: string, overrides: Partial<ModelCapability> = {}): ModelCapability {
  return capability(id, {
    toolCallingVerification: {
      status: "verified",
      checkedAt: FRESH,
      probe: "gateway-tool-calling-v1",
      configurationFingerprint: "fixture",
    },
    ...overrides,
  });
}

/** One model per AC1 ineligibility class, beside two eligible ones of different windows. */
const MODELS: readonly ModelCapability[] = [
  verified("small-window", { contextWindow: 8_192 }),
  verified("large", { contextWindow: 262_144 }),
  verified("medium", { contextWindow: 131_072 }),
  verified("no-tools", { toolCalling: false, toolCallingVerification: undefined }),
  verified("stale-tools", {
    toolCallingVerification: {
      status: "verified",
      checkedAt: STALE,
      probe: "gateway-tool-calling-v1",
      configurationFingerprint: "fixture",
    },
  }),
  verified("assumed-window", { contextWindowAssumed: true }),
  verified("not-ready", { conversationReady: false }),
];

function context(
  operator: ReviewOperatorConfig = parseReviewOperatorConfig({ enabled: true }),
  models: readonly ModelCapability[] = MODELS,
): ReviewPolicyContext {
  return {
    operator,
    capabilities: models,
    capability: (id) => models.find((model) => model.id === id),
    nowMs: NOW,
  };
}

function settings(overrides: Partial<ReviewSettingsDocument> = {}): ReviewSettingsDocument {
  return { schemaVersion: 1, repositoryId: REPOSITORY, revision: 0, ...overrides };
}

interface WriteResult {
  readonly outcome: Awaited<ReturnType<typeof updateReviewSettings>>;
  readonly saved: readonly ReviewSettingsDocument[];
}

async function write(
  ctx: ReviewPolicyContext,
  body: unknown,
  current = settings(),
): Promise<WriteResult> {
  const saved: ReviewSettingsDocument[] = [];
  const outcome = await updateReviewSettings({
    ctx,
    current,
    body,
    nowIso: new Date(NOW).toISOString(),
    save: (document) => saved.push(document),
  });
  return { outcome, saved };
}

describe("AC1: eligibility refusals", () => {
  it.each([
    ["no-tools", "not-tool-capable"],
    ["stale-tools", "tool-verification-stale"],
    ["assumed-window", "window-unknown"],
    ["small-window", "window-too-small"],
    ["missing", "not-configured"],
  ])("refuses to save %s for either role with %s", async (modelId, reason) => {
    for (const field of ["reviewerModelId", "counterCheckerModelId"] as const) {
      const { outcome, saved } = await write(context(), { [field]: modelId });
      expect(outcome).toMatchObject({ kind: "refused", reason });
      expect(saved).toEqual([]);
    }
  });

  it("runs the same rule at run start through the policy check", () => {
    expect(
      checkReviewRoleModels(context(), {
        reviewerModelId: "stale-tools",
        counterCheckerModelId: "medium",
      }),
    ).toEqual({ ok: false, reason: "tool-verification-stale", role: "reviewer" });
  });

  it("saves a temporarily unavailable model and reports it as such", async () => {
    const { outcome } = await write(context(), { counterCheckerModelId: "not-ready" });
    expect(outcome).toMatchObject({
      kind: "saved",
      policy: {
        counterChecker: { modelId: "not-ready", state: { status: "temporarily-unavailable" } },
      },
    });
    expect(
      checkReviewRoleModels(context(), {
        reviewerModelId: "large",
        counterCheckerModelId: "not-ready",
      }),
    ).toEqual({ ok: true, temporarilyUnavailable: true });
  });
});

describe("AC2: allowlist, lock and invalid operator values", () => {
  const allowlisted = parseReviewOperatorConfig({
    enabled: true,
    allowedReviewModelIds: ["large", "small-window"],
  });

  it("refuses a selection outside the allowlist at save and at run start", async () => {
    const { outcome } = await write(context(allowlisted), { counterCheckerModelId: "medium" });
    expect(outcome).toEqual({
      kind: "refused",
      reason: "outside-allowlist",
      role: "counter-checker",
    });
    expect(
      admitReviewRoleModels(context(allowlisted), {
        reviewerModelId: "large",
        counterCheckerModelId: "medium",
      }),
    ).toEqual({ ok: false, reason: "outside-allowlist", role: "counter-checker" });
  });

  it("never recommends a model outside the allowlist", () => {
    const policy = resolveReviewPolicy(context(allowlisted), undefined);
    expect(policy.reviewer).toMatchObject({ modelId: "large", source: "recommendation" });
    // `small-window` is allowed but too small for every role: the only eligible model is reused.
    expect(policy.counterChecker).toMatchObject({ modelId: "large", source: "recommendation" });
    expect(policy.singleModel).toBe(true);
    expect(policy.allowlistActive).toBe(true);
  });

  it("refuses every user change while locked and keeps the resolved policy readable", async () => {
    const locked = parseReviewOperatorConfig({
      enabled: true,
      lockModelPolicy: true,
      reviewerModelId: "medium",
    });
    const { outcome, saved } = await write(context(locked), { reviewerModelId: "large" });
    expect(outcome).toEqual({ kind: "refused", reason: "policy-locked", role: "none" });
    expect(saved).toEqual([]);
    const stored = settings({ reviewerModelId: "large", counterCheckerModelId: "large" });
    const policy = resolveReviewPolicy(context(locked), stored);
    expect(policy.locked).toBe(true);
    expect(policy.reviewer).toMatchObject({ modelId: "medium", source: "operator" });
    expect(policy.counterChecker).toMatchObject({ modelId: "large", source: "recommendation" });
    expect(
      admitReviewRoleModels(context(locked), {
        reviewerModelId: "large",
        counterCheckerModelId: "large",
      }),
    ).toEqual({ ok: false, reason: "policy-locked", role: "reviewer" });
    expect(
      admitReviewRoleModels(context(locked), {
        reviewerModelId: "medium",
        counterCheckerModelId: "large",
      }),
    ).toEqual({ ok: true, temporarilyUnavailable: false });
  });

  it("fails closed on an invalid operator value without substituting another model", async () => {
    const invalid = parseReviewOperatorConfig({
      enabled: true,
      reviewerModelId: "medium",
      counterCheckerModelId: "",
    });
    const policy = resolveReviewPolicy(context(invalid), settings({ reviewerModelId: "large" }));
    expect(policy.reviewer).toEqual({
      modelId: "medium",
      source: "operator",
      state: { status: "refused", reason: "invalid-operator-value" },
    });
    expect(policy.counterChecker).toEqual({
      modelId: null,
      source: "none",
      state: { status: "refused", reason: "invalid-operator-value" },
    });
    expect(policy.invalidOperatorKeys).toEqual(["counterCheckerModelId"]);
    expect(
      admitReviewRoleModels(context(invalid), {
        reviewerModelId: "large",
        counterCheckerModelId: "medium",
      }),
    ).toEqual({ ok: false, reason: "invalid-operator-value", role: "none" });
    const { outcome } = await write(context(invalid), { rulesFilePath: "docs/rules.md" });
    expect(outcome).toMatchObject({ kind: "refused", reason: "invalid-operator-value" });
  });
});

describe("AC3: recommendation", () => {
  it("prefers two different eligible models, the largest verified window first", () => {
    const policy = resolveReviewPolicy(context(), undefined);
    expect(policy.reviewer).toEqual({
      modelId: "large",
      source: "recommendation",
      state: { status: "eligible" },
    });
    expect(policy.counterChecker).toMatchObject({ modelId: "medium", source: "recommendation" });
    expect(policy.singleModel).toBe(false);
  });

  it("falls back to one model with an explicit single-model state", () => {
    const policy = resolveReviewPolicy(context(undefined, [verified("only")]), undefined);
    expect(policy.reviewer.modelId).toBe("only");
    expect(policy.counterChecker.modelId).toBe("only");
    expect(policy.singleModel).toBe(true);
  });

  it("recommends a Counter-checker different from the user's Reviewer", () => {
    const policy = resolveReviewPolicy(context(), settings({ reviewerModelId: "medium" }));
    expect(policy.reviewer).toMatchObject({ modelId: "medium", source: "user" });
    expect(policy.counterChecker).toMatchObject({ modelId: "large", source: "recommendation" });
  });

  it("reports nothing configured when no model qualifies", () => {
    const policy = resolveReviewPolicy(context(undefined, []), undefined);
    expect(policy.reviewer).toEqual({
      modelId: null,
      source: "none",
      state: { status: "refused", reason: "not-configured" },
    });
  });

  it("summarizes every chat model as an option", () => {
    const options = reviewModelOptions(context());
    expect(options.map((option) => option.modelId)).toEqual(MODELS.map((model) => model.id));
    expect(options.find((option) => option.modelId === "stale-tools")).toMatchObject({
      toolCalling: "stale",
      reviewer: { status: "ineligible", reason: "tool-verification-stale" },
    });
    expect(options.find((option) => option.modelId === "assumed-window")).toMatchObject({
      contextWindowTokens: null,
      contextWindowAssumed: true,
    });
    expect(options.find((option) => option.modelId === "no-tools")?.toolCalling).toBe(
      "unsupported",
    );
  });
});

describe("settings writes", () => {
  it("saves a change with the next revision and keeps an unchanged write unsaved", async () => {
    const { outcome, saved } = await write(context(), {
      expectedRevision: 0,
      reviewerModelId: "medium",
      rulesFilePath: "docs/rules.md",
    });
    expect(outcome).toMatchObject({ kind: "saved", modelsChanged: true, rulesPathChanged: true });
    expect(saved).toEqual([
      {
        schemaVersion: 1,
        repositoryId: REPOSITORY,
        revision: 1,
        reviewerModelId: "medium",
        rulesFilePath: "docs/rules.md",
        updatedAt: new Date(NOW).toISOString(),
      },
    ]);
    const current = saved[0] ?? settings();
    const again = await write(context(), { reviewerModelId: "medium" }, current);
    expect(again.saved).toEqual([]);
    const cleared = await write(context(), { reviewerModelId: null }, current);
    expect(cleared.saved[0]).not.toHaveProperty("reviewerModelId");
    expect(cleared.saved[0]?.revision).toBe(2);
  });

  it("refuses a stale revision, a bad body and a path with .. segments", async () => {
    const current = settings({ revision: 4 });
    expect((await write(context(), { expectedRevision: 3 }, current)).outcome).toMatchObject({
      reason: "revision-conflict",
    });
    expect((await write(context(), { unknown: 1 })).outcome).toMatchObject({
      reason: "request-invalid",
    });
    expect((await write(context(), { rulesFilePath: "docs/../x.md" })).outcome).toMatchObject({
      reason: "rules-path-invalid",
    });
  });
});

describe("AC7: the effective rules path", () => {
  const presets = parseReviewOperatorConfig({
    rulesFilePath: "ops/default-rules.md",
    repositories: { [REPOSITORY]: { rulesFilePath: "ops/repo-rules.md" } },
  });
  const locked = parseReviewOperatorConfig({
    lockModelPolicy: true,
    repositories: { [REPOSITORY]: { rulesFilePath: "ops/repo-rules.md" } },
  });

  it("uses the user value unless the policy is locked, where the operator preset wins", () => {
    const stored = settings({ rulesFilePath: "user/rules.md" });
    expect(effectiveRulesFilePath(presets, stored, REPOSITORY)).toEqual({
      path: "user/rules.md",
      source: "user",
    });
    expect(effectiveRulesFilePath(locked, stored, REPOSITORY)).toEqual({
      path: "ops/repo-rules.md",
      source: "operator",
    });
    expect(effectiveRulesFilePath(presets, undefined, "repo_other")).toEqual({
      path: "ops/default-rules.md",
      source: "operator",
    });
    expect(
      effectiveRulesFilePath(parseReviewOperatorConfig(undefined), undefined, REPOSITORY),
    ).toEqual({ path: ".keiko/review-rules.md", source: "default" });
  });
});
