import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  type CodingWorkbenchModelSource,
  type CodingWorkbenchRuntimeSource,
  type CodingWorkbenchValidationResult,
} from "./coding-workbench.js";
import { isCodingWorkbenchEvidenceSafeText } from "./coding-workbench-evidence.js";
import { deepFreeze } from "./deep-freeze.js";

export type CodingWorkbenchCodexAuthMethod =
  "chatgpt-browser-login" | "chatgpt-device-code" | "codex-access-token";

export const CODING_WORKBENCH_CODEX_AUTH_METHODS: readonly CodingWorkbenchCodexAuthMethod[] =
  Object.freeze([
    "chatgpt-browser-login",
    "chatgpt-device-code",
    "codex-access-token",
  ] as const satisfies readonly CodingWorkbenchCodexAuthMethod[]);

export type CodingWorkbenchCodexAuthStatus =
  | "connected"
  | "missing"
  | "expired"
  | "revoked"
  | "disabled-by-deployment"
  | "unsupported-headless"
  | "failed-login"
  | "redistribution-unapproved";

export const CODING_WORKBENCH_CODEX_AUTH_STATUSES: readonly CodingWorkbenchCodexAuthStatus[] =
  Object.freeze([
    "connected",
    "missing",
    "expired",
    "revoked",
    "disabled-by-deployment",
    "unsupported-headless",
    "failed-login",
    "redistribution-unapproved",
  ] as const satisfies readonly CodingWorkbenchCodexAuthStatus[]);

export type CodingWorkbenchCodexCredentialStore = "file" | "keyring" | "auto";

export const CODING_WORKBENCH_CODEX_CREDENTIAL_STORES: readonly CodingWorkbenchCodexCredentialStore[] =
  Object.freeze(["file", "keyring", "auto"] as const);

export type CodingWorkbenchCodexAuthStateScope = "keiko-owned-state" | "os-credential-store";

export const CODING_WORKBENCH_CODEX_AUTH_STATE_SCOPES: readonly CodingWorkbenchCodexAuthStateScope[] =
  Object.freeze(["keiko-owned-state", "os-credential-store"] as const);

export type CodingWorkbenchCodexAuthStateRoot = "keiko-codex-runtime-state" | "os-credential-store";

export const CODING_WORKBENCH_CODEX_AUTH_STATE_ROOTS: readonly CodingWorkbenchCodexAuthStateRoot[] =
  Object.freeze(["keiko-codex-runtime-state", "os-credential-store"] as const);

export type CodingWorkbenchCodexRuntimeBinarySource = "managed-sidecar-runtime";

export const CODING_WORKBENCH_CODEX_RUNTIME_BINARY_SOURCES: readonly CodingWorkbenchCodexRuntimeBinarySource[] =
  Object.freeze([
    "managed-sidecar-runtime",
  ] as const satisfies readonly CodingWorkbenchCodexRuntimeBinarySource[]);

export type CodingWorkbenchCodexAuthCommandLabel =
  "codex-login" | "codex-login-device-auth" | "codex-login-with-access-token";

export const CODING_WORKBENCH_CODEX_AUTH_COMMAND_LABELS: readonly CodingWorkbenchCodexAuthCommandLabel[] =
  Object.freeze([
    "codex-login",
    "codex-login-device-auth",
    "codex-login-with-access-token",
  ] as const satisfies readonly CodingWorkbenchCodexAuthCommandLabel[]);

export type CodingWorkbenchCodexCredentialTransport = "stdin";

export interface CodingWorkbenchCodexSubscriptionProfile {
  readonly schemaVersion: typeof CODING_WORKBENCH_SCHEMA_VERSION;
  readonly profileId: string;
  readonly modelSource: "chatgpt-codex-subscription-profile";
  readonly runtimeSource: "codex-cli-adapter";
  readonly status: CodingWorkbenchCodexAuthStatus;
  readonly authMethod?: CodingWorkbenchCodexAuthMethod | undefined;
  readonly credentialStore: CodingWorkbenchCodexCredentialStore;
  readonly stateScope: CodingWorkbenchCodexAuthStateScope;
  readonly stateRoot: CodingWorkbenchCodexAuthStateRoot;
  readonly usesGlobalCodexHome: false;
  readonly runtimeBinarySources: readonly CodingWorkbenchCodexRuntimeBinarySource[];
  readonly supportsBrowserLogin: boolean;
  readonly supportsDeviceCode: boolean;
  readonly supportsAccessToken: boolean;
  readonly deploymentPolicyDisabled: boolean;
  readonly headless: boolean;
}

