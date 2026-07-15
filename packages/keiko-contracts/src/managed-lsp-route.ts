// Managed-LSP HTTP route envelopes (Epic #2094, ADR-0132). This contracts leaf is the canonical
// owner for the same-origin control request, response, status, and mutation-result wire shapes.
// Parsers are strict and throw-free so malformed or drifted BFF data fails closed at both edges.

import { LANGUAGE_SERVICE_OPERATIONS, type LanguageServiceOperation } from "./language-service.js";
import {
  LSP_PROCESS_SCHEMA_VERSION,
  LSP_PROCESS_STATUSES,
  type ManagedLspProcessHealthSnapshot,
} from "./lsp-process.js";
import {
  MANAGED_LSP_LANGUAGES,
  parseManagedLspActivationStatus,
  type ManagedLspActivationDenied,
  type ManagedLspActivationResolution,
  type ManagedLspActivationStatus,
  type ManagedLspLanguage,
} from "./managed-lsp-activation.js";
import type { ManagedLspEvidenceActorClass } from "./managed-lsp-evidence.js";
import {
  MANAGED_LSP_SETTING_PRECEDENCE,
  parseManagedLspRuntimeConfiguration,
  type ManagedLspConfigurationProvenance,
  type ManagedLspPersistedSettingSource,
  type ManagedLspRestartField,
  type ManagedLspRuntimeConfiguration,
} from "./managed-lsp-runtime.js";

const MAX_ROOT_CHARS = 4_096;
const MAX_MANAGER_ID_CHARS = 256;
const REVISION_ETAG_PATTERN = /^"lspcfg-(\d+)-([A-Za-z0-9_-]{16,64})"$/u;
const CONTROL_RESPONSE_KEYS = [
  "storeState",
  "revision",
  "etag",
  "evidenceCount",
  "languages",
  "settings",
  "configurations",
  "health",
  "providerMetadata",
] as const;

export const MANAGED_LSP_CONTROL_ACTIONS = Object.freeze([
  "activate",
  "deactivate",
  "configure",
  "reset",
  "rollback",
  "restart",
] as const);

export type ManagedLspControlAction = (typeof MANAGED_LSP_CONTROL_ACTIONS)[number];
export type ManagedLspControlStoreState = "absent" | "ready" | "unavailable";
export type ManagedLspProviderConfigurationSource =
  "pyrightconfig" | "pyproject" | "workspaceConfiguration";
export type ManagedLspProviderRuntimeIdentitySource = "venv" | "interpreter";

export interface ManagedLspControlRequest {
  readonly action: ManagedLspControlAction;
  readonly expectedRevision: number;
  readonly language: ManagedLspLanguage;
  readonly root: string;
  readonly configuration?: ManagedLspRuntimeConfiguration | undefined;
}

export interface ManagedLspControlMutation extends ManagedLspControlRequest {
  readonly actorClass: ManagedLspEvidenceActorClass;
  readonly expectedEtag?: string | undefined;
  readonly idempotencyKey: string;
}

export interface ManagedLspConfigurationSummary {
  readonly language: ManagedLspLanguage;
  readonly workspaceActivation: "enabled" | "disabled" | "unset";
  readonly configured: boolean;
  readonly restartRequired: boolean;
  readonly restartFields: readonly ManagedLspRestartField[];
  readonly provenance: ManagedLspConfigurationProvenance | null;
}

export interface ManagedLspProviderMetadata {
  readonly language: "python";
  readonly configurationSource: ManagedLspProviderConfigurationSource;
  readonly runtimeIdentitySource?: ManagedLspProviderRuntimeIdentitySource | undefined;
}

export interface ManagedLspControlSnapshot {
  readonly storeState: ManagedLspControlStoreState;
  readonly revision: number;
  readonly etag: string;
  readonly evidenceCount: number;
  readonly languages: readonly ManagedLspActivationResolution[];
  readonly settings: readonly ManagedLspConfigurationSummary[];
  readonly configurations: readonly ManagedLspRuntimeConfiguration[];
}

