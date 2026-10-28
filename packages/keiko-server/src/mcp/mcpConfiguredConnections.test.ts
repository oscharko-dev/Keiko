import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseMcpServerRegistry,
  type McpServerDefinition,
  type McpSettingsUpdate,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import type { ExternalMcpClientOptions } from "@oscharko-dev/keiko-mcp";
import {
  createConfiguredMcpConnections,
  type ConfiguredMcpConnections,
} from "./mcpConfiguredConnections.js";
import { createMcpSettingsStore } from "./mcpSettingsStore.js";

const roots: string[] = [];
const managers: ConfiguredMcpConnections[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(
  transport: unknown = { kind: "remote", url: "https://synthetic.example.test/mcp" },
  secrets: McpSettingsUpdate["secrets"] = {},
): { root: string; store: ReturnType<typeof createMcpSettingsStore>; server: McpServerDefinition } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-configured-mcp-")));
  roots.push(root);
  const store = createMcpSettingsStore({
    stateDir: root,
    env: { KEIKO_MCP_OAUTH_CREDENTIALS_KEY: randomBytes(32).toString("base64") },
    keychainAccess: () => undefined,
  });
  const parsed = parseMcpServerRegistry({
    schemaVersion: 1,
    servers: [{ name: "notes", discovery: "automatic", transport, tools: {} }],
  });
  if (!parsed.ok || parsed.servers[0] === undefined) throw new Error("Invalid fixture");
  const server = parsed.servers[0];
  store.update(
    { expectedRevision: store.read("fixture").revision, servers: [server], secrets },
    "fixture",
  );
  return { root, store, server };
}
const tools = [{ name: "probe", inputSchema: { type: "object" } }];
function context(): import("@oscharko-dev/keiko-contracts/runtime/managed-mcp").ManagedMcpInvocationContext {
  return {
    invocationId: "synthetic-invocation",
    correlationId: "synthetic-correlation",
    signal: new AbortController().signal,
    beforeEffect: (): boolean => true,
  };
}

function probeRequest(): Request {
  return new Request("https://relay.example.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "probe", arguments: {} },
    }),
  });
}

