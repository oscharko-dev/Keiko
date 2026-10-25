import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { causeChain, keikoStackFrames, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { correlationIdOrUnknown } from "../correlation.js";
import {
  OWNER_PRIVATE_FILE_REFUSALS,
  OwnerPrivateFileRefused,
  readOwnerPrivateFile,
} from "../ownerPrivateStateFile.js";
import { onlyKeys, plainRecord } from "../operatorRegistryJson.js";
import { CODING_RUNTIME_FAILURE_TRACE_FIELDS } from "./codingRuntimeActivityOperations.js";
import {
  readPluginPackage,
  writePluginPackage,
  type PluginPackageFile,
} from "./opencodeOperatorPluginPackage.js";
import type { SecureWorkspaceTextReadResult } from "./secureWorkspaceTextRead.js";

/**
 * OpenCode plugins are executable code the producer imports into its own process (#3903 AC2), so
 * repository text never registers one: the project layer stays off and `plugins` in a project
 * `opencode.json` is dropped. A plugin loads only when the operator names it in the owner-private
 * registry `<stateDir>/opencode-plugins.json` together with the SHA-256 of the exact file. Keiko
 * copies a file whose bytes match into the run's private configuration directory, which the kernel
 * keeps read-only to the run, and the producer discovers Keiko's generated wrapper for it. The
 * wrapper lets the plugin's permission hooks narrow an effect but never widen one, so Keiko's
 * decisions stand in whichever order the hooks run. Beyond that an admitted plugin is operator
 * code: the kernel boundary and Keiko's server-side authority bind it like the runtime itself, but
 * per-action approval cannot, so plugins load only for a run launched in Full access, the mode whose
 * effects already proceed inside the envelope without a per-action decision. Keiko's own plugins
 * stay required: a plugin that claims one of their identities fails the run's readiness. A
 * mismatch, an unreadable file or any other doubt admits nothing of that plugin.
 */
export const OPENCODE_PLUGIN_REGISTRY_FILE = "opencode-plugins.json";
const MAX_REGISTRY_BYTES = 16_384;
const MAX_PLUGINS = 8;
const MAX_PLUGIN_BYTES = 524_288;
const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const PLUGIN_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".mjs", ".ts"]);
const SHA256_HEX = /^[0-9a-f]{64}$/u;
/** Admitted wrappers carry this prefix: never a name Keiko's own generated plugins use. */
const ADMITTED_PREFIX = "admitted-";
/** Beside `plugins`, inside the configuration directory the kernel keeps read-only to the run. */
const OPERATOR_PLUGIN_DIRECTORY = "operator-plugins";
const FULL_ACCESS = "autonomous-delivery";

export type OperatorPluginSource =
  | { readonly kind: "workspace"; readonly path: string }
  | { readonly kind: "file"; readonly path: string }
  /** A locally installed npm package: its directory and its entry module inside it. */
  | { readonly kind: "package"; readonly path: string; readonly entry: string };

export interface OperatorPluginDefinition {
  readonly name: string;
  readonly source: OperatorPluginSource;
  readonly sha256: string;
}

const REGISTRY_REASONS = [
  "malformed",
  "schema-version",
  "too-many-plugins",
  "plugin-invalid",
  "duplicate-plugin",
  "not-json",
  ...OWNER_PRIVATE_FILE_REFUSALS,
] as const;
type RegistryReason = (typeof REGISTRY_REASONS)[number];

export type OperatorPluginRegistry =
  | { readonly state: "absent" | "loaded"; readonly plugins: readonly OperatorPluginDefinition[] }
  | { readonly state: "refused"; readonly plugins: readonly []; readonly reason: RegistryReason };

/**
 * Reads the operator's plugin registry. A missing file is no plugin; a file Keiko cannot trust
 * (`OwnerPrivateFileRefused`) or that is not JSON (`SyntaxError`) throws, and the admission records
 * it as a refused registry.
 */
export function loadOperatorPluginRegistry(stateDir: string): OperatorPluginRegistry {
  const bytes = readOwnerPrivateFile(
    join(stateDir, OPENCODE_PLUGIN_REGISTRY_FILE),
    MAX_REGISTRY_BYTES,
  );
  if (bytes === undefined) return { state: "absent", plugins: [] };
  const parsed = parseOperatorPluginRegistry(JSON.parse(bytes.toString("utf8")) as unknown);
  return parsed.ok
    ? { state: "loaded", plugins: parsed.plugins }
    : { state: "refused", plugins: [], reason: parsed.reason };
}

