// Bounded managed-LSP workspace runtime configuration (Issue #2271, Epic #2094, ADR-0132).
// Executables and arguments are deliberately absent: persisted settings can reference only an
// opaque operator-approved runtime and contained workspace-relative configuration files.

import { EDITOR_AGENT_TARGET_PATH_MAX_BYTES, isContainedAgentPath } from "./editor-agent-path.js";
import type { ManagedLspLanguage } from "./managed-lsp-activation.js";
import { parseSafely } from "./managed-lsp-parse-safely.js";

export const MANAGED_LSP_RUNTIME_SCHEMA_VERSION = "1" as const;
export const MANAGED_LSP_RUNTIME_ID_MAX_CHARS = 128;
export const MANAGED_LSP_ETAG_MAX_CHARS = 96;
export const MANAGED_LSP_BUILD_TAG_MAX_COUNT = 32;
export const MANAGED_LSP_BUILD_TAG_MAX_CHARS = 64;
export const MANAGED_LSP_PYTHON_EXTRA_PATH_MAX_COUNT = 32;
export const MANAGED_LSP_GO_DIRECTORY_FILTER_MAX_COUNT = 32;
export const MANAGED_LSP_SHELLCHECK_EXCLUDE_MAX_COUNT = 32;
export const MANAGED_LSP_SHELL_INCLUDE_PATH_MAX_COUNT = 32;
export const MANAGED_LSP_JAVA_CLASSPATH_MAX_COUNT = 128;
export const MANAGED_LSP_JAVA_PROJECT_ROOT_MAX_COUNT = 32;
export const MANAGED_LSP_RUST_FEATURE_MAX_COUNT = 64;
export const MANAGED_LSP_RUST_CFG_MAX_COUNT = 64;
export const MANAGED_LSP_RUST_LINKED_PROJECT_MAX_COUNT = 32;
export const MANAGED_LSP_RUST_MAX_PROJECT_FILES = 100_000;
export const MANAGED_LSP_RUST_MAX_CARGO_METADATA_BYTES = 16_777_216;
export const MANAGED_LSP_RUST_MAX_MEMORY_MB = 4_096;
export const MANAGED_LSP_RUST_MAX_INDEX_DEADLINE_MS = 120_000;

export type ManagedLspSettingSource =
  "builtInDefault" | "legacyEnvironment" | "operatorProvisioning" | "workspace";

// Low to high. Legacy environment is compatibility input only; the provenance contract below
// structurally excludes it from runtime and language settings.
export const MANAGED_LSP_SETTING_PRECEDENCE: readonly ManagedLspSettingSource[] = Object.freeze([
  "builtInDefault",
  "legacyEnvironment",
  "operatorProvisioning",
  "workspace",
] as const satisfies readonly ManagedLspSettingSource[]);

export type ManagedLspPersistedSettingSource = Exclude<
  ManagedLspSettingSource,
  "legacyEnvironment"
>;

export interface ManagedLspSettingLayers<T> {
  readonly builtInDefault: T;
  readonly legacyEnvironment?: T | undefined;
  readonly operatorProvisioning?: T | undefined;
  readonly workspace?: T | undefined;
}

export interface ManagedLspResolvedSetting<T> {
  readonly value: T;
  readonly source: ManagedLspSettingSource;
}

export function resolveManagedLspSetting<T>(
  layers: ManagedLspSettingLayers<T>,
): ManagedLspResolvedSetting<T> {
  if (layers.workspace !== undefined) return { value: layers.workspace, source: "workspace" };
  if (layers.operatorProvisioning !== undefined) {
    return { value: layers.operatorProvisioning, source: "operatorProvisioning" };
  }
  if (layers.legacyEnvironment !== undefined) {
    return { value: layers.legacyEnvironment, source: "legacyEnvironment" };
  }
  return { value: layers.builtInDefault, source: "builtInDefault" };
}

export type ManagedLspWorkspaceActivationSetting = "enabled" | "disabled";

