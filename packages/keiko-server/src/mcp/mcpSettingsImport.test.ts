import { describe, expect, it } from "vitest";
import { prepareMcpSettingsImport } from "./mcpSettingsImport.js";

const snapshot = { revision: "a".repeat(64), servers: [] };
const remote = { type: "remote", url: "https://example.test/mcp", enabled: true };

describe("central MCP JSON import", () => {
  it("takes only the MCP section of an OpenCode JSONC document", () => {
    const result = prepareMcpSettingsImport(
      '{ /* copied config */ "provider": {}, "mcp": { "remote": {"type":"remote","url":"https://example.test/mcp"}, "local": {"type":"local","command":["/opt/example/node","--flag","/opt/example/server.js"]}, }, }',
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
