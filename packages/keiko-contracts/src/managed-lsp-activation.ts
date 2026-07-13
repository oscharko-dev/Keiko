// Managed multi-language activation contracts (Issue #2271, Epic #2094, ADR-0132). This strict
// contracts leaf owns only closed state, precedence, and content-free status vocabulary. Runtime
// process supervision remains owned by ADR-0069 and keiko-server.

export const MANAGED_LSP_ACTIVATION_SCHEMA_VERSION = "1" as const;

export type ManagedLspLanguage = "python" | "go" | "shell" | "java" | "rust";

// The order is also the governed rollout order: low-risk providers first, execution-sensitive
// Java/Rust last. Shell is an explicit managed provider, not an alias for arbitrary command use.
export const MANAGED_LSP_LANGUAGES: readonly ManagedLspLanguage[] = Object.freeze([
  "python",
  "go",
  "shell",
  "java",
  "rust",
] as const satisfies readonly ManagedLspLanguage[]);

export type ManagedLspEffectiveState =
  | "disabled"
  | "disabledByPolicy"
  | "notProvisioned"
  | "available"
  | "starting"
  | "active"
  | "degraded"
  | "unhealthy"
  | "restartRequired";

export const MANAGED_LSP_EFFECTIVE_STATES: readonly ManagedLspEffectiveState[] = Object.freeze([
  "disabled",
  "disabledByPolicy",
  "notProvisioned",
  "available",
  "starting",
  "active",
  "degraded",
  "unhealthy",
  "restartRequired",
] as const satisfies readonly ManagedLspEffectiveState[]);

export type ManagedLspActivationReasonCode =
  | "PRODUCT_UNSUPPORTED"
  | "POLICY_DENIED"
  | "LEGACY_ENV_DISABLED"
  | "NOT_PROVISIONED"
  | "WORKSPACE_DISABLED"
  | "WORKSPACE_ACTIVATION_UNSET"
  | "AVAILABLE"
  | "STARTING"
  | "NEGOTIATED_CAPABILITY_MISSING"
  | "RUNTIME_HEALTH_UNKNOWN"
  | "RUNTIME_DEGRADED"
  | "RUNTIME_UNHEALTHY"
  | "RESTART_REQUIRED"
  | "ACTIVE"
  | "STATE_UNAVAILABLE"
  | "INVALID_INPUT";

export const MANAGED_LSP_ACTIVATION_REASON_CODES: readonly ManagedLspActivationReasonCode[] =
  Object.freeze([
    "PRODUCT_UNSUPPORTED",
    "POLICY_DENIED",
    "LEGACY_ENV_DISABLED",
    "NOT_PROVISIONED",
    "WORKSPACE_DISABLED",
    "WORKSPACE_ACTIVATION_UNSET",
    "AVAILABLE",
    "STARTING",
    "NEGOTIATED_CAPABILITY_MISSING",
    "RUNTIME_HEALTH_UNKNOWN",
    "RUNTIME_DEGRADED",
    "RUNTIME_UNHEALTHY",
    "RESTART_REQUIRED",
    "ACTIVE",
    "STATE_UNAVAILABLE",
    "INVALID_INPUT",
  ] as const satisfies readonly ManagedLspActivationReasonCode[]);

export type ManagedLspProductSupport = "supported" | "unsupported";
export type ManagedLspCanonicalState = "available" | "unavailable" | "rejected";
export type ManagedLspDeploymentPolicy = "allowed" | "denied";
export type ManagedLspProvisioning = "provisioned" | "notProvisioned";
export type ManagedLspWorkspaceActivation = "enabled" | "disabled" | "unset";
export type ManagedLspLegacyEnvironment = "enabled" | "disabled" | "unset";
export type ManagedLspNegotiation =
  "notStarted" | "starting" | "negotiated" | "requiredCapabilityMissing";
export type ManagedLspRuntimeHealth = "unknown" | "healthy" | "degraded" | "unhealthy";
export type ManagedLspPolicyResult = "allowed" | "denied";

