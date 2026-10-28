import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type {
  McpServerDefinition,
  McpSettingsSnapshot,
  McpSettingsUpdate,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import {
  parseMcpSettingsUpdate,
  mcpServerSecretReferences,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { savePrivateJson } from "../private-json.js";
import {
  createMcpServerSecretStore,
  type McpOAuthCredentialStoreInput,
} from "./mcpOAuthCredentialStore.js";
import { loadMcpServerRegistry, MCP_SERVER_REGISTRY_FILE } from "./mcpServerRegistry.js";

const UPDATED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "mcp.settings.updated",
  category: "security",
  owner: "keiko-server",
  emitter: "mcp.mcpSettingsStore.recordMcpSettingsUpdate",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["applied", "conflict", "reconciled"],
    },
    serverCount: { type: "integer", dataClass: "count", required: true },
    secretCount: { type: "integer", dataClass: "count", required: true },
    registrySha256: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    credentialCleanup: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["complete", "pending"],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["mcp-registry"],
  proofIds: ["mcp.settings.updated.emitted-line"],
  releaseImpact: "minor",
});

export interface McpSettingsStore {
  readonly read: (correlationId: string) => McpSettingsSnapshot;
  readonly update: (
    update: McpSettingsUpdate,
    correlationId: string,
  ) => { readonly ok: boolean; readonly snapshot: McpSettingsSnapshot };
  readonly secret: (reference: string, server: McpServerDefinition) => string | undefined;
}

function snapshot(servers: readonly McpServerDefinition[]): McpSettingsSnapshot {
  return { servers, revision: createHash("sha256").update(JSON.stringify(servers)).digest("hex") };
}

function recordMcpSettingsUpdate(
  log: ServerLogSink | undefined,
  correlationId: string,
  outcome: "applied" | "conflict" | "reconciled",
  state: McpSettingsSnapshot,
  secretCount: number,
): void {
  log?.write(
    activityLogEvent(
      UPDATED,
      { correlationId },
      {
        outcome,
        serverCount: state.servers.length,
        secretCount,
        registrySha256: state.revision,
        credentialCleanup: state.credentialCleanup ?? "complete",
      },
    ),
  );
}

function readSettings(
  input: McpOAuthCredentialStoreInput & { readonly activityLog?: ServerLogSink },
  correlationId: string,
): McpSettingsSnapshot {
  const current = loadMcpServerRegistry({
    stateDir: input.stateDir,
    activityLog: input.activityLog,
    correlationId,
    consumer: "settings",
  });
  if (current.state === "refused") throw new TypeError("MCP registry is unavailable");
  return snapshot(current.servers);
}

function validUpdate(update: McpSettingsUpdate): McpSettingsUpdate {
  const validated = parseMcpSettingsUpdate(update);
  if (validated === undefined) throw new TypeError("MCP settings are invalid");
  const document = { schemaVersion: 1, servers: validated.servers };
  if (Buffer.byteLength(JSON.stringify(document), "utf8") > 64 * 1024)
    throw new TypeError("MCP settings exceed the registry size limit");
  return validated;
}

function reconcileSecrets(
  secrets: ReturnType<typeof createMcpServerSecretStore>,
  state: McpSettingsSnapshot,
): { readonly snapshot: McpSettingsSnapshot; readonly changed: boolean } {
  try {
    const removed = secrets.retain(state.servers.flatMap(mcpServerSecretReferences));
    return { snapshot: state, changed: removed > 0 };
  } catch {
    // The committed registry revokes access independently of physical ciphertext cleanup.
    // The next read/update (including a new process) retries against that same durable state.
    return { snapshot: { ...state, credentialCleanup: "pending" }, changed: true };
  }
}

/** One existing registry, one MCP vault and the canonical atomic private-file writer. */
export function createMcpSettingsStore(
  input: McpOAuthCredentialStoreInput & {
    readonly activityLog?: ServerLogSink;
  },
): McpSettingsStore {
  const secrets = createMcpServerSecretStore(input);
  const read = (correlationId: string): McpSettingsSnapshot => {
    const result = reconcileSecrets(secrets, readSettings(input, correlationId));
    if (result.changed)
      recordMcpSettingsUpdate(input.activityLog, correlationId, "reconciled", result.snapshot, 0);
    return result.snapshot;
  };
  return {
    read,
    secret: (reference, server): string | undefined => {
      const current = read(UNKNOWN_CORRELATION_ID).servers.find(
        (entry) => entry.name === server.name,
      );
      if (
        current?.enabled !== true ||
        !mcpServerSecretReferences(current).includes(reference) ||
        JSON.stringify(current.transport) !== JSON.stringify(server.transport)
      )
        return undefined;
      return secrets.get(reference, current);
    },
    update: (
      update,
      correlationId,
    ): { readonly ok: boolean; readonly snapshot: McpSettingsSnapshot } => {
      const validated = validUpdate(update);
      const document = { schemaVersion: 1, servers: validated.servers };
      const current = read(correlationId);
      if (current.revision !== update.expectedRevision) {
        recordMcpSettingsUpdate(input.activityLog, correlationId, "conflict", current, 0);
        return { ok: false, snapshot: current };
      }
      const entries = Object.entries(validated.secrets).map(([reference, entry]) => {
        const server = validated.servers.find((candidate) => candidate.name === entry.server);
        if (server === undefined) throw new TypeError("MCP secret binding is invalid");
        return { reference, server, value: entry.value };
      });
      // Unique immutable references are sealed first. A failed registry write cannot change old credentials.
      secrets.put(entries);
      savePrivateJson(join(input.stateDir, MCP_SERVER_REGISTRY_FILE), document);
      const next = reconcileSecrets(secrets, snapshot(validated.servers)).snapshot;
      recordMcpSettingsUpdate(input.activityLog, correlationId, "applied", next, entries.length);
      return { ok: true, snapshot: next };
    },
  };
}
