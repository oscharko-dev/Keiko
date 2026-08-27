// M7 editor personalization/resilience contracts (Epic #2095, ADR-0133).
// These contracts are deliberately browser/server neutral. Parsers are total and fail closed:
// malformed, oversized, future-versioned, unknown, or policy-disallowed input returns a typed denial
// instead of throwing or preserving untrusted fields.

import type { DebugActivationSummary } from "./debug-activation.js";
import { deepFreeze } from "./deep-freeze.js";
import { GIT_COMMIT_MESSAGE_POLICY_MODES } from "./git-commit-policy.js";
import type { GitCommitMessagePolicyMode } from "./git-commit-policy.js";

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
  // F-01: no live probe has confirmed the provider for the current gateway configuration. Distinct
  // from PROVIDER_UNHEALTHY (a probe answered and said no) so a surface can say "not checked yet"
  // instead of claiming either health or a failure it never observed.
  | "PROVIDER_UNVERIFIED"
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
  | "keybindingOverrides"
  | "debuggingEnabled"
  | "gitCommitMessagePolicy";

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
  | GitCommitMessagePolicyMode
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
  readonly debugging?: DebugActivationSummary | undefined;
  /**
   * Opaque server-projected identity accepted by the governed debug routes. It is derived only
   * after the server has resolved the workspace root; browser code must not derive it from `root`.
   */
  readonly debugWorkspaceId?: string | undefined;
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
  Record<
    "wordWrap" | "renderWhitespace" | "externalReload" | "largeFileMode" | "gitCommitMessagePolicy",
    readonly string[]
  >
> = Object.freeze({
  wordWrap: Object.freeze(["off", "on", "wordWrapColumn", "bounded"] as const),
  renderWhitespace: Object.freeze(["none", "selection", "boundary", "all"] as const),
  externalReload: Object.freeze(["prompt", "autoClean", "manual"] as const),
  largeFileMode: Object.freeze(["default", "degraded", "readonly"] as const),
  gitCommitMessagePolicy: GIT_COMMIT_MESSAGE_POLICY_MODES,
});

