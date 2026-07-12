// M7 editor personalization/resilience contracts (Epic #2095, ADR-0133).
// These contracts are deliberately browser/server neutral. Parsers are total and fail closed:
// malformed, oversized, future-versioned, unknown, or policy-disallowed input returns a typed denial
// instead of throwing or preserving untrusted fields.

export const EDITOR_M7_SCHEMA_VERSION = "1" as const;

export type EditorM7ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reasonCode: EditorM7ReasonCode };

export type EditorM7ReasonCode =
  | "INVALID_INPUT"
  | "UNKNOWN_FIELD"
  | "UNKNOWN_SETTING"
  | "SCHEMA_VERSION_UNSUPPORTED"
  | "VALUE_OUT_OF_BOUNDS"
  | "WORKSPACE_SCOPE_DENIED"
  | "POLICY_LOCKED"
  | "OVERSIZED"
  | "UNSAFE_PATH"
  | "UNSAFE_SNIPPET"
  | "RESERVED_KEYBINDING"
  | "KEYBINDING_COLLISION"
  | "UNKNOWN_COMMAND"
  | "STATE_UNAVAILABLE"
  | "OPERATOR_CEILING_DENIED"
  | "SECURITY_PREREQUISITE_MISSING"
  | "MODEL_CAPABILITY_MISSING"
  | "BUDGET_UNAVAILABLE"
  | "PROVIDER_UNHEALTHY"
  | "EXPLICIT_OPT_IN_REQUIRED"
  | "PRODUCT_UNSUPPORTED"
  | "ACTIVE";

export type EditorM7SettingScope = "user" | "workspace";
export type EditorM7SettingSource = "builtInDefault" | "user" | "workspace";
export type EditorM7SettingType = "boolean" | "integer" | "enum" | "stringArray";
export type EditorM7SettingEffect = "live" | "restart";
export type EditorM7SettingSecurity = "safe" | "policyCeiling" | "resourceBounded";

export type EditorM7SettingId =
  | "fontSize"
  | "tabSize"
  | "insertSpaces"
  | "wordWrap"
  | "renderWhitespace"
  | "minimap"
  | "formatOnSave"
  | "externalReload"
  | "inlineCompletion"
  | "testGeneration"
  | "patchApply"
  | "watcherExclusions"
  | "largeFileMode"
  | "modelRetentionCount"
  | "modelRetentionBytes"
  | "keybindingOverrides";

export type EditorM7WordWrap = "off" | "on" | "wordWrapColumn" | "bounded";
export type EditorM7WhitespaceRendering = "none" | "selection" | "boundary" | "all";
export type EditorM7ExternalReloadPolicy = "prompt" | "autoClean" | "manual";
export type EditorM7LargeFileMode = "default" | "degraded" | "readonly";
export type EditorM7SettingValue =
  | boolean
  | number
  | EditorM7WordWrap
  | EditorM7WhitespaceRendering
  | EditorM7ExternalReloadPolicy
  | EditorM7LargeFileMode
  | readonly string[];

export interface EditorM7SettingDefinition {
  readonly id: EditorM7SettingId;
  readonly type: EditorM7SettingType;
  readonly defaultValue: EditorM7SettingValue;
  readonly scopes: readonly EditorM7SettingScope[];
  readonly effect: EditorM7SettingEffect;
  readonly security: EditorM7SettingSecurity;
  readonly enumValues?: readonly string[] | undefined;
  readonly minimum?: number | undefined;
  readonly maximum?: number | undefined;
  readonly maxItems?: number | undefined;
  readonly maxItemBytes?: number | undefined;
  readonly description: string;
}

export interface EditorM7SettingsLayer {
  readonly scope: EditorM7SettingScope;
  readonly values: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>>;
}

export interface EditorM7PolicyCeiling {
  readonly locked: Readonly<Partial<Record<EditorM7SettingId, EditorM7ReasonCode>>>;
}

export interface EditorM7ResolvedSetting {
  readonly id: EditorM7SettingId;
  readonly value: EditorM7SettingValue;
  readonly source: EditorM7SettingSource;
  readonly scope: EditorM7SettingScope;
  readonly policyLocked: boolean;
  readonly reasonCode?: EditorM7ReasonCode | undefined;
  readonly effect: EditorM7SettingEffect;
}

export interface EditorM7SettingsRecord {
  readonly schemaVersion: typeof EDITOR_M7_SCHEMA_VERSION;
  readonly revision: number;
  readonly values: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>>;
}

export type EditorM7StoreState = "absent" | "ready" | "unavailable";

export interface EditorM7SettingsSnapshot {
  readonly schemaVersion: typeof EDITOR_M7_SCHEMA_VERSION;
  readonly storeState: EditorM7StoreState;
  readonly userRevision: number;
  readonly workspaceRevision: number;
  readonly revision: number;
  readonly etag: string;
  readonly root?: string | undefined;
  readonly definitions: readonly EditorM7SettingDefinition[];
  readonly settings: readonly EditorM7ResolvedSetting[];
  readonly eventSequence: number;
  readonly managedLanguages?:
    | {
        readonly revision: number;
        readonly etag: string;
        readonly storeState: EditorM7StoreState;
        readonly settingsCount: number;
      }
    | undefined;
  readonly aiAssistance?: EditorM7AiActivationSummary | undefined;
}

export type EditorM7SettingsMutationAction = "set" | "reset";

export interface EditorM7SettingsMutation {
  readonly schemaVersion: typeof EDITOR_M7_SCHEMA_VERSION;
  readonly root?: string | undefined;
  readonly scope: EditorM7SettingScope;
  readonly action: EditorM7SettingsMutationAction;
  readonly expectedRevision: number;
  readonly values?: Readonly<Partial<Record<EditorM7SettingId, EditorM7SettingValue>>> | undefined;
  readonly settingIds?: readonly EditorM7SettingId[] | undefined;
}

export interface EditorM7SettingsMutationOk {
  readonly kind: "ok";
  readonly changed: boolean;
  readonly revision: number;
  readonly etag: string;
  readonly snapshot: EditorM7SettingsSnapshot;
}

export type EditorM7SettingsMutationResult =
  | EditorM7SettingsMutationOk
  | { readonly kind: "conflict"; readonly code: "STALE_REVISION"; readonly etag: string }
  | {
      readonly kind: "idempotencyConflict";
      readonly code: "IDEMPOTENCY_KEY_REUSED";
      readonly etag: string;
    }
  | { readonly kind: "invalid"; readonly code: EditorM7ReasonCode }
  | { readonly kind: "unavailable"; readonly code: "STATE_UNAVAILABLE" };

