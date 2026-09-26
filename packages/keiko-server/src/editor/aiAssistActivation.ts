import type {
  EditorM7AiActivationInput,
  EditorM7AiActivationStatus,
  EditorM7AiActivationSummary,
  EditorM7AiFeature,
  EditorM7ReasonCode,
  EditorM7SettingId,
  EditorM11ResolvedSetting,
  GatewayVerificationState,
} from "@oscharko-dev/keiko-contracts";
import {
  EDITOR_M7_SCHEMA_VERSION,
  resolveEditorM7AiActivation,
} from "@oscharko-dev/keiko-contracts/runtime/editor-m7";
import { UNVERIFIED_GATEWAY } from "@oscharko-dev/keiko-contracts/runtime/gateway-verification";

import {
  currentGatewayConfigPresent,
  currentGatewayVerification,
  type UiHandlerDeps,
} from "../deps.js";

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
  for (const feature of [
    "inlineCompletion",
    "testGeneration",
    "patchApply",
    "verification",
  ] as const) {
    if (editorAiOperatorCeiling(env, feature) === "denied") {
      locked[FEATURE_SETTINGS[feature]] = "OPERATOR_CEILING_DENIED";
    }
  }
  return locked;
}

function explicitOptIn(
  settings: readonly EditorM11ResolvedSetting[],
  feature: EditorM7AiFeature,
): boolean {
  return settings.find((setting) => setting.id === FEATURE_SETTINGS[feature])?.value === true;
}

/**
 * The gateway truth the AI-assist projection needs, kept as one value so a caller cannot supply the
 * configuration half and silently omit the probe half.
 */
export interface EditorAiGatewayStatus {
  /** A gateway configuration is present and parsed (a stored setting, not a live check). */
  readonly configured: boolean;
  /** What the last live readiness probe said; `unverified` when none has run. */
  readonly verification: GatewayVerificationState;
}

/** The fail-closed gateway status: configuration unknown, and nothing verified. */
export const UNVERIFIED_EDITOR_AI_GATEWAY: EditorAiGatewayStatus = {
  configured: false,
  verification: UNVERIFIED_GATEWAY,
};

/**
 * Whether a feature reaches the model gateway at all. `patchApply` writes a diff the operator
 * already reviewed and issues no gateway request, so neither the configured-model check nor the
 * live-probe check gates it. Every other feature calls a model, so both do. One predicate owns the
 * distinction — the previous code encoded it only inside the capability check, which is how a
 * probe-derived health input could have been added to one axis and forgotten on the other.
 */
function usesModelGateway(feature: EditorM7AiFeature): boolean {
  return feature !== "patchApply";
}

function modelCapability(
  feature: EditorM7AiFeature,
  gateway: EditorAiGatewayStatus,
): EditorM7AiActivationInput["modelCapability"] {
  if (!usesModelGateway(feature)) return "available";
  return gateway.configured ? "available" : "missing";
}

/**
 * F-01: the provider-health input is the SERVER-CONFIRMED probe outcome, never a literal. Without a
 * probe result this is `unverified`, which resolves to `degraded` / `PROVIDER_UNVERIFIED` — denied,
 * and honest about why: nobody has checked. `healthy` is reachable only from a passing probe.
 */
function providerHealth(
  feature: EditorM7AiFeature,
  gateway: EditorAiGatewayStatus,
): EditorM7AiActivationInput["providerHealth"] {
  if (!usesModelGateway(feature)) return "healthy";
  if (gateway.verification === "verified") return "healthy";
  if (gateway.verification === "partial") return "degraded";
  return gateway.verification === "failed" ? "unhealthy" : "unverified";
}

export function resolveEditorAiAssistStatuses(args: {
  readonly env?: Env | undefined;
  readonly gateway: EditorAiGatewayStatus;
  readonly revision: number;
  readonly settings: readonly EditorM11ResolvedSetting[];
}): EditorM7AiActivationSummary {
  const statuses = (
    ["inlineCompletion", "testGeneration", "patchApply", "verification"] as const
  ).map((feature): EditorM7AiActivationStatus =>
    resolveEditorM7AiActivation({
      schemaVersion: EDITOR_M7_SCHEMA_VERSION,
      feature,
      productSupported: true,
      operatorCeiling: editorAiOperatorCeiling(args.env, feature),
      explicitOptIn: explicitOptIn(args.settings, feature),
      modelCapability: modelCapability(feature, args.gateway),
      // No budget accounting and no security-prerequisite probe exist for editor AI-assist, so
      // there is nothing to report and these two stay constant. They are NOT stand-ins for missing
      // evidence: the moment either gains a real source, it derives from that source here — and
      // inventing a fake budget or security probe to look thorough would be worse than saying so.
      budget: "available",
      providerHealth: providerHealth(feature, args.gateway),
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
  // The snapshot's own summary is the same projection the badge renders, so admission and display
  // can never disagree. The fallback covers a settings control that does not project one; it reads
  // the live gateway truth instead of the former `gatewayConfigured: true` literal, which asserted
  // a configured, reachable gateway on a path that had checked neither.
  const summary =
    snapshot.aiAssistance ??
    resolveEditorAiAssistStatuses({
      env: deps.env,
      gateway: {
        configured: currentGatewayConfigPresent(deps),
        verification: currentGatewayVerification(deps),
      },
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
