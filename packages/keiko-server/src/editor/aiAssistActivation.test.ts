import { describe, expect, it } from "vitest";

import {
  resolveEditorM11Settings,
  type EditorM7AiActivationStatus,
  type EditorM7AiActivationSummary,
  type EditorM7AiFeature,
  type EditorM7SettingId,
  type EditorM7SettingValue,
  type EditorM11ResolvedSetting,
} from "@oscharko-dev/keiko-contracts";

import {
  editorAiLegacyFlag,
  editorAiOperatorCeiling,
  editorAiPolicyCeilingLocks,
  editorAiStatusActive,
  resolveEditorAiAssistStatuses,
  type EditorAiGatewayStatus,
} from "./aiAssistActivation.js";

// A gateway a live probe has confirmed. Spelled out at every call site that expects an ACTIVE
// state: these cases exercise the ceiling / opt-in ladder, and each of them now has to say which
// probe outcome it stands on rather than inheriting a healthy default (F-01).
function verifiedGateway(): EditorAiGatewayStatus {
  return { configured: true, verification: "verified" };
}

type Values = Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>>;

function settings(values: Values): readonly EditorM11ResolvedSetting[] {
  const userValues: Partial<Record<EditorM7SettingId, EditorM7SettingValue>> = {};
  const workspaceValues: Partial<Record<EditorM7SettingId, EditorM7SettingValue>> = {};
  if (values.inlineCompletion !== undefined) userValues.inlineCompletion = values.inlineCompletion;
  if (values.testGeneration !== undefined) workspaceValues.testGeneration = values.testGeneration;
  if (values.patchApply !== undefined) workspaceValues.patchApply = values.patchApply;
  return resolveEditorM11Settings({
    user: { scope: "user", values: userValues },
    workspace: { scope: "workspace", values: workspaceValues },
  });
}

function featureStatus(
  summary: EditorM7AiActivationSummary,
  feature: EditorM7AiFeature,
): EditorM7AiActivationStatus {
  const status = summary.statuses.find((candidate) => candidate.feature === feature);
  expect(status).toBeDefined();
  if (status === undefined) throw new Error(`Missing AI-assist status for ${feature}`);
  return status;
}