export interface ManagedLspControlResponse extends ManagedLspControlSnapshot {
  readonly health: readonly ManagedLspProcessHealthSnapshot[];
  readonly providerMetadata?: readonly ManagedLspProviderMetadata[] | undefined;
}

export interface ManagedLspControlSuccessResult {
  readonly kind: "ok";
  readonly changed: boolean;
  readonly revision: number;
  readonly etag: string;
  readonly status: ManagedLspActivationStatus;
}

export interface ManagedLspControlDeniedResult {
  readonly kind: "denied";
  readonly changed: false;
  readonly revision: number;
  readonly etag: string;
  readonly status: ManagedLspActivationStatus;
}

export type ManagedLspControlResult =
  | ManagedLspControlSuccessResult
  | ManagedLspControlDeniedResult
  | { readonly kind: "conflict"; readonly code: "STALE_REVISION"; readonly etag: string }
  | {
      readonly kind: "idempotencyConflict";
      readonly code: "IDEMPOTENCY_KEY_REUSED";
      readonly etag: string;
    }
  | { readonly kind: "invalid"; readonly code: "INVALID_REQUEST" }
  | { readonly kind: "unavailable"; readonly code: "STATE_UNAVAILABLE" };

export type ManagedLspRouteParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

type UnknownRecord = Readonly<Record<string, unknown>>;