// deepFreeze, not Object.freeze: each entry's own `scopes` array was individually frozen at
// declaration time, but the entry OBJECT itself was not, so a bound (e.g. `minimum`/`maximum`)
// was still writable after construction — the same bug class command-runner.ts's
// COMMAND_TASK_RULES already documents and was fixed for (KEIKO-0139).
export const EDITOR_M7_SETTING_REGISTRY: readonly EditorM7SettingDefinition[] = deepFreeze([
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
  {
    id: "debuggingEnabled",
    type: "boolean",
    defaultValue: false,
    scopes: Object.freeze(["workspace"] as const),
    effect: "live",
    security: "policyCeiling",
    description: "Explicit workspace opt-in for governed Node.js/TypeScript debugging.",
  },
  {
    id: "gitCommitMessagePolicy",
    type: "enum",
    defaultValue: "keiko-conventional",
    scopes: Object.freeze(["user", "workspace"] as const),
    effect: "live",
    security: "safe",
    enumValues: ENUM_VALUES.gitCommitMessagePolicy,
    description:
      "Governed commit-message validation: Keiko Conventional or Repository Native formatting.",
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
    // KEIKO-0822: `findIndex` returns -1 when the candidate's identity is not in `retained`
    // (which happens on the second occurrence of two entries sharing an identity — the first
    // splice already removed a matching entry, so the second lookup misses). splice(-1, 1) then
    // removes the LAST retained entry, potentially one that was never evicted. Guard the splice
    // so a missing match is a no-op and the identity is not double-recorded in `evicted`.
    const index = retained.findIndex((entry) => entry.identity === candidate.identity);
    if (index < 0) continue;
    evicted.push(candidate.identity);
    retained.splice(index, 1);
  }
  const protectedEntries = args.entries.filter((entry) => !evictionEligible(entry));
  return {
    retained: retained.map((entry) => entry.identity),
    evicted,
    protected: protectedEntries.map((entry) => entry.identity),
  };
}

export type EditorM7CommandScope = "global" | "editor" | "explorer" | "git" | "settings";
// Contexts identify the runtime listener that receives a Keiko-owned keybinding. AppShell dispatches
// both "global" and "settings" contexts, while EditorWidget owns the capturing "editor" context.
// A command must not be advertised in a context until that listener exists.
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

// deepFreeze, not Object.freeze: editorCommand() returns a plain, unfrozen object per call (its
// own contexts/defaultBindings sub-arrays are individually frozen, the returned object itself is
// not), and the outer Object.freeze only protected the array — so a command's own field (e.g.
// `rebindable`, `dispatchOwner`) was still writable after construction.
export const EDITOR_M7_COMMAND_REGISTRY: readonly EditorM7CommandDefinition[] = deepFreeze([
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
const MODIFIERS = Object.freeze(["CtrlOrMeta", "Ctrl", "Meta", "Alt", "Shift"] as const);
const MAX_KEYBINDING_OVERRIDES = 64;
const MAX_KEYBINDING_OVERRIDE_BYTES = 192;
const KEYBINDING_OVERRIDE_SEPARATOR = "|";
type EditorM7KeybindingModifier = (typeof MODIFIERS)[number];

function commandFor(id: string): EditorM7CommandDefinition | undefined {
  return EDITOR_M7_COMMAND_REGISTRY.find((entry) => entry.id === id);
}

function canonicalBinding(binding: string): string | undefined {
  const parts = binding.split("+").map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part.length === 0)) return undefined;
  const key = canonicalKey(parts.at(-1) ?? "");
  if (key === undefined) return undefined;
  const modifiers = canonicalModifiers(parts.slice(0, -1));
  return modifiers === undefined ? undefined : [...modifiers, key].join("+");
}

function canonicalModifiers(
  parts: readonly string[],
): readonly EditorM7KeybindingModifier[] | undefined {
  const modifiers: EditorM7KeybindingModifier[] = [];
  const seen = new Set<EditorM7KeybindingModifier>();
  for (const part of parts) {
    const modifier = canonicalModifier(part);
    if (modifier === undefined || seen.has(modifier) || modifiersConflict(modifier, seen))
      return undefined;
    seen.add(modifier);
    modifiers.push(modifier);
  }
  modifiers.sort((left, right) => MODIFIERS.indexOf(left) - MODIFIERS.indexOf(right));
  return modifiers;
}

/**
 * `CtrlOrMeta`, `Ctrl` and `Meta` all name the same physical position in a chord, so no two of them
 * may appear together. `Ctrl+Meta` was the one pair this used to allow, and it is not a chord a
 * keyboard can produce as declared: off macOS the workspace matcher resolves `Meta` onto the
 * Control key, so `Ctrl+Meta+T` fires on a plain Ctrl+T — a doubled physical modifier that carried
 * a browser-reserved chord past the reservation check below and onto the substrate (0.3.0 release
 * audit, #2802). `WorkspaceKeyChord` refuses the same pair in `isWorkspaceDispatchableChord`.
 */
function modifiersConflict(
  modifier: EditorM7KeybindingModifier,
  seen: ReadonlySet<EditorM7KeybindingModifier>,
): boolean {
  const ctrlOrMetaAliases: readonly EditorM7KeybindingModifier[] = ["CtrlOrMeta", "Ctrl", "Meta"];
  if (!ctrlOrMetaAliases.includes(modifier)) return false;
  return ctrlOrMetaAliases.some((alias) => alias !== modifier && seen.has(alias));
}

/**
 * The PHYSICAL chord a binding produces, as one comparable key. `CtrlOrMeta+T`, `Meta+T` and
 * `Ctrl+T` are one keystroke — the browser's reserved Cmd/Ctrl+T — so reservation AND collision are
 * both decided here rather than on the canonical binding string. Comparing strings let the
 * explicit-modifier spellings through: a `Meta+P` override read as distinct from `CtrlOrMeta+P` and
 * silently took Cmd+P away from `quick-access.files` (0.3.0 release audit, #2802), and the
 * substrate refuses a reserved chord by THROWING in render, so an accepted `Ctrl+T` became a
 * persisted white screen. `WORKSPACE_RESERVED_CHORDS` in workspace-ui.ts is the chord-level twin of
 * `RESERVED_BINDINGS`, and this list must stay at least as strict.
 *
 * The rewrite collapses three names onto one, so it MUST dedupe — without it `Ctrl+Meta+T` produced
 * `ctrlormeta+ctrlormeta+t`, a key no reservation can ever equal. `modifiersConflict` now rejects
 * that pair outright; the dedupe stays because every reservation and collision answer is read off
 * this key and it must not depend on an earlier guard having run.
 */
function physicalChordKey(binding: string): string {
  const parts = binding
    .split("+")
    .map((part) => (part === "Ctrl" || part === "Meta" ? "CtrlOrMeta" : part))
    .map((part) => part.toLowerCase());
  return [...new Set(parts)].join("+");
}

function isReservedBinding(binding: string): boolean {
  const key = physicalChordKey(binding);
  return RESERVED_BINDINGS.some((reserved) => {
    const canonical = canonicalBinding(reserved);
    return canonical !== undefined && physicalChordKey(canonical) === key;
  });
}

function canonicalModifier(part: string): EditorM7KeybindingModifier | undefined {
  const lower = part.toLowerCase();
  return MODIFIERS.find((modifier) => modifier.toLowerCase() === lower);
}

function canonicalKey(key: string): string | undefined {
  if (canonicalModifier(key) !== undefined || !isSafeKeybindingPart(key)) return undefined;
  if (key.length === 1) return key.toUpperCase();
  if (key[0]?.toLowerCase() === "f" && key.slice(1).split("").every(isKeybindingDigit)) {
    return `F${key.slice(1)}`;
  }
  const named = ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "Esc", "Space"];
  return named.find((candidate) => candidate.toLowerCase() === key.toLowerCase()) ?? key;
}