export interface ManagedLspApprovedRuntimeReference {
  readonly kind: "operatorApproved";
  readonly runtimeId: string;
}

export interface ManagedLspWorkspaceRelativePath {
  readonly kind: "workspaceRelative";
  readonly path: string;
}

export interface ManagedLspConfigurationProvenance {
  readonly activation: ManagedLspSettingSource;
  readonly runtime: ManagedLspPersistedSettingSource;
  readonly settings: ManagedLspPersistedSettingSource;
}

export interface ManagedLspPythonSettings {
  readonly interpreter: ManagedLspApprovedRuntimeReference;
  readonly venv: ManagedLspApprovedRuntimeReference | null;
  readonly typeCheckingMode: "basic" | "standard" | "strict";
  readonly extraPaths: readonly ManagedLspWorkspaceRelativePath[];
  readonly configurationFile?: ManagedLspWorkspaceRelativePath | undefined;
  readonly configurationPrecedence: readonly [
    "workspaceConfiguration",
    "pyproject",
    "builtInDefault",
  ];
}

export interface ManagedLspGoBuildFlags {
  readonly moduleMode: "readonly" | "vendor";
  readonly trimPath: boolean;
}

export type ManagedLspGoOperatingSystem = "linux" | "darwin" | "windows" | "freebsd";
export type ManagedLspGoArchitecture = "amd64" | "arm64" | "386" | "arm";

export interface ManagedLspGoTarget {
  readonly goos: ManagedLspGoOperatingSystem;
  readonly goarch: ManagedLspGoArchitecture;
  readonly minimumGoVersion: string;
}

export interface ManagedLspGoDirectoryFilter {
  readonly kind: "include" | "exclude";
  readonly path: ManagedLspWorkspaceRelativePath;
}

export interface ManagedLspGoSettings {
  readonly toolchain: ManagedLspApprovedRuntimeReference;
  readonly staticcheck: boolean;
  readonly buildTags: readonly string[];
  readonly buildFlags: ManagedLspGoBuildFlags;
  readonly target: ManagedLspGoTarget;
  readonly directoryFilters: readonly ManagedLspGoDirectoryFilter[];
  readonly workspaceModuleFile?: ManagedLspWorkspaceRelativePath | undefined;
  readonly dependencyMode: "offline";
  readonly moduleDownloads: false;
}

export interface ManagedLspShellCheckSettings {
  readonly mode: "disabled" | "workspace";
  readonly severity: "error" | "warning" | "info" | "style";
  readonly excludedCodes: readonly string[];
  readonly includePaths: readonly ManagedLspWorkspaceRelativePath[];
  readonly externalSources: false;
}

export interface ManagedLspShellSettings {
  readonly dialect: "posix" | "bash";
  readonly sourcePolicy: "workspaceOnly";
  readonly shellCheck: ManagedLspShellCheckSettings;
}

export type ManagedLspJavaLanguageLevel = "8" | "11" | "17" | "21" | "25";

export interface ManagedLspJavaSettings {
  readonly jdk: ManagedLspApprovedRuntimeReference;
  readonly sourceLevel: ManagedLspJavaLanguageLevel;
  readonly targetLevel: ManagedLspJavaLanguageLevel;
  readonly classpath: readonly ManagedLspWorkspaceRelativePath[];
  readonly projectRoots: readonly ManagedLspWorkspaceRelativePath[];
  readonly projectImport: "safeOffline";
  readonly buildToolExecution: false;
  readonly annotationProcessing: false;
  readonly dependencyDownloads: false;
  readonly configurationFile?: ManagedLspWorkspaceRelativePath | undefined;
}

export interface ManagedLspRustCfg {
  readonly key: string;
  readonly value: string | null;
}

export interface ManagedLspRustResourceBudget {
  readonly maxProjectFiles: number;
  readonly maxCargoMetadataBytes: number;
  readonly maxMemoryMb: number;
  readonly indexDeadlineMs: number;
}

