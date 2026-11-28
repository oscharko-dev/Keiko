import { describe, expect, it } from "vitest";
import { prepareMcpSettingsImport } from "./mcpSettingsImport.js";

const snapshot = { revision: "a".repeat(64), servers: [] };
const remote = { type: "remote", url: "https://example.test/mcp", enabled: true };

describe("central MCP JSON import", () => {
  it("takes only the MCP section of an OpenCode JSONC document", () => {
    const result = prepareMcpSettingsImport(
      '{ /* copied config */ "$schema": "https://example.test/config.json", "provider": {"demo": {"options": {"baseURL":"https://model.example.test"}}}, "mcp": { "remote": {"type":"remote","url":"https://example.test/mcp"}, "local": {"type":"local","command":["/opt/example/node","--flag","/opt/example/server.js"]}, }, }',
      snapshot,
    );
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("Expected import");
    expect(result.update.servers).toMatchObject([
      {
        name: "remote",
        enabled: false,
        discovery: "automatic",
        tools: {},
        transport: { kind: "remote" },
      },
      {
        name: "local",
        enabled: false,
        transport: {
          kind: "local",
          command: ["/opt/example/node", "--flag", "/opt/example/server.js"],
        },
      },
    ]);
  });

  it.each([
    ["mcp", { mcp: { url: { url: remote.url } } }, "url", "remote"],
    ["mcp", { mcp: { command: { command: ["/opt/example/node"] } } }, "command", "local"],
    ["mcpServers", { mcpServers: { url: { url: remote.url } } }, "url", "remote"],
    [
      "mcpServers",
      { mcpServers: { command: { command: "/opt/example/node" } } },
      "command",
      "local",
    ],
    ["mcp.servers", { mcp: { servers: { url: { url: remote.url } } } }, "url", "remote"],
    [
      "mcp.servers",
      { mcp: { servers: { command: { command: ["/opt/example/node"] } } } },
      "command",
      "local",
    ],
  ])("reads the %s wrapper %j as a server map", (_wrapper, document, name, kind) => {
    expect(prepareMcpSettingsImport(JSON.stringify(document), snapshot)).toMatchObject({
      kind: "ready",
      update: { servers: [{ name, transport: { kind } }] },
    });
  });

  it("refuses a mixed map with definitions outside the nested map", () => {
    const document = {
      mcp: { servers: { example: remote }, second: { url: "https://second.example.test/mcp" } },
    };
    expect(prepareMcpSettingsImport(JSON.stringify(document), snapshot)).toEqual({
      kind: "invalid",
      issue: "shape",
    });
  });

  it.each(["mcp", "mcpServers"])("refuses server definitions beside the %s wrapper", (wrapper) => {
    const document = {
      [wrapper]: { example: remote },
      "local-tools": { command: "/opt/example/node", args: ["server.js"] },
    };
    expect(prepareMcpSettingsImport(JSON.stringify(document), snapshot)).toEqual({
      kind: "invalid",
      issue: "shape",
    });
  });

  it.each([
    { type: "websocket", url: "https://example.test/mcp" },
    { type: "websocket", url: { address: "https://example.test/mcp" } },
    { type: 42, url: { address: "https://example.test/mcp" } },
    { url: 42 },
    { type: "remote" },
    { type: "local", command: null },
  ])("refuses a malformed server definition beside a wrapper (%j)", (bad) => {
    const document = { mcp: { example: remote }, bad };
    expect(prepareMcpSettingsImport(JSON.stringify(document), snapshot)).toEqual({
      kind: "invalid",
      issue: "shape",
    });
  });

  it("keeps a server literally named servers alongside other direct entries", () => {
    const document = {
      mcp: { servers: remote, second: { url: "https://second.example.test/mcp" } },
    };
    expect(prepareMcpSettingsImport(JSON.stringify(document), snapshot)).toMatchObject({
      kind: "ready",
      update: { servers: [{ name: "servers" }, { name: "second" }] },
    });
  });

  it("keeps unrelated named OpenCode commands and providers outside the import", () => {
    const document = {
      command: { url: { description: "Show addresses", template: "List addresses" } },
      provider: { command: { options: { baseURL: "https://model.example.test" } } },
      mcp: { example: remote },
    };
    expect(prepareMcpSettingsImport(JSON.stringify(document), snapshot)).toMatchObject({
      kind: "ready",
      update: { servers: [{ name: "example" }] },
    });
  });

  it("refuses an SSE protocol on explicit streamable HTTP entries", () => {
    const document = { example: { ...remote, type: "streamable-http", protocol: "sse" } };
    expect(prepareMcpSettingsImport(JSON.stringify(document), snapshot)).toEqual({
      kind: "invalid",
      issue: "options",
      entry: 1,
    });
  });

  it.each(["remote", "http", "sse"])("accepts an SSE protocol on %s entries", (type) => {
    const document = { example: { ...remote, type, protocol: "sse" } };
    expect(prepareMcpSettingsImport(JSON.stringify(document), snapshot)).toMatchObject({
      kind: "ready",
      update: { servers: [{ transport: { kind: "remote", protocol: "sse" } }] },
    });
  });

  it("routes imported header and environment values to write-only Settings secrets", () => {
    const result = prepareMcpSettingsImport(
      JSON.stringify({
        mcpServers: {
          remote: { ...remote, headers: { Authorization: "Bearer fixture-credential" } },
          local: {
            command: "/opt/example/node",
            args: ["server.js"],
            env: { TEST_TOKEN: "test-secret" },
          },
        },
      }),
      snapshot,
    );
    if (result.kind !== "ready") throw new Error("Expected import");
    expect(JSON.stringify(result.update.servers)).not.toContain("fixture-credential");
    expect(JSON.stringify(result.update.servers)).not.toContain("test-secret");
    expect(Object.values(result.update.secrets)).toEqual([
      { server: "remote", value: "fixture-credential" },
      { server: "local", value: "test-secret" },
    ]);
  });

  it("accepts one named definition and an array of named definitions", () => {
    expect(
      prepareMcpSettingsImport(JSON.stringify({ name: "remote", ...remote }), snapshot).kind,
    ).toBe("ready");
    expect(
      prepareMcpSettingsImport(JSON.stringify([{ name: "remote", ...remote }]), snapshot).kind,
    ).toBe("ready");
  });

  it("refuses existing names and refuses a malformed member without importing its peers", () => {
    const current = prepareMcpSettingsImport(JSON.stringify({ existing: remote }), snapshot);
    if (current.kind !== "ready") throw new Error("Expected import");
    expect(
      prepareMcpSettingsImport(JSON.stringify({ existing: remote }), {
        ...snapshot,
        servers: current.update.servers,
      }),
    ).toEqual({
      kind: "invalid",
      issue: "duplicate",
      entry: 1,
    });
    expect(
      prepareMcpSettingsImport(
        JSON.stringify({ valid: remote, broken: { type: "local", command: ["node"] } }),
        snapshot,
      ),
    ).toEqual({
      kind: "invalid",
      issue: "local",
      entry: 2,
    });
  });

  it.each([
    ['{"mcp":{"duplicate":{},"duplicat\\u0065":{}}}', "duplicate-key"],
    ['{"mcp":{"__proto__":{}}}', "duplicate-key"],
    ['{"mcp":{}, "mcpServers":{}}', "shape"],
    ['{"mcp":', "syntax"],
    ["{}", "empty"],
    [
      '{"mcp":{"remote":{"type":"remote","url":"https://example.test/mcp","tools":{"publish":"read"}}}}',
      "options",
    ],
    ['{"mcp":{"remote":{"type":"remote","url":"https://example.test/mcp#part"}}}', "remote"],
  ] as const)("rejects unsafe or unsupported input %s", (document, issue) => {
    expect(prepareMcpSettingsImport(document, snapshot)).toMatchObject({ kind: "invalid", issue });
  });
});
