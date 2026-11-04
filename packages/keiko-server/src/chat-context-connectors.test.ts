// The Chat context meter lists the connectors a Chat offers (owner request 2026-11-02) and counts
// the tool definitions they add to every request. A status read is a peek: it never connects an MCP
// transport and never admits a catalog host. Expected values come from the production catalogs and
// the gateway's own counter, never from a formula restated here.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ToolDefinition } from "@oscharko-dev/keiko-contracts";
import type { ChatContextStatusWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import { deriveContextProfile } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import type { ExternalMcpConnection } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { gatewayToolDefinitions } from "@oscharko-dev/keiko-tool-catalog";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { jiraChatActorDigest } from "./atlassian/jiraPodAccess.js";
import { createJiraChatCatalogRuntime } from "./atlassian/jiraChatCatalogRuntime.js";
import { chatConnectorTools } from "./chat-context-connectors.js";
import { logChatContextManagement } from "./chat-context-log.js";
import { readChatContextStatus } from "./chat-context-status.js";
import { buildUiHandlerDeps, type UiHandlerDeps } from "./deps.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import { createConfiguredMcpConnections } from "./mcp/mcpConfiguredConnections.js";
import type { ConfiguredMcpConnections } from "./mcp/mcpConfiguredConnections.js";
import { createMcpChatCatalogRuntime, MCP_CHAT_PROFILE } from "./mcp/mcpChatCatalogRuntime.js";
import { createMcpSettingsStore } from "./mcp/mcpSettingsStore.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";

const MODEL = "fixture";
const POD_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const roots: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  resetServerLogger();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PROFILE = {
  ...deriveContextProfile({
    maxInputTokens: 32_000,
    reservedOutputTokens: 2_000,
    safetyMarginTokens: 1_000,
  }),
  model: { id: MODEL },
};
const ACCOUNTING = PROFILE.tokenAccounting;

function server(name: string, enabled = true): McpServerDefinition {
  return {
    name,
    description: `Synthetic ${name}`,
    enabled,
    transport: { kind: "local", command: [process.execPath], environment: {} },
    tools: { get_status: "read", create_note: "write" },
  };
}

function connection(): ExternalMcpConnection {
  return {
    signal: new AbortController().signal,
    tools: [
      {
        name: "get_status",
        description: "Reads the synthetic status",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      },
      {
        name: "create_note",
        description: "Creates a synthetic note",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string", maxLength: 64 } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    ],
    call: () => Promise.resolve({}),
    close: () => Promise.resolve(),
  };
}

interface Fixture {
  readonly deps: UiHandlerDeps;
  readonly root: string;
  readonly connections: ConfiguredMcpConnections;
  readonly connect: Mock<ConfiguredMcpConnections["connect"]>;
  readonly diagnostics: ServerDiagnosticRecord[];
  readonly connected: Map<string, ExternalMcpConnection>;
}

function fixture(servers: readonly McpServerDefinition[], withPeek = true): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-context-connectors-")));
  roots.push(root);
  const diagnostics: ServerDiagnosticRecord[] = [];
  const base = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(root, "evidence"),
    uiDbPath: join(root, "ui.db"),
    env: { KEIKO_STATE_DIR: root },
    diagnostics: { record: (record) => diagnostics.push(record) },
  });
  const settings = base.mcpSettings;
  if (settings === undefined) throw new Error("Missing MCP settings owner");
  settings.update(
    { expectedRevision: settings.read("fixture").revision, servers: [...servers], secrets: {} },
    "fixture",
  );
  const connected = new Map<string, ExternalMcpConnection>();
  const connect = vi.fn<ConfiguredMcpConnections["connect"]>(() =>
    Promise.reject(new Error("A status read must not connect")),
  );
  const connections: ConfiguredMcpConnections = {
    inspect: () => [],
    connect,
    ...(withPeek ? { connectedTools: (name: string) => connected.get(name)?.tools } : {}),
    generation: (definition, correlation) => settings.generation(definition, correlation),
    serve: () => Promise.resolve(new Response(null, { status: 404 })),
    close: () => Promise.resolve(),
  };
  const deps = Object.assign(base, { mcpConnections: connections });
  cleanups.push(async () => {
    await deps.dispose?.();
  });
  return { deps, root, connections, connect, diagnostics, connected };
}

