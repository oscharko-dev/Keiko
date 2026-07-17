import { describe, expect, it } from "vitest";

import {
  resolveEditorM7Settings,
  type EditorM7AiActivationStatus,
  type EditorM7AiActivationSummary,
  type EditorM7AiFeature,
  type EditorM7ResolvedSetting,
  type EditorM7SettingId,
  type EditorM7SettingValue,
} from "@oscharko-dev/keiko-contracts";

import {
  editorAiLegacyFlag,
  editorAiOperatorCeiling,
  editorAiPolicyCeilingLocks,
  editorAiStatusActive,
  resolveEditorAiAssistStatuses,
} from "./aiAssistActivation.js";

type Values = Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>>;

function settings(values: Values): readonly EditorM7ResolvedSetting[] {
  const userValues: Partial<Record<EditorM7SettingId, EditorM7SettingValue>> = {};
  const workspaceValues: Partial<Record<EditorM7SettingId, EditorM7SettingValue>> = {};
  if (values.inlineCompletion !== undefined) userValues.inlineCompletion = values.inlineCompletion;
  if (values.testGeneration !== undefined) workspaceValues.testGeneration = values.testGeneration;
  if (values.patchApply !== undefined) workspaceValues.patchApply = values.patchApply;
  return resolveEditorM7Settings({
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
        gatewayConfigured: entry.gatewayConfigured,
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
      gatewayConfigured: false,
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
});