export interface ManagedLspActivationInput {
  readonly schemaVersion: typeof MANAGED_LSP_ACTIVATION_SCHEMA_VERSION;
  readonly language: ManagedLspLanguage;
  readonly configurationRevision: number;
  readonly productSupport: ManagedLspProductSupport;
  readonly canonicalState?: ManagedLspCanonicalState;
  readonly deploymentPolicy: ManagedLspDeploymentPolicy;
  readonly provisioning: ManagedLspProvisioning;
  readonly workspaceActivation: ManagedLspWorkspaceActivation;
  readonly legacyEnvironment: ManagedLspLegacyEnvironment;
  readonly negotiation: ManagedLspNegotiation;
  readonly runtimeHealth: ManagedLspRuntimeHealth;
  readonly restartRequired: boolean;
}

export interface ManagedLspActivationStatus {
  readonly ok: true;
  readonly schemaVersion: typeof MANAGED_LSP_ACTIVATION_SCHEMA_VERSION;
  readonly language: ManagedLspLanguage;
  readonly configurationRevision: number;
  readonly state: ManagedLspEffectiveState;
  readonly reasonCode: ManagedLspActivationReasonCode;
  readonly policyResult: ManagedLspPolicyResult;
}

export interface ManagedLspActivationDenied {
  readonly ok: false;
  readonly state: "disabled";
  readonly reasonCode: "INVALID_INPUT";
  readonly policyResult: "denied";
}

export type ManagedLspActivationResolution =
  ManagedLspActivationStatus | ManagedLspActivationDenied;

export type ManagedLspActivationParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function memberOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const PRODUCT_SUPPORT: readonly ManagedLspProductSupport[] = ["supported", "unsupported"];
const CANONICAL_STATES: readonly ManagedLspCanonicalState[] = [
  "available",
  "unavailable",
  "rejected",
];
const DEPLOYMENT_POLICIES: readonly ManagedLspDeploymentPolicy[] = ["allowed", "denied"];
const PROVISIONING_STATES: readonly ManagedLspProvisioning[] = ["provisioned", "notProvisioned"];
const WORKSPACE_ACTIVATIONS: readonly ManagedLspWorkspaceActivation[] = [
  "enabled",
  "disabled",
  "unset",
];
const LEGACY_ENVIRONMENTS: readonly ManagedLspLegacyEnvironment[] = [
  "enabled",
  "disabled",
  "unset",
];
const NEGOTIATION_STATES: readonly ManagedLspNegotiation[] = [
  "notStarted",
  "starting",
  "negotiated",
  "requiredCapabilityMissing",
];
const RUNTIME_HEALTH_STATES: readonly ManagedLspRuntimeHealth[] = [
  "unknown",
  "healthy",
  "degraded",
  "unhealthy",
];
const POLICY_RESULTS: readonly ManagedLspPolicyResult[] = ["allowed", "denied"];

function frozenReasons(
  ...reasons: readonly ManagedLspActivationReasonCode[]
): readonly ManagedLspActivationReasonCode[] {
  return Object.freeze(reasons);
}

const REASONS_BY_STATE: Readonly<
  Record<ManagedLspEffectiveState, readonly ManagedLspActivationReasonCode[]>
> = Object.freeze({
  disabled: frozenReasons(
    "PRODUCT_UNSUPPORTED",
    "WORKSPACE_DISABLED",
    "WORKSPACE_ACTIVATION_UNSET",
    "STATE_UNAVAILABLE",
  ),
  disabledByPolicy: frozenReasons("POLICY_DENIED", "LEGACY_ENV_DISABLED"),
  notProvisioned: frozenReasons("NOT_PROVISIONED"),
  available: frozenReasons("AVAILABLE"),
  starting: frozenReasons("STARTING"),
  active: frozenReasons("ACTIVE"),
  degraded: frozenReasons(
    "NEGOTIATED_CAPABILITY_MISSING",
    "RUNTIME_HEALTH_UNKNOWN",
    "RUNTIME_DEGRADED",
  ),
  unhealthy: frozenReasons("RUNTIME_UNHEALTHY"),
  restartRequired: frozenReasons("RESTART_REQUIRED"),
});

function isDeniedReason(reason: ManagedLspActivationReasonCode): boolean {
  return (
    reason === "PRODUCT_UNSUPPORTED" ||
    reason === "STATE_UNAVAILABLE" ||
    reason === "POLICY_DENIED" ||
    reason === "LEGACY_ENV_DISABLED"
  );
}

