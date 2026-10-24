/**
 * The complete service inventory of the pinned OpenCode producer (#3899 AC3, #3907 AC2, #3908 AC4).
 *
 * `opencodeProtocolSurface.ts` pins only the subset of the producer's HTTP API that Keiko admits;
 * an allowlist of existing endpoints is not an inventory. This module closes the other half. The
 * committed fixture `opencodeServiceInventory.opencode-<version>.fixture.json` lists EVERY operation
 * the shipped executable serves (derived from its own `/openapi.json`, never typed by hand) and its
 * CLI commands, and the tables below give each one a closed disposition: admitted, covered by an
 * admitted operation, provided by a named Keiko product operation, or refused for a closed reason
 * with the open issue that owns it. Nothing here executes: it grants no authority and changes no
 * runtime behaviour. The tests fail closed when an operation has no disposition, when a disposition
 * names an operation the producer no longer serves, and when the admitted set stops equalling the
 * pinned protocol surface; the real-binary test detects drift of the live document against the
 * fixture, and `diffOpenCodeServiceOperations` names what an upgrade added, removed or moved.
 *
 * The same holds for the producer's configuration (#3903 AC5, #3908 AC2): the fixture lists every
 * setting path its configuration schema declares, and `OPENCODE_CONFIGURATION_DISPOSITIONS` says
 * of each one whether Keiko composes it, a named Keiko product owner provides it, or it stays
 * unavailable for a closed reason with its owning issue. An unavailable setting keeps the
 * producer's own default, because no configuration layer the runtime loads can set it. The same
 * fixture lists the producer's built-in plugins (`GET /api/plugin`), and
 * `OPENCODE_PLUGIN_DISPOSITIONS` says of each whether it runs natively, only applies settings of
 * the configuration inventory, or offers nothing a Keiko run can use, for a closed reason.
 */
import { OPENCODE_V2_APPROVED_ENDPOINTS } from "./opencodeProtocolSurface.js";

/** One operation of the producer's OpenAPI document. */
export interface OpenCodeServiceOperation {
  readonly operationId: string;
  /** Upper-case HTTP method. */
  readonly method: string;
  readonly path: string;
}

/** The committed, producer-derived inventory of one pinned version. */
export interface OpenCodeServiceInventory {
  readonly version: string;
  readonly operations: readonly OpenCodeServiceOperation[];
  /** Leaf CLI command paths (`auth login`); absent for a version whose binary was not captured. */
  readonly cliCommands?: readonly string[];
  /** Every setting path of the configuration schema (`extractOpenCodeConfigurationPaths`). */
  readonly configurationPaths?: readonly string[];
  /** The ids of the producer's built-in plugins (`extractOpenCodeBuiltinPlugins`). */
  readonly plugins?: readonly string[];
}

const OPERATION_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function describeOperation(operation: OpenCodeServiceOperation): string {
  return `${operation.method} ${operation.path}`;
}

function indexByOperationId(
  operations: readonly OpenCodeServiceOperation[],
): ReadonlyMap<string, OpenCodeServiceOperation> {
  const index = new Map<string, OpenCodeServiceOperation>();
  for (const operation of operations) {
    if (index.has(operation.operationId)) {
      throw new TypeError("opencode-service-operation-id-duplicate");
    }
    index.set(operation.operationId, operation);
  }
  return index;
}

/**
 * Every operation of an OpenAPI document, ordered by `operationId`. A document without `paths`, an
 * operation without an `operationId` or a repeated `operationId` throws: an inventory that could
 * silently drop an operation would hide exactly the drift it exists to detect.
 */
export function extractOpenCodeServiceOperations(
  document: unknown,
): readonly OpenCodeServiceOperation[] {
  const paths = record(record(document)?.paths);
  if (paths === undefined) throw new TypeError("opencode-openapi-paths-missing");
  const operations: OpenCodeServiceOperation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    for (const method of OPERATION_METHODS) {
      const operation = record(record(item)?.[method]);
      if (operation === undefined) continue;
      const operationId = operation.operationId;
      if (typeof operationId !== "string" || operationId === "") {
        throw new TypeError("opencode-openapi-operation-id-missing");
      }
      operations.push({ operationId, method: method.toUpperCase(), path });
    }
  }
  indexByOperationId(operations);
  return operations.sort((a, b) => compareCodeUnits(a.operationId, b.operationId));
}

function isOperation(value: unknown): value is OpenCodeServiceOperation {
  const item = record(value);
  return (
    typeof item?.operationId === "string" &&
    typeof item.method === "string" &&
    typeof item.path === "string"
  );
}

const INVENTORY_MALFORMED = "opencode-service-inventory-malformed";

function optionalNames(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(INVENTORY_MALFORMED);
  }
  return value;
}

/** Parses a committed inventory fixture, refusing any shape other than the one written. */
export function parseOpenCodeServiceInventory(json: string): OpenCodeServiceInventory {
  const parsed = record(JSON.parse(json) as unknown);
  const operations = parsed?.operations;
  if (typeof parsed?.version !== "string" || !Array.isArray(operations)) {
    throw new TypeError(INVENTORY_MALFORMED);
  }
  if (!operations.every(isOperation)) throw new TypeError(INVENTORY_MALFORMED);
  const cliCommands = optionalNames(parsed.cliCommands);
  const configurationPaths = optionalNames(parsed.configurationPaths);
  const plugins = optionalNames(parsed.plugins);
  return {
    version: parsed.version,
    operations,
    ...(cliCommands === undefined ? {} : { cliCommands }),
    ...(configurationPaths === undefined ? {} : { configurationPaths }),
    ...(plugins === undefined ? {} : { plugins }),
  };
}

/**
 * The ids of the built-in plugins in the producer's own plugin listing (`GET /api/plugin`),
 * ordered. Keiko's generated plugins and any other source are not built-in and are left out. An
 * entry without an id, or an id listed twice, throws: the inventory must not drop a plugin.
 */