export interface ManagedLspRustSettings {
  readonly toolchain: ManagedLspApprovedRuntimeReference;
  readonly features: readonly string[];
  readonly target: string | null;
  readonly cfgs: readonly ManagedLspRustCfg[];
  readonly noDefaultFeatures: boolean;
  readonly linkedProjects: readonly ManagedLspWorkspaceRelativePath[];
  readonly sysrootPolicy: "disabled" | "approvedToolchain";
  readonly resourceBudget: ManagedLspRustResourceBudget;
  readonly cargoMetadata: "disabled" | "offline";
  readonly dependencyDownloads: false;
  readonly procMacros: false;
  readonly buildScripts: false;
}

export type ManagedLspRestartField = "runtime" | "settings";

interface ManagedLspRuntimeConfigurationBase {
  readonly schemaVersion: typeof MANAGED_LSP_RUNTIME_SCHEMA_VERSION;
  readonly language: ManagedLspLanguage;
  readonly revision: number;
  readonly etag: string;
  readonly activation: ManagedLspWorkspaceActivationSetting;
  readonly runtime: ManagedLspApprovedRuntimeReference;
  readonly provenance: ManagedLspConfigurationProvenance;
  readonly restartRequired: boolean;
  readonly restartFields: readonly ManagedLspRestartField[];
}

export interface ManagedLspPythonConfiguration extends ManagedLspRuntimeConfigurationBase {
  readonly language: "python";
  readonly settings: ManagedLspPythonSettings;
}

export interface ManagedLspGoConfiguration extends ManagedLspRuntimeConfigurationBase {
  readonly language: "go";
  readonly settings: ManagedLspGoSettings;
}

export interface ManagedLspShellConfiguration extends ManagedLspRuntimeConfigurationBase {
  readonly language: "shell";
  readonly settings: ManagedLspShellSettings;
}

export interface ManagedLspJavaConfiguration extends ManagedLspRuntimeConfigurationBase {
  readonly language: "java";
  readonly settings: ManagedLspJavaSettings;
}

export interface ManagedLspRustConfiguration extends ManagedLspRuntimeConfigurationBase {
  readonly language: "rust";
  readonly settings: ManagedLspRustSettings;
}

export type ManagedLspRuntimeConfiguration =
  | ManagedLspPythonConfiguration
  | ManagedLspGoConfiguration
  | ManagedLspShellConfiguration
  | ManagedLspJavaConfiguration
  | ManagedLspRustConfiguration;

export interface ManagedLspConfigurationPrecondition {
  readonly revision: number;
  readonly etag: string;
}

export type ManagedLspRuntimeParseResult =
  | { readonly ok: true; readonly value: ManagedLspRuntimeConfiguration }
  | { readonly ok: false; readonly errors: readonly string[] };

type UnknownRecord = Readonly<Record<string, unknown>>;

function isStringMember<T extends string>(value: unknown, values: readonly T[]): value is T {
  const allowed: readonly string[] = values;
  return typeof value === "string" && allowed.includes(value);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRuntimeReference(value: unknown): value is ManagedLspApprovedRuntimeReference {
  if (!isRecord(value) || !hasOnlyKeys(value, ["kind", "runtimeId"])) return false;
  return (
    value.kind === "operatorApproved" &&
    typeof value.runtimeId === "string" &&
    value.runtimeId.length > 0 &&
    value.runtimeId.length <= MANAGED_LSP_RUNTIME_ID_MAX_CHARS &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value.runtimeId)
  );
}

function isWorkspaceRelativePath(value: unknown): value is ManagedLspWorkspaceRelativePath {
  if (!isRecord(value) || !hasOnlyKeys(value, ["kind", "path"])) return false;
  if (value.kind !== "workspaceRelative" || typeof value.path !== "string") return false;
  if (new TextEncoder().encode(value.path).length > EDITOR_AGENT_TARGET_PATH_MAX_BYTES)
    return false;
  if (!isContainedAgentPath(value.path)) return false;
  return value.path.split("/").every((segment) => segment.length > 0 && segment !== ".");
}

function isOptionalWorkspaceRelativePath(value: unknown): boolean {
  return value === undefined || isWorkspaceRelativePath(value);
}

