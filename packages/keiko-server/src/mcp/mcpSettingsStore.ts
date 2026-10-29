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
    credentialContext: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["persistent", "process-scoped"],
    },
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
  readonly revoke: (name: string, correlationId: string) => void;
  readonly read: (correlationId: string) => McpSettingsSnapshot;
  /** Revoked synchronously when the committed definition changes, is disabled, or disappears. */
  readonly generation: (server: McpServerDefinition, correlationId: string) => AbortSignal;
  /** Whole-catalog authority changes also when an unrelated server is added. */
  readonly revisionSignal: (revision: string, correlationId: string) => AbortSignal;
  readonly update: (
    update: McpSettingsUpdate,
    correlationId: string,
  ) => { readonly ok: boolean; readonly snapshot: McpSettingsSnapshot };
  readonly secret: (reference: string, server: McpServerDefinition) => string | undefined;
}

function snapshot(
  servers: readonly McpServerDefinition[],
  generation?: string,
): McpSettingsSnapshot {
  const identity = generation === undefined ? servers : { servers, generation };
  return { servers, revision: createHash("sha256").update(JSON.stringify(identity)).digest("hex") };
}

function recordMcpSettingsUpdate(
  log: ServerLogSink | undefined,
  correlationId: string,
  outcome: "applied" | "conflict" | "reconciled",
  state: McpSettingsSnapshot,
  secretCount: number,
  credentialContext?: "persistent" | "process-scoped",
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
        ...(credentialContext === undefined ? {} : { credentialContext }),
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
  return snapshot(current.servers, current.generation);
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
  if (Buffer.byteLength(JSON.stringify(document), "utf8") + 64 > 64 * 1024)
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
    const removed = secrets.retain(state.servers.flatMap(mcpServerSecretReferences), state.servers);
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
  #revision: { digest: string; controller: AbortController } | undefined;
  readonly #environmentEpoch = randomUUID();
  #credentialContext: { readonly revision: string; readonly scoped: boolean } | undefined;
  constructor(private readonly input: StoreInput) {
    this.#secrets = createMcpServerSecretStore(input);
  }
  private processCredentialContext(state: McpSettingsSnapshot): McpSettingsSnapshot {
    return {
      ...state,
      revision: createHash("sha256")
        .update(JSON.stringify([state.revision, this.#environmentEpoch]))
        .digest("hex"),
    };
  }
  private scopeCredentialContext(
    state: McpSettingsSnapshot,
    correlationId: string,
  ): McpSettingsSnapshot {
    const references = state.servers
      .filter((server) => server.enabled)
      .flatMap(mcpServerSecretReferences);
    let scoped: boolean;
    try {
      scoped = this.#secrets.usesEnvironment(references);
    } catch {
      // An unavailable vault cannot prove that a configured environment credential is shadowed.
      const current = this.processCredentialContext({ ...state, credentialCleanup: "pending" });
      recordMcpSettingsUpdate(
        this.input.activityLog,
        correlationId,
        "reconciled",
        current,
        0,
        "process-scoped",
      );
      this.#credentialContext = { revision: current.revision, scoped: true };
      return current;
    }
    const current = scoped ? this.processCredentialContext(state) : state;
    if (
      (scoped && this.#credentialContext?.revision !== current.revision) ||
      (this.#credentialContext?.scoped === true && !scoped)
    )
      recordMcpSettingsUpdate(
        this.input.activityLog,
        correlationId,
        "reconciled",
        current,
        0,
        scoped ? "process-scoped" : "persistent",
      );
    this.#credentialContext = { revision: current.revision, scoped };
    return current;
  }

  private reconcileGenerations(state: McpSettingsSnapshot): void {
    const { revision: digest, servers } = state;
    if (this.#revision?.digest !== digest) {
      const previous = this.#revision;
      this.#revision = { digest, controller: new AbortController() };
      previous?.controller.abort();
    }
    for (const [name, generation] of this.#generations) {
      const current = servers.find((server) => server.name === name && server.enabled);
      if (current === undefined || JSON.stringify(current) !== generation.definition) {
        this.#generations.delete(name);
        generation.controller.abort();
      }
    }
  }
  readonly revoke = (name: string, correlationId: string): void => {
    const state = this.read(correlationId);
    if (!state.servers.some((server) => server.name === name))
      throw new TypeError("MCP server is unavailable");
    const generation = this.#generations.get(name);
    this.#generations.delete(name);
    generation?.controller.abort();
    const servers = validUpdate({
      expectedRevision: state.revision,
      secrets: {},
      servers: state.servers.map((server) =>
        server.name === name ? { ...server, credentialGeneration: randomUUID() } : server,
      ),
    }).servers;
    savePrivateJson(join(this.input.stateDir, MCP_SERVER_REGISTRY_FILE), {
      schemaVersion: 1,
      generation: randomUUID(),
      servers,
    });
    const next = this.read(correlationId);
    recordMcpSettingsUpdate(this.input.activityLog, correlationId, "reconciled", next, 0);
  };
  readonly read = (correlationId: string): McpSettingsSnapshot => {
    let current: McpSettingsSnapshot;
    try {
      current = this.scopeCredentialContext(readSettings(this.input, correlationId), correlationId);
    } catch (error) {
      this.reconcileGenerations(snapshot([]));
      throw error;
    }
    this.reconcileGenerations(current);
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
  readonly revisionSignal = (revision: string, correlationId: string): AbortSignal => {
    this.read(correlationId);
    return this.#revision?.digest === revision
      ? this.#revision.controller.signal
      : AbortSignal.abort();
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
    const activeReferences = new Set(current.servers.flatMap(mcpServerSecretReferences));
    for (const entry of entries) {
      if (
        activeReferences.has(entry.reference) &&
        (this.#secrets.usesEnvironment([entry.reference]) ||
          this.#secrets.get(entry.reference, entry.server) !== entry.value)
      )
        throw new TypeError("An active MCP credential requires a new reference");
    }
    this.#secrets.put(entries);
    if (JSON.stringify(current.servers) !== JSON.stringify(validated.servers)) {
      // The epoch and definitions commit together: restoring old definitions never restores consent.
      const generation = randomUUID();
      savePrivateJson(join(this.input.stateDir, MCP_SERVER_REGISTRY_FILE), {
        schemaVersion: 1,
        generation,
        servers: validated.servers,
      });
    }
    // Resolve the public revision from the committed definitions and current credential custody.
    const committed = this.scopeCredentialContext(
      readSettings(this.input, correlationId),
      correlationId,
    );
    this.reconcileGenerations(committed);
    const next = reconcileSecrets(
      this.#secrets,
      committed,
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