export function extractOpenCodeBuiltinPlugins(
  listing: readonly Readonly<Record<string, unknown>>[],
): readonly string[] {
  const ids = listing
    .filter((entry) => record(entry.source)?.type === "builtin")
    .map((entry) => {
      if (typeof entry.id !== "string" || entry.id === "")
        throw new TypeError("opencode-plugin-id-missing");
      return entry.id;
    });
  if (new Set(ids).size !== ids.length) throw new TypeError("opencode-plugin-id-duplicate");
  return ids.sort(compareCodeUnits);
}

const CONFIGURATION_ROOT_SCHEMA = "Config.InfoEncoded";
const SCHEMA_REFERENCE_PREFIX = "#/components/schemas/";
const SCHEMA_UNIONS = ["anyOf", "oneOf", "allOf"] as const;

interface SchemaWalk {
  readonly schemas: Readonly<Record<string, unknown>>;
  readonly paths: Set<string>;
}

interface ResolvedSchema {
  readonly schema: Readonly<Record<string, unknown>>;
  /** The references expanded on the way here: a reference is expanded once per path. */
  readonly expanded: readonly string[];
}

function resolveSchema(
  node: unknown,
  expanded: readonly string[],
  walk: SchemaWalk,
): ResolvedSchema | undefined {
  const value = record(node);
  if (value === undefined) return undefined;
  const reference = value.$ref;
  if (typeof reference !== "string") return { schema: value, expanded };
  if (expanded.includes(reference)) return undefined;
  const target = reference.startsWith(SCHEMA_REFERENCE_PREFIX)
    ? record(walk.schemas[reference.slice(SCHEMA_REFERENCE_PREFIX.length)])
    : undefined;
  if (target === undefined) throw new TypeError("opencode-configuration-reference-unresolved");
  return { schema: target, expanded: [...expanded, reference] };
}

/** The alternatives and the array items of a schema: each declares settings at the same path. */
function schemaBranches(schema: Readonly<Record<string, unknown>>): readonly unknown[] {
  const unions = SCHEMA_UNIONS.flatMap((key) => {
    const branches = schema[key];
    return Array.isArray(branches) ? (branches as readonly unknown[]) : [];
  });
  return schema.items === undefined ? unions : [...unions, schema.items];
}

function settingPath(prefix: string, key: string): string {
  return prefix === "" ? key : `${prefix}.${key}`;
}

function visitSetting(
  node: unknown,
  path: string,
  expanded: readonly string[],
  walk: SchemaWalk,
): void {
  walk.paths.add(path);
  visitSchema(node, path, expanded, walk);
}

function visitSchema(
  node: unknown,
  prefix: string,
  expanded: readonly string[],
  walk: SchemaWalk,
): void {
  const resolved = resolveSchema(node, expanded, walk);
  if (resolved === undefined) return;
  const { schema } = resolved;
  for (const branch of schemaBranches(schema)) visitSchema(branch, prefix, resolved.expanded, walk);
  for (const [key, child] of Object.entries(record(schema.properties) ?? {}))
    visitSetting(child, settingPath(prefix, key), resolved.expanded, walk);
  const named = record(schema.additionalProperties);
  if (named !== undefined) visitSetting(named, settingPath(prefix, "*"), resolved.expanded, walk);
}

/**
 * Every setting the producer's configuration schema declares (#3903 AC5, #3908 AC2): the dotted
 * path of each named property, with `*` where the configuration names its own key (an agent, a
 * provider, a header). It follows `$ref`, unions and array items, so an array of rules declares
 * `permissions.action` and a union declares the settings of every alternative; a reference is
 * expanded once per path, so a recursive schema ends. Derived from the producer's own
 * `/openapi.json`, never typed by hand, and ordered by code unit.
 */
export function extractOpenCodeConfigurationPaths(document: unknown): readonly string[] {
  const schemas = record(record(record(document)?.components)?.schemas);
  if (schemas?.[CONFIGURATION_ROOT_SCHEMA] === undefined)
    throw new TypeError("opencode-configuration-schema-missing");
  const walk: SchemaWalk = { schemas, paths: new Set() };
  visitSchema({ $ref: `${SCHEMA_REFERENCE_PREFIX}${CONFIGURATION_ROOT_SCHEMA}` }, "", [], walk);
  return [...walk.paths].sort(compareCodeUnits);
}

/** The setting paths an upgrade added and removed; a removal can break a setting Keiko writes. */
export function diffOpenCodeConfigurationPaths(
  previous: readonly string[],
  next: readonly string[],
): { readonly added: readonly string[]; readonly removed: readonly string[] } {
  const before: ReadonlySet<string> = new Set(previous);
  const after: ReadonlySet<string> = new Set(next);
  return {
    added: next.filter((path) => !before.has(path)),
    removed: previous.filter((path) => !after.has(path)),
  };
}

/** An operation whose `operationId` stayed but whose method or path moved. */
export interface OpenCodeServiceOperationChange {
  readonly operationId: string;
  readonly previous: string;
  readonly next: string;
}

export interface OpenCodeServiceOperationDiff {
  /** `operationId`s the newer producer serves and the older did not; each needs a disposition. */
  readonly added: readonly string[];
  /** `operationId`s the older producer served and the newer does not. */
  readonly removed: readonly string[];
  readonly changed: readonly OpenCodeServiceOperationChange[];
  /** A removed or moved operation breaks a client written against the older version. */
  readonly breaking: boolean;
}

/** What an upgrade added, removed or moved, keyed by `operationId`. */
export function diffOpenCodeServiceOperations(
  previous: readonly OpenCodeServiceOperation[],
  next: readonly OpenCodeServiceOperation[],
): OpenCodeServiceOperationDiff {
  const before = indexByOperationId(previous);
  const after = indexByOperationId(next);
  const added = [...after.keys()].filter((id) => !before.has(id)).sort(compareCodeUnits);
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort(compareCodeUnits);
  const changed: OpenCodeServiceOperationChange[] = [];
  for (const [operationId, operation] of after) {
    const earlier = before.get(operationId);
    if (earlier === undefined || describeOperation(earlier) === describeOperation(operation)) {
      continue;
    }
    changed.push({
      operationId,
      previous: describeOperation(earlier),
      next: describeOperation(operation),
    });
  }
  changed.sort((a, b) => compareCodeUnits(a.operationId, b.operationId));
  return { added, removed, changed, breaking: removed.length > 0 || changed.length > 0 };
}

