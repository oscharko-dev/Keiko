import { createHash, randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
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
  /** Revoked synchronously when the committed definition changes, is disabled, or disappears. */
  readonly generation: (server: McpServerDefinition, correlationId: string) => AbortSignal;
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

function importEnvironmentFiles(update: McpSettingsUpdate): McpSettingsUpdate {
  const secrets = { ...update.secrets };
  const servers = update.servers.map((server) => {
    const file = update.environmentFiles?.[server.name];
    if (file === undefined || server.transport.kind !== "local") return server;
    const environment = { ...server.transport.environment };
    const secretEnvironment = { ...server.transport.secretEnvironment };
    for (const [name, value] of Object.entries(parseEnv(file))) {
      if (value === undefined) throw new TypeError("MCP environment value is invalid");
      if (value === "") {
        environment[name] = "";
        Reflect.deleteProperty(secretEnvironment, name);
        continue;
      }
      const reference = `KEIKO_MCP_SECRET_${randomUUID().replaceAll("-", "").toUpperCase()}`;
      Reflect.deleteProperty(environment, name);
      secretEnvironment[name] = { secretEnv: reference };
      secrets[reference] = { server: server.name, value };
    }
    return { ...server, transport: { ...server.transport, environment, secretEnvironment } };
  });
  return { expectedRevision: update.expectedRevision, servers, secrets };
}

function validUpdate(update: McpSettingsUpdate): McpSettingsUpdate {
  const input = parseMcpSettingsUpdate(update);
  const validated =
    input === undefined ? undefined : parseMcpSettingsUpdate(importEnvironmentFiles(input));
  if (validated === undefined) throw new TypeError("MCP settings are invalid");
  const document = { schemaVersion: 1, servers: validated.servers };
  if (Buffer.byteLength(JSON.stringify(document), "utf8") > 64 * 1024)
    throw new TypeError("MCP settings exceed the registry size limit");
  return validated;
}

function reconcileSecrets(
  secrets: ReturnType<typeof createMcpServerSecretStore>,
  state: McpSettingsSnapshot,
  log: ServerLogSink | undefined,
  correlationId: string,
): { readonly snapshot: McpSettingsSnapshot; readonly changed: boolean } {
  try {
    const removed = secrets.retain(state.servers.flatMap(mcpServerSecretReferences));
    return { snapshot: state, changed: removed > 0 };
  } catch {
    // The committed registry revokes access independently of physical ciphertext cleanup.
    // The next read/update (including a new process) retries against that same durable state.
    const pending = { ...state, credentialCleanup: "pending" as const };
    recordMcpSettingsUpdate(log, correlationId, "reconciled", pending, 0);
    return { snapshot: pending, changed: true };
  }
}

type StoreInput = McpOAuthCredentialStoreInput & { readonly activityLog?: ServerLogSink };
class SettingsStore implements McpSettingsStore {
  readonly #secrets: ReturnType<typeof createMcpServerSecretStore>;
  readonly #generations = new Map<string, { definition: string; controller: AbortController }>();
  constructor(private readonly input: StoreInput) {
    this.#secrets = createMcpServerSecretStore(input);
  }
  private reconcileGenerations(servers: readonly McpServerDefinition[]): void {
    for (const [name, generation] of this.#generations) {
      const current = servers.find((server) => server.name === name && server.enabled);
      if (current === undefined || JSON.stringify(current) !== generation.definition) {
        this.#generations.delete(name);
        generation.controller.abort();
      }
    }
  }
  readonly read = (correlationId: string): McpSettingsSnapshot => {
    let current: McpSettingsSnapshot;
    try {
      current = readSettings(this.input, correlationId);
    } catch (error) {
      this.reconcileGenerations([]);
      throw error;
    }
    this.reconcileGenerations(current.servers);
    const result = reconcileSecrets(this.#secrets, current, this.input.activityLog, correlationId);
    if (result.changed && result.snapshot.credentialCleanup !== "pending")
      recordMcpSettingsUpdate(
        this.input.activityLog,
        correlationId,
        "reconciled",
        result.snapshot,
        0,
      );
    return result.snapshot;
  };
  readonly generation = (server: McpServerDefinition, correlationId: string): AbortSignal => {
    const definition = JSON.stringify(server);
    if (
      !this.read(correlationId).servers.some(
        (current) => current.enabled && JSON.stringify(current) === definition,
      )
    )
      throw new TypeError("MCP server is unavailable");
    let generation = this.#generations.get(server.name);
    if (generation === undefined) {
      generation = { definition, controller: new AbortController() };
      this.#generations.set(server.name, generation);
    }
    return generation.controller.signal;
  };
  readonly secret = (reference: string, server: McpServerDefinition): string | undefined => {
    const current = this.read(UNKNOWN_CORRELATION_ID).servers.find(
      (entry) => entry.name === server.name,
    );
    if (
      current?.enabled !== true ||
      !mcpServerSecretReferences(current).includes(reference) ||
      JSON.stringify(current.transport) !== JSON.stringify(server.transport)
    )
      return undefined;
    return this.#secrets.get(reference, current);
  };
  readonly update = (
    update: McpSettingsUpdate,
    correlationId: string,
  ): { readonly ok: boolean; readonly snapshot: McpSettingsSnapshot } => {
    const validated = validUpdate(update);
    const document = { schemaVersion: 1, servers: validated.servers };
    const current = this.read(correlationId);
    if (current.revision !== update.expectedRevision) {
      recordMcpSettingsUpdate(this.input.activityLog, correlationId, "conflict", current, 0);
      return { ok: false, snapshot: current };
    }
    const entries = Object.entries(validated.secrets).map(([reference, entry]) => {
      const server = validated.servers.find((candidate) => candidate.name === entry.server);
      if (server === undefined) throw new TypeError("MCP secret binding is invalid");
      return { reference, server, value: entry.value };
    });
    this.#secrets.put(entries);
    savePrivateJson(join(this.input.stateDir, MCP_SERVER_REGISTRY_FILE), document);
    this.reconcileGenerations(validated.servers);
    const next = reconcileSecrets(
      this.#secrets,
      snapshot(validated.servers),
      this.input.activityLog,
      correlationId,
    ).snapshot;
    recordMcpSettingsUpdate(this.input.activityLog, correlationId, "applied", next, entries.length);
    return { ok: true, snapshot: next };
  };
}

/** One existing registry, one MCP vault and the canonical atomic private-file writer. */
export function createMcpSettingsStore(input: StoreInput): McpSettingsStore {
  return new SettingsStore(input);
}