export interface CodingWorkbenchCodexAuthSetupRequest {
  readonly method: CodingWorkbenchCodexAuthMethod;
}

export interface CodingWorkbenchCodexAuthSetupPlan {
  readonly schemaVersion: typeof CODING_WORKBENCH_SCHEMA_VERSION;
  readonly profileId: string;
  readonly method: CodingWorkbenchCodexAuthMethod;
  readonly modelSource: "chatgpt-codex-subscription-profile";
  readonly runtimeSource: "codex-cli-adapter";
  readonly credentialStore: CodingWorkbenchCodexCredentialStore;
  readonly stateScope: CodingWorkbenchCodexAuthStateScope;
  readonly stateRoot: CodingWorkbenchCodexAuthStateRoot;
  readonly usesGlobalCodexHome: false;
  readonly commandLabel: CodingWorkbenchCodexAuthCommandLabel;
  readonly requiresSecretInput: boolean;
  readonly credentialTransport?: CodingWorkbenchCodexCredentialTransport | undefined;
}

export type CodingWorkbenchRuntimeAdapterKind = "model-gateway-sidecar" | "codex-cli-adapter";

export interface CodingWorkbenchRuntimeProfileSelection {
  readonly schemaVersion: typeof CODING_WORKBENCH_SCHEMA_VERSION;
  readonly modelSource: CodingWorkbenchModelSource;
  readonly runtimeSource: CodingWorkbenchRuntimeSource;
  readonly adapterKind: CodingWorkbenchRuntimeAdapterKind;
  readonly sidecarGatewayAllowed: boolean;
  readonly codexSubscriptionAllowed: boolean;
  readonly runtimeBinarySources: readonly CodingWorkbenchCodexRuntimeBinarySource[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function validateAllowedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: string[],
): void {
  Object.keys(record)
    .filter((key) => !allowed.includes(key))
    .forEach((key) => errors.push(`${path}.${key} is not allowed`));
}

function validateBooleanField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): void {
  if (typeof record[key] !== "boolean") {
    errors.push(`${path}.${key} must be a boolean`);
  }
}

function validateFalseField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): void {
  if (record[key] !== false) {
    errors.push(`${path}.${key} must be false`);
  }
}

function validateStringArray(
  value: unknown,
  allowed: readonly string[],
  path: string,
  errors: string[],
  requireNonEmpty: boolean,
): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (requireNonEmpty && value.length === 0) {
    errors.push(`${path} must not be empty`);
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !allowed.includes(entry)) {
      errors.push(`${path}[${String(index)}] is invalid`);
    }
  });
}

function validateProfileEnums(record: Record<string, unknown>, errors: string[]): void {
  if (record.schemaVersion !== CODING_WORKBENCH_SCHEMA_VERSION) {
    errors.push("schemaVersion is invalid");
  }
  if (record.modelSource !== "chatgpt-codex-subscription-profile") {
    errors.push("profile.modelSource is invalid");
  }
  if (record.runtimeSource !== "codex-cli-adapter") {
    errors.push("profile.runtimeSource is invalid");
  }
  if (!isOneOf(record.status, CODING_WORKBENCH_CODEX_AUTH_STATUSES)) {
    errors.push("profile.status is invalid");
  }
}

function validateProfileSafeFields(record: Record<string, unknown>, errors: string[]): void {
  if (!isCodingWorkbenchEvidenceSafeText(record.profileId)) {
    errors.push("profile.profileId must be content-free evidence-safe text");
  }
  if (
    record.authMethod !== undefined &&
    !isOneOf(record.authMethod, CODING_WORKBENCH_CODEX_AUTH_METHODS)
  ) {
    errors.push("profile.authMethod is invalid");
  }
  if (!isOneOf(record.credentialStore, CODING_WORKBENCH_CODEX_CREDENTIAL_STORES)) {
    errors.push("profile.credentialStore is invalid");
  }
  if (!isOneOf(record.stateScope, CODING_WORKBENCH_CODEX_AUTH_STATE_SCOPES)) {
    errors.push("profile.stateScope is invalid");
  }
  if (!isOneOf(record.stateRoot, CODING_WORKBENCH_CODEX_AUTH_STATE_ROOTS)) {
    errors.push("profile.stateRoot is invalid");
  }
  validateStringArray(
    record.runtimeBinarySources,
    CODING_WORKBENCH_CODEX_RUNTIME_BINARY_SOURCES,
    "profile.runtimeBinarySources",
    errors,
    false,
  );
}