/** The closed registry grammar: `{ "schemaVersion": 1, "plugins": [{ name, workspacePath | path, sha256 }] }`. */
export function parseOperatorPluginRegistry(
  value: unknown,
):
  | { readonly ok: true; readonly plugins: readonly OperatorPluginDefinition[] }
  | { readonly ok: false; readonly reason: RegistryReason } {
  const document = plainRecord(value);
  if (document === undefined || !onlyKeys(document, ["schemaVersion", "plugins"]))
    return { ok: false, reason: "malformed" };
  if (document.schemaVersion !== 1) return { ok: false, reason: "schema-version" };
  const entries = document.plugins;
  if (!Array.isArray(entries)) return { ok: false, reason: "malformed" };
  if (entries.length > MAX_PLUGINS) return { ok: false, reason: "too-many-plugins" };
  const plugins: OperatorPluginDefinition[] = [];
  for (const entry of entries as readonly unknown[]) {
    const plugin = pluginDefinition(entry);
    if (plugin === undefined) return { ok: false, reason: "plugin-invalid" };
    if (plugins.some((known) => known.name === plugin.name))
      return { ok: false, reason: "duplicate-plugin" };
    plugins.push(plugin);
  }
  return { ok: true, plugins };
}

function pluginDefinition(value: unknown): OperatorPluginDefinition | undefined {
  const entry = plainRecord(value);
  if (entry === undefined || !onlyKeys(entry, ["name", "workspacePath", "path", "entry", "sha256"]))
    return undefined;
  const { name, workspacePath, path, sha256 } = entry;
  if (typeof name !== "string" || !PLUGIN_NAME.test(name) || name.startsWith("keiko"))
    return undefined;
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) return undefined;
  const source =
    entry.entry === undefined
      ? pluginSource(workspacePath, path)
      : packageSource(workspacePath, path, entry.entry);
  return source === undefined ? undefined : { name, source, sha256 };
}

// Exactly one source: a workspace-relative file the producer would have loaded, or an absolute file
// the operator installed; either names a module by an allowed extension.
function pluginSource(workspacePath: unknown, path: unknown): OperatorPluginSource | undefined {
  if (typeof workspacePath === "string" && path === undefined)
    return containedRelative(workspacePath) && moduleFile(workspacePath)
      ? { kind: "workspace", path: workspacePath }
      : undefined;
  if (typeof path === "string" && workspacePath === undefined)
    return isAbsolute(path) && resolve(path) === path && moduleFile(path)
      ? { kind: "file", path }
      : undefined;
  return undefined;
}

// A package is an absolute directory the operator installed, and its entry a module inside it.
function packageSource(
  workspacePath: unknown,
  path: unknown,
  entry: unknown,
): OperatorPluginSource | undefined {
  if (workspacePath !== undefined || typeof path !== "string" || typeof entry !== "string")
    return undefined;
  if (!isAbsolute(path) || resolve(path) !== path) return undefined;
  const relative = entry.split("/").join(sep);
  return containedRelative(relative) && moduleFile(entry) && !entry.includes("\\")
    ? { kind: "package", path, entry }
    : undefined;
}

function containedRelative(path: string): boolean {
  return !isAbsolute(path) && normalize(path) === path && !path.startsWith("..");
}

function moduleFile(path: string): boolean {
  return PLUGIN_EXTENSIONS.has(extname(path));
}

const ADMISSION_STATES = [
  "absent",
  "registry-refused",
  "mode-restricted",
  "admitted",
  "failed",
] as const;
type AdmissionState = (typeof ADMISSION_STATES)[number];
const PLUGIN_REFUSALS = [
  "digest-mismatch",
  "unreadable",
  "too-large",
  "workspace-unavailable",
  "entry-missing",
] as const;
type PluginRefusal = (typeof PLUGIN_REFUSALS)[number];