const SOURCES: readonly ManagedLspSettingSource[] = MANAGED_LSP_SETTING_PRECEDENCE;
const PERSISTED_SOURCES: ReadonlySet<ManagedLspPersistedSettingSource> = new Set([
  "builtInDefault",
  "operatorProvisioning",
  "workspace",
]);

function isSource(value: unknown): value is ManagedLspSettingSource {
  const sourcesValues: readonly string[] = SOURCES;
  return typeof value === "string" && sourcesValues.includes(value);
}

function isPersistedSource(value: unknown): value is ManagedLspPersistedSettingSource {
  const persisted_sourcesValues: ReadonlySet<string> = PERSISTED_SOURCES;
  return typeof value === "string" && persisted_sourcesValues.has(value);
}

function isProvenance(value: unknown): value is ManagedLspConfigurationProvenance {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["activation", "runtime", "settings"]) &&
    isSource(value.activation) &&
    isPersistedSource(value.runtime) &&
    isPersistedSource(value.settings)
  );
}

function isRestartField(value: unknown): value is ManagedLspRestartField {
  return value === "runtime" || value === "settings";
}

function isRestartFields(
  value: unknown,
  required: unknown,
): value is readonly ManagedLspRestartField[] {
  if (!isBoundedPhysicalArray(value, 2, isRestartField, (entry) => entry)) return false;
  return typeof required === "boolean" && required === value.length > 0;
}

function isInitialExtentAllowed(extent: number, maximum: number, inclusive: boolean): boolean {
  if (inclusive) return extent <= maximum;
  const exceedsMaximum = extent > maximum;
  return !exceedsMaximum;
}

function isBoundedPhysicalArray<T>(
  value: unknown,
  maximum: number,
  guard: (member: unknown) => member is T,
  identity: (member: T) => string,
  initialInclusive = false,
): value is readonly T[] {
  if (!Array.isArray(value) || !isInitialExtentAllowed(value.length, maximum, initialInclusive))
    return false;
  const extent = value.length;
  if (!isIntegerWithin(extent, 0, maximum)) return false;
  const identities = new Set<string>();
  for (let index = 0; index < extent; index += 1) {
    if (!(index in value)) return false;
    const member: unknown = value[index];
    if (!guard(member)) return false;
    identities.add(identity(member));
  }
  const finalExtent = value.length;
  return finalExtent === extent && identities.size === finalExtent;
}

function isBoundedUniqueStrings(
  value: unknown,
  maxCount: number,
  predicate: (item: string) => boolean,
): value is readonly string[] {
  const guard = (item: unknown): item is string => typeof item === "string" && predicate(item);
  return isBoundedPhysicalArray(value, maxCount, guard, (item) => item, true);
}

function isBoundedContainedPaths(
  value: unknown,
  maxCount: number,
): value is readonly ManagedLspWorkspaceRelativePath[] {
  return isBoundedPhysicalArray(value, maxCount, isWorkspaceRelativePath, (entry) => entry.path);
}

function hasPythonConfigurationPrecedence(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value[0] === "workspaceConfiguration" &&
    value[1] === "pyproject" &&
    value[2] === "builtInDefault"
  );
}

function isPythonSettings(value: unknown): value is ManagedLspPythonSettings {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "interpreter",
      "venv",
      "typeCheckingMode",
      "extraPaths",
      "configurationFile",
      "configurationPrecedence",
    ]) &&
    isRuntimeReference(value.interpreter) &&
    (value.venv === null || isRuntimeReference(value.venv)) &&
    isStringMember(value.typeCheckingMode, ["basic", "standard", "strict"]) &&
    isBoundedContainedPaths(value.extraPaths, MANAGED_LSP_PYTHON_EXTRA_PATH_MAX_COUNT) &&
    (value.configurationFile === undefined || isWorkspaceRelativePath(value.configurationFile)) &&
    hasPythonConfigurationPrecedence(value.configurationPrecedence)
  );
}