function isKeybindingDigit(char: string): boolean {
  return char >= "0" && char <= "9";
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
      binding: canonicalBinding(binding) ?? "",
    })),
  );
}

function hasMinimumKeybindingModifier(binding: string): boolean {
  const modifiers = new Set(binding.split("+").slice(0, -1));
  return (
    modifiers.has("CtrlOrMeta") ||
    modifiers.has("Ctrl") ||
    modifiers.has("Meta") ||
    modifiers.has("Alt")
  );
}

function canonicalPersistableBinding(commandId: string, binding: string): string | undefined {
  const canonical = canonicalBinding(binding);
  if (canonical === undefined) return undefined;
  const serialized = serializeEditorM7KeybindingOverride({
    schemaVersion: EDITOR_M7_KEYBINDING_OVERRIDE_VERSION,
    commandId,
    binding: canonical,
  });
  return utf8ByteLength(serialized) > MAX_KEYBINDING_OVERRIDE_BYTES ? undefined : canonical;
}

export function validateEditorM7Keybinding(args: {
  readonly commandId: string;
  readonly binding: string;
  readonly activeBindings: Readonly<Record<string, string>> | readonly EditorM7ActiveKeybinding[];
}): EditorM7ParseResult<string> {
  try {
    const command = commandFor(args.commandId);
    if (command === undefined) return { ok: false, reasonCode: "UNKNOWN_COMMAND" };
    if (utf8ByteLength(args.binding) > MAX_KEYBINDING_OVERRIDE_BYTES) {
      return { ok: false, reasonCode: "INVALID_INPUT" };
    }
    const canonical = canonicalPersistableBinding(args.commandId, args.binding);
    if (canonical === undefined) return { ok: false, reasonCode: "INVALID_INPUT" };
    if (!hasMinimumKeybindingModifier(canonical)) {
      return { ok: false, reasonCode: "INVALID_INPUT" };
    }
    if (!command.rebindable) return { ok: false, reasonCode: "POLICY_LOCKED" };
    if (isReservedBinding(canonical)) {
      return { ok: false, reasonCode: "RESERVED_KEYBINDING" };
    }
    const active = Array.isArray(args.activeBindings)
      ? (args.activeBindings as readonly EditorM7ActiveKeybinding[])
      : activeKeybindingsFromRecord(args.activeBindings as Readonly<Record<string, string>>);
    const collision = active.find((entry) => collidesWithCommand(command, canonical, entry));
    return collision === undefined
      ? { ok: true, value: canonical }
      : { ok: false, reasonCode: "KEYBINDING_COLLISION" };
  } catch {
    return { ok: false, reasonCode: "INVALID_INPUT" };
  }
}

// Collision is decided on the PHYSICAL chord, never on the canonical binding string: dispatch
// matches keystrokes, so `Meta+P` and `CtrlOrMeta+P` are the same claim even though the two strings
// differ. Comparing strings here let a persisted `Meta+P` override be accepted alongside
// `quick-access.files`' own `CtrlOrMeta+P` and take the chord away from it (0.3.0 audit, #2802).
function collidesWithCommand(
  command: EditorM7CommandDefinition,
  binding: string,
  active: EditorM7ActiveKeybinding,
): boolean {
  const activeBinding = canonicalBinding(active.binding);
  if (active.commandId === command.id || activeBinding === undefined) return false;
  if (physicalChordKey(activeBinding) !== physicalChordKey(binding)) return false;
  const other = commandFor(active.commandId);
  return other !== undefined && commandContextsOverlap(command, other);
}

export function serializeEditorM7KeybindingOverride(override: EditorM7KeybindingOverride): string {
  return [
    override.schemaVersion,
    override.commandId,
    canonicalBinding(override.binding) ?? "",
  ].join(KEYBINDING_OVERRIDE_SEPARATOR);
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
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789,./;'[]`-\\",
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
  /**
   * F-01: `unverified` is the fail-closed input for "no live probe has confirmed this provider".
   * A caller that cannot name a probe outcome must pass it rather than `healthy`.
   */
  readonly providerHealth: "healthy" | "degraded" | "unhealthy" | "unverified";
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
const AI_PROVIDER_HEALTH_STATES = Object.freeze([
  "healthy",
  "degraded",
  "unhealthy",
  "unverified",
] as const);
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

// F-01: an unverified provider and an unhealthy one are both refused (degraded is never `allowed`),
// but only one of them is true when no probe has run, so they carry distinct reason codes.
function aiProviderHealthRule(
  input: EditorM7AiActivationInput,
): EditorM7AiActivationStatus | undefined {
  if (input.providerHealth === "healthy") return undefined;
  return input.providerHealth === "unverified"
    ? aiStatus(input.feature, "degraded", "PROVIDER_UNVERIFIED")
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