export interface OperatorPluginsAdmissionRequest {
  readonly runId: string;
  /** The run's private configuration directory (`openCodeConfigDirectory(stateRoot)`), created. */
  readonly discoveryRoot: string;
  /** The run's launch mode (`KEIKO_CODING_MODE`); only Full access loads a plugin. */
  readonly mode: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface OperatorPluginsAdmissionInput {
  readonly registry: () => OperatorPluginRegistry;
  /** The run's exact-workspace secure read, for a workspace source. */
  readonly readWorkspaceText: (
    relativePath: string,
    signal: AbortSignal | undefined,
  ) => Promise<SecureWorkspaceTextReadResult>;
  readonly activityLog: ServerLogSink | undefined;
}

export interface OperatorPluginsPort {
  /**
   * Writes the admitted copies and records one line. A plugin it cannot admit is refused, never
   * thrown; it rejects only when it cannot clear an earlier admission, which must fail the prepare.
   */
  readonly admitForRun: (request: OperatorPluginsAdmissionRequest) => Promise<void>;
}

export function createOperatorPluginsPort(
  input: OperatorPluginsAdmissionInput,
): OperatorPluginsPort {
  return { admitForRun: (request) => admitOperatorPlugins(input, request) };
}

interface Outcome {
  readonly state: AdmissionState;
  readonly pluginCount: number;
  readonly admitted: readonly OperatorPluginDefinition[];
  readonly refusals: readonly PluginRefusal[];
  readonly registryReason?: RegistryReason | undefined;
}

async function admitOperatorPlugins(
  input: OperatorPluginsAdmissionInput,
  request: OperatorPluginsAdmissionRequest,
): Promise<void> {
  try {
    clearAdmittedCopies(request.discoveryRoot);
    const outcome = await admission(input, request);
    recordOperatorPluginsAdmission(input.activityLog, request.runId, outcome);
  } catch (error) {
    recordOperatorPluginsAdmission(input.activityLog, request.runId, failedOutcome(error), error);
    // What this admission wrote goes again. A directory Keiko cannot clear fails the prepare: a
    // copy left behind would load in a run that never admitted it.
    clearAdmittedCopies(request.discoveryRoot);
  }
}

// A registry file Keiko cannot trust or parse refuses the registry; anything else is a failure.
function failedOutcome(error: unknown): Outcome {
  const none = { pluginCount: 0, admitted: [], refusals: [] } as const;
  if (error instanceof OwnerPrivateFileRefused)
    return { state: "registry-refused", ...none, registryReason: error.reason };
  if (error instanceof SyntaxError)
    return { state: "registry-refused", ...none, registryReason: "not-json" };
  // The file was replaced by a link between the check and the no-follow open.
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ELOOP")
    return { state: "registry-refused", ...none, registryReason: "not-regular-file" };
  return { state: "failed", ...none };
}

async function admission(
  input: OperatorPluginsAdmissionInput,
  request: OperatorPluginsAdmissionRequest,
): Promise<Outcome> {
  const registry = input.registry();
  const pluginCount = registry.plugins.length;
  if (registry.state === "refused")
    return {
      state: "registry-refused",
      pluginCount,
      admitted: [],
      refusals: [],
      registryReason: registry.reason,
    };
  if (pluginCount === 0) return { state: "absent", pluginCount, admitted: [], refusals: [] };
  if (request.mode !== FULL_ACCESS)
    return { state: "mode-restricted", pluginCount, admitted: [], refusals: [] };
  const admitted: OperatorPluginDefinition[] = [];
  const refusals: PluginRefusal[] = [];
  for (const plugin of registry.plugins) {
    const read = await pluginContent(input, plugin, request.signal);
    if (typeof read === "string") refusals.push(read);
    else if (read.sha256 !== plugin.sha256) refusals.push("digest-mismatch");
    else {
      writeAdmittedCopy(request.discoveryRoot, plugin, read);
      admitted.push(plugin);
    }
  }
  return { state: "admitted", pluginCount, admitted, refusals };
}

/** What an admitted plugin copies: its digest and the files below its module path. */
interface PluginContent {
  readonly sha256: string;
  /** The module the wrapper imports, relative to the operator directory. */
  readonly module: string;
  readonly files: readonly PluginPackageFile[];
}

async function pluginContent(
  input: OperatorPluginsAdmissionInput,
  plugin: OperatorPluginDefinition,
  signal: AbortSignal | undefined,
): Promise<PluginContent | PluginRefusal> {
  if (plugin.source.kind === "package") {
    const read = readPluginPackage(plugin.source.path, plugin.source.entry);
    if (!read.ok) return read.reason;
    // The tree is copied below a directory of the plugin's own name, as its module path says.
    return {
      sha256: read.sha256,
      module: `${plugin.name}/${plugin.source.entry}`,
      files: read.files.map((file) => ({ path: `${plugin.name}/${file.path}`, bytes: file.bytes })),
    };
  }
  const bytes = await pluginBytes(input, plugin, signal);
  if (typeof bytes === "string") return bytes;
  const module = `${plugin.name}${extname(plugin.source.path)}`;
  return { sha256: sha256(bytes), module, files: [{ path: module, bytes }] };
}

async function pluginBytes(
  input: OperatorPluginsAdmissionInput,
  plugin: OperatorPluginDefinition,
  signal: AbortSignal | undefined,
): Promise<Buffer | PluginRefusal> {
  if (plugin.source.kind === "workspace") {
    const read = await input.readWorkspaceText(plugin.source.path, signal);
    if (!read.ok)
      return read.reason === "workspace-unavailable" ? "workspace-unavailable" : "unreadable";
    const bytes = Buffer.from(read.text, "utf8");
    return bytes.length > MAX_PLUGIN_BYTES ? "too-large" : bytes;
  }
  try {
    return readOwnerPrivateFile(plugin.source.path, MAX_PLUGIN_BYTES) ?? "unreadable";
  } catch (error) {
    if (error instanceof OwnerPrivateFileRefused)
      return error.reason === "too-large" ? "too-large" : "unreadable";
    throw error;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// The operator's file goes beside the discovered directory, where the producer never loads it on
// its own; the discovered entry is Keiko's generated wrapper, which imports it.
function writeAdmittedCopy(
  discoveryRoot: string,
  plugin: OperatorPluginDefinition,
  content: PluginContent,
): void {
  const operatorRoot = join(discoveryRoot, OPERATOR_PLUGIN_DIRECTORY);
  mkdirSync(operatorRoot, { recursive: true, mode: 0o700 });
  chmodSync(operatorRoot, 0o700);
  writePluginPackage(operatorRoot, content.files);
  writePrivateCopy(
    join(discoveryRoot, "plugins", `${ADMITTED_PREFIX}${plugin.name}.ts`),
    Buffer.from(operatorPluginWrapperSource(content.module), "utf8"),
  );
}

function writePrivateCopy(target: string, bytes: Buffer): void {
  writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
  chmodSync(target, 0o600);
}

/**
 * The discovered module for one admitted plugin. It hands the plugin the producer's context with
 * one change: a permission hook may only narrow the effect it receives (allow → ask → deny), and it
 * judges a copy of the event, so it can neither widen Keiko's decision nor alter what Keiko's own
 * hook reads, in whichever order the hooks run. Every other permission hook is refused, and only
 * the public `setup` form loads: an `effect` export would reach the producer's services directly.
 */
export function operatorPluginWrapperSource(module: string): string {
  const specifier = JSON.stringify(`../${OPERATOR_PLUGIN_DIRECTORY}/${module}`);
  return [
    "// Generated by Keiko: an operator-admitted OpenCode plugin (#3903 AC2). Do not edit.",
    `import admitted from ${specifier};`,
    "const RANK = { allow: 0, ask: 1, deny: 2 };",
    "function narrowing(hook) {",
    "  return async (event) => {",
    "    const before = RANK[event.effect];",
    "    if (before === undefined) return;",
    "    let view;",
    "    try {",
    "      view = structuredClone({ sessionID: event.sessionID, agent: event.agent, action: event.action, resources: event.resources, metadata: event.metadata, source: event.source, effect: event.effect, message: event.message });",
    "    } catch {",
    "      return;",
    "    }",
    "    await hook(view);",
    "    const after = RANK[view.effect];",
    "    if (after === undefined || after <= before) return;",
    "    event.effect = view.effect;",
    '    if (typeof view.message === "string") event.message = view.message;',
    "  };",
    "}",
    "function governed(ctx) {",
    "  const permission = Object.freeze({",
    "    hook(name, hook) {",
    '      if (name !== "evaluate" || typeof hook !== "function") throw new Error("Keiko admits only a narrowing permission evaluate hook.");',
    '      return ctx.permission.hook("evaluate", narrowing(hook));',
    "    },",
    "  });",
    '  return new Proxy(ctx, { get: (target, key) => (key === "permission" ? permission : Reflect.get(target, key)) });',
    "}",
    "export default {",
    "  id: admitted?.id,",
    "  async setup(ctx) {",
    '    if (typeof admitted?.setup !== "function") throw new Error("Keiko loads only a setup plugin.");',
    "    return admitted.setup(governed(ctx));",
    "  },",
    "};",
    "",
  ].join("\n");
}

// The directories reflect exactly this admission: nothing an earlier prepare admitted outlives it.
function clearAdmittedCopies(discoveryRoot: string): void {
  const pluginRoot = join(discoveryRoot, "plugins");
  for (const entry of existsSync(pluginRoot) ? readdirSync(pluginRoot) : []) {
    if (entry.startsWith(ADMITTED_PREFIX)) rmSync(join(pluginRoot, entry), { force: true });
  }
  rmSync(join(discoveryRoot, OPERATOR_PLUGIN_DIRECTORY), { recursive: true, force: true });
}

const COUNT = { type: "integer", dataClass: "count", required: true } as const;

const OPERATOR_PLUGINS_ADMITTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.operator-plugins.admitted",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeOperatorPlugins.recordOperatorPluginsAdmission",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...ADMISSION_STATES],
    },
    pluginCount: COUNT,
    admittedCount: COUNT,
    refusedCount: COUNT,
    // SHA-256 over the admitted names and file digests, so the exact plugin set is reconstructable.
    admittedSha256: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    refusalReasons: {
      type: "string-array",
      dataClass: "closed-enum",
      required: false,
      maxItems: 4,
      values: [...PLUGIN_REFUSALS],
    },
    registryReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...REGISTRY_REASONS],
    },
    ...CODING_RUNTIME_FAILURE_TRACE_FIELDS,
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  diagnosticWhen: [{ field: "state", values: ["registry-refused", "failed"] }],
  failureClasses: ["coding-runtime-operator-plugins"],
  proofIds: ["coding-runtime.operator-plugins.admitted.emitted-line"],
  releaseImpact: "patch",
});