export interface EditorM7SettingsEvent {
  readonly schemaVersion: typeof EDITOR_M7_SCHEMA_VERSION;
  readonly sequence: number;
  readonly kind: "changed" | "snapshot";
  readonly revision: number;
  readonly userRevision: number;
  readonly workspaceRevision: number;
  readonly scope: EditorM7SettingScope;
  readonly settingIds: readonly EditorM7SettingId[];
  readonly storeState: EditorM7StoreState;
}

const ENUM_VALUES: Readonly<
  Record<"wordWrap" | "renderWhitespace" | "externalReload" | "largeFileMode", readonly string[]>
> = Object.freeze({
  wordWrap: Object.freeze(["off", "on", "wordWrapColumn", "bounded"] as const),
  renderWhitespace: Object.freeze(["none", "selection", "boundary", "all"] as const),
  externalReload: Object.freeze(["prompt", "autoClean", "manual"] as const),
  largeFileMode: Object.freeze(["default", "degraded", "readonly"] as const),
});

export const EDITOR_M7_SETTING_REGISTRY: readonly EditorM7SettingDefinition[] = Object.freeze([
  {
    id: "fontSize",
    type: "integer",
    defaultValue: 13,
    scopes: Object.freeze(["user", "workspace"] as const),
    effect: "live",
    security: "safe",
    minimum: 8,
    maximum: 32,
    description: "Monaco editor font size in CSS pixels.",
  },
  {
    id: "tabSize",
    type: "integer",
    defaultValue: 2,
    scopes: Object.freeze(["user", "workspace"] as const),
    effect: "live",
    security: "safe",
    minimum: 1,
    maximum: 12,
    description: "Editor tab width.",
  },
  {
    id: "insertSpaces",
    type: "boolean",
    defaultValue: true,
    scopes: Object.freeze(["user", "workspace"] as const),
    effect: "live",
    security: "safe",
    description: "Insert spaces when indentation is generated.",
  },
  {
    id: "wordWrap",
    type: "enum",
    defaultValue: "off",
    scopes: Object.freeze(["user", "workspace"] as const),
    effect: "live",
    security: "safe",
    enumValues: ENUM_VALUES.wordWrap,
    description: "Monaco word wrapping mode.",
  },
  {
    id: "renderWhitespace",
    type: "enum",
    defaultValue: "selection",
    scopes: Object.freeze(["user", "workspace"] as const),
    effect: "live",
    security: "safe",
    enumValues: ENUM_VALUES.renderWhitespace,
    description: "Whitespace visualization mode.",
  },
  {
    id: "minimap",
    type: "boolean",
    defaultValue: false,
    scopes: Object.freeze(["user"] as const),
    effect: "live",
    security: "safe",
    description: "Minimap visibility. Workspace overrides are denied to preserve dense layouts.",
  },
  {
    id: "formatOnSave",
    type: "boolean",
    defaultValue: false,
    scopes: Object.freeze(["user", "workspace"] as const),
    effect: "live",
    security: "safe",
    description: "Run the existing governed formatter before save.",
  },
  {
    id: "externalReload",
    type: "enum",
    defaultValue: "prompt",
    scopes: Object.freeze(["user", "workspace"] as const),
    effect: "live",
    security: "safe",
    enumValues: ENUM_VALUES.externalReload,
    description: "Clean-buffer external reload behavior; dirty buffers still require choice.",
  },
  {
    id: "inlineCompletion",
    type: "boolean",
    defaultValue: false,
    scopes: Object.freeze(["user"] as const),
    effect: "live",
    security: "policyCeiling",
    description: "Explicit user opt-in for governed inline AI completion.",
  },
  {
    id: "testGeneration",
    type: "boolean",
    defaultValue: false,
    scopes: Object.freeze(["workspace"] as const),
    effect: "live",
    security: "policyCeiling",
    description:
      "Explicit workspace opt-in for governed AI test generation; generated tests still require human review.",
  },
  {
    id: "patchApply",
    type: "boolean",
    defaultValue: false,
    scopes: Object.freeze(["workspace"] as const),
    effect: "live",
    security: "policyCeiling",
    description:
      "Explicit workspace opt-in for governed AI patch apply; apply remains review-first and never widens delivery authority.",
  },
  {
    id: "watcherExclusions",
    type: "stringArray",
    defaultValue: Object.freeze([".git/**", "node_modules/**", "dist/**"] as const),
    scopes: Object.freeze(["user", "workspace"] as const),
    effect: "restart",
    security: "resourceBounded",
    maxItems: 64,
    maxItemBytes: 256,
    description: "Bounded root-relative watcher exclusion globs.",
  },
  {
    id: "largeFileMode",
    type: "enum",
    defaultValue: "default",
    scopes: Object.freeze(["user", "workspace"] as const),
    effect: "live",
    security: "resourceBounded",
    enumValues: ENUM_VALUES.largeFileMode,
    description: "Large-file behavior within the existing hard server size limits.",
  },
  {
    id: "modelRetentionCount",
    type: "integer",
    defaultValue: 32,
    scopes: Object.freeze(["user", "workspace"] as const),
    effect: "live",
    security: "resourceBounded",
    minimum: 4,
    maximum: 128,
    description: "Maximum retained clean inactive Monaco models.",
  },
  {
    id: "modelRetentionBytes",
    type: "integer",
    defaultValue: 64 * 1024 * 1024,
    scopes: Object.freeze(["user", "workspace"] as const),
    effect: "live",
    security: "resourceBounded",
    minimum: 4 * 1024 * 1024,
    maximum: 256 * 1024 * 1024,
    description: "Approximate retained clean inactive Monaco model byte budget.",
  },
  {
    id: "keybindingOverrides",
    type: "stringArray",
    defaultValue: Object.freeze([] as const),
    scopes: Object.freeze(["user", "workspace"] as const),
    effect: "live",
    security: "safe",
    maxItems: 64,
    maxItemBytes: 192,
    description: "Bounded M7 keyboard shortcut override records.",
  },
] as const satisfies readonly EditorM7SettingDefinition[]);

const SETTING_IDS = Object.freeze(EDITOR_M7_SETTING_REGISTRY.map((entry) => entry.id));

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function definitionFor(id: EditorM7SettingId): EditorM7SettingDefinition {
  const definition = EDITOR_M7_SETTING_REGISTRY.find((entry) => entry.id === id);
  if (definition === undefined) {
    throw new Error(`unknown editor setting id: ${id}`);
  }
  return definition;
}

function isSettingId(value: unknown): value is EditorM7SettingId {
  return typeof value === "string" && SETTING_IDS.includes(value as EditorM7SettingId);
}