function validateProfileBooleans(record: Record<string, unknown>, errors: string[]): void {
  validateFalseField(record, "usesGlobalCodexHome", "profile", errors);
  [
    "supportsBrowserLogin",
    "supportsDeviceCode",
    "supportsAccessToken",
    "deploymentPolicyDisabled",
    "headless",
  ].forEach((key) => {
    validateBooleanField(record, key, "profile", errors);
  });
}

function validateUnapprovedProfile(record: Record<string, unknown>, errors: string[]): void {
  if (record.status !== "redistribution-unapproved") return;
  if (Array.isArray(record.runtimeBinarySources) && record.runtimeBinarySources.length > 0) {
    errors.push("profile.runtimeBinarySources must be empty when redistribution is unapproved");
  }
  ["supportsBrowserLogin", "supportsDeviceCode", "supportsAccessToken"].forEach((key) => {
    if (record[key] !== false) {
      errors.push(`${key} must be false when redistribution is unapproved`);
    }
  });
}

const CODEX_PROFILE_KEYS: readonly string[] = Object.freeze([
  "schemaVersion",
  "profileId",
  "modelSource",
  "runtimeSource",
  "status",
  "authMethod",
  "credentialStore",
  "stateScope",
  "stateRoot",
  "usesGlobalCodexHome",
  "runtimeBinarySources",
  "supportsBrowserLogin",
  "supportsDeviceCode",
  "supportsAccessToken",
  "deploymentPolicyDisabled",
  "headless",
] as const);

export function validateCodingWorkbenchCodexSubscriptionProfile(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchCodexSubscriptionProfile> {
  if (!isRecord(value)) {
    return { ok: false, errors: ["profile must be an object"] };
  }
  const errors: string[] = [];
  validateAllowedKeys(value, CODEX_PROFILE_KEYS, "profile", errors);
  validateProfileEnums(value, errors);
  validateProfileSafeFields(value, errors);
  validateProfileBooleans(value, errors);
  validateUnapprovedProfile(value, errors);
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as CodingWorkbenchCodexSubscriptionProfile };
}

