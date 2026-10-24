import { describe, expect, it } from "vitest";

import {
  MCP_SERVER_MAX,
  mcpToolAction,
  mcpToolActions,
  parseMcpServerRegistry,
} from "./mcp-servers.js";

const LOCAL = {
  name: "docs",
  description: "Searches the internal docs",
  transport: {
    kind: "local",
    command: ["/opt/tools/bin/docs-mcp", "--stdio"],
    environment: { DOCS_INDEX: "/srv/docs" },
  },
  tools: { search: "read", "page.update": "write" },
};
const REMOTE = {
  name: "tracker",
  transport: { kind: "remote", url: "https://tracker.example.test/mcp" },
  tools: { find: "read" },
};

function registry(...servers: unknown[]): unknown {
  return { schemaVersion: 1, servers };
}

describe("the MCP server registry (#3903)", () => {
  it("admits a local and a remote server with their declared tools", () => {
    const parsed = parseMcpServerRegistry(registry(LOCAL, REMOTE));
    expect(parsed).toEqual({
      ok: true,
      servers: [
        {
          name: "docs",
          description: "Searches the internal docs",
          enabled: true,
          transport: {
            kind: "local",
            command: ["/opt/tools/bin/docs-mcp", "--stdio"],
            environment: { DOCS_INDEX: "/srv/docs" },
          },
          tools: { search: "read", "page.update": "write" },
        },
        {
          name: "tracker",
          description: undefined,
          enabled: true,
          transport: { kind: "remote", url: "https://tracker.example.test/mcp" },
          tools: { find: "read" },
        },
      ],
    });
  });

  it("names a tool the way the runtime does, and only for enabled servers", () => {
    expect(mcpToolAction("docs", "page.update")).toBe("docs_page_update");
    const parsed = parseMcpServerRegistry(registry(LOCAL, { ...REMOTE, enabled: false }));
    if (!parsed.ok) throw new Error("expected a registry");
    expect([...mcpToolActions(parsed.servers).entries()]).toEqual([
      ["docs_search", { risk: "read", remote: false }],
      ["docs_page_update", { risk: "write", remote: false }],
    ]);
  });

  it.each([
    ["not an object", 7],
    ["an unknown top-level key", { schemaVersion: 1, servers: [], extra: true }],
    ["servers that are not a list", { schemaVersion: 1, servers: {} }],
  ])("refuses %s as malformed", (_label, document) => {
    expect(parseMcpServerRegistry(document)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses another schema version, too many servers and a duplicate name", () => {
    expect(parseMcpServerRegistry({ schemaVersion: 2, servers: [] })).toEqual({
      ok: false,
      reason: "schema-version",
    });
    const many = Array.from({ length: MCP_SERVER_MAX + 1 }, (_, index) => ({
      ...LOCAL,
      name: `docs${String(index)}`,
    }));
    expect(parseMcpServerRegistry(registry(...many))).toEqual({
      ok: false,
      reason: "too-many-servers",
    });
    expect(parseMcpServerRegistry(registry(LOCAL, LOCAL))).toEqual({
      ok: false,
      reason: "duplicate-server",
    });
  });

  it.each([
    ["a name with an underscore", { ...LOCAL, name: "my_docs" }],
    ["an uppercase name", { ...LOCAL, name: "Docs" }],
    ["an unknown key", { ...LOCAL, secret: "x" }],
    ["no tools", { ...LOCAL, tools: {} }],
    ["an unknown risk", { ...LOCAL, tools: { search: "admin" } }],
    ["tools the runtime would name alike", { ...LOCAL, tools: { "a.b": "read", a_b: "write" } }],
    [
      "a relative executable",
      { ...LOCAL, transport: { ...LOCAL.transport, command: ["docs-mcp"] } },
    ],
    [
      "a placeholder in an argument",
      { ...LOCAL, transport: { ...LOCAL.transport, command: ["/bin/x", "{env:TOKEN}"] } },
    ],
    [
      "a placeholder in the environment",
      {
        ...LOCAL,
        transport: { ...LOCAL.transport, environment: { TOKEN: "{env:KEIKO_SECRET}" } },
      },
    ],
    [
      "a file placeholder in the environment",
      { ...LOCAL, transport: { ...LOCAL.transport, environment: { KEY: "{file:~/.ssh/id}" } } },
    ],
    [
      "a lowercase variable",
      { ...LOCAL, transport: { ...LOCAL.transport, environment: { path: "/bin" } } },
    ],
    ["an http URL", { ...REMOTE, transport: { kind: "remote", url: "http://tracker.test/mcp" } }],
    [
      "credentials in the URL",
      { ...REMOTE, transport: { kind: "remote", url: "https://user:pw@tracker.test/mcp" } },
    ],
    [
      "a placeholder in the URL",
      { ...REMOTE, transport: { kind: "remote", url: "https://tracker.test/{env:PATH}" } },
    ],
    ["headers on a remote server", { ...REMOTE, transport: { ...REMOTE.transport, headers: {} } }],
    ["an unknown transport", { ...LOCAL, transport: { kind: "sse", url: "https://x.test" } }],
  ])("refuses a server with %s", (_label, server) => {
    expect(parseMcpServerRegistry(registry(server))).toEqual({
      ok: false,
      reason: "server-invalid",
    });
  });
});