function isGoBuildFlags(value: unknown): value is ManagedLspGoBuildFlags {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["moduleMode", "trimPath"]) &&
    (value.moduleMode === "readonly" || value.moduleMode === "vendor") &&
    typeof value.trimPath === "boolean"
  );
}

const GO_OPERATING_SYSTEMS: ReadonlySet<ManagedLspGoOperatingSystem> = new Set([
  "linux",
  "darwin",
  "windows",
  "freebsd",
]);
const GO_ARCHITECTURES: ReadonlySet<ManagedLspGoArchitecture> = new Set([
  "amd64",
  "arm64",
  "386",
  "arm",
]);

function isGoOperatingSystem(value: unknown): value is ManagedLspGoOperatingSystem {
  const allowed: ReadonlySet<string> = GO_OPERATING_SYSTEMS;
  return typeof value === "string" && allowed.has(value);
}

function isGoArchitecture(value: unknown): value is ManagedLspGoArchitecture {
  const allowed: ReadonlySet<string> = GO_ARCHITECTURES;
  return typeof value === "string" && allowed.has(value);
}

function isGoTarget(value: unknown): value is ManagedLspGoTarget {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["goos", "goarch", "minimumGoVersion"]) &&
    isGoOperatingSystem(value.goos) &&
    isGoArchitecture(value.goarch) &&
    typeof value.minimumGoVersion === "string" &&
    /^1\.(?:2[2-9]|[3-9]\d)$/u.test(value.minimumGoVersion)
  );
}

function isGoDirectoryFilter(value: unknown): value is ManagedLspGoDirectoryFilter {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["kind", "path"]) &&
    (value.kind === "include" || value.kind === "exclude") &&
    isWorkspaceRelativePath(value.path)
  );
}

function isGoDirectoryFilters(value: unknown): value is readonly ManagedLspGoDirectoryFilter[] {
  return isBoundedPhysicalArray(
    value,
    MANAGED_LSP_GO_DIRECTORY_FILTER_MAX_COUNT,
    isGoDirectoryFilter,
    (entry) => `${entry.kind}:${entry.path.path}`,
  );
}

function isGoSettings(value: unknown): value is ManagedLspGoSettings {
  const validTag = (tag: string): boolean =>
    tag.length <= MANAGED_LSP_BUILD_TAG_MAX_CHARS && /^\w[\w.-]*$/u.test(tag);
  if (!isRecord(value)) return false;
  return [
    hasOnlyKeys(value, [
      "toolchain",
      "staticcheck",
      "buildTags",
      "buildFlags",
      "target",
      "directoryFilters",
      "workspaceModuleFile",
      "dependencyMode",
      "moduleDownloads",
    ]),
    isRuntimeReference(value.toolchain),
    typeof value.staticcheck === "boolean",
    isBoundedUniqueStrings(value.buildTags, MANAGED_LSP_BUILD_TAG_MAX_COUNT, validTag),
    isGoBuildFlags(value.buildFlags),
    isGoTarget(value.target),
    isGoDirectoryFilters(value.directoryFilters),
    isOptionalWorkspaceRelativePath(value.workspaceModuleFile),
    value.dependencyMode === "offline",
    value.moduleDownloads === false,
  ].every(Boolean);
}

function isShellCheckSettings(value: unknown): value is ManagedLspShellCheckSettings {
  const validCode = (code: string): boolean => /^SC\d{4}$/u.test(code);
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["mode", "severity", "excludedCodes", "includePaths", "externalSources"]) &&
    (value.mode === "disabled" || value.mode === "workspace") &&
    isShellCheckSeverity(value.severity) &&
    isBoundedUniqueStrings(
      value.excludedCodes,
      MANAGED_LSP_SHELLCHECK_EXCLUDE_MAX_COUNT,
      validCode,
    ) &&
    isBoundedContainedPaths(value.includePaths, MANAGED_LSP_SHELL_INCLUDE_PATH_MAX_COUNT) &&
    value.externalSources === false
  );
}