function parseInteger(
  value: unknown,
  definition: EditorM7SettingDefinition,
): EditorM7ParseResult<number> {
  const valid =
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= (definition.minimum ?? Number.MIN_SAFE_INTEGER) &&
    value <= (definition.maximum ?? Number.MAX_SAFE_INTEGER);
  return valid ? { ok: true, value } : { ok: false, reasonCode: "VALUE_OUT_OF_BOUNDS" };
}

function parseBoolean(value: unknown): EditorM7ParseResult<boolean> {
  return typeof value === "boolean"
    ? { ok: true, value }
    : { ok: false, reasonCode: "VALUE_OUT_OF_BOUNDS" };
}

function parseEnum(
  value: unknown,
  definition: EditorM7SettingDefinition,
): EditorM7ParseResult<EditorM7SettingValue> {
  const values = definition.enumValues ?? [];
  return typeof value === "string" && values.includes(value)
    ? { ok: true, value: value as EditorM7SettingValue }
    : { ok: false, reasonCode: "VALUE_OUT_OF_BOUNDS" };
}

function safeSettingPathToken(value: string, maxBytes: number): boolean {
  return (
    utf8ByteLength(value) <= maxBytes &&
    value.length > 0 &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index) ?? 0;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code > 0xffff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function parseStringArray(
  value: unknown,
  definition: EditorM7SettingDefinition,
): EditorM7ParseResult<readonly string[]> {
  if (!Array.isArray(value) || value.length > (definition.maxItems ?? 0)) {
    return { ok: false, reasonCode: "OVERSIZED" };
  }
  const maxBytes = definition.maxItemBytes ?? 0;
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !safeSettingPathToken(entry, maxBytes) || seen.has(entry)) {
      return { ok: false, reasonCode: "UNSAFE_PATH" };
    }
    seen.add(entry);
  }
  return { ok: true, value: Object.freeze([...seen]) };
}

export function parseEditorM7SettingValue(
  id: EditorM7SettingId,
  value: unknown,
): EditorM7ParseResult<EditorM7SettingValue> {
  if (!isSettingId(id)) return { ok: false, reasonCode: "UNKNOWN_SETTING" };
  const definition = definitionFor(id);
  if (definition.type === "integer") return parseInteger(value, definition);
  if (definition.type === "boolean") return parseBoolean(value);
  if (definition.type === "enum") return parseEnum(value, definition);
  if (id === "keybindingOverrides") return parseEditorM7KeybindingOverrideSetting(value);
  return parseStringArray(value, definition);
}

function parseEditorM7SettingPatchUnsafe(
  scope: EditorM7SettingScope,
  value: unknown,
): EditorM7ParseResult<EditorM7SettingsLayer> {
  if (!isRecord(value)) return { ok: false, reasonCode: "INVALID_INPUT" };
  const values: Partial<Record<EditorM7SettingId, EditorM7SettingValue>> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isSettingId(key)) return { ok: false, reasonCode: "UNKNOWN_SETTING" };
    const definition = definitionFor(key);
    if (!definition.scopes.includes(scope))
      return { ok: false, reasonCode: "WORKSPACE_SCOPE_DENIED" };
    const parsed = parseEditorM7SettingValue(key, raw);
    if (!parsed.ok) return parsed;
    values[key] = parsed.value;
  }
  return { ok: true, value: { scope, values } };
}

export function parseEditorM7SettingPatch(
  scope: EditorM7SettingScope,
  value: unknown,
): EditorM7ParseResult<EditorM7SettingsLayer> {
  try {
    return parseEditorM7SettingPatchUnsafe(scope, value);
  } catch {
    return { ok: false, reasonCode: "INVALID_INPUT" };
  }
}

export function defaultEditorM7Settings(): Readonly<
  Record<EditorM7SettingId, EditorM7SettingValue>
> {
  return Object.freeze(
    Object.fromEntries(
      EDITOR_M7_SETTING_REGISTRY.map((entry) => [entry.id, entry.defaultValue]),
    ) as Record<EditorM7SettingId, EditorM7SettingValue>,
  );
}

function layerValue(
  id: EditorM7SettingId,
  layer: EditorM7SettingsLayer | undefined,
): EditorM7SettingValue | undefined {
  return layer?.values[id];
}

function resolveOneSetting(
  definition: EditorM7SettingDefinition,
  user: EditorM7SettingsLayer | undefined,
  workspace: EditorM7SettingsLayer | undefined,
  ceiling: EditorM7PolicyCeiling | undefined,
): EditorM7ResolvedSetting {
  const lockedReason = ceiling?.locked[definition.id];
  const workspaceValue = layerValue(definition.id, workspace);
  const userValue = layerValue(definition.id, user);
  const source = settingSource(workspaceValue, userValue);
  const value = workspaceValue ?? userValue ?? definition.defaultValue;
  return {
    id: definition.id,
    value,
    source,
    scope: source === "workspace" ? "workspace" : "user",
    policyLocked: lockedReason !== undefined,
    ...(lockedReason === undefined ? {} : { reasonCode: lockedReason }),
    effect: definition.effect,
  };
}

function settingSource(
  workspaceValue: EditorM7SettingValue | undefined,
  userValue: EditorM7SettingValue | undefined,
): EditorM7ResolvedSetting["source"] {
  if (workspaceValue !== undefined) return "workspace";
  return userValue === undefined ? "builtInDefault" : "user";
}

export function resolveEditorM7Settings(args: {
  readonly user?: EditorM7SettingsLayer | undefined;
  readonly workspace?: EditorM7SettingsLayer | undefined;
  readonly ceiling?: EditorM7PolicyCeiling | undefined;
}): readonly EditorM7ResolvedSetting[] {
  return Object.freeze(
    EDITOR_M7_SETTING_REGISTRY.map((definition) =>
      resolveOneSetting(definition, args.user, args.workspace, args.ceiling),
    ),
  );
}

export function parseEditorM7SettingsRecord(
  value: unknown,
  scope: EditorM7SettingScope = "user",
): EditorM7ParseResult<EditorM7SettingsRecord> {
  try {
    return parseEditorM7SettingsRecordUnsafe(value, scope);
  } catch {
    return { ok: false, reasonCode: "INVALID_INPUT" };
  }
}

function parseEditorM7SettingsRecordUnsafe(
  value: unknown,
  scope: EditorM7SettingScope,
): EditorM7ParseResult<EditorM7SettingsRecord> {
  if (!isRecord(value)) return { ok: false, reasonCode: "INVALID_INPUT" };
  if (!hasOnlyKeys(value, ["schemaVersion", "revision", "values"])) {
    return { ok: false, reasonCode: "UNKNOWN_FIELD" };
  }
  if (value.schemaVersion !== EDITOR_M7_SCHEMA_VERSION) {
    return { ok: false, reasonCode: "SCHEMA_VERSION_UNSUPPORTED" };
  }
  if (
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  ) {
    return { ok: false, reasonCode: "INVALID_INPUT" };
  }
  const parsed = parseEditorM7SettingPatch(scope, value.values);
  return parsed.ok
    ? {
        ok: true,
        value: {
          schemaVersion: EDITOR_M7_SCHEMA_VERSION,
          revision: value.revision,
          values: parsed.value.values,
        },
      }
    : parsed;
}

