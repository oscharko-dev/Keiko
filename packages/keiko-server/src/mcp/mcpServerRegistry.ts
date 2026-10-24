import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { causeChain, keikoStackFrames, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts";
import { parseMcpServerRegistry } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

/**
 * The operator's MCP server registry file (#3903, parity row C04): `<stateDir>/mcp-servers.json`,
 * owned by the user Keiko runs as and writable by nobody else. It is read when a consumer needs it
 * (a native coding run at launch), so an operator's edit applies to the next run without a restart.
 * A missing file is an empty registry; a file Keiko cannot trust or parse admits no server at all
 * rather than a partial set. Nothing of the file's content enters the log: counts, the closed
 * outcome and a digest of what was admitted.
 */
export const MCP_SERVER_REGISTRY_FILE = "mcp-servers.json";
const MAX_REGISTRY_BYTES = 64 * 1024;

const LOAD_STATES = ["absent", "loaded", "refused"] as const;
type McpRegistryLoadState = (typeof LOAD_STATES)[number];
const LOAD_REASONS = [
  "malformed",
  "schema-version",
  "too-many-servers",
  "server-invalid",
  "duplicate-server",
  "not-regular-file",
  "not-owner-private",
  "too-large",
  "unreadable",
  "not-json",
] as const;
type McpRegistryLoadReason = (typeof LOAD_REASONS)[number];

const MCP_REGISTRY_LOADED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "mcp.registry.loaded",
  category: "process",
  owner: "keiko-server",
  emitter: "mcp.mcpServerRegistry.recordMcpRegistryLoaded",
  fields: {
    consumer: { type: "string", dataClass: "closed-enum", required: true, values: ["coding-run"] },
    state: { type: "string", dataClass: "closed-enum", required: true, values: [...LOAD_STATES] },
    serverCount: { type: "integer", dataClass: "count", required: true },
    enabledServerCount: { type: "integer", dataClass: "count", required: true },
    remoteServerCount: { type: "integer", dataClass: "count", required: true },
    toolCount: { type: "integer", dataClass: "count", required: true },
    // SHA-256 over the admitted definitions, so the exact registry a run saw is reconstructable.
    registrySha256: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...LOAD_REASONS],
    },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["mcp-registry"],
  proofIds: ["mcp.registry.loaded.emitted-line"],
  releaseImpact: "patch",
});

export interface McpServerRegistryLoad {
  readonly state: McpRegistryLoadState;
  readonly servers: readonly McpServerDefinition[];
  readonly reason?: McpRegistryLoadReason | undefined;
}

/** A registry the loader refuses, with the closed reason; the message never quotes the file. */
class McpRegistryRefused extends Error {
  public constructor(public readonly reason: McpRegistryLoadReason) {
    super(`mcp-registry-${reason}`);
    this.name = "McpRegistryRefused";
  }
}

// The file, opened without following a link and checked on the open descriptor, so the bytes read
// are the bytes of the file that was checked. A missing file is an empty registry.
function readRegistryText(path: string): string | undefined {
  const probe = lstatSync(path, { throwIfNoEntry: false });
  if (probe === undefined) return undefined;
  if (!probe.isFile()) throw new McpRegistryRefused("not-regular-file");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readCheckedDescriptor(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readCheckedDescriptor(descriptor: number): string {
  const stat = fstatSync(descriptor);
  if (!stat.isFile()) throw new McpRegistryRefused("not-regular-file");
  const ownUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (stat.uid !== ownUid || (stat.mode & 0o022) !== 0)
    throw new McpRegistryRefused("not-owner-private");
  if (stat.size > MAX_REGISTRY_BYTES) throw new McpRegistryRefused("too-large");
  const buffer = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(descriptor, buffer, offset, buffer.length - offset, null);
    if (count === 0) break;
    offset += count;
  }
  return buffer.subarray(0, offset).toString("utf8");
}

function parsedRegistry(text: string): McpServerRegistryLoad {
  const parsed = parseMcpServerRegistry(JSON.parse(text) as unknown);
  return parsed.ok
    ? { state: "loaded", servers: parsed.servers }
    : { state: "refused", servers: [], reason: parsed.reason };
}

function refusalOf(error: unknown): McpRegistryLoadReason {
  if (error instanceof McpRegistryRefused) return error.reason;
  if (error instanceof SyntaxError) return "not-json";
  return (error as NodeJS.ErrnoException).code === "ELOOP" ? "not-regular-file" : "unreadable";
}

/** Reads the registry for one consumer and records the outcome; never throws. */
export function loadMcpServerRegistry(input: {
  readonly stateDir: string;
  readonly activityLog: ServerLogSink | undefined;
  readonly correlationId: string;
}): McpServerRegistryLoad {
  try {
    const text = readRegistryText(join(input.stateDir, MCP_SERVER_REGISTRY_FILE));
    const load: McpServerRegistryLoad =
      text === undefined ? { state: "absent", servers: [] } : parsedRegistry(text);
    recordMcpRegistryLoaded(input.activityLog, input.correlationId, load);
    return load;
  } catch (error) {
    // A file Keiko cannot trust admits no server; the closed reason and the frames are the evidence.
    const load: McpServerRegistryLoad = { state: "refused", servers: [], reason: refusalOf(error) };
    recordMcpRegistryLoaded(input.activityLog, input.correlationId, load, error);
    return load;
  }
}

function registryDigest(servers: readonly McpServerDefinition[]): string | undefined {
  if (servers.length === 0) return undefined;
  return createHash("sha256").update(JSON.stringify(servers), "utf8").digest("hex");
}

export function recordMcpRegistryLoaded(
  activityLog: ServerLogSink | undefined,
  correlationId: string,
  load: McpServerRegistryLoad,
  error?: unknown,
): void {
  const enabled = load.servers.filter((server) => server.enabled);
  const digest = registryDigest(load.servers);
  activityLog?.write(
    activityLogEvent(
      MCP_REGISTRY_LOADED_OPERATION,
      { correlationId, ...(load.state === "refused" ? { level: "warn" as const } : {}) },
      {
        consumer: "coding-run",
        state: load.state,
        serverCount: load.servers.length,
        enabledServerCount: enabled.length,
        remoteServerCount: enabled.filter((server) => server.transport.kind === "remote").length,
        toolCount: enabled.reduce((total, server) => total + Object.keys(server.tools).length, 0),
        ...(digest === undefined ? {} : { registrySha256: digest }),
        ...(load.reason === undefined ? {} : { reason: load.reason }),
        ...(error === undefined
          ? {}
          : { frames: keikoStackFrames(error), causeChain: causeChain(error) }),
      },
    ),
  );
}
