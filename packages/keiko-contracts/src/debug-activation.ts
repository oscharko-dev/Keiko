// Governed debug activation contracts (Issue #2347, Epic #2096, ADR-0136 D7).
// This leaf owns the closed static activation summary only. Session lifecycle is owned by the DAP
// manager, and the resolver deliberately has no restart state or runtime-health vocabulary.

export const DEBUG_ACTIVATION_SCHEMA_VERSION = "1" as const;

export type DebugAdapterId = "node-typescript";
export const DEBUG_ADAPTER_IDS: readonly DebugAdapterId[] = Object.freeze([
  "node-typescript",
] as const satisfies readonly DebugAdapterId[]);

export type DebugActivationEffectiveState =
  "disabled" | "disabledByPolicy" | "notProvisioned" | "available";
export const DEBUG_ACTIVATION_EFFECTIVE_STATES: readonly DebugActivationEffectiveState[] =
  Object.freeze([
    "disabled",
    "disabledByPolicy",
    "notProvisioned",
    "available",
  ] as const satisfies readonly DebugActivationEffectiveState[]);

export type DebugActivationReasonCode =
  | "PRODUCT_UNSUPPORTED"
  | "POLICY_DENIED"
  | "POLICY_UNAVAILABLE"
  | "WORKSPACE_DISABLED"
  | "WORKSPACE_ACTIVATION_UNSET"
  | "NOT_PROVISIONED"
  | "AVAILABLE"
  | "INVALID_INPUT";
export const DEBUG_ACTIVATION_REASON_CODES: readonly DebugActivationReasonCode[] = Object.freeze([
  "PRODUCT_UNSUPPORTED",
  "POLICY_DENIED",
  "POLICY_UNAVAILABLE",
  "WORKSPACE_DISABLED",
  "WORKSPACE_ACTIVATION_UNSET",
  "NOT_PROVISIONED",
  "AVAILABLE",
  "INVALID_INPUT",
] as const satisfies readonly DebugActivationReasonCode[]);

export type DebugProductSupport = "supported" | "unsupported";
export type DebugDeploymentPolicy = "allowed" | "denied" | "unavailable";
export type DebugProvisioning = "provisioned" | "notProvisioned";
export type DebugWorkspaceActivation = "enabled" | "disabled" | "unset";

export interface DebugActivationInput {
  readonly schemaVersion: typeof DEBUG_ACTIVATION_SCHEMA_VERSION;
  readonly adapterId: DebugAdapterId;
  readonly revision: number;
  readonly productSupport: DebugProductSupport;
  readonly deploymentPolicy: DebugDeploymentPolicy;
  readonly provisioning: DebugProvisioning;
  readonly workspaceActivation: DebugWorkspaceActivation;
}

export interface DebugActivationSummary {
  readonly ok: true;
  readonly schemaVersion: typeof DEBUG_ACTIVATION_SCHEMA_VERSION;
  readonly adapterId: DebugAdapterId;
  readonly revision: number;
  readonly state: DebugActivationEffectiveState;
  readonly reasonCode: Exclude<DebugActivationReasonCode, "INVALID_INPUT">;
  readonly policyResult: "allowed" | "denied";
}

export interface DebugActivationDenied {
  readonly ok: false;
  readonly state: "disabled";
  readonly reasonCode: "INVALID_INPUT";
  readonly policyResult: "denied";
}

export type DebugActivationResolution = DebugActivationSummary | DebugActivationDenied;
export type DebugActivationParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function memberOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const PRODUCT_SUPPORT: readonly DebugProductSupport[] = ["supported", "unsupported"];
const DEPLOYMENT_POLICIES: readonly DebugDeploymentPolicy[] = ["allowed", "denied", "unavailable"];
const PROVISIONING: readonly DebugProvisioning[] = ["provisioned", "notProvisioned"];
const WORKSPACE_ACTIVATIONS: readonly DebugWorkspaceActivation[] = ["enabled", "disabled", "unset"];