export function parseEditorM7SettingsEvent(
  value: unknown,
): EditorM7ParseResult<EditorM7SettingsEvent> {
  try {
    return parseEditorM7SettingsEventUnsafe(value);
  } catch {
    return { ok: false, reasonCode: "INVALID_INPUT" };
  }
}

function parseEditorM7SettingsEventUnsafe(
  value: unknown,
): EditorM7ParseResult<EditorM7SettingsEvent> {
  if (!validSettingsEventEnvelope(value)) {
    return { ok: false, reasonCode: "INVALID_INPUT" };
  }
  if (!Array.isArray(value.settingIds) || !value.settingIds.every(isSettingId)) {
    return { ok: false, reasonCode: "UNKNOWN_SETTING" };
  }
  return {
    ok: true,
    value: {
      schemaVersion: EDITOR_M7_SCHEMA_VERSION,
      sequence: value.sequence,
      kind: value.kind,
      revision: value.revision,
      userRevision: value.userRevision,
      workspaceRevision: value.workspaceRevision,
      scope: value.scope,
      settingIds: Object.freeze([...value.settingIds]),
      storeState: value.storeState,
    },
  };
}

interface SettingsEventRecord {
  readonly sequence: number;
  readonly kind: "changed" | "snapshot";
  readonly revision: number;
  readonly userRevision: number;
  readonly workspaceRevision: number;
  readonly scope: EditorM7SettingScope;
  readonly settingIds: unknown[];
  readonly storeState: EditorM7StoreState;
}

function validSettingsEventEnvelope(value: unknown): value is SettingsEventRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, SETTINGS_EVENT_KEYS)) return false;
  return (
    value.schemaVersion === EDITOR_M7_SCHEMA_VERSION &&
    validSettingsEventKind(value.kind) &&
    validSettingsEventRevisions(value) &&
    (value.scope === "user" || value.scope === "workspace") &&
    validStoreState(value.storeState) &&
    Array.isArray(value.settingIds)
  );
}

const SETTINGS_EVENT_KEYS = Object.freeze([
  "schemaVersion",
  "sequence",
  "kind",
  "revision",
  "userRevision",
  "workspaceRevision",
  "scope",
  "settingIds",
  "storeState",
] as const);

function validSettingsEventKind(value: unknown): value is "changed" | "snapshot" {
  return value === "changed" || value === "snapshot";
}

function validNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validSettingsEventRevisions(value: UnknownRecord): boolean {
  return (
    validNonNegativeInteger(value.sequence) &&
    validNonNegativeInteger(value.revision) &&
    validNonNegativeInteger(value.userRevision) &&
    validNonNegativeInteger(value.workspaceRevision)
  );
}

function validStoreState(value: unknown): value is EditorM7StoreState {
  return value === "absent" || value === "ready" || value === "unavailable";
}

export type EditorM7WatchEventKind =
  "created" | "changed" | "deleted" | "renamed" | "rescan" | "overflow";
export type EditorM7WatchHealth = "healthy" | "degraded" | "rescanRequired" | "stopped";
export type EditorM7WatchEntryKind = "file" | "directory" | "symlink" | "unknown";
export type EditorM7WatchDegradedReason =
  | "native-watch-unavailable"
  | "unsupported-recursive-watch"
  | "event-overflow"
  | "sequence-gap"
  | "ambiguous-event"
  | "unsafe-path"
  | "root-replaced"
  | "shutdown";

export interface EditorM7WatchEvent {
  readonly schemaVersion: typeof EDITOR_M7_SCHEMA_VERSION;
  readonly sequence: number;
  readonly kind: EditorM7WatchEventKind;
  readonly relativePath: string;
  readonly oldRelativePath?: string | undefined;
  readonly entryKind?: EditorM7WatchEntryKind | undefined;
  readonly sizeBytes?: number | undefined;
  readonly modifiedAt?: number | undefined;
  readonly metadataHash?: string | undefined;
  readonly health?: EditorM7WatchHealth | undefined;
  readonly reason?: EditorM7WatchDegradedReason | undefined;
}

export interface EditorM7WatchSnapshot {
  readonly schemaVersion: typeof EDITOR_M7_SCHEMA_VERSION;
  readonly sequence: number;
  readonly health: EditorM7WatchHealth;
  readonly rootToken: string;
  readonly nativeWatcherCount: number;
  readonly subscriberCount: number;
  readonly queueDepth: number;
  readonly replayCapacity: number;
  readonly replayOldestSequence: number;
  readonly eventCount: number;
  readonly requiresSnapshot: boolean;
  readonly degradedReasons: readonly EditorM7WatchDegradedReason[];
}

const HASH_PATTERN = /^[a-f0-9]{16,64}$/u;

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === "string" && (value.length === 0 || safeSettingPathToken(value, 4_096));
}

function isWatchKind(value: unknown): value is EditorM7WatchEventKind {
  return (
    value === "created" ||
    value === "changed" ||
    value === "deleted" ||
    value === "renamed" ||
    value === "rescan" ||
    value === "overflow"
  );
}

function isWatchHealth(value: unknown): value is EditorM7WatchHealth {
  return (
    value === "healthy" || value === "degraded" || value === "rescanRequired" || value === "stopped"
  );
}

function isWatchEntryKind(value: unknown): value is EditorM7WatchEntryKind {
  return value === "file" || value === "directory" || value === "symlink" || value === "unknown";
}

function isWatchDegradedReason(value: unknown): value is EditorM7WatchDegradedReason {
  return (
    value === "native-watch-unavailable" ||
    value === "unsupported-recursive-watch" ||
    value === "event-overflow" ||
    value === "sequence-gap" ||
    value === "ambiguous-event" ||
    value === "unsafe-path" ||
    value === "root-replaced" ||
    value === "shutdown"
  );
}

export function parseEditorM7WatchEvent(value: unknown): EditorM7ParseResult<EditorM7WatchEvent> {
  try {
    return parseEditorM7WatchEventUnsafe(value);
  } catch {
    return { ok: false, reasonCode: "INVALID_INPUT" };
  }
}