interface ManagedLspRevisionEtagParts {
  readonly revision: number;
  readonly workspaceIdentity: string;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function memberOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function uniqueLanguages(values: readonly { readonly language: ManagedLspLanguage }[]): boolean {
  return new Set(values.map(({ language }) => language)).size === values.length;
}

function hasExactLanguageCoverage(
  values: readonly { readonly language: ManagedLspLanguage }[],
): boolean {
  return (
    values.length === MANAGED_LSP_LANGUAGES.length &&
    uniqueLanguages(values) &&
    MANAGED_LSP_LANGUAGES.every((language) => values.some((entry) => entry.language === language))
  );
}

function invalid<T>(message: string): ManagedLspRouteParseResult<T> {
  return { ok: false, errors: [message] };
}

function parseSafely<T>(
  parser: () => ManagedLspRouteParseResult<T>,
): ManagedLspRouteParseResult<T> {
  try {
    return parser();
  } catch (error: unknown) {
    return invalid(
      `payload could not be inspected: ${error instanceof Error ? error.name : "unknown"}`,
    );
  }
}

function parseRevisionEtagParts(value: unknown): ManagedLspRevisionEtagParts | undefined {
  if (typeof value !== "string") return undefined;
  const match = REVISION_ETAG_PATTERN.exec(value);
  const revision = match === null ? undefined : Number(match[1]);
  const workspaceIdentity = match?.[2];
  return isRevision(revision) && workspaceIdentity !== undefined
    ? { revision, workspaceIdentity }
    : undefined;
}

export function parseManagedLspRevisionEtag(value: unknown, revision: unknown): string | undefined {
  const parsed = parseRevisionEtagParts(value);
  return typeof value === "string" && isRevision(revision) && parsed?.revision === revision
    ? value
    : undefined;
}

function parseControlRequestUnsafe(
  value: unknown,
): ManagedLspRouteParseResult<ManagedLspControlRequest> {
  if (!isRecord(value)) return invalid("managed LSP control request must be an object");
  const keys = ["root", "language", "action", "expectedRevision", "configuration"];
  if (!hasOnlyKeys(value, keys)) return invalid("managed LSP control request has unknown fields");
  if (!validRequestScalars(value)) return invalid("managed LSP control request is invalid");
  const action = value.action as ManagedLspControlAction;
  const configuration = parseRequestConfiguration(value, action);
  if (configuration === null) return invalid("managed LSP control configuration is invalid");
  return {
    ok: true,
    value: {
      root: value.root as string,
      language: value.language as ManagedLspLanguage,
      action,
      expectedRevision: value.expectedRevision as number,
      ...(configuration === undefined ? {} : { configuration }),
    },
  };
}

function validRequestScalars(value: UnknownRecord): boolean {
  return (
    typeof value.root === "string" &&
    value.root.length > 0 &&
    value.root.length <= MAX_ROOT_CHARS &&
    memberOf(value.language, MANAGED_LSP_LANGUAGES) &&
    memberOf(value.action, MANAGED_LSP_CONTROL_ACTIONS) &&
    isRevision(value.expectedRevision)
  );
}

function parseRequestConfiguration(
  value: UnknownRecord,
  action: ManagedLspControlAction,
): ManagedLspRuntimeConfiguration | undefined | null {
  if (action !== "configure") return value.configuration === undefined ? undefined : null;
  const parsed = parseManagedLspRuntimeConfiguration(value.configuration);
  if (!parsed.ok) return null;
  return parsed.value.language === value.language &&
    parsed.value.revision === value.expectedRevision
    ? parsed.value
    : null;
}

export function parseManagedLspControlRequest(
  value: unknown,
): ManagedLspRouteParseResult<ManagedLspControlRequest> {
  return parseSafely(() => parseControlRequestUnsafe(value));
}

function isProvenance(value: unknown): value is ManagedLspConfigurationProvenance {
  if (!isRecord(value) || !hasOnlyKeys(value, ["activation", "runtime", "settings"])) return false;
  const persisted: readonly ManagedLspPersistedSettingSource[] = [
    "builtInDefault",
    "operatorProvisioning",
    "workspace",
  ];
  return (
    memberOf(value.activation, MANAGED_LSP_SETTING_PRECEDENCE) &&
    memberOf(value.runtime, persisted) &&
    memberOf(value.settings, persisted)
  );
}

function isRestartFields(
  value: unknown,
  required: unknown,
): value is readonly ManagedLspRestartField[] {
  return (
    Array.isArray(value) &&
    value.length <= 2 &&
    value.every((field) => field === "runtime" || field === "settings") &&
    new Set(value).size === value.length &&
    typeof required === "boolean" &&
    required === value.length > 0
  );
}

function isConfigurationSummary(value: unknown): value is ManagedLspConfigurationSummary {
  if (!isRecord(value)) return false;
  const valid = [
    hasOnlyKeys(value, [
      "language",
      "workspaceActivation",
      "configured",
      "restartRequired",
      "restartFields",
      "provenance",
    ]),
    memberOf(value.language, MANAGED_LSP_LANGUAGES),
    memberOf(value.workspaceActivation, ["enabled", "disabled", "unset"]),
    typeof value.configured === "boolean",
    isRestartFields(value.restartFields, value.restartRequired),
    value.provenance === null || isProvenance(value.provenance),
  ];
  return valid.every(Boolean) && value.configured === (value.provenance !== null);
}

function isActivationDenied(value: unknown): value is ManagedLspActivationDenied {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["ok", "state", "reasonCode", "policyResult"]) &&
    value.ok === false &&
    value.state === "disabled" &&
    value.reasonCode === "INVALID_INPUT" &&
    value.policyResult === "denied"
  );
}

function isActivationResolution(value: unknown): value is ManagedLspActivationResolution {
  return parseManagedLspActivationStatus(value).ok || isActivationDenied(value);
}

function isActivationArray(value: unknown): value is readonly ManagedLspActivationResolution[] {
  if (!Array.isArray(value) || !value.every(isActivationResolution)) return false;
  const resolved = value.flatMap((entry) => (entry.ok ? [entry] : []));
  return resolved.length === value.length && hasExactLanguageCoverage(resolved);
}

