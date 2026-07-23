import {
  EDITOR_M7_SETTING_REGISTRY,
  EDITOR_M11_SETTINGS_SCHEMA_VERSION,
  WORKSPACE_PROFILE_DISPLAY_NAME_MAX_CHARS,
  WORKSPACE_PROFILE_SCHEMA_VERSION,
  isWorkspaceProfileDisplayName,
  isWorkspaceProfileRef,
  parseEditorM7SettingValue,
  type EditorM7SettingId,
  type EditorM7SettingValue,
  type WorkspaceProfileExportRedaction,
  type WorkspaceProfileExportResult,
  type WorkspaceProfileImportFailureCode,
  type WorkspaceProfileImportPreview,
  type WorkspaceProfileImportPreviewRow,
  type WorkspaceProfileManifest,
} from "@oscharko-dev/keiko-contracts";
import { canonicalise, containsRedactableSecret, sha256Hex } from "@oscharko-dev/keiko-security";

const IMPORT_MAX_DEPTH = 8;
const IMPORT_MAX_SETTING_ROWS = 64;
const MANIFEST_KEYS = [
  "kind",
  "schemaVersion",
  "profileRef",
  "displayName",
  "revision",
  "settings",
] as const;
const SETTINGS_KEYS = ["kind", "schemaVersion", "profileRef", "revision", "values"] as const;
const SETTING_ORDER = new Map(
  EDITOR_M7_SETTING_REGISTRY.map((definition, index) => [definition.id, index]),
);

type UnknownRecord = Readonly<Record<string, unknown>>;
type ImportValues = Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>>;

interface ImportCandidate {
  readonly displayName: string;
  readonly values: UnknownRecord;
}

export interface EditorProfileImportPreviewContext {
  readonly activeValues: ImportValues;
  readonly existingNames: readonly string[];
  readonly expectedRevision: number;
}

export type PreparedEditorProfileImport =
  | {
      readonly kind: "ok";
      readonly preview: WorkspaceProfileImportPreview;
      readonly values: ImportValues;
    }
  | { readonly kind: "invalid"; readonly code: WorkspaceProfileImportFailureCode };

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function exceedsDepth(value: unknown, depth = 0, seen = new WeakSet()): boolean {
  if (depth > IMPORT_MAX_DEPTH) return true;
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value as UnknownRecord);
  return children.some((child) => exceedsDepth(child, depth + 1, seen));
}

function versionFailure(value: unknown): WorkspaceProfileImportFailureCode | undefined {
  if (value === WORKSPACE_PROFILE_SCHEMA_VERSION) return undefined;
  return typeof value === "number" && value > WORKSPACE_PROFILE_SCHEMA_VERSION
    ? "FUTURE_SCHEMA_VERSION"
    : "UNSUPPORTED_SCHEMA_VERSION";
}

function validSettingsEnvelope(
  value: UnknownRecord,
  profileRef: unknown,
  revision: unknown,
): value is UnknownRecord & { readonly values: UnknownRecord } {
  return (
    hasOnlyKeys(value, SETTINGS_KEYS) &&
    value.kind === "editor-profile-settings" &&
    value.schemaVersion === EDITOR_M11_SETTINGS_SCHEMA_VERSION &&
    value.profileRef === profileRef &&
    value.revision === revision &&
    isRecord(value.values) &&
    Object.keys(value.values).length <= IMPORT_MAX_SETTING_ROWS
  );
}

function validManifestEnvelope(value: UnknownRecord): value is UnknownRecord & {
  readonly displayName: string;
  readonly revision: number;
  readonly settings: UnknownRecord;
} {
  return (
    hasOnlyKeys(value, MANIFEST_KEYS) &&
    value.kind === "workspace-profile" &&
    isWorkspaceProfileRef(value.profileRef) &&
    isWorkspaceProfileDisplayName(value.displayName) &&
    isRevision(value.revision) &&
    isRecord(value.settings)
  );
}