function parseEditorM7WatchEventUnsafe(value: unknown): EditorM7ParseResult<EditorM7WatchEvent> {
  if (!validWatchEnvelope(value)) {
    return { ok: false, reasonCode: "INVALID_INPUT" };
  }
  if (!validWatchPayload(value)) {
    return { ok: false, reasonCode: "UNSAFE_PATH" };
  }
  return { ok: true, value: value as unknown as EditorM7WatchEvent };
}

function validWatchEnvelope(value: unknown): value is UnknownRecord {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "schemaVersion",
      "sequence",
      "kind",
      "relativePath",
      "oldRelativePath",
      "entryKind",
      "sizeBytes",
      "modifiedAt",
      "metadataHash",
      "health",
      "reason",
    ]) &&
    value.schemaVersion === EDITOR_M7_SCHEMA_VERSION &&
    validNonNegativeInteger(value.sequence)
  );
}

function validWatchPayload(value: UnknownRecord): boolean {
  return (
    isWatchKind(value.kind) &&
    isSafeRelativePath(value.relativePath) &&
    validOptionalRelativePath(value.oldRelativePath) &&
    validOptionalEntryKind(value.entryKind) &&
    validOptionalNonNegativeNumber(value.sizeBytes) &&
    validOptionalNonNegativeNumber(value.modifiedAt) &&
    validOptionalMetadataHash(value.metadataHash) &&
    validOptionalWatchHealth(value.health) &&
    validOptionalWatchReason(value.reason)
  );
}

function validOptionalRelativePath(value: unknown): boolean {
  return value === undefined || isSafeRelativePath(value);
}

function validOptionalMetadataHash(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && HASH_PATTERN.test(value));
}

function validOptionalEntryKind(value: unknown): boolean {
  return value === undefined || isWatchEntryKind(value);
}

function validOptionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function validOptionalWatchHealth(value: unknown): boolean {
  return value === undefined || isWatchHealth(value);
}

function validOptionalWatchReason(value: unknown): boolean {
  return value === undefined || isWatchDegradedReason(value);
}

export function parseEditorM7WatchSnapshot(
  value: unknown,
): EditorM7ParseResult<EditorM7WatchSnapshot> {
  try {
    return parseEditorM7WatchSnapshotUnsafe(value);
  } catch {
    return { ok: false, reasonCode: "INVALID_INPUT" };
  }
}

function parseEditorM7WatchSnapshotUnsafe(
  value: unknown,
): EditorM7ParseResult<EditorM7WatchSnapshot> {
  if (!validWatchSnapshotEnvelope(value)) {
    return { ok: false, reasonCode: "INVALID_INPUT" };
  }
  if (!value.degradedReasons.every(isWatchDegradedReason)) {
    return { ok: false, reasonCode: "INVALID_INPUT" };
  }
  return {
    ok: true,
    value: {
      ...value,
      degradedReasons: Object.freeze([...value.degradedReasons]),
    },
  };
}

function validWatchSnapshotEnvelope(value: unknown): value is EditorM7WatchSnapshot {
  if (!isRecord(value) || !hasOnlyKeys(value, WATCH_SNAPSHOT_KEYS)) return false;
  return (
    value.schemaVersion === EDITOR_M7_SCHEMA_VERSION &&
    isWatchHealth(value.health) &&
    validWatchSnapshotToken(value.rootToken) &&
    validWatchSnapshotNumbers(value) &&
    typeof value.requiresSnapshot === "boolean" &&
    Array.isArray(value.degradedReasons)
  );
}