function isLatency(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = [
    "count",
    "totalMs",
    "maximumMs",
    "lessThanOrEqual10Ms",
    "lessThanOrEqual50Ms",
    "lessThanOrEqual250Ms",
    "lessThanOrEqual1Second",
    "greaterThan1Second",
  ];
  return hasOnlyKeys(value, keys) && keys.every((key) => isNonNegativeFinite(value[key]));
}

function hasValidHealthNumbers(value: UnknownRecord): boolean {
  const counters = [
    "restartCount",
    "configurationRevision",
    "lastTransitionTimestampMs",
    "pendingRequestCount",
    "requestCount",
    "successCount",
    "timeoutCount",
    "cancellationCount",
    "failureCount",
  ];
  return counters.every((key) => isRevision(value[key]));
}

function hasValidHealthIdentity(value: UnknownRecord): boolean {
  return (
    value.schemaVersion === LSP_PROCESS_SCHEMA_VERSION &&
    typeof value.managerId === "string" &&
    value.managerId.length > 0 &&
    value.managerId.length <= MAX_MANAGER_ID_CHARS &&
    memberOf(value.language, MANAGED_LSP_LANGUAGES) &&
    memberOf(value.status, LSP_PROCESS_STATUSES)
  );
}

function isHealthSnapshot(value: unknown): value is ManagedLspProcessHealthSnapshot {
  if (!isRecord(value)) return false;
  const keys = [
    "schemaVersion",
    "managerId",
    "language",
    "status",
    "restartCount",
    "configurationRevision",
    "negotiatedOperations",
    "lastTransitionTimestampMs",
    "pendingRequestCount",
    "requestCount",
    "successCount",
    "timeoutCount",
    "cancellationCount",
    "failureCount",
    "latency",
  ];
  return (
    hasOnlyKeys(value, keys) &&
    hasValidHealthIdentity(value) &&
    hasValidHealthNumbers(value) &&
    isOperations(value.negotiatedOperations) &&
    isLatency(value.latency)
  );
}

function isOperations(value: unknown): value is readonly LanguageServiceOperation[] {
  return (
    Array.isArray(value) &&
    value.every((operation) => memberOf(operation, LANGUAGE_SERVICE_OPERATIONS)) &&
    new Set(value).size === value.length
  );
}

function isProviderMetadata(value: unknown): value is ManagedLspProviderMetadata {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, ["language", "configurationSource", "runtimeIdentitySource"]) &&
    value.language === "python" &&
    memberOf(value.configurationSource, ["pyrightconfig", "pyproject", "workspaceConfiguration"]) &&
    (value.runtimeIdentitySource === undefined ||
      memberOf(value.runtimeIdentitySource, ["venv", "interpreter"]))
  );
}

function isUniqueLanguageArray<T extends { readonly language: ManagedLspLanguage }>(
  value: unknown,
  predicate: (entry: unknown) => entry is T,
): value is readonly T[] {
  return Array.isArray(value) && value.every(predicate) && uniqueLanguages(value);
}

function isCompleteLanguageArray<T extends { readonly language: ManagedLspLanguage }>(
  value: unknown,
  predicate: (entry: unknown) => entry is T,
): value is readonly T[] {
  return Array.isArray(value) && value.every(predicate) && hasExactLanguageCoverage(value);
}

function isSnapshotConfigurationArray(
  value: unknown,
  revision: unknown,
  etag: unknown,
): value is readonly ManagedLspRuntimeConfiguration[] {
  const snapshotEtag = parseRevisionEtagParts(etag);
  if (
    !isRevision(revision) ||
    snapshotEtag?.revision !== revision ||
    !isUniqueLanguageArray(value, isRuntimeConfiguration)
  ) {
    return false;
  }
  return value.every((configuration) => {
    const configurationEtag = parseRevisionEtagParts(configuration.etag);
    return (
      configuration.revision <= revision &&
      configurationEtag?.workspaceIdentity === snapshotEtag.workspaceIdentity
    );
  });
}