describe("editor AI-assist activation", () => {
  it("treats legacy flags as operator ceilings, with false tokens winning rollback", () => {
    expect(editorAiOperatorCeiling(undefined, "inlineCompletion")).toBe("allowed");
    expect(editorAiOperatorCeiling(undefined, "testGeneration")).toBe("denied");
    expect(editorAiOperatorCeiling(undefined, "patchApply")).toBe("denied");
    expect(editorAiOperatorCeiling(undefined, "verification")).toBe("denied");
    expect(
      editorAiLegacyFlag(
        { KEIKO_EDITOR_AI_TEST_GENERATION: "on", KEIKO_EDITOR_TEST_GENERATION: "off" },
        "testGeneration",
      ),
    ).toBe("disabled");
    expect(editorAiOperatorCeiling({ KEIKO_EDITOR_TEST_GENERATION: "on" }, "testGeneration")).toBe(
      "allowed",
    );
    expect(editorAiOperatorCeiling({ KEIKO_EDITOR_PATCH_APPLY: "0" }, "patchApply")).toBe("denied");
  });

  it("locks denied policy-ceiling settings without letting workspace intent widen them", () => {
    expect(
      editorAiPolicyCeilingLocks({
        KEIKO_EDITOR_INLINE_COMPLETION: "off",
        KEIKO_EDITOR_TEST_GENERATION: "off",
        KEIKO_EDITOR_PATCH_APPLY: "off",
      }),
    ).toEqual({
      inlineCompletion: "OPERATOR_CEILING_DENIED",
      testGeneration: "OPERATOR_CEILING_DENIED",
      patchApply: "OPERATOR_CEILING_DENIED",
    });
    const denied = resolveEditorAiAssistStatuses({
      env: { KEIKO_EDITOR_TEST_GENERATION: "off" },
      gateway: verifiedGateway(),
      revision: 7,
      settings: settings({ testGeneration: true }),
    }).statuses.find((status) => status.feature === "testGeneration");

    expect(denied).toMatchObject({
      state: "denied",
      reasonCode: "OPERATOR_CEILING_DENIED",
      policyResult: "denied",
    });
  });

  it("projects every closed feature and applies the stricter shared patch/verification ceiling", () => {
    const summary = resolveEditorAiAssistStatuses({
      env: {
        KEIKO_EDITOR_PATCH_APPLY: "on",
        KEIKO_EDITOR_AI_VERIFICATION: "off",
      },
      gateway: verifiedGateway(),
      revision: 10,
      settings: settings({ patchApply: true }),
    });

    expect(summary.statuses.map((status) => status.feature)).toEqual([
      "inlineCompletion",
      "testGeneration",
      "patchApply",
      "verification",
    ]);
    expect(summary.statuses.find((status) => status.feature === "patchApply")).toMatchObject({
      state: "active",
      policyResult: "allowed",
    });
    expect(summary.statuses.find((status) => status.feature === "verification")).toMatchObject({
      state: "denied",
      reasonCode: "OPERATOR_CEILING_DENIED",
      policyResult: "denied",
    });
    expect(
      editorAiPolicyCeilingLocks({
        KEIKO_EDITOR_PATCH_APPLY: "on",
        KEIKO_EDITOR_AI_VERIFICATION: "off",
      }),
    ).toMatchObject({ patchApply: "OPERATOR_CEILING_DENIED" });
  });

  it("keeps patch apply and verification honest under either stricter shared-setting ceiling", () => {
    const cases = [
      {
        env: { KEIKO_EDITOR_PATCH_APPLY: "off", KEIKO_EDITOR_AI_VERIFICATION: "off" },
        patchApply: "denied",
        verification: "denied",
        locked: true,
      },
      {
        env: { KEIKO_EDITOR_PATCH_APPLY: "off", KEIKO_EDITOR_AI_VERIFICATION: "on" },
        patchApply: "denied",
        verification: "active",
        locked: true,
      },
      {
        env: { KEIKO_EDITOR_PATCH_APPLY: "on", KEIKO_EDITOR_AI_VERIFICATION: "off" },
        patchApply: "active",
        verification: "denied",
        locked: true,
      },
      {
        env: { KEIKO_EDITOR_PATCH_APPLY: "on", KEIKO_EDITOR_AI_VERIFICATION: "on" },
        patchApply: "active",
        verification: "active",
        locked: false,
      },
    ] as const;

    for (const entry of cases) {
      const summary = resolveEditorAiAssistStatuses({
        env: entry.env,
        gateway: verifiedGateway(),
        revision: 11,
        settings: settings({ patchApply: true }),
      });

      expect(featureStatus(summary, "patchApply").state).toBe(entry.patchApply);
      expect(featureStatus(summary, "verification").state).toBe(entry.verification);
      expect(editorAiPolicyCeilingLocks(entry.env).patchApply).toBe(
        entry.locked ? "OPERATOR_CEILING_DENIED" : undefined,
      );
    }
  });

  it("reports verification active, available, denied, and degraded independently", () => {
    const cases = [
      {
        setting: true,
        ceiling: "on",
        gatewayConfigured: true,
        state: "active",
        reasonCode: "ACTIVE",
        policyResult: "allowed",
      },
      {
        setting: false,
        ceiling: "on",
        gatewayConfigured: true,
        state: "available",
        reasonCode: "EXPLICIT_OPT_IN_REQUIRED",
        policyResult: "denied",
      },
      {
        setting: true,
        ceiling: "off",
        gatewayConfigured: true,
        state: "denied",
        reasonCode: "OPERATOR_CEILING_DENIED",
        policyResult: "denied",
      },
      {
        setting: true,
        ceiling: "on",
        gatewayConfigured: false,
        state: "degraded",
        reasonCode: "MODEL_CAPABILITY_MISSING",
        policyResult: "denied",
      },
    ] as const;

    for (const entry of cases) {
      const summary = resolveEditorAiAssistStatuses({
        env: {
          KEIKO_EDITOR_PATCH_APPLY: "on",
          KEIKO_EDITOR_AI_VERIFICATION: entry.ceiling,
        },
        gateway: { configured: entry.gatewayConfigured, verification: "verified" },
        revision: 12,
        settings: settings({ patchApply: entry.setting }),
      });

      expect(featureStatus(summary, "verification")).toMatchObject({
        state: entry.state,
        reasonCode: entry.reasonCode,
        policyResult: entry.policyResult,
      });
      expect(featureStatus(summary, "patchApply").state).toBe(
        entry.setting ? "active" : "available",
      );
      expect(summary.statuses).toHaveLength(4);
      expect(new Set(summary.statuses.map((status) => status.feature)).size).toBe(4);
    }
  });

  it("requires explicit opt-in even when the operator ceiling permits a feature", () => {
    const statuses = resolveEditorAiAssistStatuses({
      env: { KEIKO_EDITOR_TEST_GENERATION: "on", KEIKO_EDITOR_PATCH_APPLY: "on" },
      gateway: verifiedGateway(),
      revision: 8,
      settings: settings({ inlineCompletion: false, testGeneration: false, patchApply: true }),
    }).statuses;

    expect(statuses.find((status) => status.feature === "inlineCompletion")).toMatchObject({
      state: "available",
      reasonCode: "EXPLICIT_OPT_IN_REQUIRED",
      policyResult: "denied",
    });
    expect(statuses.find((status) => status.feature === "testGeneration")).toMatchObject({
      state: "available",
      reasonCode: "EXPLICIT_OPT_IN_REQUIRED",
      policyResult: "denied",
    });
    expect(statuses.find((status) => status.feature === "patchApply")).toMatchObject({
      state: "active",
      reasonCode: "ACTIVE",
      policyResult: "allowed",
    });
  });

  it("marks missing gateway capability as degraded and therefore not active", () => {
    const statuses = resolveEditorAiAssistStatuses({
      env: { KEIKO_EDITOR_TEST_GENERATION: "on", KEIKO_EDITOR_PATCH_APPLY: "on" },
      gateway: { configured: false, verification: "verified" },
      revision: 9,
      settings: settings({ inlineCompletion: true, testGeneration: true, patchApply: true }),
    }).statuses;

    expect(statuses.find((status) => status.feature === "inlineCompletion")).toMatchObject({
      state: "degraded",
      reasonCode: "MODEL_CAPABILITY_MISSING",
    });
    expect(statuses.find((status) => status.feature === "testGeneration")).toMatchObject({
      state: "degraded",
      reasonCode: "MODEL_CAPABILITY_MISSING",
    });
    const inline = statuses.find((status) => status.feature === "inlineCompletion");
    const patch = statuses.find((status) => status.feature === "patchApply");
    expect(inline).toBeDefined();
    expect(patch).toBeDefined();
    if (inline !== undefined && patch !== undefined) {
      expect(editorAiStatusActive(inline)).toBe(false);
      expect(editorAiStatusActive(patch)).toBe(true);
    }
  });

  // F-01: a configured gateway nobody has probed used to resolve to state "active" /
  // policyResult "allowed" — a green badge and an allowed inline-completion admission backed by a
  // hardcoded `providerHealth: "healthy"` and a `gatewayConfigured` default of `true`. Opting in is
  // an operator decision; it is not evidence that the provider answers.
  it("never reports an active gateway-backed feature without a probe outcome", () => {
    const summary = resolveEditorAiAssistStatuses({
      env: {
        KEIKO_EDITOR_TEST_GENERATION: "on",
        KEIKO_EDITOR_PATCH_APPLY: "on",
        KEIKO_EDITOR_AI_VERIFICATION: "on",
      },
      gateway: { configured: true, verification: "unverified" },
      revision: 13,
      settings: settings({ inlineCompletion: true, testGeneration: true, patchApply: true }),
    });

    for (const feature of ["inlineCompletion", "testGeneration", "verification"] as const) {
      const status = featureStatus(summary, feature);
      expect(status).toMatchObject({
        state: "degraded",
        reasonCode: "PROVIDER_UNVERIFIED",
        policyResult: "denied",
      });
      expect(editorAiStatusActive(status)).toBe(false);
    }
    // Patch apply issues no gateway request, so an unprobed gateway neither degrades it nor lets it
    // borrow the gateway's confirmation.
    expect(featureStatus(summary, "patchApply")).toMatchObject({
      state: "active",
      reasonCode: "ACTIVE",
      policyResult: "allowed",
    });
  });

  it("distinguishes an unprobed gateway from a probe that answered", () => {
    const cases = [
      { verification: "verified", state: "active", reasonCode: "ACTIVE" },
      { verification: "partial", state: "degraded", reasonCode: "PROVIDER_UNHEALTHY" },
      { verification: "failed", state: "degraded", reasonCode: "PROVIDER_UNHEALTHY" },
      { verification: "unverified", state: "degraded", reasonCode: "PROVIDER_UNVERIFIED" },
    ] as const;

    for (const entry of cases) {
      const summary = resolveEditorAiAssistStatuses({
        gateway: { configured: true, verification: entry.verification },
        revision: 14,
        settings: settings({ inlineCompletion: true }),
      });

      expect(featureStatus(summary, "inlineCompletion")).toMatchObject({
        state: entry.state,
        reasonCode: entry.reasonCode,
        policyResult: entry.state === "active" ? "allowed" : "denied",
      });
    }
  });
});