export function validateCodingWorkbenchCodexAuthSetupRequest(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchCodexAuthSetupRequest> {
  if (!isRecord(value)) {
    return { ok: false, errors: ["setup request must be an object"] };
  }
  const errors: string[] = [];
  validateAllowedKeys(value, ["method"], "setup", errors);
  if (!isOneOf(value.method, CODING_WORKBENCH_CODEX_AUTH_METHODS)) {
    errors.push("setup.method is invalid");
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as CodingWorkbenchCodexAuthSetupRequest };
}

const SETUP_PLAN_KEYS: readonly string[] = Object.freeze([
  "schemaVersion",
  "profileId",
  "method",
  "modelSource",
  "runtimeSource",
  "credentialStore",
  "stateScope",
  "stateRoot",
  "usesGlobalCodexHome",
  "commandLabel",
  "requiresSecretInput",
  "credentialTransport",
] as const);

function validateSetupPlanEnums(record: Record<string, unknown>, errors: string[]): void {
  if (record.schemaVersion !== CODING_WORKBENCH_SCHEMA_VERSION) {
    errors.push("schemaVersion is invalid");
  }
  if (!isCodingWorkbenchEvidenceSafeText(record.profileId)) {
    errors.push("setup.profileId must be content-free evidence-safe text");
  }
  if (!isOneOf(record.method, CODING_WORKBENCH_CODEX_AUTH_METHODS)) {
    errors.push("setup.method is invalid");
  }
  if (record.modelSource !== "chatgpt-codex-subscription-profile") {
    errors.push("setup.modelSource is invalid");
  }
  if (record.runtimeSource !== "codex-cli-adapter") {
    errors.push("setup.runtimeSource is invalid");
  }
}

function validateSetupPlanPolicy(record: Record<string, unknown>, errors: string[]): void {
  if (!isOneOf(record.credentialStore, CODING_WORKBENCH_CODEX_CREDENTIAL_STORES)) {
    errors.push("setup.credentialStore is invalid");
  }
  if (!isOneOf(record.stateScope, CODING_WORKBENCH_CODEX_AUTH_STATE_SCOPES)) {
    errors.push("setup.stateScope is invalid");
  }
  if (!isOneOf(record.stateRoot, CODING_WORKBENCH_CODEX_AUTH_STATE_ROOTS)) {
    errors.push("setup.stateRoot is invalid");
  }
  validateFalseField(record, "usesGlobalCodexHome", "setup", errors);
  if (!isOneOf(record.commandLabel, CODING_WORKBENCH_CODEX_AUTH_COMMAND_LABELS)) {
    errors.push("setup.commandLabel is invalid");
  }
  if (typeof record.requiresSecretInput !== "boolean") {
    errors.push("setup.requiresSecretInput must be a boolean");
  }
}

// A setup plan's method DETERMINES its command label, whether a secret is typed, and how that
// secret travels. Those three fields were each validated in isolation, so a plan could name
// `chatgpt-browser-login` while carrying the access-token command label and requiresSecretInput
// true — a combination no producer emits and no operator could act on, describing a login flow that
// does not exist. This table is the ONE formula for the rule; keiko-server's
// coding-codex-subscription.ts used to carry its own hand-written copy (a private commandLabelFor
// plus `accessToken = method === "codex-access-token"`) that could drift from this table and make
// the server build a plan its own validator (below) rejects. The server now calls
// `codingWorkbenchCodexAuthMethodRowFor` instead of restating the mapping.
export interface CodingWorkbenchCodexAuthMethodRow {
  readonly commandLabel: CodingWorkbenchCodexAuthCommandLabel;
  readonly requiresSecretInput: boolean;
  readonly credentialTransport?: CodingWorkbenchCodexCredentialTransport | undefined;
}

// deepFreeze, not Object.freeze: Object.freeze is shallow, and codingWorkbenchCodexAuthMethodRowFor
// below hands each row object out to external callers by reference (keiko-server's setupPlanFor
// among them) — a plain Object.freeze on the outer record would still leave every inner row
// object writable, letting a caller rewrite requiresSecretInput or credentialTransport
// process-wide and making validateSetupPlanMethodConsistency agree with the corrupted row it
// reads from this same table (KEIKO-0139's exact bug class).
const CODEX_AUTH_METHOD_ROWS: Readonly<
  Record<CodingWorkbenchCodexAuthMethod, CodingWorkbenchCodexAuthMethodRow>
> = deepFreeze({
  "chatgpt-browser-login": { commandLabel: "codex-login", requiresSecretInput: false },
  "chatgpt-device-code": {
    commandLabel: "codex-login-device-auth",
    requiresSecretInput: false,
  },
  "codex-access-token": {
    commandLabel: "codex-login-with-access-token",
    requiresSecretInput: true,
    credentialTransport: "stdin",
  },
});

// The canonical producer for a Codex auth method's command label, secret-input requirement, and
// credential transport. `validateSetupPlanMethodConsistency` below and keiko-server's
// `setupPlanFor` (coding-codex-subscription.ts) both call this instead of each keeping their own
// copy of the mapping, so a plan can never disagree with the one formula that builds it.
export function codingWorkbenchCodexAuthMethodRowFor(
  method: CodingWorkbenchCodexAuthMethod,
): CodingWorkbenchCodexAuthMethodRow {
  return CODEX_AUTH_METHOD_ROWS[method];
}

function validateSetupPlanMethodConsistency(
  record: Record<string, unknown>,
  errors: string[],
): void {
  const method = record.method;
  if (!isOneOf(method, CODING_WORKBENCH_CODEX_AUTH_METHODS)) return;
  const row = codingWorkbenchCodexAuthMethodRowFor(method);
  if (record.commandLabel !== row.commandLabel) {
    errors.push("setup.commandLabel does not match setup.method");
  }
  if (record.requiresSecretInput !== row.requiresSecretInput) {
    errors.push("setup.requiresSecretInput does not match setup.method");
  }
  if (record.credentialTransport !== row.credentialTransport) {
    errors.push("setup.credentialTransport does not match setup.method");
  }
}

export function validateCodingWorkbenchCodexAuthSetupPlan(
  value: unknown,
): CodingWorkbenchValidationResult<CodingWorkbenchCodexAuthSetupPlan> {
  if (!isRecord(value)) {
    return { ok: false, errors: ["setup plan must be an object"] };
  }
  const errors: string[] = [];
  validateAllowedKeys(value, SETUP_PLAN_KEYS, "setup", errors);
  validateSetupPlanEnums(value, errors);
  validateSetupPlanPolicy(value, errors);
  if (value.credentialTransport !== undefined && value.credentialTransport !== "stdin") {
    errors.push("setup.credentialTransport is invalid");
  }
  validateSetupPlanMethodConsistency(value, errors);
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as CodingWorkbenchCodexAuthSetupPlan };
}

