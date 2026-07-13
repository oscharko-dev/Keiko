import { describe, expect, it } from "vitest";

import {
  resolveEditorM7Settings,
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

describe("editor AI-assist activation", () => {
  it("treats legacy flags as operator ceilings, with false tokens winning rollback", () => {
    expect(editorAiOperatorCeiling(undefined, "inlineCompletion")).toBe("allowed");
    expect(editorAiOperatorCeiling(undefined, "testGeneration")).toBe("denied");
    expect(editorAiOperatorCeiling(undefined, "patchApply")).toBe("denied");
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
