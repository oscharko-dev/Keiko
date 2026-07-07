import {
  CODING_WORKBENCH_SCHEMA_VERSION,
  type CodingWorkbenchModelSource,
  type CodingWorkbenchRuntimeSource,
  type CodingWorkbenchValidationResult,
} from "./coding-workbench.js";
import { isCodingWorkbenchEvidenceSafeText } from "./coding-workbench-evidence.js";

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
  | "failed-login";

export const CODING_WORKBENCH_CODEX_AUTH_STATUSES: readonly CodingWorkbenchCodexAuthStatus[] =
  Object.freeze([
    "connected",
    "missing",
    "expired",
    "revoked",
    "disabled-by-deployment",
    "unsupported-headless",
    "failed-login",
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

export type CodingWorkbenchCodexRuntimeBinarySource =
  "managed-sidecar-runtime" | "policy-allowed-local-install";

export const CODING_WORKBENCH_CODEX_RUNTIME_BINARY_SOURCES: readonly CodingWorkbenchCodexRuntimeBinarySource[] =
  Object.freeze([
    "managed-sidecar-runtime",
    "policy-allowed-local-install",
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
    true,
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
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as CodingWorkbenchCodexAuthSetupPlan };
}

export function selectCodingWorkbenchRuntimeProfile(
  modelSource: CodingWorkbenchModelSource,
): CodingWorkbenchRuntimeProfileSelection {
  const codex = modelSource === "chatgpt-codex-subscription-profile";
  return {
    schemaVersion: CODING_WORKBENCH_SCHEMA_VERSION,
    modelSource,
    runtimeSource: codex ? "codex-cli-adapter" : "keiko-sidecar",
    adapterKind: codex ? "codex-cli-adapter" : "model-gateway-sidecar",
    sidecarGatewayAllowed: !codex,
    codexSubscriptionAllowed: codex,
    runtimeBinarySources: codex ? CODING_WORKBENCH_CODEX_RUNTIME_BINARY_SOURCES : [],
  };
}
