// Local runtime capability contracts (Issue #1385, Epic #1491). This leaf module owns the
// wire-stable vocabulary for host tool/runtime detection only. It is intentionally pure: no IO,
// no process execution, no clock, no randomness, and no imports from sibling packages.

export const RUNTIME_CAPABILITY_SCHEMA_VERSION = "1" as const;

export type RuntimeCapabilityKind =
  | "git"
  | "node"
  | "package-manager"
  | "language-toolchain"
  | "container-engine"
  | "command-source";

export type RuntimeCapabilityState =
  | "available"
  | "missing"
  | "unsupported"
  | "permission-denied"
  | "not-running"
  | "policy-blocked";

export type RuntimeCapabilityUnavailableReason =
  | "executable-not-found"
  | "executable-not-runnable"
  | "unsupported-version"
  | "daemon-not-running"
  | "policy-blocked"
  | "unsafe-path"
  | "manifest-not-found"
  | "script-not-defined"
  | "probe-timed-out"
  | "probe-failed";

export type RuntimeCommandKind = "test" | "build" | "lint" | "typecheck";

export type RuntimeCommandSourceType = "package-json-script" | "ecosystem-manifest" | "lockfile";

export interface RuntimeCommandSource {
  readonly type: RuntimeCommandSourceType;
  readonly path: string;
  readonly commandKind?: RuntimeCommandKind | undefined;
  readonly scriptName?: string | undefined;
  readonly packageManager?: string | undefined;
}

export interface RuntimeCapability {
  readonly id: string;
  readonly kind: RuntimeCapabilityKind;
  readonly label: string;
  readonly state: RuntimeCapabilityState;
  readonly version?: string | undefined;
  readonly unavailableReason?: RuntimeCapabilityUnavailableReason | undefined;
  readonly remediationHint?: string | undefined;
  readonly source?: RuntimeCommandSource | undefined;
}

export interface RuntimeCapabilitiesResponse {
  readonly schemaVersion: typeof RUNTIME_CAPABILITY_SCHEMA_VERSION;
  readonly generatedAtMs: number;
  readonly deadlineMs: number;
  readonly capabilities: readonly RuntimeCapability[];
}

export interface RuntimeCapabilitiesParseOk {
  readonly ok: true;
  readonly value: RuntimeCapabilitiesResponse;
}

export interface RuntimeCapabilitiesParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type RuntimeCapabilitiesParse = RuntimeCapabilitiesParseOk | RuntimeCapabilitiesParseFail;

export const RUNTIME_CAPABILITY_KINDS: readonly RuntimeCapabilityKind[] = Object.freeze([
  "git",
  "node",
  "package-manager",
  "language-toolchain",
  "container-engine",
  "command-source",
] as const satisfies readonly RuntimeCapabilityKind[]);

export const RUNTIME_CAPABILITY_STATES: readonly RuntimeCapabilityState[] = Object.freeze([
  "available",
  "missing",
  "unsupported",
  "permission-denied",
  "not-running",
  "policy-blocked",
] as const satisfies readonly RuntimeCapabilityState[]);

export const RUNTIME_CAPABILITY_UNAVAILABLE_REASONS: readonly RuntimeCapabilityUnavailableReason[] =
  Object.freeze([
    "executable-not-found",
    "executable-not-runnable",
    "unsupported-version",
    "daemon-not-running",
    "policy-blocked",
    "unsafe-path",
    "manifest-not-found",
    "script-not-defined",
    "probe-timed-out",
    "probe-failed",
  ] as const satisfies readonly RuntimeCapabilityUnavailableReason[]);

export const RUNTIME_COMMAND_KINDS: readonly RuntimeCommandKind[] = Object.freeze([
  "test",
  "build",
  "lint",
  "typecheck",
] as const satisfies readonly RuntimeCommandKind[]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function validateStringField(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
  optional = false,
  label = key,
): void {
  const value = record[key];
  if (value === undefined && optional) return;
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label} must be a non-empty string`);
  }
}

function validateCommandSource(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!isOneOf(value.type, ["package-json-script", "ecosystem-manifest", "lockfile"] as const)) {
    errors.push(`${path}.type is invalid`);
  }
  validateStringField(value, "path", errors, false, `${path}.path`);
  if (value.commandKind !== undefined && !isOneOf(value.commandKind, RUNTIME_COMMAND_KINDS)) {
    errors.push(`${path}.commandKind is invalid`);
  }
  if (value.scriptName !== undefined && typeof value.scriptName !== "string") {
    errors.push(`${path}.scriptName must be a string`);
  }
  if (value.packageManager !== undefined && typeof value.packageManager !== "string") {
    errors.push(`${path}.packageManager must be a string`);
  }
}

function validateCapabilityRequiredFields(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  validateStringField(value, "id", errors);
  validateStringField(value, "label", errors);
  if (!isOneOf(value.kind, RUNTIME_CAPABILITY_KINDS)) {
    errors.push(`${path}.kind is invalid`);
  }
  if (!isOneOf(value.state, RUNTIME_CAPABILITY_STATES)) {
    errors.push(`${path}.state is invalid`);
  }
}

function validateCapabilityOptionalFields(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (value.version !== undefined && typeof value.version !== "string") {
    errors.push(`${path}.version must be a string`);
  }
  if (
    value.unavailableReason !== undefined &&
    !isOneOf(value.unavailableReason, RUNTIME_CAPABILITY_UNAVAILABLE_REASONS)
  ) {
    errors.push(`${path}.unavailableReason is invalid`);
  }
  if (value.remediationHint !== undefined && typeof value.remediationHint !== "string") {
    errors.push(`${path}.remediationHint must be a string`);
  }
  if (value.source !== undefined) {
    validateCommandSource(value.source, `${path}.source`, errors);
  }
}

function validateCapability(value: unknown, index: number, errors: string[]): void {
  const path = `capabilities[${String(index)}]`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateCapabilityRequiredFields(value, path, errors);
  validateCapabilityOptionalFields(value, path, errors);
}

function validateResponseScalars(value: Record<string, unknown>, errors: string[]): void {
  if (value.schemaVersion !== RUNTIME_CAPABILITY_SCHEMA_VERSION)
    errors.push("schemaVersion is invalid");
  const generatedAtMs = value.generatedAtMs;
  if (
    typeof generatedAtMs !== "number" ||
    !Number.isSafeInteger(generatedAtMs) ||
    generatedAtMs < 0
  ) {
    errors.push("generatedAtMs must be a non-negative safe integer");
  }
  const deadlineMs = value.deadlineMs;
  if (typeof deadlineMs !== "number" || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    errors.push("deadlineMs must be a positive safe integer");
  }
}

function validateCapabilitiesArray(value: Record<string, unknown>, errors: string[]): void {
  if (!Array.isArray(value.capabilities)) {
    errors.push("capabilities must be an array");
  } else {
    value.capabilities.forEach((entry, index) => {
      validateCapability(entry, index, errors);
    });
  }
}

export function validateRuntimeCapabilitiesResponse(value: unknown): RuntimeCapabilitiesParse {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["response must be an object"] };
  }
  validateResponseScalars(value, errors);
  validateCapabilitiesArray(value, errors);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: value as unknown as RuntimeCapabilitiesResponse };
}