function validWatchSnapshotToken(value: unknown): boolean {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function validWatchSnapshotNumbers(value: UnknownRecord): boolean {
  return (
    validNonNegativeInteger(value.sequence) &&
    validNonNegativeInteger(value.nativeWatcherCount) &&
    validNonNegativeInteger(value.subscriberCount) &&
    validNonNegativeInteger(value.queueDepth) &&
    validNonNegativeInteger(value.replayCapacity) &&
    validNonNegativeInteger(value.replayOldestSequence) &&
    validNonNegativeInteger(value.eventCount)
  );
}

const WATCH_SNAPSHOT_KEYS = Object.freeze([
  "schemaVersion",
  "sequence",
  "health",
  "rootToken",
  "nativeWatcherCount",
  "subscriberCount",
  "queueDepth",
  "replayCapacity",
  "replayOldestSequence",
  "eventCount",
  "requiresSnapshot",
  "degradedReasons",
] as const);

export interface EditorM7ModelEntry {
  readonly identity: string;
  readonly byteSize: number;
  readonly lastAccessSequence: number;
  readonly dirty: boolean;
  readonly pinned: boolean;
  readonly active: boolean;
  readonly pendingOperation: boolean;
}

export interface EditorM7ModelEvictionPlan {
  readonly retained: readonly string[];
  readonly evicted: readonly string[];
  readonly protected: readonly string[];
}

function evictionEligible(entry: EditorM7ModelEntry): boolean {
  return !entry.dirty && !entry.pinned && !entry.active && !entry.pendingOperation;
}

function overBudget(
  retained: readonly EditorM7ModelEntry[],
  maximumCount: number,
  maximumBytes: number,
): boolean {
  const bytes = retained.reduce((total, entry) => total + entry.byteSize, 0);
  return retained.length > maximumCount || bytes > maximumBytes;
}

// D4 baseline reference algorithm. The production runtime
// (packages/keiko-editor/src/components/editor-model-registry.ts, issue #2322) implements its own
// eviction policy with a richer protection predicate (pending-save, pending-conflict,
// hot-exit-recovery, and agent-review states) and does not call this function. See ADR-0133
// Consequences for #2322.
export function planEditorM7ModelEviction(args: {
  readonly entries: readonly EditorM7ModelEntry[];
  readonly maximumCount: number;
  readonly maximumBytes: number;
}): EditorM7ModelEvictionPlan {
  const sorted = [...args.entries].sort(
    (left, right) => left.lastAccessSequence - right.lastAccessSequence,
  );
  const retained = [...args.entries];
  const evicted: string[] = [];
  for (const candidate of sorted) {
    if (!overBudget(retained, args.maximumCount, args.maximumBytes)) break;
    if (!evictionEligible(candidate)) continue;
    evicted.push(candidate.identity);
    retained.splice(
      retained.findIndex((entry) => entry.identity === candidate.identity),
      1,
    );
  }
  const protectedEntries = args.entries.filter((entry) => !evictionEligible(entry));
  return {
    retained: retained.map((entry) => entry.identity),
    evicted,
    protected: protectedEntries.map((entry) => entry.identity),
  };
}

export type EditorM7CommandScope = "global" | "editor" | "explorer" | "git" | "settings";
export type EditorM7CommandContext = "global" | "editor" | "monaco" | "settings" | "explorer";
export type EditorM7CommandDispatchOwner = "keiko" | "monaco";

export interface EditorM7CommandDefinition {
  readonly id: string;
  readonly labelKey: string;
  readonly descriptionKey: string;
  readonly scope: EditorM7CommandScope;
  readonly contexts: readonly EditorM7CommandContext[];
  readonly defaultBindings: readonly string[];
  readonly rebindable: boolean;
  readonly dispatchOwner: EditorM7CommandDispatchOwner;
}

function editorCommand(
  id: string,
  labelKey: string,
  scope: EditorM7CommandScope,
  contexts: readonly EditorM7CommandContext[],
  defaultBindings: readonly string[],
  rebindable: boolean,
  dispatchOwner: EditorM7CommandDispatchOwner = "keiko",
): EditorM7CommandDefinition {
  return {
    id,
    labelKey,
    descriptionKey: `${labelKey}.description`,
    scope,
    contexts: Object.freeze([...contexts]),
    defaultBindings: Object.freeze([...defaultBindings]),
    rebindable,
    dispatchOwner,
  };
}

export const EDITOR_M7_COMMAND_REGISTRY: readonly EditorM7CommandDefinition[] = Object.freeze([
  editorCommand("undo", "command.undo", "global", ["global"], ["CtrlOrMeta+Z"], true),
  editorCommand("redo", "command.redo", "global", ["global"], ["CtrlOrMeta+Shift+Z"], true),
  editorCommand("focus-status", "command.focusStatus", "global", ["global"], ["Alt+S"], true),
  editorCommand(
    "focus-workspace-search",
    "command.focusWorkspaceSearch",
    "global",
    ["global"],
    ["CtrlOrMeta+Shift+F"],
    true,
  ),
  editorCommand(
    "quick-access.files",
    "command.quickAccessFiles",
    "global",
    ["global", "editor"],
    ["CtrlOrMeta+P"],
    true,
  ),
  editorCommand(
    "quick-access.commands",
    "command.quickAccessCommands",
    "global",
    ["global", "editor"],
    ["CtrlOrMeta+Shift+P"],
    true,
  ),
  editorCommand(
    "open-editor-settings",
    "command.openEditorSettings",
    "settings",
    ["settings"],
    ["CtrlOrMeta+,"],
    true,
  ),
  editorCommand(
    "view.splitRight",
    "command.splitEditorRight",
    "editor",
    ["editor"],
    ["CtrlOrMeta+Alt+\\"],
    true,
  ),
  editorCommand("view.splitDown", "command.splitEditorDown", "editor", ["editor"], [], true),
  editorCommand("view.closeSplit", "command.closeEditorSplit", "editor", ["editor"], [], true),
  editorCommand(
    "tab.next",
    "command.nextEditorTab",
    "editor",
    ["editor"],
    ["CtrlOrMeta+Alt+ArrowRight"],
    true,
  ),
  editorCommand(
    "tab.prev",
    "command.previousEditorTab",
    "editor",
    ["editor"],
    ["CtrlOrMeta+Alt+ArrowLeft"],
    true,
  ),
  editorCommand("tab.close", "command.closeEditorTab", "editor", ["editor"], [], true),
  editorCommand(
    "tab.reopenClosed",
    "command.reopenClosedEditor",
    "editor",
    ["editor"],
    ["CtrlOrMeta+Alt+R"],
    true,
  ),
  editorCommand(
    "files.saveAll",
    "command.saveAllEditors",
    "editor",
    ["editor"],
    ["CtrlOrMeta+Alt+S"],
    true,
  ),
  editorCommand(
    "editor.save",
    "command.editorSave",
    "editor",
    ["editor", "monaco"],
    ["CtrlOrMeta+S"],
    false,
    "monaco",
  ),
  editorCommand(
    "editor.find",
    "command.editorFind",
    "editor",
    ["editor", "monaco"],
    ["CtrlOrMeta+F"],
    false,
    "monaco",
  ),
  editorCommand(
    "editor.format",
    "command.editorFormat",
    "editor",
    ["editor", "monaco"],
    ["Shift+Alt+F"],
    false,
    "monaco",
  ),
  editorCommand(
    "editor.generateTests",
    "command.editorGenerateTests",
    "editor",
    ["editor", "monaco"],
    ["CtrlOrMeta+Alt+T"],
    false,
    "monaco",
  ),
  editorCommand(
    "editor.askKeikoAboutSelection",
    "command.editorAskSelection",
    "editor",
    ["editor", "monaco"],
    ["CtrlOrMeta+Alt+K"],
    false,
    "monaco",
  ),
  editorCommand(
    "editor.renameSymbol",
    "command.editorRenameSymbol",
    "editor",
    ["editor", "monaco"],
    ["F2"],
    false,
    "monaco",
  ),
  editorCommand(
    "editor.action.accessibilityHelp",
    "command.editorAccessibilityHelp",
    "editor",
    ["editor", "monaco"],
    ["Alt+F1"],
    false,
    "monaco",
  ),
] as const satisfies readonly EditorM7CommandDefinition[]);

export const EDITOR_M7_KEYBINDING_OVERRIDE_VERSION = "1" as const;

export interface EditorM7KeybindingOverride {
  readonly schemaVersion: typeof EDITOR_M7_KEYBINDING_OVERRIDE_VERSION;
  readonly commandId: string;
  readonly binding: string;
}

export interface EditorM7ActiveKeybinding {
  readonly commandId: string;
  readonly binding: string;
}

const RESERVED_BINDINGS = Object.freeze([
  "CtrlOrMeta+Q",
  "CtrlOrMeta+W",
  "CtrlOrMeta+R",
  "CtrlOrMeta+T",
  "CtrlOrMeta+Shift+N",
]);
const MODIFIERS = Object.freeze(["Ctrl", "Meta", "CtrlOrMeta", "Alt", "Shift"]);
const MAX_KEYBINDING_OVERRIDES = 64;
const MAX_KEYBINDING_OVERRIDE_BYTES = 192;
const KEYBINDING_OVERRIDE_SEPARATOR = "|";

function commandFor(id: string): EditorM7CommandDefinition | undefined {
  return EDITOR_M7_COMMAND_REGISTRY.find((entry) => entry.id === id);
}

function normalizeBinding(binding: string): string {
  return binding
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("+");
}

// Case and modifier-order neutral comparison key. `normalizeBinding` preserves the caller's
// casing/order for the stored/returned value, so reserved-chord matching must not rely on exact
// string equality: "shift+ctrlormeta+n" and "CtrlOrMeta+Shift+N" are the same physical chord.
function canonicalBindingKey(binding: string): string {
  const parts = binding.split("+").map((part) => part.trim().toLowerCase());
  const key = parts.at(-1) ?? "";
  const modifiers = parts.slice(0, -1).sort((left, right) => left.localeCompare(right));
  return [...modifiers, key].join("+");
}

function isReservedBinding(binding: string): boolean {
  const canonical = canonicalBindingKey(binding);
  return RESERVED_BINDINGS.some((reserved) => canonicalBindingKey(reserved) === canonical);
}

function syntacticallyValidBinding(binding: string): boolean {
  const parts = binding.split("+");
  const key = parts.at(-1);
  if (key === undefined || MODIFIERS.includes(key)) return false;
  return parts.every(isSafeKeybindingPart);
}

function isSafeKeybindingPart(part: string): boolean {
  if (part.length === 0) return false;
  for (const char of part) {
    if (!SAFE_KEYBINDING_CHARS.has(char)) return false;
  }
  return true;
}

function commandContextsOverlap(
  left: EditorM7CommandDefinition,
  right: EditorM7CommandDefinition,
): boolean {
  if (left.contexts.includes("global") || right.contexts.includes("global")) return true;
  if (left.contexts.some((context) => right.contexts.includes(context))) return true;
  const editorLike = new Set<EditorM7CommandContext>(["editor", "monaco"]);
  return (
    left.contexts.some((context) => editorLike.has(context)) &&
    right.contexts.some((context) => editorLike.has(context))
  );
}

function activeKeybindingsFromRecord(
  activeBindings: Readonly<Record<string, string>>,
): readonly EditorM7ActiveKeybinding[] {
  return Object.entries(activeBindings).map(([commandId, binding]) => ({ commandId, binding }));
}

function normalizedDefaultKeybindings(): readonly EditorM7ActiveKeybinding[] {
  return EDITOR_M7_COMMAND_REGISTRY.flatMap((command) =>
    command.defaultBindings.map((binding) => ({
      commandId: command.id,
      binding: normalizeBinding(binding),
    })),
  );
}

export function validateEditorM7Keybinding(args: {
  readonly commandId: string;
  readonly binding: string;
  readonly activeBindings: Readonly<Record<string, string>> | readonly EditorM7ActiveKeybinding[];
}): EditorM7ParseResult<string> {
  try {
    const command = commandFor(args.commandId);
    if (command === undefined) return { ok: false, reasonCode: "UNKNOWN_COMMAND" };
    const normalized = normalizeBinding(args.binding);
    if (!command.rebindable) return { ok: false, reasonCode: "POLICY_LOCKED" };
    if (isReservedBinding(normalized)) {
      return { ok: false, reasonCode: "RESERVED_KEYBINDING" };
    }
    if (!syntacticallyValidBinding(normalized)) return { ok: false, reasonCode: "INVALID_INPUT" };
    const active = Array.isArray(args.activeBindings)
      ? (args.activeBindings as readonly EditorM7ActiveKeybinding[])
      : activeKeybindingsFromRecord(args.activeBindings as Readonly<Record<string, string>>);
    const collision = active.find((entry) => collidesWithCommand(command, normalized, entry));
    return collision === undefined
      ? { ok: true, value: normalized }
      : { ok: false, reasonCode: "KEYBINDING_COLLISION" };
  } catch {
    return { ok: false, reasonCode: "INVALID_INPUT" };
  }
}

function collidesWithCommand(
  command: EditorM7CommandDefinition,
  binding: string,
  active: EditorM7ActiveKeybinding,
): boolean {
  if (active.commandId === command.id || normalizeBinding(active.binding) !== binding) return false;
  const other = commandFor(active.commandId);
  return other !== undefined && commandContextsOverlap(command, other);
}

export function serializeEditorM7KeybindingOverride(override: EditorM7KeybindingOverride): string {
  return [override.schemaVersion, override.commandId, normalizeBinding(override.binding)].join(
    KEYBINDING_OVERRIDE_SEPARATOR,
  );
}

export function parseEditorM7KeybindingOverrideRecord(
  value: string,
  activeBindings: readonly EditorM7ActiveKeybinding[] = normalizedDefaultKeybindings(),
): EditorM7ParseResult<EditorM7KeybindingOverride> {
  if (utf8ByteLength(value) > MAX_KEYBINDING_OVERRIDE_BYTES) {
    return { ok: false, reasonCode: "OVERSIZED" };
  }
  const parts = value.split(KEYBINDING_OVERRIDE_SEPARATOR);
  if (parts.length !== 3 || parts[0] !== EDITOR_M7_KEYBINDING_OVERRIDE_VERSION) {
    return { ok: false, reasonCode: "SCHEMA_VERSION_UNSUPPORTED" };
  }
  const [, commandId, binding] = parts as [string, string, string];
  const parsed = validateEditorM7Keybinding({ commandId, binding, activeBindings });
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      schemaVersion: EDITOR_M7_KEYBINDING_OVERRIDE_VERSION,
      commandId,
      binding: parsed.value,
    },
  };
}