function admittedDigest(admitted: readonly OperatorPluginDefinition[]): string | undefined {
  if (admitted.length === 0) return undefined;
  const lines = admitted
    .map((plugin) => `${plugin.name}:${plugin.sha256}`)
    .sort((left, right) => left.localeCompare(right));
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

/** Counts, closed reasons and digests only; never a name, a path or a byte of a plugin. */
export function recordOperatorPluginsAdmission(
  activityLog: ServerLogSink | undefined,
  runId: string,
  outcome: Outcome,
  error?: unknown,
): void {
  const digest = admittedDigest(outcome.admitted);
  const warn =
    outcome.state === "failed" ||
    outcome.state === "registry-refused" ||
    outcome.refusals.length > 0;
  activityLog?.write(
    activityLogEvent(
      OPERATOR_PLUGINS_ADMITTED_OPERATION,
      {
        correlationId: correlationIdOrUnknown(runId),
        ...(warn ? { level: "warn" as const } : {}),
        ...(outcome.state === "failed" ? { errorKind: "internal" as const } : {}),
      },
      {
        runId,
        state: outcome.state,
        pluginCount: outcome.pluginCount,
        admittedCount: outcome.admitted.length,
        refusedCount: outcome.refusals.length,
        ...(digest === undefined ? {} : { admittedSha256: digest }),
        ...(outcome.refusals.length === 0
          ? {}
          : { refusalReasons: [...new Set(outcome.refusals)].sort((a, b) => a.localeCompare(b)) }),
        ...(outcome.registryReason === undefined ? {} : { registryReason: outcome.registryReason }),
        ...(error === undefined
          ? {}
          : { frames: keikoStackFrames(error), causeChain: causeChain(error) }),
      },
    ),
  );
}