/**
 * The command names of a `--help` SUBCOMMANDS section, first spelling only (`upgrade, update`
 * yields `upgrade`). A help text without that section names no subcommand.
 */
export function parseOpenCodeCliSubcommands(help: string): readonly string[] {
  const lines = help.split("\n");
  const start = lines.findIndex((line) => line.trim() === "SUBCOMMANDS");
  if (start < 0) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || /^\S/u.test(line)) break;
    const name = /^ {2}([^\s,]+)/u.exec(line)?.[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

/**
 * Why an original surface is not offered. A reason is a statement about the surface, never a
 * permanent veto: `refused` always names the open issue that owns the decision or the work.
 */
export const OPENCODE_SERVICE_REFUSAL_REASONS = [
  "leaves-machine",
  "keiko-owns-workspace-binding",
  "keiko-owns-authority",
  "keiko-owns-configuration",
  "keiko-owns-credentials",
  "experimental-unadmitted",
  "host-surface",
  "not-yet-implemented",
  "producer-inert",
] as const;

export type OpenCodeServiceRefusalReason = (typeof OPENCODE_SERVICE_REFUSAL_REASONS)[number];

export type OpenCodeServiceDisposition =
  /** In the digest-pinned protocol surface; derived, never listed here. */
  | { readonly kind: "admitted" }
  /** Nothing is missing: an admitted operation returns the same facts (`by` is its operationId). */
  | { readonly kind: "covered"; readonly by: string }
  /** A Keiko product operation provides the capability; `source` is relative to `src/`. */
  | { readonly kind: "keiko-operation"; readonly operation: string; readonly source: string }
  | {
      readonly kind: "refused";
      readonly reason: OpenCodeServiceRefusalReason;
      /** The epic #3897 issue that owns the decision or the implementation. */
      readonly owner: number;
    };

type KeikoOperationDisposition = Extract<
  OpenCodeServiceDisposition,
  { readonly kind: "keiko-operation" }
>;
type RefusedDisposition = Extract<OpenCodeServiceDisposition, { readonly kind: "refused" }>;

/**
 * Of one configuration setting: Keiko composes it for every native run (`keiko-set`, the value
 * `createFixedOpenCodeV2Config` writes), a named Keiko product owner provides what it configures,
 * or it is refused for a closed reason with its owner and keeps the producer's default.
 */
export type OpenCodeConfigurationDisposition =
  { readonly kind: "keiko-set" } | KeikoOperationDisposition | RefusedDisposition;

interface OpenCodeDispositionEntry<D> {
  /** An `operationId`, a leaf command path, or a configuration setting path. */
  readonly name: string;
  readonly disposition: D;
  /** Capability-matrix rows (`docs/qa/opencode-capability-parity.md`) that carry the status. */
  readonly rows: readonly string[];
}

export type OpenCodeServiceDispositionEntry = OpenCodeDispositionEntry<
  Exclude<OpenCodeServiceDisposition, { readonly kind: "admitted" }>
>;

export type OpenCodeConfigurationDispositionEntry =
  OpenCodeDispositionEntry<OpenCodeConfigurationDisposition>;

/**
 * Of one built-in plugin, which the producer loads in every run: it runs as in standalone OpenCode
 * (`native`; where it acts on the workspace, the machine or the network, that effect passes
 * `keiko.native-policy` and the native sandbox), it only applies a setting of the configuration
 * inventory, whose disposition then decides (`configuration`), or what it offers is unavailable in
 * a Keiko run for a closed reason with its owner (`refused`).
 */
export type OpenCodePluginDisposition =
  | { readonly kind: "native" }
  | { readonly kind: "configuration"; readonly setting: string }
  | RefusedDisposition;

export type OpenCodePluginDispositionEntry = OpenCodeDispositionEntry<OpenCodePluginDisposition>;

interface DispositionGroup<D> {
  readonly disposition: D;
  readonly rows: readonly string[];
  readonly names: readonly string[];
}

function covered(
  by: string,
  rows: string[],
  names: string[],
): DispositionGroup<OpenCodeServiceDispositionEntry["disposition"]> {
  return { disposition: { kind: "covered", by }, rows, names };
}

function keikoOperation(
  operation: string,
  source: string,
  rows: string[],
  names: string[],
): DispositionGroup<KeikoOperationDisposition> {
  return { disposition: { kind: "keiko-operation", operation, source }, rows, names };
}

function refused(
  reason: OpenCodeServiceRefusalReason,
  owner: number,
  rows: string[],
  names: string[],
): DispositionGroup<RefusedDisposition> {
  return { disposition: { kind: "refused", reason, owner }, rows, names };
}

function keikoSet(
  rows: string[],
  names: string[],
): DispositionGroup<OpenCodeConfigurationDisposition> {
  return { disposition: { kind: "keiko-set" }, rows, names };
}

function nativePlugin(
  rows: string[],
  names: string[],
): DispositionGroup<OpenCodePluginDisposition> {
  return { disposition: { kind: "native" }, rows, names };
}

function configurationPlugin(
  setting: string,
  rows: string[],
  names: string[],
): DispositionGroup<OpenCodePluginDisposition> {
  return { disposition: { kind: "configuration", setting }, rows, names };
}

function flatten<D>(
  groups: readonly DispositionGroup<D>[],
): readonly OpenCodeDispositionEntry<D>[] {
  return groups.flatMap(({ disposition, rows, names }) =>
    names.map((name) => ({ name, disposition, rows })),
  );
}

/**
 * Every 2.1.4 HTTP operation Keiko does not admit, by `operationId`. Admitted operations are not
 * listed: `openCodeServiceDisposition` derives them from the pinned protocol surface, so this table
 * cannot restate (and drift from) it.
 */
export const OPENCODE_SERVICE_DISPOSITIONS = flatten<
  OpenCodeServiceDispositionEntry["disposition"]
>([
  covered("session.list", ["S01"], ["session.get"]),
  covered("session.message.list", ["S01"], ["session.message.get"]),
  covered("form.list", ["T18"], ["session.form.list", "session.form.get"]),
  covered(
    "permission.request.list",
    ["S16"],
    ["session.permission.list", "session.permission.get"],
  ),
  keikoOperation(
    "Model Gateway model catalog",
    "read-handlers.ts",
    ["S11"],
    ["model.list", "model.default"],
  ),
  keikoOperation(
    "Model Gateway readiness and provider settings",
    "gateway-readiness.ts",
    ["S11"],
    ["provider.list", "provider.get"],
  ),
  keikoOperation(
    "Files and Editor, human-operated",
    "files.ts",
    [],
    ["fs.read", "fs.list", "fs.find"],
  ),
  refused(
    "host-surface",
    3899,
    ["S18"],
    [
      "server.pair",
      "server.connect",
      "debug.heapDump",
      "debug.location.list",
      "debug.location.evict",
    ],
  ),
  refused("host-surface", 3899, ["S01"], ["session.synthetic", "session.generate", "session.view"]),
  refused("host-surface", 3899, ["T18"], ["session.form.create"]),
  refused(
    "host-surface",
    3899,
    ["C04"],
    ["experimental.mcp.client.token", "experimental.mcp.client"],
  ),
  refused("host-surface", 3899, ["C05"], ["rpc.call"]),
  refused(
    "host-surface",
    3901,
    ["T13"],
    [
      "pty.list",
      "pty.create",
      "pty.get",
      "pty.update",
      "pty.remove",
      "pty.connect.token",
      "pty.connect",
    ],
  ),
  refused(
    "experimental-unadmitted",
    3901,
    ["T13"],
    [
      "server.experimental.persistentPty.read",
      "server.experimental.persistentPty.list",
      "server.experimental.persistentPty.create",
      "server.experimental.persistentPty.shutdown",
      "server.experimental.persistentPty.handoff",
      "server.experimental.persistentPty.get",
      "server.experimental.persistentPty.update",
      "server.experimental.persistentPty.remove",
      "server.experimental.persistentPty.snapshot",
      "server.experimental.persistentPty.connectToken",
      "persistentPty.connect",
    ],
  ),
  refused("experimental-unadmitted", 3899, ["S18"], ["experimental.session.stats"]),
  refused("experimental-unadmitted", 3908, ["S01"], ["experimental.session.wait", "session.log"]),
  refused(
    "experimental-unadmitted",
    3908,
    [],
    ["experimental.generate.text", "experimental.migration.v1.status"],
  ),
  refused(
    "experimental-unadmitted",
    3900,
    ["C03"],
    [
      "experimental.session.instructions.entry.list",
      "experimental.session.instructions.entry.put",
      "experimental.session.instructions.entry.remove",
    ],
  ),
  refused(
    "keiko-owns-workspace-binding",
    3902,
    ["S17"],
    ["location.get", "project.list", "project.update", "vcs.init"],
  ),
  refused(
    "keiko-owns-workspace-binding",
    3902,
    ["S17", "T22"],
    ["session.move", "worktree.list", "worktree.create", "worktree.remove", "worktree.refresh"],
  ),
  refused(
    "keiko-owns-configuration",
    3903,
    ["C06"],
    ["location.reload", "config.get", "config.shells", "experimental.config.update"],
  ),
  refused("keiko-owns-configuration", 3905, ["S11", "S12"], ["session.switchModel"]),
  refused(
    "keiko-owns-authority",
    3899,
    ["S16"],
    [
      "session.permission.create",
      "permission.saved.list",
      "permission.saved.update",
      "permission.saved.remove",
    ],
  ),
  refused("keiko-owns-authority", 3901, ["T11"], ["session.environment"]),
  refused("keiko-owns-authority", 3900, ["T06"], ["experimental.fs.write"]),
  refused(
    "keiko-owns-credentials",
    3905,
    ["S11"],
    [
      "integration.list",
      "integration.get",
      "integration.connect.key",
      "integration.connect.external",
      "integration.oauth.connect",
      "integration.oauth.status",
      "integration.oauth.cancel",
      "integration.oauth.complete",
      "integration.command.connect",
      "integration.command.status",
      "integration.command.cancel",
      "credential.list",
      "credential.create",
      "credential.update",
      "credential.remove",
      "credential.activate",
    ],
  ),
  refused("leaves-machine", 3905, ["S11"], ["experimental.integration.wellknown.add"]),
  refused("leaves-machine", 3903, ["C05"], ["plugin.check", "plugin.update"]),
  refused("leaves-machine", 3903, ["T15"], ["websearch.providers", "websearch.query"]),
  refused(
    "leaves-machine",
    3899,
    [],
    ["experimental.voice.models", "experimental.voice.session", "experimental.voice.instructions"],
  ),
  refused("not-yet-implemented", 3903, ["C01"], ["agent.get"]),
  refused("not-yet-implemented", 3903, ["T17"], ["experimental.session.skill"]),
  refused(
    "not-yet-implemented",
    3903,
    ["C04"],
    [
      "mcp.list",
      "experimental.mcp.add",
      "experimental.mcp.remove",
      "experimental.mcp.connect",
      "experimental.mcp.disconnect",
      "mcp.resource.catalog",
    ],
  ),
  refused("not-yet-implemented", 3904, ["S02"], ["session.update"]),
  keikoOperation(
    "Coding History task export (local, redacted)",
    "coding-runtime/codingTaskExport.ts",
    ["S05"],
    ["experimental.session.export"],
  ),
  refused("not-yet-implemented", 3904, ["S05"], ["experimental.session.import"]),
  refused("not-yet-implemented", 3904, ["S08"], ["session.compact", "session.context"]),
  refused("not-yet-implemented", 3901, ["T11"], ["session.shell"]),
  refused(
    "not-yet-implemented",
    3901,
    ["T13"],
    // `shell.list` and `shell.remove` are admitted (#3901 AC3): the run is held while its
    // background jobs run and stops them with its turn.
    ["session.background", "shell.create", "shell.get", "shell.output"],
  ),
  refused("not-yet-implemented", 3900, ["C08"], ["reference.list"]),
  refused(
    "not-yet-implemented",
    3902,
    ["T12"],
    ["vcs.get", "vcs.base", "vcs.status", "vcs.branch.list", "vcs.diff"],
  ),
]);

/**
 * Every 2.1.4 CLI leaf command (`opencode --help`, walked recursively), by command path. `serve` is
 * the one surface Keiko starts; the rest are reached, if at all, through Keiko's own operations.
 */
export const OPENCODE_CLI_DISPOSITIONS = flatten<OpenCodeServiceDispositionEntry["disposition"]>([
  keikoOperation(
    "Coding runtime host starts the service",
    "coding-runtime/opencodeLaunchProfile.ts",
    ["S18"],
    ["serve"],
  ),
  keikoOperation(
    "Coding Workbench task run",
    "coding-runtime/codingRuntimeOrchestrator.ts",
    ["S01"],
    ["run"],
  ),
  keikoOperation(
    "Coding History",
    "coding-runtime/codingHistoryRoutes.ts",
    ["S02"],
    ["session list"],
  ),
  keikoOperation("Model Gateway model catalog", "read-handlers.ts", ["S11"], ["models"]),
  refused(
    "host-surface",
    3899,
    ["S18"],
    [
      "acp",
      "api",
      "mini",
      "pair",
      "stats",
      "debug agents",
      "debug config",
      "debug heap-dump",
      "debug paths",
      "service get",
      "service restart",
      "service set",
      "service start",
      "service status",
      "service stop",
      "service unset",
    ],
  ),
  refused("host-surface", 3898, ["S06"], ["uninstall"]),
  refused("keiko-owns-configuration", 3903, ["C06"], ["reload"]),
  refused(
    "keiko-owns-credentials",
    3905,
    ["S11"],
    ["auth export", "auth import", "auth list", "auth login", "auth logout", "auth switch"],
  ),
  refused("not-yet-implemented", 3903, ["C04"], ["mcp add", "mcp auth", "mcp list", "mcp logout"]),
  refused("not-yet-implemented", 3903, ["C05"], ["plugin list", "plugin remove"]),
  refused("leaves-machine", 3903, ["C05"], ["plugin add", "plugin check", "plugin update"]),
  keikoOperation(
    "Coding History task export (local, redacted)",
    "coding-runtime/codingTaskExport.ts",
    ["S05"],
    ["session export"],
  ),
  refused("not-yet-implemented", 3904, ["S05"], ["session import"]),
  refused("not-yet-implemented", 3904, ["S02"], ["session delete"]),
  refused("leaves-machine", 3904, ["S06"], ["upgrade"]),
]);

/**
 * Every setting path of the 2.1.4 configuration schema, by name. `keiko-set` is exactly what the
 * native profile composes (the inventory test derives it from `createFixedOpenCodeV2Config` and the
 * MCP admission, so this table cannot claim a setting the runtime is not given). A refused setting
 * keeps the producer's own default: the runtime loads no configuration layer that could set it
 * (`OPENCODE_DISABLE_PROJECT_CONFIG`, a private `HOME`), and the owner issue holds the decision.
 */
export const OPENCODE_CONFIGURATION_DISPOSITIONS = flatten<OpenCodeConfigurationDisposition>([
  keikoSet(["S06"], ["update"]),
  // The gateway-only provider policy (`OPENCODE_GATEWAY_PROVIDER_POLICIES`).
  keikoSet(["S11"], ["policies", "policies.action", "policies.effect", "policies.resource"]),
  keikoSet(["S05"], ["share"]),
  keikoSet(["S04"], ["snapshots"]),
  keikoSet(["C07"], ["formatter"]),
  keikoSet(["C01"], ["default_agent"]),
  keikoSet(
    ["S08"],
    [
      "compaction",
      "compaction.auto",
      "compaction.buffer",
      "compaction.keep",
      "compaction.keep.tokens",
    ],
  ),
  keikoSet(["S09"], ["tool_output", "tool_output.max_bytes"]),
  keikoSet(["T19"], ["experimental", "experimental.todo"]),
  keikoSet(
    ["C04"],
    [
      "mcp",
      "mcp.servers",
      "mcp.servers.*",
      "mcp.servers.*.command",
      "mcp.servers.*.oauth",
      "mcp.servers.*.type",
      "mcp.servers.*.url",
    ],
  ),
  keikoSet(
    ["S16", "C08"],
    ["permissions", "permissions.action", "permissions.effect", "permissions.resource"],
  ),
  keikoSet(
    ["S11"],
    [
      "model",
      "providers",
      "providers.*",
      "providers.*.headers",
      "providers.*.headers.*",
      "providers.*.models",
      "providers.*.models.*",
      "providers.*.models.*.capabilities",
      "providers.*.models.*.capabilities.input",
      "providers.*.models.*.capabilities.output",
      "providers.*.models.*.capabilities.tools",
      "providers.*.models.*.cost",
      "providers.*.models.*.cost.input",
      "providers.*.models.*.cost.output",
      "providers.*.models.*.limit",
      "providers.*.models.*.limit.context",
      "providers.*.models.*.limit.input",
      "providers.*.models.*.limit.output",
      "providers.*.models.*.name",
      "providers.*.name",
      "providers.*.package",
      "providers.*.settings",
      "providers.*.settings.*",
      "providers.*.settings.chunkTimeout",
    ],
  ),
  keikoOperation(
    "Repository items, sanitized Markdown subagents",
    "coding-runtime/codingRuntimeRepositoryItems.ts",
    ["C01", "C06"],
    ["agents", "agents.*", "agents.*.description", "agents.*.mode", "agents.*.system"],
  ),
  keikoOperation(
    "Repository items, sanitized Markdown commands",
    "coding-runtime/codingRuntimeRepositoryItems.ts",
    ["C02", "C06"],
    [
      "commands",
      "commands.*",
      "commands.*.agent",
      "commands.*.description",
      "commands.*.subagent",
      "commands.*.subtask",
      "commands.*.template",
    ],
  ),
  keikoOperation(
    "Operator MCP server registry",
    "coding-runtime/opencodeNativeMcp.ts",
    ["C04"],
    ["mcp.servers.*.disabled", "mcp.servers.*.environment", "mcp.servers.*.environment.*"],
  ),
  refused("keiko-owns-configuration", 3903, ["C06"], ["$schema"]),
  refused("keiko-owns-configuration", 3901, ["T10", "T11"], ["shell"]),
  refused(
    "keiko-owns-configuration",
    3905,
    ["S11", "S12"],
    ["model.model", "model.providerID", "model.variant"],
  ),
  refused("leaves-machine", 3904, ["S05"], ["enterprise", "enterprise.url"]),
  refused("keiko-owns-configuration", 3906, ["C06"], ["username"]),
  refused(
    "keiko-owns-authority",
    3903,
    ["S16", "C06"],
    [
      "experimental.policies",
      "experimental.policies.action",
      "experimental.policies.effect",
      "experimental.policies.resource",
    ],
  ),
  refused(
    "not-yet-implemented",
    3903,
    ["C01"],
    ["agents.*.color", "agents.*.disabled", "agents.*.hidden", "agents.*.steps"],
  ),
  refused(
    "keiko-owns-configuration",
    3905,
    ["C01", "S11"],
    [
      "agents.*.model",
      "agents.*.model.model",
      "agents.*.model.providerID",
      "agents.*.model.variant",
      "agents.*.request",
      "agents.*.request.body",
      "agents.*.request.headers",
      "agents.*.request.headers.*",
    ],
  ),
  refused(
    "keiko-owns-authority",
    3903,
    ["C01", "S16"],
    [
      "agents.*.permissions",
      "agents.*.permissions.action",
      "agents.*.permissions.effect",
      "agents.*.permissions.resource",
    ],
  ),
  refused(
    "keiko-owns-configuration",
    3905,
    ["C02", "S11"],
    [
      "commands.*.model",
      "commands.*.model.model",
      "commands.*.model.providerID",
      "commands.*.model.variant",
    ],
  ),
  refused(
    "not-yet-implemented",
    3900,
    ["C07"],
    [
      "formatter.*",
      "formatter.*.command",
      "formatter.*.disabled",
      "formatter.*.environment",
      "formatter.*.environment.*",
      "formatter.*.extensions",
    ],
  ),
  refused(
    "producer-inert",
    3900,
    ["T20"],
    [
      "lsp",
      "lsp.*",
      "lsp.*.command",
      "lsp.*.disabled",
      "lsp.*.env",
      "lsp.*.env.*",
      "lsp.*.extensions",
      "lsp.*.initialization",
    ],
  ),
  refused("keiko-owns-configuration", 3900, ["C03"], ["instructions"]),
  refused("keiko-owns-configuration", 3903, ["T17", "C06"], ["skills"]),
  refused("not-yet-implemented", 3903, ["C04", "T21"], ["mcp.servers.*.codemode"]),
  refused("keiko-owns-workspace-binding", 3903, ["C04"], ["mcp.servers.*.cwd"]),
  refused(
    "keiko-owns-credentials",
    3903,
    ["C04"],
    [
      "mcp.servers.*.headers",
      "mcp.servers.*.headers.*",
      "mcp.servers.*.oauth.auth_server_metadata_url",
      "mcp.servers.*.oauth.callback_port",
      "mcp.servers.*.oauth.client_id",
      "mcp.servers.*.oauth.client_secret",
      "mcp.servers.*.oauth.redirect_uri",
      "mcp.servers.*.oauth.scope",
    ],
  ),
  refused(
    "not-yet-implemented",
    3903,
    ["C04"],
    [
      "mcp.servers.*.protocol",
      "mcp.servers.*.timeout",
      "mcp.servers.*.timeout.catalog",
      "mcp.servers.*.timeout.execution",
      "mcp.servers.*.timeout.startup",
      "mcp.timeout",
      "mcp.timeout.catalog",
      "mcp.timeout.execution",
      "mcp.timeout.startup",
    ],
  ),
  refused(
    "keiko-owns-configuration",
    3906,
    ["S14"],
    [
      "media",
      "media.image",
      "media.image.auto_resize",
      "media.image.max_base64_bytes",
      "media.image.max_height",
      "media.image.max_width",
    ],
  ),
  refused("keiko-owns-authority", 3903, ["C05"], ["plugins", "plugins.options", "plugins.package"]),
  refused(
    "keiko-owns-workspace-binding",
    3902,
    ["C08"],
    [
      "references",
      "references.*",
      "references.*.branch",
      "references.*.description",
      "references.*.hidden",
      "references.*.path",
    ],
  ),
  refused("leaves-machine", 3902, ["C08"], ["references.*.repository"]),
  refused("keiko-owns-configuration", 3899, ["S09"], ["tool_output.max_lines"]),
  refused(
    "keiko-owns-configuration",
    3905,
    ["S10"],
    ["warming", "warming.duration", "warming.interval", "warming.prompt"],
  ),
  refused("keiko-owns-configuration", 3900, ["C06"], ["watcher", "watcher.ignore"]),
  refused("leaves-machine", 3900, ["T15"], ["websearch", "websearch.provider"]),
  refused("keiko-owns-workspace-binding", 3902, ["S17"], ["worktree", "worktree.directory"]),
  refused("experimental-unadmitted", 3904, ["S08"], ["experimental.background_compaction"]),
  refused("experimental-unadmitted", 3899, ["S01"], ["experimental.location_idle_timeout"]),
  refused("experimental-unadmitted", 3901, ["S16"], ["experimental.portable_shell_scanner"]),
  refused("experimental-unadmitted", 3903, ["T16"], ["experimental.subagent_depth"]),
  refused(
    "keiko-owns-credentials",
    3905,
    ["S11"],
    [
      "providers.*.env",
      "providers.*.models.*.headers",
      "providers.*.models.*.headers.*",
      "providers.*.models.*.variants.headers",
      "providers.*.models.*.variants.headers.*",
    ],
  ),
  refused(
    "keiko-owns-configuration",
    3905,
    ["S12"],
    [
      "providers.*.compatibility.reasoningField",
      "providers.*.models.*.capabilities.reasoning",
      "providers.*.models.*.capabilities.reasoning.budget",
      "providers.*.models.*.capabilities.reasoning.budget.max",
      "providers.*.models.*.capabilities.reasoning.budget.min",
      "providers.*.models.*.capabilities.reasoning.effort",
      "providers.*.models.*.capabilities.reasoning.supported",
      "providers.*.models.*.capabilities.reasoning.toggle",
      "providers.*.models.*.compatibility.reasoningField",
      "providers.*.models.*.variants",
      "providers.*.models.*.variants.body",
      "providers.*.models.*.variants.id",
      "providers.*.models.*.variants.settings",
      "providers.*.models.*.variants.settings.*",
      "providers.*.models.*.variants.settings.compaction",
      "providers.*.models.*.variants.settings.compaction.type",
      "providers.*.models.*.variants.settings.encoding",
    ],
  ),
  refused(
    "keiko-owns-configuration",
    3905,
    ["S11"],
    [
      "providers.*.body",
      "providers.*.canonical",
      "providers.*.compatibility",
      "providers.*.compatibility.cacheFormat",
      "providers.*.compatibility.maxTokensField",
      "providers.*.compatibility.requireAssistantAfterTool",
      "providers.*.compatibility.requireFinishReason",
      "providers.*.compatibility.requireReasoning",
      "providers.*.compatibility.streamUsage",
      "providers.*.compatibility.supportsPromptCacheKey",
      "providers.*.models.*.body",
      "providers.*.models.*.capabilities.temperature",
      "providers.*.models.*.compatibility",
      "providers.*.models.*.compatibility.cacheFormat",
      "providers.*.models.*.compatibility.maxTokensField",
      "providers.*.models.*.compatibility.requireAssistantAfterTool",
      "providers.*.models.*.compatibility.requireFinishReason",
      "providers.*.models.*.compatibility.requireReasoning",
      "providers.*.models.*.compatibility.streamUsage",
      "providers.*.models.*.compatibility.supportsEffortUpdates",
      "providers.*.models.*.compatibility.supportsPromptCacheKey",
      "providers.*.models.*.compatibility.supportsThinkingBlockBinding",
      "providers.*.models.*.cost.cache",
      "providers.*.models.*.cost.cache.read",
      "providers.*.models.*.cost.cache.write",
      "providers.*.models.*.cost.tier",
      "providers.*.models.*.cost.tier.size",
      "providers.*.models.*.cost.tier.type",
      "providers.*.models.*.disabled",
      "providers.*.models.*.family",
      "providers.*.models.*.modelID",
      "providers.*.models.*.package",
      "providers.*.models.*.releaseDate",
      "providers.*.models.*.settings",
      "providers.*.models.*.settings.*",
      "providers.*.models.*.settings.compaction",
      "providers.*.models.*.settings.compaction.type",
      "providers.*.models.*.settings.encoding",
      "providers.*.settings.compaction",
      "providers.*.settings.compaction.type",
      "providers.*.settings.encoding",
      "providers.*.settings.headerTimeout",
      "providers.*.settings.timeout",
      "providers.*.settings.transport",
    ],
  ),
]);

/**
 * Every built-in plugin of the pinned 2.1.4 producer, by id. Every provider plugin but the one that
 * loads the gateway binding's own SDK package (`opencode.provider.dynamic`) serves a provider the
 * gateway-only provider policy refuses (`OPENCODE_GATEWAY_PROVIDER_POLICIES`). The workspace's
 * Claude-compatible skill directories are not read by the runtime under the launch profile; Keiko
 * admits those skills itself as sanitized copies (`codingRuntimeRepositoryItems.ts`).
 */
export const OPENCODE_PLUGIN_DISPOSITIONS = flatten<OpenCodePluginDisposition>([
  nativePlugin(["S01"], ["opencode.tool.input.repair"]),
  nativePlugin(["T01", "T02"], ["opencode.tool.read"]),
  nativePlugin(["T03"], ["opencode.tool.glob"]),
  nativePlugin(["T04"], ["opencode.tool.grep"]),
  nativePlugin(["T05"], ["opencode.tool.edit"]),
  nativePlugin(["T06", "T07"], ["opencode.tool.write"]),
  nativePlugin(["T08"], ["opencode.tool.patch"]),
  nativePlugin(["T10", "T11", "T12", "T13"], ["opencode.tool.shell"]),
  nativePlugin(["T14"], ["opencode.tool.webfetch"]),
  nativePlugin(["T15"], ["opencode.tool.websearch"]),
  nativePlugin(["T16"], ["opencode.tool.subagent"]),
  nativePlugin(["T17"], ["opencode.tool.skill", "opencode.skill"]),
  nativePlugin(["T18"], ["opencode.tool.question"]),
  nativePlugin(["T19"], ["opencode.tool.todo"]),
  nativePlugin(["T21", "T22"], ["opencode.tools"]),
  nativePlugin(["C04", "T21"], ["opencode.tools.mcp-resources"]),
  nativePlugin(["C01"], ["opencode.agent", "opencode.plan"]),
  nativePlugin(["C02"], ["opencode.command"]),
  nativePlugin(["T12", "S17"], ["opencode.vcs.git", "opencode.vcs.hg"]),
  nativePlugin(
    ["S11"],
    [
      "opencode.provider.dynamic",
      "opencode.prompt.anthropic",
      "opencode.prompt.arcee",
      "opencode.prompt.identity",
      "opencode.prompt.kimi",
      "opencode.prompt.meta",
      "opencode.prompt.openai",
      "opencode.prompt.verbosity",
    ],
  ),
  configurationPlugin("worktree", ["S17"], ["opencode.config.worktree"]),
  configurationPlugin("mcp", ["C04"], ["opencode.config.mcp"]),
  configurationPlugin("mcp.servers.*.codemode", ["C04", "T21"], ["opencode.mcp.codemode.defaults"]),
  configurationPlugin("instructions", ["C03"], ["opencode.config.instruction"]),
  configurationPlugin("references", ["C08"], ["opencode.config.reference"]),
  configurationPlugin("agents", ["C01"], ["opencode.config.agent"]),
  configurationPlugin("commands", ["C02"], ["opencode.config.command"]),
  configurationPlugin("compaction", ["S08"], ["opencode.config.compaction"]),
  configurationPlugin("formatter", ["C07"], ["opencode.config.formatter"]),
  configurationPlugin("media", ["S14"], ["opencode.config.image"]),
  configurationPlugin("watcher", ["C06"], ["opencode.config.location-watcher"]),
  configurationPlugin("shell", ["T10", "T11"], ["opencode.config.shell"]),
  configurationPlugin("snapshots", ["S04"], ["opencode.config.snapshot"]),
  configurationPlugin("tool_output", ["S09"], ["opencode.config.tool-output"]),
  configurationPlugin("skills", ["T17"], ["opencode.config.skill"]),
  configurationPlugin("providers", ["S11"], ["opencode.config.provider"]),
  configurationPlugin("websearch", ["T15"], ["opencode.config.websearch"]),
  configurationPlugin("policies", ["S11"], ["opencode.config.policy"]),
  configurationPlugin("warming", ["S10"], ["opencode.warming"]),
  configurationPlugin(
    "providers.*.compatibility.supportsPromptCacheKey",
    ["S11"],
    ["opencode.provider.prompt-cache-key"],
  ),
  refused("keiko-owns-configuration", 3903, ["T17", "C06"], ["opencode.config.compatibility"]),
  refused("host-surface", 3899, ["T21", "T22"], ["opencode.browser"]),
  refused(
    "leaves-machine",
    3905,
    ["S11"],
    ["opencode.wellknown", "opencode.models.dev", "opencode.provider.opencode"],
  ),
  refused(
    "leaves-machine",
    3900,
    ["T15"],
    [
      "opencode.websearch.exa",
      "opencode.websearch.firecrawl",
      "opencode.websearch.parallel",
      "opencode.websearch.tavily",
      "opencode.websearch.tinyfish",
    ],
  ),
  refused(
    "keiko-owns-configuration",
    3905,
    ["S11"],
    [
      "opencode.provider.amazon.bedrock",
      "opencode.provider.azure",
      "opencode.provider.cerebras",
      "opencode.provider.chatgpt",
      "opencode.provider.cloudflare.ai.gateway",
      "opencode.provider.cloudflare.workers.ai",
      "opencode.provider.cohere",
      "opencode.provider.databricks",
      "opencode.provider.digitalocean",
      "opencode.provider.github.copilot",
      "opencode.provider.gitlab",
      "opencode.provider.google.vertex",
      "opencode.provider.kilo",
      "opencode.provider.llmgateway",
      "opencode.provider.lmstudio",
      "opencode.provider.modal",
      "opencode.provider.neon",
      "opencode.provider.nvidia",
      "opencode.provider.ollama",
      "opencode.provider.openai",
      "opencode.provider.openai-context-caps",
      "opencode.provider.openrouter",
      "opencode.provider.perplexity",
      "opencode.provider.poe",
      "opencode.provider.sap.ai.core",
      "opencode.provider.snowflake.cortex",
      "opencode.provider.vercel",
      "opencode.provider.vllm",
      "opencode.provider.xai",
      "opencode.provider.zenmux",
    ],
  ),
]);

const PLUGIN_DISPOSITIONS: ReadonlyMap<string, OpenCodePluginDisposition> = new Map(
  OPENCODE_PLUGIN_DISPOSITIONS.map((entry) => [entry.name, entry.disposition]),
);

/** The disposition of one built-in plugin id, or `undefined` when none exists. */
export function openCodePluginDisposition(id: string): OpenCodePluginDisposition | undefined {
  return PLUGIN_DISPOSITIONS.get(id);
}

const CONFIGURATION_DISPOSITIONS: ReadonlyMap<string, OpenCodeConfigurationDisposition> = new Map(
  OPENCODE_CONFIGURATION_DISPOSITIONS.map((entry) => [entry.name, entry.disposition]),
);

/** The disposition of one configuration setting path, or `undefined` when none exists. */
export function openCodeConfigurationDisposition(
  path: string,
): OpenCodeConfigurationDisposition | undefined {
  return CONFIGURATION_DISPOSITIONS.get(path);
}

const ADMITTED_ENDPOINTS: ReadonlySet<string> = new Set(OPENCODE_V2_APPROVED_ENDPOINTS);
const EXPLICIT_DISPOSITIONS: ReadonlyMap<string, OpenCodeServiceDispositionEntry> = new Map(
  OPENCODE_SERVICE_DISPOSITIONS.map((entry) => [entry.name, entry]),
);

/**
 * The disposition of one inventory operation: `admitted` exactly when its method and path are in
 * the digest-pinned protocol surface, otherwise the explicit entry, or `undefined` when none
 * exists (which the inventory test refuses).
 */
export function openCodeServiceDisposition(
  operation: OpenCodeServiceOperation,
): OpenCodeServiceDisposition | undefined {
  if (ADMITTED_ENDPOINTS.has(describeOperation(operation))) return { kind: "admitted" };
  return EXPLICIT_DISPOSITIONS.get(operation.operationId)?.disposition;
}