function importCandidate(value: unknown): ImportCandidate | WorkspaceProfileImportFailureCode {
  if (exceedsDepth(value)) return "IMPORT_TOO_DEEP";
  if (!isRecord(value)) return "INVALID_MANIFEST";
  const failure = versionFailure(value.schemaVersion);
  if (failure !== undefined) return failure;
  if (!validManifestEnvelope(value) || !isRecord(value.settings)) return "INVALID_MANIFEST";
  const settingsFailure = versionFailure(value.settings.schemaVersion);
  if (settingsFailure !== undefined) return settingsFailure;
  return validSettingsEnvelope(value.settings, value.profileRef, value.revision)
    ? { displayName: value.displayName, values: value.settings.values }
    : "INVALID_MANIFEST";
}

function pathLike(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.startsWith("~") ||
    /^[A-Za-z]:[/\\]/u.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)
  );
}

function portabilityReason(value: unknown): "NON_PORTABLE_PATH" | "SECRET_LIKE" | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    if (pathLike(entry)) return "NON_PORTABLE_PATH";
    if (containsRedactableSecret(entry)) return "SECRET_LIKE";
  }
  return undefined;
}

function sortedEntries(values: UnknownRecord): readonly (readonly [string, unknown])[] {
  return Object.entries(values).sort(([left], [right]) => {
    const leftOrder = SETTING_ORDER.get(left as EditorM7SettingId) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = SETTING_ORDER.get(right as EditorM7SettingId) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    if (left === right) return 0;
    return left < right ? -1 : 1;
  });
}

function previewRow(
  settingId: string,
  raw: unknown,
  activeValues: ImportValues,
): WorkspaceProfileImportPreviewRow {
  const definition = EDITOR_M7_SETTING_REGISTRY.find((entry) => entry.id === settingId);
  if (definition === undefined) {
    return { settingId, disposition: "rejected", reasonCode: "UNKNOWN_SETTING" };
  }
  if (!definition.scopes.includes("user")) {
    return { settingId, disposition: "rejected", reasonCode: "WORKSPACE_SCOPE_DENIED" };
  }
  const unsafe = portabilityReason(raw);
  if (unsafe !== undefined) return { settingId, disposition: "rejected", reasonCode: unsafe };
  const parsed = parseEditorM7SettingValue(definition.id, raw);
  if (!parsed.ok) {
    return { settingId, disposition: "rejected", reasonCode: parsed.reasonCode };
  }
  const current = activeValues[definition.id];
  let disposition: "add" | "noOp" | "change" = "change";
  if (current === undefined) disposition = "add";
  else if (canonicalise(current) === canonicalise(parsed.value)) disposition = "noOp";
  return { settingId, disposition, value: parsed.value };
}

function uniqueImportedName(source: string, existingNames: readonly string[]): string {
  const occupied = new Set(existingNames.map((name) => name.toLowerCase()));
  if (source.toLowerCase() !== "default" && !occupied.has(source.toLowerCase())) {
    return source;
  }
  for (let index = 1; index <= IMPORT_MAX_SETTING_ROWS; index += 1) {
    const suffix = index === 1 ? " (Imported)" : ` (Imported ${String(index)})`;
    const base = source
      .slice(0, WORKSPACE_PROFILE_DISPLAY_NAME_MAX_CHARS - suffix.length)
      .trimEnd();
    const candidate = `${base.length === 0 ? "Profile" : base}${suffix}`;
    if (!occupied.has(candidate.toLowerCase())) return candidate;
  }
  return "Imported profile";
}

function preparedValues(rows: readonly WorkspaceProfileImportPreviewRow[]): ImportValues {
  const values: Partial<Record<EditorM7SettingId, EditorM7SettingValue>> = {};
  for (const row of rows) {
    if (row.disposition !== "rejected" && row.value !== undefined) {
      values[row.settingId as EditorM7SettingId] = row.value;
    }
  }
  return values;
}

function buildPreview(
  candidate: ImportCandidate,
  context: EditorProfileImportPreviewContext,
): PreparedEditorProfileImport {
  const rows = sortedEntries(candidate.values).map(([id, value]) =>
    previewRow(id, value, context.activeValues),
  );
  const proposedDisplayName = uniqueImportedName(candidate.displayName, context.existingNames);
  const unsigned = {
    kind: "ok" as const,
    schemaVersion: WORKSPACE_PROFILE_SCHEMA_VERSION,
    expectedRevision: context.expectedRevision,
    sourceDisplayName: candidate.displayName,
    proposedDisplayName,
    collisionRenamed: proposedDisplayName !== candidate.displayName,
    rows,
  };
  const preview = { ...unsigned, previewDigest: sha256Hex(canonicalise(unsigned)) };
  return { kind: "ok", preview, values: preparedValues(rows) };
}