function emptyTokens(): number {
  return countGatewayPromptTokens({ messages: [] }, ACCOUNTING);
}

function toolTokens(definitions: readonly ToolDefinition[]): number {
  return countGatewayPromptTokens({ messages: [], tools: definitions }, ACCOUNTING) - emptyTokens();
}

/** The server is connected and a turn's own connect call resolves to that same connection. */
function connectProduction(f: Fixture, name: string): void {
  const connected = connection();
  f.connected.set(name, connected);
  f.connect.mockImplementation(() => Promise.resolve(connected));
}

/** The catalog a turn really admits for the connected servers, through the production runtime. */
async function productionMcpDefinitions(f: Fixture): Promise<readonly ToolDefinition[]> {
  const runtime = createMcpChatCatalogRuntime({
    deps: f.deps,
    log: { primary: createBufferedServerLogSink(), diagnostics: { record: () => undefined } },
    executeMutation: () => Promise.reject(new Error("Not executed")),
  });
  const catalog = await runtime.get("production-catalog");
  await runtime.close();
  if (catalog === undefined) throw new Error("Expected a production catalog");
  return gatewayToolDefinitions(catalog.catalog, MCP_CHAT_PROFILE);
}

describe("chatConnectorTools for MCP servers", () => {
  it("counts a connected server's definitions exactly as the production catalog advertises them", async () => {
    const f = fixture([server("alpha")]);
    connectProduction(f, "alpha");
    const expected = await productionMcpDefinitions(f);
    f.connect.mockClear();
    const result = chatConnectorTools(f.deps, {}, ACCOUNTING, "corr-connected");
    expect(expected).toHaveLength(2);
    expect(result.connectors).toEqual([
      { kind: "mcp", name: "alpha", toolCount: 2, tokens: toolTokens(expected) },
    ]);
    expect(result.tokens).toBe(toolTokens(expected));
    expect(result.tokens).toBeGreaterThan(0);
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("lists a server that is not connected without counts and never connects it", () => {
    const f = fixture([server("alpha"), server("beta")]);
    f.connected.set("alpha", connection());
    const result = chatConnectorTools(f.deps, {}, ACCOUNTING, "corr-idle");
    expect(result.connectors).toMatchObject([
      { kind: "mcp", name: "alpha", toolCount: 2 },
      { kind: "mcp", name: "beta" },
    ]);
    expect(result.connectors[1]).not.toHaveProperty("toolCount");
    expect(result.connectors[1]).not.toHaveProperty("tokens");
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("treats a port that cannot peek like a server that is not connected", () => {
    const f = fixture([server("alpha")], false);
    f.connected.set("alpha", connection());
    expect(chatConnectorTools(f.deps, {}, ACCOUNTING, "corr-no-peek")).toEqual({
      tokens: 0,
      connectors: [{ kind: "mcp", name: "alpha" }],
    });
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("follows the Chat's selection and never lists a disabled or unselected server", () => {
    const f = fixture([server("alpha"), server("beta"), server("gamma", false)]);
    const names = (selection: readonly string[] | undefined): string[] =>
      chatConnectorTools(f.deps, { mcpServers: selection }, ACCOUNTING, "corr-selection")
        .connectors.map((connector) => connector.name)
        .filter((name): name is string => name !== undefined);
    expect(names(undefined)).toEqual(["alpha", "beta"]);
    expect(names(["beta", "gamma"])).toEqual(["beta"]);
    expect(names([])).toEqual([]);
  });

  it("reports a failing peek as a correlated diagnostic and keeps the server listed", () => {
    const f = fixture([server("alpha")]);
    const failing = {
      ...f.deps,
      mcpConnections: {
        ...f.connections,
        connectedTools: (): never => {
          throw new Error("synthetic-private-peek-failure");
        },
      },
    };
    expect(chatConnectorTools(failing, {}, ACCOUNTING, "corr-peek-failure")).toEqual({
      tokens: 0,
      connectors: [{ kind: "mcp", name: "alpha" }],
    });
    expect(f.diagnostics).toMatchObject([
      { correlationId: "corr-peek-failure", operation: "chat.context.connector-tools" },
    ]);
    expect(JSON.stringify(f.diagnostics)).not.toContain("synthetic-private-peek-failure");
  });

  it("reports unreadable settings once and lists no MCP connector", () => {
    const f = fixture([server("alpha")]);
    const settings = f.deps.mcpSettings;
    if (settings === undefined) throw new Error("Missing MCP settings owner");
    vi.spyOn(settings, "read").mockImplementation(() => {
      throw new Error("synthetic-settings-failure");
    });
    expect(chatConnectorTools(f.deps, {}, ACCOUNTING, "corr-settings-failure")).toEqual({
      tokens: 0,
      connectors: [],
    });
    expect(f.diagnostics).toHaveLength(1);
  });

  it("reports no connector for a Chat without any", () => {
    const f = fixture([]);
    expect(chatConnectorTools(f.deps, {}, ACCOUNTING, "corr-none")).toEqual({
      tokens: 0,
      connectors: [],
    });
    expect(chatConnectorTools(f.deps, undefined, ACCOUNTING, "corr-no-chat")).toEqual({
      tokens: 0,
      connectors: [],
    });
  });
});

function withPod(f: Fixture): {
  readonly deps: UiHandlerDeps;
  readonly runtime: ReturnType<typeof createJiraChatCatalogRuntime>;
} {
  const principal = (): string => "synthetic-operator";
  const ownerDigest = jiraChatActorDigest({ serverPrincipal: principal });
  const pod = {
    deployment: "data-center",
    displayName: "Synthetic Jira",
    livePod: { podId: POD_ID, ownerDigest },
  };
  const runtime = createJiraChatCatalogRuntime(f.deps, {
    primary: createBufferedServerLogSink(),
    diagnostics: { record: () => undefined },
  });
  cleanups.push(() => runtime.close());
  const deps = {
    ...f.deps,
    serverPrincipal: principal,
    jiraChatCatalog: runtime,
    atlassianConnectorCredentials: {
      custody: { list: () => [pod] },
    } as unknown as UiHandlerDeps["atlassianConnectorCredentials"],
  };
  return { deps, runtime };
}

const BINDING = {
  podId: POD_ID,
  bindingGeneration: 1,
  authenticationGeneration: 1,
  connectedAtMs: 1,
};

describe("chatConnectorTools for the Jira Pod", () => {
  it("counts the static Jira definitions exactly as the production catalog advertises them", async () => {
    const f = fixture([]);
    const { deps, runtime } = withPod(f);
    const get = vi.spyOn(runtime, "get");
    const result = chatConnectorTools(deps, { jiraPodBinding: BINDING }, ACCOUNTING, "corr-jira");
    expect(get).not.toHaveBeenCalled();
    const admitted = await runtime.get();
    const expected = gatewayToolDefinitions(admitted.catalog, { id: "jira-chat", version: 1 });
    expect(expected.length).toBeGreaterThan(10);
    expect(result.connectors).toEqual([
      {
        kind: "jira",
        name: "Synthetic Jira",
        toolCount: expected.length,
        tokens: toolTokens(expected),
      },
    ]);
    expect(result.tokens).toBe(toolTokens(expected));
  });

  it("adds the connectors' definitions together and counts them once as one request carries them", async () => {
    const f = fixture([server("alpha")]);
    connectProduction(f, "alpha");
    const mcp = await productionMcpDefinitions(f);
    const { deps, runtime } = withPod(f);
    const admitted = await runtime.get();
    const jira = gatewayToolDefinitions(admitted.catalog, { id: "jira-chat", version: 1 });
    const result = chatConnectorTools(deps, { jiraPodBinding: BINDING }, ACCOUNTING, "corr-both");
    expect(result.connectors.map((connector) => connector.kind)).toEqual(["mcp", "jira"]);
    expect(result.tokens).toBe(toolTokens([...mcp, ...jira]));
  });

  it("lists a Pod this principal does not own without counts", () => {
    const f = fixture([]);
    const { deps } = withPod(f);
    const other = { ...deps, serverPrincipal: (): string => "another-operator" };
    expect(
      chatConnectorTools(other, { jiraPodBinding: BINDING }, ACCOUNTING, "corr-foreign"),
    ).toEqual({ tokens: 0, connectors: [{ kind: "jira" }] });
  });

  it("lists no Jira connector without a binding or without the Jira catalog", () => {
    const f = fixture([]);
    const { deps } = withPod(f);
    expect(chatConnectorTools(deps, {}, ACCOUNTING, "corr-unbound").connectors).toEqual([]);
    const bare = { ...deps, jiraChatCatalog: undefined };
    expect(
      chatConnectorTools(bare, { jiraPodBinding: BINDING }, ACCOUNTING, "corr-no-catalog")
        .connectors,
    ).toEqual([]);
  });
});

function seededChat(f: Fixture): string {
  f.deps.store.createProject(f.root);
  const chat = f.deps.store.createChat(f.root, "Connector fixture", MODEL);
  for (let index = 0; index < 4; index += 1) {
    for (const role of ["user", "assistant"] as const) {
      f.deps.store.createMessage({
        chatId: chat.id,
        role,
        content: `Note ${String(index)}. We review the documentation together.`,
        timestamp: 1_700_000_000_000 + index * 2 + (role === "user" ? 0 : 1),
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
        taskType: undefined,
      });
    }
  }
  return chat.id;
}

function statusOf(
  f: Fixture,
  chatId: string,
  correlationId = "corr-status",
): ChatContextStatusWire {
  return readChatContextStatus(withProfile(f.deps, PROFILE), chatId, MODEL, correlationId);
}

// The model's own profile outranks the deployment default, so a test pins it at the model.
function withProfile(deps: UiHandlerDeps, profile: typeof PROFILE): UiHandlerDeps {
  return { ...deps, contextProfile: profile, contextProfileForModel: () => profile };
}

function segment(status: ChatContextStatusWire, id: string): number | undefined {
  return status.segments?.find((entry) => entry.id === id)?.tokens;
}

describe("context status with connectors", () => {
  it("shows the tools share, lists the connector and keeps the window sum exact", () => {
    const f = fixture([server("alpha")]);
    const chatId = seededChat(f);
    const without = statusOf(f, chatId);
    expect(without.connectors).toBeDefined();
    expect(segment(without, "tools")).toBeUndefined();
    f.connected.set("alpha", connection());
    const status = statusOf(f, chatId);
    const tools = status.connectors?.[0]?.tokens ?? 0;
    expect(tools).toBeGreaterThan(0);
    expect(segment(status, "tools")).toBe(tools);
    expect(status.estimatedInputTokens - without.estimatedInputTokens).toBe(tools);
    const sum = status.segments?.reduce((total, entry) => total + entry.tokens, 0);
    expect(sum).toBe(status.contextWindowTokens);
    expect(status.segments?.find((entry) => entry.id === "tools")?.count).toBe(2);
  });

  it("omits connectors for a Chat without any and never connects a server to read", () => {
    const f = fixture([]);
    const chatId = seededChat(f);
    const status = statusOf(f, chatId);
    expect(status).not.toHaveProperty("connectors");
    expect(segment(status, "tools")).toBeUndefined();
    const idle = fixture([server("alpha")]);
    const idleStatus = statusOf(idle, seededChat(idle));
    expect(idleStatus.connectors).toEqual([{ kind: "mcp", name: "alpha" }]);
    expect(segment(idleStatus, "tools")).toBeUndefined();
    expect(idle.connect).not.toHaveBeenCalled();
  });

  it("follows the Chat's own server selection", () => {
    const f = fixture([server("alpha"), server("beta")]);
    const chatId = seededChat(f);
    f.deps.store.updateChat(chatId, { mcpServers: ["beta"] });
    expect(statusOf(f, chatId).connectors).toEqual([{ kind: "mcp", name: "beta" }]);
    f.deps.store.updateChat(chatId, { mcpServers: [] });
    expect(statusOf(f, chatId)).not.toHaveProperty("connectors");
  });

  it("counts the tools toward the manual compaction threshold", () => {
    const f = fixture([server("alpha")]);
    const chatId = seededChat(f);
    const stored = statusOf(f, chatId).estimatedInputTokens;
    const bounded = (): ChatContextStatusWire =>
      readChatContextStatus(
        withProfile(f.deps, {
          ...deriveContextProfile({
            maxInputTokens: stored * 2 + 2 + 2_000,
            reservedOutputTokens: 2_000,
            safetyMarginTokens: 0,
          }),
          model: { id: MODEL },
        }),
        chatId,
        MODEL,
        "corr-threshold",
      );
    expect(bounded().canCompact).toBe(false);
    f.connected.set("alpha", connection());
    expect(bounded().canCompact).toBe(true);
  });

  it("records the tools share and connector counts, never a name, on the context line", () => {
    const f = fixture([server("alpha"), server("beta")]);
    const chatId = seededChat(f);
    f.connected.set("alpha", connection());
    const status = statusOf(f, chatId, "corr-log");
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    logChatContextManagement("inspected", status, 0, "corr-log");
    const line = formatActivityLogProofLine(sink.events[0] ?? {});
    expect(expectActivityLogProof("chat.context.management.line", line)).toMatchObject({
      correlationId: "corr-log",
      toolDefinitionTokens: segment(status, "tools"),
      connectorCount: 2,
      connectorToolCount: 2,
      connectorUnknownCount: 1,
    });
    expect(line).not.toContain("alpha");
    expect(line).not.toContain("beta");
  });
});

describe("ConfiguredMcpConnections.connectedTools", () => {
  function realConnections(
    connect: () => Promise<ExternalMcpConnection>,
  ): ReturnType<typeof createConfiguredMcpConnections> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-connected-tools-")));
    roots.push(root);
    const settings = createMcpSettingsStore({
      stateDir: root,
      env: {},
      keychainAccess: () => undefined,
    });
    settings.update(
      {
        expectedRevision: settings.read("fixture").revision,
        servers: [server("alpha")],
        secrets: {},
      },
      "fixture",
    );
    const connections = createConfiguredMcpConnections({
      settings,
      stateDir: root,
      log: createBufferedServerLogSink(),
      egress: () => undefined,
      connect,
    });
    cleanups.push(() => connections.close());
    return connections;
  }

  it("answers only for a settled connection and never starts a transport itself", async () => {
    const started = vi.fn(() => Promise.resolve(connection()));
    const connections = realConnections(started);
    expect(connections.connectedTools?.("alpha", "corr-peek")).toBeUndefined();
    expect(started).not.toHaveBeenCalled();
    const pending = connections.connect("alpha", "corr-connect");
    expect(connections.connectedTools?.("alpha", "corr-peek")).toBeUndefined();
    await pending;
    expect(connections.connectedTools?.("alpha", "corr-peek")?.map((tool) => tool.name)).toEqual([
      "get_status",
      "create_note",
    ]);
    expect(connections.connectedTools?.("unknown", "corr-peek")).toBeUndefined();
    expect(started).toHaveBeenCalledOnce();
  });

  it("answers nothing for a failed connection", async () => {
    const connections = realConnections(() => Promise.reject(new Error("synthetic-failure")));
    await expect(connections.connect("alpha", "corr-fail")).rejects.toThrow("synthetic-failure");
    expect(connections.connectedTools?.("alpha", "corr-peek")).toBeUndefined();
  });
});