export function parseEditorM7KeybindingOverrides(
  value: unknown,
): EditorM7ParseResult<readonly EditorM7KeybindingOverride[]> {
  if (!Array.isArray(value) || value.length > MAX_KEYBINDING_OVERRIDES) {
    return { ok: false, reasonCode: "OVERSIZED" };
  }
  let active = normalizedDefaultKeybindings();
  const overrides: EditorM7KeybindingOverride[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") return { ok: false, reasonCode: "INVALID_INPUT" };
    const parsed = parseEditorM7KeybindingOverrideRecord(entry, active);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.value.commandId)) {
      return { ok: false, reasonCode: "KEYBINDING_COLLISION" };
    }
    seen.add(parsed.value.commandId);
    overrides.push(parsed.value);
    active = [
      ...active.filter((binding) => binding.commandId !== parsed.value.commandId),
      { commandId: parsed.value.commandId, binding: parsed.value.binding },
    ];
  }
  return { ok: true, value: Object.freeze(overrides) };
}

function parseEditorM7KeybindingOverrideSetting(
  value: unknown,
): EditorM7ParseResult<readonly string[]> {
  const parsed = parseEditorM7KeybindingOverrides(value);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: Object.freeze(parsed.value.map(serializeEditorM7KeybindingOverride)),
  };
}

// Note: workspace snippets are NOT defined here. The single canonical snippet contract is
// packages/keiko-contracts/src/editor-snippets.ts (issue #2323), which is what
// keiko-server/editor/snippets and keiko-ui actually consume. Do not reintroduce a second
// snippet contract in this module (AGENTS.md §5, ADR-0133 D6).

const SAFE_KEYBINDING_CHARS = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789,./;'[]`-",
);

export type EditorM7AiFeature =
  "inlineCompletion" | "testGeneration" | "patchApply" | "verification";