describe("configured MCP connections", () => {
  it("never installs a stale connection's endpoint on its replacement generation", async () => {
    const f = fixture();
    const dispatch = vi.fn(() => Promise.resolve({ content: [{ type: "text", text: "fresh" }] }));
    const manager = createConfiguredMcpConnections({
      settings: f.store,
      stateDir: f.root,
      log: { write: () => undefined },
      egress: () => undefined,
      connect: () =>
        Promise.resolve({
          signal: new AbortController().signal,
          tools,
          call: dispatch,
          close: () => Promise.resolve(),
        }),
    });
    managers.push(manager);
    const first = manager.connect("notes", "test");
    // Rotate after discovery resolves, but before the suspended serve resumes.
    const replacement = first.then(() => {
      f.store.update(
        {
          expectedRevision: f.store.read("test").revision,
          servers: [{ ...f.server, tools: { probe: "write" } }],
          secrets: {},
        },
        "test",
      );
      return manager.connect("notes", "test");
    });
    const stale = manager.serve("notes", probeRequest(), context());
    const observed = Promise.allSettled([stale]);
    await replacement;
    const response = await manager.serve("notes", probeRequest(), context());
    expect(await response.text()).toContain('"text":"fresh"');
    expect(await observed).toMatchObject([
      { status: "rejected", reason: { reason: "not-admitted" } },
    ]);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("shares a connection, immediately revokes it on disable, and never reuses it after re-enable", async () => {
    const f = fixture();
    const options: ExternalMcpClientOptions[] = [];
    const dispatch = vi.fn(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const connect = vi.fn((input: ExternalMcpClientOptions) => {
      options.push(input);
      return Promise.resolve({
        signal: new AbortController().signal,
        tools,
        call: dispatch,
        close: () => Promise.resolve(),
      });
    });
    const manager = createConfiguredMcpConnections({
      settings: f.store,
      stateDir: f.root,
      log: { write: () => undefined },
      egress: () => undefined,
      connect,
    });
    managers.push(manager);
    const first = await manager.connect("notes", "test");
    expect(await manager.connect("notes", "test")).toBe(first);
    expect(connect).toHaveBeenCalledTimes(1);
    f.store.update(
      {
        expectedRevision: f.store.read("test").revision,
        servers: [{ ...f.server, enabled: false }],
        secrets: {},
      },
      "test",
    );
    expect(options[0]?.signal.aborted).toBe(true);
    await expect(first.call("probe", {}, context())).rejects.toMatchObject({
      reason: "not-admitted",
    });
    expect(dispatch).not.toHaveBeenCalled();
    f.store.update(
      { expectedRevision: f.store.read("test").revision, servers: [f.server], secrets: {} },
      "test",
    );
    expect(await manager.connect("notes", "test")).not.toBe(first);
    expect(connect).toHaveBeenCalledTimes(2);
  });
  it("refuses a late result after removal", async () => {
    const f = fixture();
    let complete: ((value: { content: [] }) => void) | undefined;
    const manager = createConfiguredMcpConnections({
      settings: f.store,
      stateDir: f.root,
      log: { write: () => undefined },
      egress: () => undefined,
      connect: () =>
        Promise.resolve({
          signal: new AbortController().signal,
          tools,
          call: () =>
            new Promise((resolve) => {
              complete = resolve;
            }),
          close: () => Promise.resolve(),
        }),
    });
    managers.push(manager);
    const connection = await manager.connect("notes", "test");
    const pending = connection.call("probe", {}, context());
    f.store.update(
      { expectedRevision: f.store.read("test").revision, servers: [], secrets: {} },
      "test",
    );
    complete?.({ content: [] });
    await expect(pending).rejects.toMatchObject({ reason: "not-admitted" });
  });
  it("applies the configured network class and headers only to the admitted target", async () => {
    const reference = "KEIKO_MCP_SECRET_SYNTHETIC";
    const token = "synthetic-private-mcp-token";
    const f = fixture(
      {
        kind: "remote",
        url: "https://synthetic.example.test/mcp",
        network: "private",
        headers: { Authorization: { secretEnv: reference, prefix: "Bearer " } },
      },
      { [reference]: { server: "notes", value: token } },
    );
    let transport: ExternalMcpClientOptions["transport"] | undefined;
    const fetch = vi.fn(() => Promise.resolve(Response.json({})));
    const manager = createConfiguredMcpConnections({
      settings: f.store,
      stateDir: f.root,
      log: { write: () => undefined },
      egress: () => ({ allowLinkLocalAndMetadata: true, allowPrivateNetwork: true }),
      fetch,
      connect: (options) => {
        transport = options.transport;
        return Promise.resolve({
          signal: new AbortController().signal,
          tools,
          call: () => Promise.resolve({ content: [{ type: "text", text: token }] }),
          close: () => Promise.resolve(),
        });
      },
    });
    managers.push(manager);
    const connection = await manager.connect("notes", "test");
    if (transport?.kind !== "remote") throw new Error("Missing transport");
    await expect(transport.fetch("https://elsewhere.example.test/mcp")).rejects.toMatchObject({
      reason: "not-admitted",
    });
    expect(fetch).not.toHaveBeenCalled();
    await transport.fetch("https://synthetic.example.test/mcp", { method: "POST", body: "{}" });

    const request = fetch.mock.calls[0] as unknown as [
      string,
      { headers: Headers; redirect: string; egress: Record<string, unknown> },
    ];
    expect(request[1].redirect).toBe("manual");
    expect(request[1].egress).toMatchObject({
      requiredTargetClass: "private",
      allowLinkLocalAndMetadata: false,
      denyLoopback: true,
      pinProxiedConnectTarget: true,
    });
    expect(request[1].headers.get("Authorization")).toBe(`Bearer ${token}`);
    expect(JSON.stringify(await connection.call("probe", {}, context()))).not.toContain(token);
    f.store.update(
      { expectedRevision: f.store.read("test").revision, servers: [], secrets: {} },
      "test",
    );
    await expect(transport.fetch("https://synthetic.example.test/mcp")).rejects.toMatchObject({
      reason: "not-admitted",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("imports .env into the existing vault and calls a real stdio tool through the production SDK", async () => {
    const f = fixture();
    const program = join(f.root, "synthetic-mcp.mjs");
    writeFileSync(
      program,
      `import { createInterface } from "node:readline";
      createInterface({input:process.stdin}).on("line", line => {
        const m=JSON.parse(line); if(m.id===undefined)return; let result;
        if(m.method==="initialize")result={protocolVersion:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"synthetic",version:"1"}};
        if(m.method==="tools/list")result={tools:[{name:"probe",inputSchema:{type:"object",properties:{},additionalProperties:false}}]};
        if(m.method==="tools/call")result={content:[{type:"text",text:process.env.FIXTURE_TOKEN==="synthetic-env-secret"&&process.env.USER===""?"sealed":"missing"}]};
        process.stdout.write(JSON.stringify(result===undefined?{jsonrpc:"2.0",id:m.id,error:{code:-32601,message:"Unknown method"}}:{jsonrpc:"2.0",id:m.id,result})+"\\n");
      });`,
    );
    const updated = f.store.update(
      {
        expectedRevision: f.store.read("test").revision,
        servers: [
          {
            ...f.server,
            transport: { kind: "local", command: [process.execPath, program], environment: {} },
            tools: { probe: "write" },
          },
        ],
        secrets: {},
        environmentFiles: { notes: 'FIXTURE_TOKEN="synthetic-env-secret"\nEMPTY_VALUE=\n' },
      },
      "test",
    );
    expect(JSON.stringify(updated)).not.toContain("synthetic-env-secret");
    expect(readFileSync(join(f.root, "mcp-servers.json"), "utf8")).not.toContain(
      "synthetic-env-secret",
    );
    const manager = createConfiguredMcpConnections({
      settings: f.store,
      stateDir: f.root,
      log: { write: () => undefined },
      egress: () => undefined,
    });
    managers.push(manager);
    const connection = await manager.connect("notes", "test");
    expect(await connection.call("probe", {}, context())).toMatchObject({
      content: [{ text: "sealed" }],
    });
    const response = await manager.serve(
      "notes",
      new Request("https://relay.example.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-03-26",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "probe", arguments: {} },
        }),
      }),
      context(),
    );
    expect(await response.text()).toContain('"text":"sealed"');
    f.store.update(
      { expectedRevision: f.store.read("test").revision, servers: [], secrets: {} },
      "test",
    );
    await expect(connection.call("probe", {}, context())).rejects.toMatchObject({
      reason: "not-admitted",
    });
  });
});

it("reports only runtime connection facts and recovers a closed connection without changing settings", async () => {
  const f = fixture();
  let ready: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const lifetimes: AbortController[] = [];
  const connect = vi.fn(async () => {
    await gate;
    const lifetime = new AbortController();
    lifetimes.push(lifetime);
    return {
      signal: lifetime.signal,
      tools,
      call: (): Promise<{ content: [] }> => Promise.resolve({ content: [] }),
      close: (): Promise<void> => {
        lifetime.abort();
        return Promise.resolve();
      },
    };
  });
  const manager = createConfiguredMcpConnections({
    settings: f.store,
    stateDir: f.root,
    log: { write: () => undefined },
    egress: () => undefined,
    connect,
  });
  managers.push(manager);
  expect(manager.inspect("test")).toEqual([{ name: "notes", state: "idle", toolCount: null }]);
  expect(connect).not.toHaveBeenCalled();
  const pending = manager.connect("notes", "test");
  expect(manager.inspect("test")[0]?.state).toBe("connecting");
  ready?.();
  const first = await pending;
  expect(manager.inspect("test")).toEqual([{ name: "notes", state: "connected", toolCount: 1 }]);
  expect(f.store.read("test").servers[0]?.tools).toEqual({});
  lifetimes[0]?.abort();
  expect(manager.inspect("test")).toEqual([{ name: "notes", state: "failed", toolCount: null }]);
  expect(await manager.connect("notes", "test")).not.toBe(first);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(manager.inspect("test")[0]?.state).toBe("connected");
  f.store.update(
    {
      expectedRevision: f.store.read("test").revision,
      servers: [{ ...f.server, enabled: false }],
      secrets: {},
    },
    "test",
  );
  expect(manager.inspect("test")).toEqual([{ name: "notes", state: "disabled", toolCount: null }]);
});

it("keeps a failed connection observable and retries only on explicit connection demand", async () => {
  const f = fixture();
  const connect = vi.fn(() => Promise.reject(new Error("synthetic unreachable endpoint")));
  const manager = createConfiguredMcpConnections({
    settings: f.store,
    stateDir: f.root,
    log: { write: () => undefined },
    egress: () => undefined,
    connect,
  });
  managers.push(manager);
  await expect(manager.connect("notes", "test")).rejects.toThrow("synthetic unreachable");
  expect(manager.inspect("test")).toEqual([{ name: "notes", state: "failed", toolCount: null }]);
  expect(manager.inspect("test")[0]?.state).toBe("failed");
  expect(connect).toHaveBeenCalledTimes(1);
  await expect(manager.connect("notes", "test")).rejects.toThrow();
  expect(connect).toHaveBeenCalledTimes(2);
});