function isConsistentStatus(value: UnknownRecord): boolean {
  const state = value.state as ManagedLspEffectiveState;
  const reason = value.reasonCode as ManagedLspActivationReasonCode;
  const policyResult = value.policyResult as ManagedLspPolicyResult;
  return (
    REASONS_BY_STATE[state].includes(reason) &&
    (policyResult === "denied") === isDeniedReason(reason)
  );
}

function parseSafely<T>(
  parser: () => ManagedLspActivationParseResult<T>,
): ManagedLspActivationParseResult<T> {
  try {
    return parser();
  } catch (error: unknown) {
    return {
      ok: false,
      errors: [
        `payload could not be inspected: ${error instanceof Error ? error.name : "unknown"}`,
      ],
    };
  }
}

function canonicalActivationInput(value: UnknownRecord): ManagedLspActivationInput {
  return {
    schemaVersion: MANAGED_LSP_ACTIVATION_SCHEMA_VERSION,
    language: value.language as ManagedLspLanguage,
    configurationRevision: value.configurationRevision as number,
    productSupport: value.productSupport as ManagedLspProductSupport,
    deploymentPolicy: value.deploymentPolicy as ManagedLspDeploymentPolicy,
    provisioning: value.provisioning as ManagedLspProvisioning,
    workspaceActivation: value.workspaceActivation as ManagedLspWorkspaceActivation,
    legacyEnvironment: value.legacyEnvironment as ManagedLspLegacyEnvironment,
    negotiation: value.negotiation as ManagedLspNegotiation,
    runtimeHealth: value.runtimeHealth as ManagedLspRuntimeHealth,
    restartRequired: value.restartRequired as boolean,
    ...(value.canonicalState !== undefined
      ? { canonicalState: value.canonicalState as ManagedLspCanonicalState }
      : {}),
  };
}

function parseActivationInputUnsafe(
  value: unknown,
): ManagedLspActivationParseResult<ManagedLspActivationInput> {
  if (!isRecord(value)) return { ok: false, errors: ["activation input must be an object"] };
  const keys = [
    "schemaVersion",
    "language",
    "configurationRevision",
    "productSupport",
    "canonicalState",
    "deploymentPolicy",
    "provisioning",
    "workspaceActivation",
    "legacyEnvironment",
    "negotiation",
    "runtimeHealth",
    "restartRequired",
  ];
  const valid = [
    hasOnlyKeys(value, keys),
    value.schemaVersion === MANAGED_LSP_ACTIVATION_SCHEMA_VERSION,
    memberOf(value.language, MANAGED_LSP_LANGUAGES),
    isRevision(value.configurationRevision),
    memberOf(value.productSupport, PRODUCT_SUPPORT),
    value.canonicalState === undefined || memberOf(value.canonicalState, CANONICAL_STATES),
    memberOf(value.deploymentPolicy, DEPLOYMENT_POLICIES),
    memberOf(value.provisioning, PROVISIONING_STATES),
    memberOf(value.workspaceActivation, WORKSPACE_ACTIVATIONS),
    memberOf(value.legacyEnvironment, LEGACY_ENVIRONMENTS),
    memberOf(value.negotiation, NEGOTIATION_STATES),
    memberOf(value.runtimeHealth, RUNTIME_HEALTH_STATES),
    typeof value.restartRequired === "boolean",
  ].every(Boolean);
  return valid
    ? { ok: true, value: canonicalActivationInput(value) }
    : { ok: false, errors: ["activation input is invalid or contains unknown fields"] };
}

export function parseManagedLspActivationInput(
  value: unknown,
): ManagedLspActivationParseResult<ManagedLspActivationInput> {
  return parseSafely(() => parseActivationInputUnsafe(value));
}

function status(
  input: ManagedLspActivationInput,
  state: ManagedLspEffectiveState,
  reasonCode: ManagedLspActivationReasonCode,
): ManagedLspActivationStatus {
  const policyResult =
    input.productSupport === "unsupported" ||
    input.canonicalState === "unavailable" ||
    input.canonicalState === "rejected" ||
    input.deploymentPolicy === "denied" ||
    input.legacyEnvironment === "disabled"
      ? "denied"
      : "allowed";
  return {
    ok: true,
    schemaVersion: MANAGED_LSP_ACTIVATION_SCHEMA_VERSION,
    language: input.language,
    configurationRevision: input.configurationRevision,
    state,
    reasonCode,
    policyResult,
  };
}