export function previewEditorProfileImport(
  value: unknown,
  context: EditorProfileImportPreviewContext,
): PreparedEditorProfileImport {
  try {
    const candidate = importCandidate(value);
    return typeof candidate === "string"
      ? { kind: "invalid", code: candidate }
      : buildPreview(candidate, context);
  } catch {
    return { kind: "invalid", code: "INVALID_MANIFEST" };
  }
}

function redaction(
  settingId: EditorM7SettingId,
  reasonCode: WorkspaceProfileExportRedaction["reasonCode"],
  rejectedCount: number,
): WorkspaceProfileExportRedaction {
  return { settingId, reasonCode, rejectedCount };
}

function sanitizeArray(
  settingId: EditorM7SettingId,
  raw: readonly unknown[],
): {
  readonly value: readonly unknown[];
  readonly redactions: readonly WorkspaceProfileExportRedaction[];
} {
  const accepted: unknown[] = [];
  const counts = { path: 0, secret: 0, invalid: 0 };
  for (const entry of raw) {
    if (typeof entry !== "string") counts.invalid += 1;
    else if (pathLike(entry)) counts.path += 1;
    else if (containsRedactableSecret(entry)) counts.secret += 1;
    else accepted.push(entry);
  }
  const redactions = [
    ...(counts.path === 0 ? [] : [redaction(settingId, "NON_PORTABLE_PATH", counts.path)]),
    ...(counts.secret === 0 ? [] : [redaction(settingId, "SECRET_LIKE", counts.secret)]),
    ...(counts.invalid === 0 ? [] : [redaction(settingId, "INVALID_VALUE", counts.invalid)]),
  ];
  return { value: accepted, redactions };
}

function sanitizeExportValues(rawValues: Readonly<Record<string, unknown>>): {
  readonly values: ImportValues;
  readonly redactions: readonly WorkspaceProfileExportRedaction[];
} {
  const values: Partial<Record<EditorM7SettingId, EditorM7SettingValue>> = {};
  const redactions: WorkspaceProfileExportRedaction[] = [];
  for (const definition of EDITOR_M7_SETTING_REGISTRY) {
    const raw = rawValues[definition.id];
    if (raw === undefined) continue;
    if (!definition.scopes.includes("user")) {
      redactions.push(redaction(definition.id, "INVALID_VALUE", 1));
      continue;
    }
    const sanitized = Array.isArray(raw)
      ? sanitizeArray(definition.id, raw)
      : { value: raw, redactions: [] };
    redactions.push(...sanitized.redactions);
    const parsed = parseEditorM7SettingValue(definition.id, sanitized.value);
    if (parsed.ok) values[definition.id] = parsed.value;
    else redactions.push(redaction(definition.id, "INVALID_VALUE", 1));
  }
  return { values, redactions };
}

export function assembleEditorProfileExport(
  profile: WorkspaceProfileManifest,
): WorkspaceProfileExportResult {
  const sanitized = sanitizeExportValues(profile.settings.values);
  const manifest: WorkspaceProfileManifest = {
    kind: "workspace-profile",
    schemaVersion: WORKSPACE_PROFILE_SCHEMA_VERSION,
    profileRef: profile.profileRef,
    displayName: profile.displayName,
    revision: profile.revision,
    settings: {
      kind: "editor-profile-settings",
      schemaVersion: EDITOR_M11_SETTINGS_SCHEMA_VERSION,
      profileRef: profile.profileRef,
      revision: profile.revision,
      values: sanitized.values,
    },
  };
  return {
    kind: "ok",
    schemaVersion: WORKSPACE_PROFILE_SCHEMA_VERSION,
    manifest,
    serializedManifest: `${JSON.stringify(manifest, null, 2)}\n`,
    redactions: sanitized.redactions,
  };
}