export type EditorM7AiState = "disabled" | "available" | "active" | "denied" | "degraded";

export interface EditorM7AiActivationInput {
  readonly schemaVersion: typeof EDITOR_M7_SCHEMA_VERSION;
  readonly feature: EditorM7AiFeature;
  readonly productSupported: boolean;
  readonly operatorCeiling: "allowed" | "denied";
  readonly explicitOptIn: boolean;
  readonly modelCapability: "available" | "missing";
  readonly budget: "available" | "exhausted";
  readonly providerHealth: "healthy" | "degraded" | "unhealthy";
  readonly securityPrerequisites: "satisfied" | "missing";
  readonly legacyFlag?: "unset" | "disabled" | "enabled" | undefined;
}

export interface EditorM7AiActivationStatus {
  readonly schemaVersion: typeof EDITOR_M7_SCHEMA_VERSION;
  readonly feature: EditorM7AiFeature;
  readonly state: EditorM7AiState;
  readonly reasonCode: EditorM7ReasonCode;
  readonly policyResult: "allowed" | "denied";
}

export interface EditorM7AiActivationSummary {
  readonly revision: number;
  readonly statuses: readonly EditorM7AiActivationStatus[];
}

const AI_FEATURES = Object.freeze([
  "inlineCompletion",
  "testGeneration",
  "patchApply",
  "verification",
] as const);
const AI_OPERATOR_CEILINGS = Object.freeze(["allowed", "denied"] as const);
const AI_MODEL_CAPABILITIES = Object.freeze(["available", "missing"] as const);
const AI_BUDGET_STATES = Object.freeze(["available", "exhausted"] as const);
const AI_PROVIDER_HEALTH_STATES = Object.freeze(["healthy", "degraded", "unhealthy"] as const);
const AI_SECURITY_PREREQUISITES = Object.freeze(["satisfied", "missing"] as const);
const AI_LEGACY_FLAGS = Object.freeze(["unset", "disabled", "enabled"] as const);

function validAiInput(value: unknown): value is EditorM7AiActivationInput {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, [
      "schemaVersion",
      "feature",
      "productSupported",
      "operatorCeiling",
      "explicitOptIn",
      "modelCapability",
      "budget",
      "providerHealth",
      "securityPrerequisites",
      "legacyFlag",
    ]) &&
    value.schemaVersion === EDITOR_M7_SCHEMA_VERSION &&
    typeof value.productSupported === "boolean" &&
    typeof value.explicitOptIn === "boolean" &&
    validAiEnums(value)
  );
}

function validAiEnums(value: UnknownRecord): boolean {
  return (
    stringIn(value.feature, AI_FEATURES) &&
    stringIn(value.operatorCeiling, AI_OPERATOR_CEILINGS) &&
    stringIn(value.modelCapability, AI_MODEL_CAPABILITIES) &&
    stringIn(value.budget, AI_BUDGET_STATES) &&
    stringIn(value.providerHealth, AI_PROVIDER_HEALTH_STATES) &&
    stringIn(value.securityPrerequisites, AI_SECURITY_PREREQUISITES) &&
    (value.legacyFlag === undefined || stringIn(value.legacyFlag, AI_LEGACY_FLAGS))
  );
}

function stringIn<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

export function resolveEditorM7AiActivation(value: unknown): EditorM7AiActivationStatus {
  try {
    if (!validAiInput(value)) {
      return aiStatus("inlineCompletion", "denied", "INVALID_INPUT");
    }
    return firstAiActivationStatus(value) ?? aiStatus(value.feature, "active", "ACTIVE");
  } catch {
    return aiStatus("inlineCompletion", "denied", "INVALID_INPUT");
  }
}

function firstAiActivationStatus(
  input: EditorM7AiActivationInput,
): EditorM7AiActivationStatus | undefined {
  for (const rule of AI_ACTIVATION_RULES) {
    const status = rule(input);
    if (status !== undefined) return status;
  }
  return undefined;
}

type AiActivationRule = (
  input: EditorM7AiActivationInput,
) => EditorM7AiActivationStatus | undefined;

const AI_ACTIVATION_RULES: readonly AiActivationRule[] = Object.freeze([
  aiProductSupportRule,
  aiOperatorCeilingRule,
  aiSecurityRule,
  aiExplicitOptInRule,
  aiModelCapabilityRule,
  aiBudgetRule,
  aiProviderHealthRule,
]);

function aiProductSupportRule(
  input: EditorM7AiActivationInput,
): EditorM7AiActivationStatus | undefined {
  return input.productSupported
    ? undefined
    : aiStatus(input.feature, "disabled", "PRODUCT_UNSUPPORTED");
}

function aiOperatorCeilingRule(
  input: EditorM7AiActivationInput,
): EditorM7AiActivationStatus | undefined {
  return input.operatorCeiling === "denied" || input.legacyFlag === "disabled"
    ? aiStatus(input.feature, "denied", "OPERATOR_CEILING_DENIED")
    : undefined;
}

function aiSecurityRule(input: EditorM7AiActivationInput): EditorM7AiActivationStatus | undefined {
  return input.securityPrerequisites === "missing"
    ? aiStatus(input.feature, "denied", "SECURITY_PREREQUISITE_MISSING")
    : undefined;
}

function aiExplicitOptInRule(
  input: EditorM7AiActivationInput,
): EditorM7AiActivationStatus | undefined {
  return input.explicitOptIn
    ? undefined
    : aiStatus(input.feature, "available", "EXPLICIT_OPT_IN_REQUIRED");
}

function aiModelCapabilityRule(
  input: EditorM7AiActivationInput,
): EditorM7AiActivationStatus | undefined {
  return input.modelCapability === "missing"
    ? aiStatus(input.feature, "degraded", "MODEL_CAPABILITY_MISSING")
    : undefined;
}

function aiBudgetRule(input: EditorM7AiActivationInput): EditorM7AiActivationStatus | undefined {
  return input.budget === "exhausted"
    ? aiStatus(input.feature, "degraded", "BUDGET_UNAVAILABLE")
    : undefined;
}

function aiProviderHealthRule(
  input: EditorM7AiActivationInput,
): EditorM7AiActivationStatus | undefined {
  return input.providerHealth === "healthy"
    ? undefined
    : aiStatus(input.feature, "degraded", "PROVIDER_UNHEALTHY");
}

function aiStatus(
  feature: EditorM7AiFeature,
  state: EditorM7AiState,
  reasonCode: EditorM7ReasonCode,
): EditorM7AiActivationStatus {
  const allowed = state === "active";
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    feature,
    state,
    reasonCode,
    policyResult: allowed ? "allowed" : "denied",
  };
}