function hasSameProvenance(
  left: ManagedLspConfigurationProvenance,
  right: ManagedLspConfigurationProvenance,
): boolean {
  return (
    left.activation === right.activation &&
    left.runtime === right.runtime &&
    left.settings === right.settings
  );
}

function summaryMatchesConfiguration(
  summary: ManagedLspConfigurationSummary,
  configurations: readonly ManagedLspRuntimeConfiguration[],
): boolean {
  const configuration = configurations.find((entry) => entry.language === summary.language);
  if (configuration === undefined) return !summary.configured && summary.provenance === null;
  return (
    summary.configured &&
    summary.provenance !== null &&
    hasSameProvenance(summary.provenance, configuration.provenance)
  );
}

function hasConsistentSnapshotPayload(value: UnknownRecord): boolean {
  if (
    !isRevision(value.revision) ||
    !isActivationArray(value.languages) ||
    !isCompleteLanguageArray(value.settings, isConfigurationSummary) ||
    !isSnapshotConfigurationArray(value.configurations, value.revision, value.etag)
  ) {
    return false;
  }
  const configurations = value.configurations;
  const revision = value.revision;
  return (
    value.languages.every(
      (activation) => activation.ok && activation.configurationRevision === revision,
    ) && value.settings.every((summary) => summaryMatchesConfiguration(summary, configurations))
  );
}

function validControlResponse(value: UnknownRecord): boolean {
  return (
    hasOnlyKeys(value, CONTROL_RESPONSE_KEYS) &&
    memberOf(value.storeState, ["absent", "ready", "unavailable"]) &&
    isRevision(value.revision) &&
    parseManagedLspRevisionEtag(value.etag, value.revision) !== undefined &&
    isRevision(value.evidenceCount) &&
    hasConsistentSnapshotPayload(value) &&
    isUniqueLanguageArray(value.health, isHealthSnapshot) &&
    isProviderMetadataArray(value.providerMetadata)
  );
}

function isRuntimeConfiguration(value: unknown): value is ManagedLspRuntimeConfiguration {
  return parseManagedLspRuntimeConfiguration(value).ok;
}

function isProviderMetadataArray(value: unknown): value is readonly ManagedLspProviderMetadata[] {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(isProviderMetadata) &&
      new Set(value.map((entry) => entry.language)).size === value.length)
  );
}

function parseControlResponseUnsafe(
  value: unknown,
): ManagedLspRouteParseResult<ManagedLspControlResponse> {
  if (!isRecord(value) || !validControlResponse(value)) {
    return invalid("managed LSP control response is invalid or contains unknown fields");
  }
  return { ok: true, value: value as unknown as ManagedLspControlResponse };
}

export function parseManagedLspControlResponse(
  value: unknown,
): ManagedLspRouteParseResult<ManagedLspControlResponse> {
  return parseSafely(() => parseControlResponseUnsafe(value));
}

function parseMutationResponseUnsafe(
  value: unknown,
): ManagedLspRouteParseResult<ManagedLspControlSuccessResult> {
  if (!isRecord(value)) return invalid("managed LSP mutation response must be an object");
  const status = parseManagedLspActivationStatus(value.status);
  const valid = [
    hasOnlyKeys(value, ["kind", "changed", "revision", "etag", "status"]),
    value.kind === "ok",
    typeof value.changed === "boolean",
    isRevision(value.revision),
    parseManagedLspRevisionEtag(value.etag, value.revision) !== undefined,
    status.ok && status.value.configurationRevision === value.revision,
  ].every(Boolean);
  return valid
    ? { ok: true, value: value as unknown as ManagedLspControlSuccessResult }
    : invalid("managed LSP mutation response is invalid or contains unknown fields");
}

export function parseManagedLspControlMutationResponse(
  value: unknown,
): ManagedLspRouteParseResult<ManagedLspControlSuccessResult> {
  return parseSafely(() => parseMutationResponseUnsafe(value));
}