function isShellCheckSeverity(value: unknown): value is ManagedLspShellCheckSettings["severity"] {
  return typeof value === "string" && ["error", "warning", "info", "style"].includes(value);
}

function isShellSettings(value: unknown): value is ManagedLspShellSettings {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["dialect", "sourcePolicy", "shellCheck"]) &&
    (value.dialect === "posix" || value.dialect === "bash") &&
    value.sourcePolicy === "workspaceOnly" &&
    isShellCheckSettings(value.shellCheck)
  );
}

const JAVA_LEVELS: ReadonlySet<ManagedLspJavaLanguageLevel> = new Set([
  "8",
  "11",
  "17",
  "21",
  "25",
]);

function isJavaLanguageLevel(value: unknown): value is ManagedLspJavaLanguageLevel {
  const java_levelsValues: ReadonlySet<string> = JAVA_LEVELS;
  return typeof value === "string" && java_levelsValues.has(value);
}

function hasValidJavaLevels(value: UnknownRecord): boolean {
  return (
    isJavaLanguageLevel(value.sourceLevel) &&
    isJavaLanguageLevel(value.targetLevel) &&
    Number(value.sourceLevel) <= Number(value.targetLevel)
  );
}

function isJavaSettings(value: unknown): value is ManagedLspJavaSettings {
  if (!isRecord(value)) return false;
  return [
    hasOnlyKeys(value, [
      "jdk",
      "sourceLevel",
      "targetLevel",
      "classpath",
      "projectRoots",
      "projectImport",
      "buildToolExecution",
      "annotationProcessing",
      "dependencyDownloads",
      "configurationFile",
    ]),
    isRuntimeReference(value.jdk),
    hasValidJavaLevels(value),
    isBoundedContainedPaths(value.classpath, MANAGED_LSP_JAVA_CLASSPATH_MAX_COUNT),
    isBoundedContainedPaths(value.projectRoots, MANAGED_LSP_JAVA_PROJECT_ROOT_MAX_COUNT),
    value.projectImport === "safeOffline",
    value.buildToolExecution === false,
    value.annotationProcessing === false,
    value.dependencyDownloads === false,
    isOptionalWorkspaceRelativePath(value.configurationFile),
  ].every(Boolean);
}

function isRustCfg(value: unknown): value is ManagedLspRustCfg {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["key", "value"]) &&
    typeof value.key === "string" &&
    /^[A-Za-z_]\w{0,63}$/u.test(value.key) &&
    (value.value === null ||
      (typeof value.value === "string" && /^\w[\w.-]{0,127}$/u.test(value.value)))
  );
}

function isRustCfgs(value: unknown): value is readonly ManagedLspRustCfg[] {
  return isBoundedPhysicalArray(
    value,
    MANAGED_LSP_RUST_CFG_MAX_COUNT,
    isRustCfg,
    (entry) => `${entry.key}=${entry.value ?? ""}`,
  );
}

function isIntegerWithin(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

function isRustResourceBudget(value: unknown): value is ManagedLspRustResourceBudget {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "maxProjectFiles",
      "maxCargoMetadataBytes",
      "maxMemoryMb",
      "indexDeadlineMs",
    ]) &&
    isIntegerWithin(value.maxProjectFiles, 1, MANAGED_LSP_RUST_MAX_PROJECT_FILES) &&
    isIntegerWithin(value.maxCargoMetadataBytes, 1, MANAGED_LSP_RUST_MAX_CARGO_METADATA_BYTES) &&
    isIntegerWithin(value.maxMemoryMb, 128, MANAGED_LSP_RUST_MAX_MEMORY_MB) &&
    isIntegerWithin(value.indexDeadlineMs, 1_000, MANAGED_LSP_RUST_MAX_INDEX_DEADLINE_MS)
  );
}

