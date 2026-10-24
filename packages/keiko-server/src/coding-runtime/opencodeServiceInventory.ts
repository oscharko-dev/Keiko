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

/** Parses a committed inventory fixture, refusing any shape other than the one written. */
export function parseOpenCodeServiceInventory(json: string): OpenCodeServiceInventory {
  const parsed = record(JSON.parse(json) as unknown);
  const operations = parsed?.operations;
  const cliCommands = parsed?.cliCommands;
  if (typeof parsed?.version !== "string" || !Array.isArray(operations)) {
    throw new TypeError("opencode-service-inventory-malformed");
  }
  if (!operations.every(isOperation)) throw new TypeError("opencode-service-inventory-malformed");
  if (cliCommands === undefined) return { version: parsed.version, operations };
  if (!Array.isArray(cliCommands) || !cliCommands.every((c) => typeof c === "string")) {
    throw new TypeError("opencode-service-inventory-malformed");
  }
  return { version: parsed.version, operations, cliCommands };
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

export interface OpenCodeServiceDispositionEntry {
  /** An `operationId` of the HTTP inventory, or a leaf command path of the CLI inventory. */
  readonly name: string;
  readonly disposition: Exclude<OpenCodeServiceDisposition, { readonly kind: "admitted" }>;
  /** Capability-matrix rows (`docs/qa/opencode-capability-parity.md`) that carry the status. */
  readonly rows: readonly string[];
}

interface DispositionGroup {
  readonly disposition: OpenCodeServiceDispositionEntry["disposition"];
  readonly rows: readonly string[];
  readonly names: readonly string[];
}

function covered(by: string, rows: string[], names: string[]): DispositionGroup {
  return { disposition: { kind: "covered", by }, rows, names };
}

function keikoOperation(
  operation: string,
  source: string,
  rows: string[],
  names: string[],
): DispositionGroup {
  return { disposition: { kind: "keiko-operation", operation, source }, rows, names };
}

function refused(
  reason: OpenCodeServiceRefusalReason,
  owner: number,
  rows: string[],
  names: string[],
): DispositionGroup {
  return { disposition: { kind: "refused", reason, owner }, rows, names };
}

function flatten(groups: readonly DispositionGroup[]): readonly OpenCodeServiceDispositionEntry[] {
  return groups.flatMap(({ disposition, rows, names }) =>
    names.map((name) => ({ name, disposition, rows })),
  );
}

/**
 * Every 2.1.4 HTTP operation Keiko does not admit, by `operationId`. Admitted operations are not
 * listed: `openCodeServiceDisposition` derives them from the pinned protocol surface, so this table
 * cannot restate (and drift from) it.
 */
export const OPENCODE_SERVICE_DISPOSITIONS = flatten([
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
  refused("not-yet-implemented", 3903, ["C01"], ["agent.list", "agent.get"]),
  refused("not-yet-implemented", 3903, ["T17"], ["skill.list", "experimental.session.skill"]),
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
    [
      "session.background",
      "shell.list",
      "shell.create",
      "shell.get",
      "shell.remove",
      "shell.output",
    ],
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
export const OPENCODE_CLI_DISPOSITIONS = flatten([
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