export function parseDebugActivationInput(
  value: unknown,
): DebugActivationParseResult<DebugActivationInput> {
  try {
    if (!isRecord(value)) return { ok: false, errors: ["activation input must be an object"] };
    const valid = [
      hasOnlyKeys(value, [
        "schemaVersion",
        "adapterId",
        "revision",
        "productSupport",
        "deploymentPolicy",
        "provisioning",
        "workspaceActivation",
      ]),
      value.schemaVersion === DEBUG_ACTIVATION_SCHEMA_VERSION,
      memberOf(value.adapterId, DEBUG_ADAPTER_IDS),
      isRevision(value.revision),
      memberOf(value.productSupport, PRODUCT_SUPPORT),
      memberOf(value.deploymentPolicy, DEPLOYMENT_POLICIES),
      memberOf(value.provisioning, PROVISIONING),
      memberOf(value.workspaceActivation, WORKSPACE_ACTIVATIONS),
    ].every(Boolean);
    if (!valid)
      return { ok: false, errors: ["activation input is invalid or contains unknown fields"] };
    return {
      ok: true,
      value: {
        schemaVersion: DEBUG_ACTIVATION_SCHEMA_VERSION,
        adapterId: value.adapterId as DebugAdapterId,
        revision: value.revision as number,
        productSupport: value.productSupport as DebugProductSupport,
        deploymentPolicy: value.deploymentPolicy as DebugDeploymentPolicy,
        provisioning: value.provisioning as DebugProvisioning,
        workspaceActivation: value.workspaceActivation as DebugWorkspaceActivation,
      },
    };
  } catch {
    return { ok: false, errors: ["activation input could not be inspected"] };
  }
}

type ActivationRule = Readonly<{
  readonly matches: (input: DebugActivationInput) => boolean;
  readonly state: DebugActivationEffectiveState;
  readonly reasonCode: DebugActivationSummary["reasonCode"];
  readonly policyResult: DebugActivationSummary["policyResult"];
}>;

const ACTIVATION_RULES: readonly ActivationRule[] = Object.freeze([
  {
    matches: (input) => input.productSupport === "unsupported",
    state: "disabled",
    reasonCode: "PRODUCT_UNSUPPORTED",
    policyResult: "denied",
  },
  {
    matches: (input) => input.deploymentPolicy === "denied",
    state: "disabledByPolicy",
    reasonCode: "POLICY_DENIED",
    policyResult: "denied",
  },
  {
    matches: (input) => input.deploymentPolicy === "unavailable",
    state: "disabledByPolicy",
    reasonCode: "POLICY_UNAVAILABLE",
    policyResult: "denied",
  },
  {
    matches: (input) => input.workspaceActivation === "disabled",
    state: "disabled",
    reasonCode: "WORKSPACE_DISABLED",
    policyResult: "allowed",
  },
  {
    matches: (input) => input.workspaceActivation === "unset",
    state: "disabled",
    reasonCode: "WORKSPACE_ACTIVATION_UNSET",
    policyResult: "allowed",
  },
  {
    matches: (input) => input.provisioning === "notProvisioned",
    state: "notProvisioned",
    reasonCode: "NOT_PROVISIONED",
    policyResult: "allowed",
  },
  { matches: () => true, state: "available", reasonCode: "AVAILABLE", policyResult: "allowed" },
]);

export function resolveDebugActivation(value: unknown): DebugActivationResolution {
  const parsed = parseDebugActivationInput(value);
  if (!parsed.ok)
    return { ok: false, state: "disabled", reasonCode: "INVALID_INPUT", policyResult: "denied" };
  const input = parsed.value;
  const rule = ACTIVATION_RULES.find((candidate) => candidate.matches(input));
  if (rule === undefined)
    return { ok: false, state: "disabled", reasonCode: "INVALID_INPUT", policyResult: "denied" };
  return {
    ok: true,
    schemaVersion: DEBUG_ACTIVATION_SCHEMA_VERSION,
    adapterId: input.adapterId,
    revision: input.revision,
    state: rule.state,
    reasonCode: rule.reasonCode,
    policyResult: rule.policyResult,
  };
}
