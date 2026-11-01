// Local runtime capability contracts (Issue #1385, Epic #1491). This leaf module owns the
// wire-stable vocabulary for host tool/runtime detection only. It is intentionally pure: no IO,
// no process execution, no clock, no randomness, and no imports from sibling packages.

import { isPortableWorkspaceRelativePath } from "./workspace-contract-primitives.js";

export const RUNTIME_CAPABILITY_SCHEMA_VERSION = "1" as const;

export type RuntimeCapabilityKind =
  "git" | "node" | "package-manager" | "language-toolchain" | "container-engine" | "command-source";

export type RuntimeCapabilityState =
  "available" | "missing" | "unsupported" | "permission-denied" | "not-running" | "policy-blocked";

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
  const strings: readonly string[] = allowed;
  return typeof value === "string" && strings.includes(value);
}

function validateStringField(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
  label = key,
): boolean {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label} must be a non-empty string`);
    return false;
  }
  return true;
}

function validateCommandSource(
  value: unknown,
  path: string,
  errors: string[],
): value is RuntimeCommandSource {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  let valid = true;
  if (!isOneOf(value.type, ["package-json-script", "ecosystem-manifest", "lockfile"] as const)) {
    errors.push(`${path}.type is invalid`);
    valid = false;
  }
  const pathOk = validateStringField(value, "path", errors, `${path}.path`);
  // Keep the portable-path boundary shared with the sibling workspace contracts.
  if (typeof value.path === "string" && !isPortableWorkspaceRelativePath(value.path)) {
    errors.push(`${path}.path must be workspace-relative`);
    valid = false;
  }
  const optionalsOk = validateCommandSourceOptionals(value, path, errors);
  return valid && pathOk && optionalsOk;
}

function validateCommandSourceOptionals(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): boolean {
  let valid = true;
  if (value.commandKind !== undefined && !isOneOf(value.commandKind, RUNTIME_COMMAND_KINDS)) {
    errors.push(`${path}.commandKind is invalid`);
    valid = false;
  }
  if (value.scriptName !== undefined && typeof value.scriptName !== "string") {
    errors.push(`${path}.scriptName must be a string`);
    valid = false;
  }
  if (value.packageManager !== undefined && typeof value.packageManager !== "string") {
    errors.push(`${path}.packageManager must be a string`);
    valid = false;
  }
  return valid;
}

function validateCapabilityRequiredFields(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): boolean {
  const idOk = validateStringField(value, "id", errors);
  const labelOk = validateStringField(value, "label", errors);
  let valid = true;
  if (!isOneOf(value.kind, RUNTIME_CAPABILITY_KINDS)) {
    errors.push(`${path}.kind is invalid`);
    valid = false;
  }
  if (!isOneOf(value.state, RUNTIME_CAPABILITY_STATES)) {
    errors.push(`${path}.state is invalid`);
    valid = false;
  }
  return idOk && labelOk && valid;
}

function validateCapabilityOptionalFields(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): boolean {
  let valid = true;
  if (value.version !== undefined && typeof value.version !== "string") {
    errors.push(`${path}.version must be a string`);
    valid = false;
  }
  if (
    value.unavailableReason !== undefined &&
    !isOneOf(value.unavailableReason, RUNTIME_CAPABILITY_UNAVAILABLE_REASONS)
  ) {
    errors.push(`${path}.unavailableReason is invalid`);
    valid = false;
  }
  if (value.remediationHint !== undefined && typeof value.remediationHint !== "string") {
    errors.push(`${path}.remediationHint must be a string`);
    valid = false;
  }
  if (value.source !== undefined) {
    const sourceOk = validateCommandSource(value.source, `${path}.source`, errors);
    valid = sourceOk && valid;
  }
  return valid;
}

function validateCapability(
  value: unknown,
  index: number,
  errors: string[],
): value is RuntimeCapability {
  const path = `capabilities[${String(index)}]`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  const requiredOk = validateCapabilityRequiredFields(value, path, errors);
  const optionalOk = validateCapabilityOptionalFields(value, path, errors);
  return requiredOk && optionalOk;
}

function validateResponseScalars(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & Omit<RuntimeCapabilitiesResponse, "capabilities"> {
  let valid = true;
  if (value.schemaVersion !== RUNTIME_CAPABILITY_SCHEMA_VERSION) {
    errors.push("schemaVersion is invalid");
    valid = false;
  }
  const generatedAtMs = value.generatedAtMs;
  if (
    typeof generatedAtMs !== "number" ||
    !Number.isSafeInteger(generatedAtMs) ||
    generatedAtMs < 0
  ) {
    errors.push("generatedAtMs must be a non-negative safe integer");
    valid = false;
  }
  const deadlineMs = value.deadlineMs;
  if (typeof deadlineMs !== "number" || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    errors.push("deadlineMs must be a positive safe integer");
    valid = false;
  }
  return valid;
}

function validateCapabilityEntries(value: unknown, errors: string[]): value is RuntimeCapability[] {
  if (!Array.isArray(value)) {
    errors.push("capabilities must be an array");
    return false;
  }
  const length = value.length;
  let valid = true;
  for (let index = 0; index < length; index++) {
    const entryOk = validateCapability(value[index], index, errors);
    valid = entryOk && valid;
  }
  return valid;
}

function validateCapabilitiesArray(
  value: Record<string, unknown>,
  errors: string[],
): value is Record<string, unknown> & Pick<RuntimeCapabilitiesResponse, "capabilities"> {
  if (!Array.isArray(value.capabilities)) {
    errors.push("capabilities must be an array");
    return false;
  }
  return validateCapabilityEntries(value.capabilities, errors);
}

export function validateRuntimeCapabilitiesResponse(value: unknown): RuntimeCapabilitiesParse {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["response must be an object"] };
  }
  const scalarsOk = validateResponseScalars(value, errors);
  const capabilitiesOk = validateCapabilitiesArray(value, errors);
  if (!scalarsOk || !capabilitiesOk) {
    return { ok: false, errors };
  }
  return { ok: true, value };
}