interface ActivationRule {
  readonly matches: (input: ManagedLspActivationInput) => boolean;
  readonly state: ManagedLspEffectiveState;
  readonly reason: ManagedLspActivationReasonCode;
}

const ACTIVATION_RULES: readonly ActivationRule[] = Object.freeze([
  {
    matches: (input) => input.productSupport === "unsupported",
    state: "disabled",
    reason: "PRODUCT_UNSUPPORTED",
  },
  {
    matches: (input) =>
      input.canonicalState === "unavailable" || input.canonicalState === "rejected",
    state: "disabled",
    reason: "STATE_UNAVAILABLE",
  },
  {
    matches: (input) => input.deploymentPolicy === "denied",
    state: "disabledByPolicy",
    reason: "POLICY_DENIED",
  },
  {
    matches: (input) => input.legacyEnvironment === "disabled",
    state: "disabledByPolicy",
    reason: "LEGACY_ENV_DISABLED",
  },
  {
    matches: (input) => input.provisioning === "notProvisioned",
    state: "notProvisioned",
    reason: "NOT_PROVISIONED",
  },
  {
    matches: (input) => input.workspaceActivation === "disabled",
    state: "disabled",
    reason: "WORKSPACE_DISABLED",
  },
  {
    matches: (input) => input.workspaceActivation === "unset",
    state: "disabled",
    reason: "WORKSPACE_ACTIVATION_UNSET",
  },
  {
    matches: (input) => input.negotiation === "notStarted",
    state: "available",
    reason: "AVAILABLE",
  },
  { matches: (input) => input.negotiation === "starting", state: "starting", reason: "STARTING" },
  {
    matches: (input) => input.negotiation === "requiredCapabilityMissing",
    state: "degraded",
    reason: "NEGOTIATED_CAPABILITY_MISSING",
  },
  {
    matches: (input) => input.runtimeHealth === "unhealthy",
    state: "unhealthy",
    reason: "RUNTIME_UNHEALTHY",
  },
  {
    matches: (input) => input.runtimeHealth === "degraded",
    state: "degraded",
    reason: "RUNTIME_DEGRADED",
  },
  {
    matches: (input) => input.runtimeHealth === "unknown",
    state: "degraded",
    reason: "RUNTIME_HEALTH_UNKNOWN",
  },
  {
    matches: (input) => input.restartRequired,
    state: "restartRequired",
    reason: "RESTART_REQUIRED",
  },
]);

function resolveValidActivation(input: ManagedLspActivationInput): ManagedLspActivationStatus {
  for (const rule of ACTIVATION_RULES) {
    if (rule.matches(input)) return status(input, rule.state, rule.reason);
  }
  return status(input, "active", "ACTIVE");
}

export function resolveManagedLspActivation(value: unknown): ManagedLspActivationResolution {
  const parsed = parseManagedLspActivationInput(value);
  return parsed.ok
    ? resolveValidActivation(parsed.value)
    : { ok: false, state: "disabled", reasonCode: "INVALID_INPUT", policyResult: "denied" };
}

function parseActivationStatusUnsafe(
  value: unknown,
): ManagedLspActivationParseResult<ManagedLspActivationStatus> {
  if (!isRecord(value)) return { ok: false, errors: ["activation status must be an object"] };
  const valid = [
    hasOnlyKeys(value, [
      "ok",
      "schemaVersion",
      "language",
      "configurationRevision",
      "state",
      "reasonCode",
      "policyResult",
    ]),
    value.ok === true,
    value.schemaVersion === MANAGED_LSP_ACTIVATION_SCHEMA_VERSION,
    memberOf(value.language, MANAGED_LSP_LANGUAGES),
    isRevision(value.configurationRevision),
    memberOf(value.state, MANAGED_LSP_EFFECTIVE_STATES),
    memberOf(value.reasonCode, MANAGED_LSP_ACTIVATION_REASON_CODES),
    memberOf(value.policyResult, POLICY_RESULTS),
    isConsistentStatus(value),
  ].every(Boolean);
  return valid
    ? { ok: true, value: value as unknown as ManagedLspActivationStatus }
    : { ok: false, errors: ["activation status is invalid or contains unknown fields"] };
}

export function parseManagedLspActivationStatus(
  value: unknown,
): ManagedLspActivationParseResult<ManagedLspActivationStatus> {
  return parseSafely(() => parseActivationStatusUnsafe(value));
}