function isRustSettings(value: unknown): value is ManagedLspRustSettings {
  const validFeature = (feature: string): boolean => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(feature);
  if (!isRecord(value)) return false;
  const validTarget =
    value.target === null ||
    (typeof value.target === "string" && /^\w[\w.-]{0,127}$/u.test(value.target));
  return [
    hasOnlyKeys(value, [
      "toolchain",
      "features",
      "target",
      "cfgs",
      "noDefaultFeatures",
      "linkedProjects",
      "sysrootPolicy",
      "resourceBudget",
      "cargoMetadata",
      "dependencyDownloads",
      "procMacros",
      "buildScripts",
    ]),
    isRuntimeReference(value.toolchain),
    isBoundedUniqueStrings(value.features, MANAGED_LSP_RUST_FEATURE_MAX_COUNT, validFeature),
    validTarget,
    isRustCfgs(value.cfgs),
    typeof value.noDefaultFeatures === "boolean",
    isBoundedContainedPaths(value.linkedProjects, MANAGED_LSP_RUST_LINKED_PROJECT_MAX_COUNT),
    isStringMember(value.sysrootPolicy, ["disabled", "approvedToolchain"]),
    isRustResourceBudget(value.resourceBudget),
    isStringMember(value.cargoMetadata, ["disabled", "offline"]),
    value.dependencyDownloads === false,
    value.procMacros === false,
    value.buildScripts === false,
  ].every(Boolean);
}

function isLanguageSettings(
  value: UnknownRecord,
): value is UnknownRecord &
  (
    | Pick<ManagedLspPythonConfiguration, "language" | "settings">
    | Pick<ManagedLspGoConfiguration, "language" | "settings">
    | Pick<ManagedLspShellConfiguration, "language" | "settings">
    | Pick<ManagedLspJavaConfiguration, "language" | "settings">
    | Pick<ManagedLspRustConfiguration, "language" | "settings">
  ) {
  const language = value.language;
  const settings = value.settings;
  if (language === "python") return isPythonSettings(settings);
  if (language === "go") return isGoSettings(settings);
  if (language === "shell") return isShellSettings(settings);
  if (language === "java") return isJavaSettings(settings);
  if (language === "rust") return isRustSettings(settings);
  return false;
}

function isRevisionBoundEtag(value: unknown, revision: unknown): value is string {
  if (typeof value !== "string" || value.length > MANAGED_LSP_ETAG_MAX_CHARS) return false;
  const match = /^"lspcfg-(\d+)-[A-Za-z0-9_-]{16,64}"$/u.exec(value);
  return match !== null && isRevision(revision) && Number(match[1]) === revision;
}

function validRuntimeConfiguration(
  value: UnknownRecord,
): value is UnknownRecord & ManagedLspRuntimeConfiguration {
  return [
    hasOnlyKeys(value, [
      "schemaVersion",
      "language",
      "revision",
      "etag",
      "activation",
      "runtime",
      "provenance",
      "restartRequired",
      "restartFields",
      "settings",
    ]),
    value.schemaVersion === MANAGED_LSP_RUNTIME_SCHEMA_VERSION,
    isRevisionBoundEtag(value.etag, value.revision),
    isStringMember(value.activation, ["enabled", "disabled"]),
    isRuntimeReference(value.runtime),
    isProvenance(value.provenance),
    isRestartFields(value.restartFields, value.restartRequired),
    isLanguageSettings(value),
  ].every(Boolean);
}

function parseRuntimeConfigurationUnsafe(value: unknown): ManagedLspRuntimeParseResult {
  if (!isRecord(value)) return { ok: false, errors: ["runtime configuration must be an object"] };
  const valid = validRuntimeConfiguration(value);
  return valid
    ? { ok: true, value }
    : { ok: false, errors: ["runtime configuration is invalid or contains unknown fields"] };
}

export function parseManagedLspRuntimeConfiguration(value: unknown): ManagedLspRuntimeParseResult {
  return parseSafely(() => parseRuntimeConfigurationUnsafe(value));
}

export function matchesManagedLspConfigurationPrecondition(
  configuration: ManagedLspRuntimeConfiguration,
  precondition: ManagedLspConfigurationPrecondition,
): boolean {
  return (
    configuration.revision === precondition.revision && configuration.etag === precondition.etag
  );
}