// KEIKO-0708 / #3321: redistribution of the Codex CLI adapter has not been approved yet, so
// `selectCodingWorkbenchRuntimeProfile` below must keep returning `codexSubscriptionAllowed: false`
// and `runtimeBinarySources: []` for the Codex model source, instead of hand-writing that `false` /
// `[]` as a bare literal with no explanation at the point of the decision.
//
// This constant is only the contract layer's static default — it is NOT where redistribution
// approval is granted or recorded. The actual approval record lives in
// `portable-runtime-approvals.json` (`releaseApproval.redistribution.status` /
// `reviewReference`; see ADR-0140 D3 and ADR-0163) and is verified at runtime through
// `deps.codexRuntimeAvailability.isApprovedVerified()`
// (`packages/keiko-server/src/coding-codex-subscription.ts`), which projects the unapproved case
// as the `redistribution-unapproved` status via `codexSubscriptionProfileForEnv`. Do not flip this
// constant to `true` as a way to grant approval — flip it only once a `codex-cli` entry exists in
// that catalog and the server-side gate verifies it.
export const CODEX_REDISTRIBUTION_APPROVED = false as const;

// Exported so tests can drive both the approved and unapproved branches directly, without needing
// to mock module-level state: the derivation itself — not just the constant's current value — is
// what must stay pinned. `codex` gates on the model source; `approved` gates on redistribution
// approval. Both must hold for Codex runtime binaries or the Codex subscription to be authorized —
// a non-Codex model source must never report `codexSubscriptionAllowed: true`, no matter how
// `CODEX_REDISTRIBUTION_APPROVED` is set.
export function deriveCodexRuntimeAuthorization(
  codex: boolean,
  approved: boolean,
): Pick<
  CodingWorkbenchRuntimeProfileSelection,
  "codexSubscriptionAllowed" | "runtimeBinarySources"
> {
  const allowed = codex && approved;
  return {
    codexSubscriptionAllowed: allowed,
    runtimeBinarySources: allowed ? CODING_WORKBENCH_CODEX_RUNTIME_BINARY_SOURCES : [],
  };
}

// Exported (in addition to selectCodingWorkbenchRuntimeProfile) so tests can drive the wrapper's
// own `approved` branch directly. selectCodingWorkbenchRuntimeProfile always calls this with the
// live CODEX_REDISTRIBUTION_APPROVED constant, which is false today -- a test that only calls
// selectCodingWorkbenchRuntimeProfile can never observe the wrapper's `approved: true` path, so it
// cannot tell a real derivation from a reverted bare-literal one. This builder closes that gap.
export function buildCodingWorkbenchRuntimeProfile(
  modelSource: CodingWorkbenchModelSource,
  approved: boolean,
): CodingWorkbenchRuntimeProfileSelection {
  const codex = modelSource === "chatgpt-codex-subscription-profile";
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    modelSource,
    runtimeSource: codex ? "codex-cli-adapter" : "keiko-sidecar",
    adapterKind: codex ? "codex-cli-adapter" : "model-gateway-sidecar",
    sidecarGatewayAllowed: !codex,
    ...deriveCodexRuntimeAuthorization(codex, approved),
  };
}

export function selectCodingWorkbenchRuntimeProfile(
  modelSource: CodingWorkbenchModelSource,
): CodingWorkbenchRuntimeProfileSelection {
  return buildCodingWorkbenchRuntimeProfile(modelSource, CODEX_REDISTRIBUTION_APPROVED);
}
