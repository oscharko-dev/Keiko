import {
  EDITOR_M7_SCHEMA_VERSION,
  resolveEditorM7AiActivation,
  type EditorM7AiActivationInput,
  type EditorM7AiActivationStatus,
  type EditorM7AiActivationSummary,
  type EditorM7AiFeature,
  type EditorM7ReasonCode,
  type EditorM7ResolvedSetting,
  type EditorM7SettingId,
} from "@oscharko-dev/keiko-contracts";

import type { UiHandlerDeps } from "../deps.js";

type Env = Readonly<Record<string, string | undefined>>;

const TRUE_TOKENS: ReadonlySet<string> = new Set([
  "1",
  "true",
  "on",
  "yes",
  "enabled",
  "allow",
  "allowed",
]);
const FALSE_TOKENS: ReadonlySet<string> = new Set([
  "0",
  "false",
  "off",
  "no",
  "disabled",
  "deny",
  "denied",
]);

const FEATURE_SETTINGS: Readonly<Record<EditorM7AiFeature, EditorM7SettingId>> = {
  inlineCompletion: "inlineCompletion",
  testGeneration: "testGeneration",
  patchApply: "patchApply",
  verification: "patchApply",
};

const LEGACY_ENV: Readonly<Record<EditorM7AiFeature, readonly string[]>> = {
  inlineCompletion: ["KEIKO_EDITOR_AI_INLINE_COMPLETION", "KEIKO_EDITOR_INLINE_COMPLETION"],
  testGeneration: ["KEIKO_EDITOR_AI_TEST_GENERATION", "KEIKO_EDITOR_TEST_GENERATION"],
  patchApply: ["KEIKO_EDITOR_AI_PATCH_APPLY", "KEIKO_EDITOR_PATCH_APPLY"],
  verification: ["KEIKO_EDITOR_AI_VERIFICATION", "KEIKO_EDITOR_PATCH_APPLY_VERIFICATION"],
};

const UNSET_OPERATOR_CEILING: Readonly<
  Record<EditorM7AiFeature, EditorM7AiActivationInput["operatorCeiling"]>
> = {
  inlineCompletion: "allowed",
  testGeneration: "denied",
  patchApply: "denied",
  verification: "denied",
};

function token(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

export function editorAiLegacyFlag(
  env: Env | undefined,
  feature: EditorM7AiFeature,
): EditorM7AiActivationInput["legacyFlag"] {
  const values = LEGACY_ENV[feature].map((name) => token(env?.[name]));
  if (values.some((value) => value !== undefined && FALSE_TOKENS.has(value))) return "disabled";
  if (values.some((value) => value !== undefined && TRUE_TOKENS.has(value))) return "enabled";
  return "unset";
}

export function editorAiOperatorCeiling(
  env: Env | undefined,
  feature: EditorM7AiFeature,
): EditorM7AiActivationInput["operatorCeiling"] {
  const legacyFlag = editorAiLegacyFlag(env, feature);
  if (legacyFlag === "disabled") return "denied";
  if (legacyFlag === "enabled") return "allowed";
  return UNSET_OPERATOR_CEILING[feature];
}

export function editorAiPolicyCeilingLocks(
  env: Env | undefined,
): Readonly<Partial<Record<EditorM7SettingId, EditorM7ReasonCode>>> {
  const locked: Partial<Record<EditorM7SettingId, EditorM7ReasonCode>> = {};
  for (const feature of ["inlineCompletion", "testGeneration", "patchApply"] as const) {
    if (editorAiOperatorCeiling(env, feature) === "denied") {
      locked[FEATURE_SETTINGS[feature]] = "OPERATOR_CEILING_DENIED";
    }
  }
  return locked;
}

function explicitOptIn(
  settings: readonly EditorM7ResolvedSetting[],
  feature: EditorM7AiFeature,
): boolean {
  return settings.find((setting) => setting.id === FEATURE_SETTINGS[feature])?.value === true;
}

function modelCapability(
  feature: EditorM7AiFeature,
  gatewayConfigured: boolean,
): EditorM7AiActivationInput["modelCapability"] {
  if (feature !== "inlineCompletion" && feature !== "testGeneration") return "available";
  return gatewayConfigured ? "available" : "missing";
}

export function resolveEditorAiAssistStatuses(args: {
  readonly env?: Env | undefined;
  readonly gatewayConfigured?: boolean | undefined;
  readonly revision: number;
  readonly settings: readonly EditorM7ResolvedSetting[];
}): EditorM7AiActivationSummary {
  const gatewayConfigured = args.gatewayConfigured ?? true;
  const statuses = (["inlineCompletion", "testGeneration", "patchApply"] as const).map(
    (feature): EditorM7AiActivationStatus =>
      resolveEditorM7AiActivation({
        schemaVersion: EDITOR_M7_SCHEMA_VERSION,
        feature,
        productSupported: true,
        operatorCeiling: editorAiOperatorCeiling(args.env, feature),
        explicitOptIn: explicitOptIn(args.settings, feature),
        modelCapability: modelCapability(feature, gatewayConfigured),
        budget: "available",
        providerHealth: "healthy",
        securityPrerequisites: "satisfied",
        legacyFlag: editorAiLegacyFlag(args.env, feature),
      }),
  );
  return { revision: args.revision, statuses };
}

export function inactiveEditorAiStatus(
  feature: EditorM7AiFeature,
  reasonCode: EditorM7ReasonCode,
): EditorM7AiActivationStatus {
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    feature,
    state: "denied",
    reasonCode,
    policyResult: "denied",
  };
}

export async function resolveEditorAiAssistStatusForRoot(
  deps: UiHandlerDeps,
  realRoot: string,
  feature: EditorM7AiFeature,
): Promise<EditorM7AiActivationStatus> {
  if (deps.editorSettingsControl === undefined) {
    return inactiveEditorAiStatus(feature, "STATE_UNAVAILABLE");
  }
  const snapshot = await deps.editorSettingsControl.read(realRoot);
  if (snapshot.storeState === "unavailable") {
    return inactiveEditorAiStatus(feature, "STATE_UNAVAILABLE");
  }
  const summary =
    snapshot.aiAssistance ??
    resolveEditorAiAssistStatuses({
      env: deps.env,
      gatewayConfigured: true,
      revision: snapshot.revision,
      settings: snapshot.settings,
    });
  return (
    summary.statuses.find((status) => status.feature === feature) ??
    inactiveEditorAiStatus(feature, "PRODUCT_UNSUPPORTED")
  );
}

export function editorAiStatusActive(status: EditorM7AiActivationStatus): boolean {
  return status.state === "active" && status.policyResult === "allowed";
}
