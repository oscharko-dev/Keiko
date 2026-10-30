import { describe, expect, it } from "vitest";

import {
  MCP_SERVER_MAX,
  mcpToolAction,
  mcpToolActions,
  isMcpToolActionName,
  parseMcpServerRegistry,
  parseMcpSettingsUpdate,
  type McpServerDefinition,
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

const ISSUER = "https://login.example.test/tenant";

function withOAuth(oauth: Readonly<Record<string, unknown>>): unknown {
  return { ...REMOTE, transport: { ...REMOTE.transport, oauth } };
}

function withHeaders(headers: unknown, extra: Readonly<Record<string, unknown>> = {}): unknown {
  return { ...REMOTE, transport: { ...REMOTE.transport, ...extra, headers } };
}

const TOKEN_HEADER = { secretEnv: "KEIKO_MCP_SECRET_TRACKER", prefix: "Bearer " };

function registry(...servers: unknown[]): unknown {
  return { schemaVersion: 1, servers };
}

describe("the MCP server registry (#3903)", () => {
  it.each([
    String.raw`C:relative.exe`,
    String.raw`\\host\share\tool.exe`,
    "//host/share/tool",
    String.raw`\\?\C:\tool.exe`,
  ])("refuses ambiguous or remote executable paths: %s", (executable) => {
    expect(
      parseMcpServerRegistry(
        registry({ ...LOCAL, transport: { ...LOCAL.transport, command: [executable] } }),
      ).ok,
    ).toBe(false);
  });

  it.each([String.raw`C:\Program Files\nodejs\node.exe`, "D:/tools/docs-mcp.exe"])(
    "admits a fully qualified local Windows executable: %s",
    (executable) => {
      expect(
        parseMcpServerRegistry(
          registry({
            ...LOCAL,
            transport: { ...LOCAL.transport, command: [executable, "--stdio"] },
          }),
        ).ok,
      ).toBe(true);
    },
  );

  it("admits 128-character MCP tool names through the native action boundary", () => {
    const name = "t".repeat(128);
    const parsed = parseMcpServerRegistry(registry({ ...REMOTE, tools: { [name]: "read" } }));
    expect(parsed.ok).toBe(true);
    expect(isMcpToolActionName(mcpToolAction("s".repeat(64), name))).toBe(true);
    expect(
      parseMcpServerRegistry(registry({ ...REMOTE, tools: { [`${name}x`]: "read" } })).ok,
    ).toBe(false);
  });
  it("admits a remote server's expected issuer, public client and scope exactly as written", () => {
    const oauth = {
      issuer: ISSUER,
      clientId: "keiko-workbench",
      scope: "tracker.read tracker.write",
    };
    expect(parseMcpServerRegistry(registry(withOAuth(oauth)))).toEqual({
      ok: true,
      servers: [
        expect.objectContaining({
          transport: { kind: "remote", url: "https://tracker.example.test/mcp", oauth },
        }) as unknown,
      ],
    });
    // An issuer is compared as written (RFC 8414 §3.3), so no trailing slash is added to it.
    const [server] = (
      parseMcpServerRegistry(registry(withOAuth({ issuer: ISSUER }))) as {
        readonly servers: readonly McpServerDefinition[];
      }
    ).servers;
    expect(server?.transport).toEqual({
      kind: "remote",
      url: "https://tracker.example.test/mcp",
      oauth: { issuer: ISSUER },
    });
  });

  // #3903 AC3: a static credential is named, never written: Keiko's own variable holds it.
  it("admits a remote server's credential headers as references to Keiko's MCP secrets", () => {
    const headers = {
      Authorization: TOKEN_HEADER,
      "X-Api-Key": { secretEnv: "KEIKO_MCP_SECRET_K" },
    };
    const [server] = (
      parseMcpServerRegistry(registry(withHeaders(headers))) as {
        readonly servers: readonly McpServerDefinition[];
      }
    ).servers;
    expect(server?.transport).toEqual({
      kind: "remote",
      url: "https://tracker.example.test/mcp",
      headers,
    });
  });

  it.each([
    ["a literal header value", { Authorization: { value: "Bearer abc" } }],
    ["a literal string header", { Authorization: "Bearer abc" }],
    ["a variable outside Keiko's MCP secrets", { Authorization: { secretEnv: "HOME" } }],
    [
      "Keiko's own provider key",
      { Authorization: { secretEnv: "KEIKO_PROVIDER_CREDENTIALS_KEY" } },
    ],
    ["a lowercase secret variable", { Authorization: { secretEnv: "KEIKO_MCP_SECRET_token" } }],
    ["a transport header", { "Mcp-Session-Id": TOKEN_HEADER }],
    ["the relay's own header", { "X-Keiko-Mcp-Relay": TOKEN_HEADER }],
    ["a host header", { Host: TOKEN_HEADER }],
    ["a header name with a space", { "X Api": TOKEN_HEADER }],
    ["one header in two spellings", { Authorization: TOKEN_HEADER, authorization: TOKEN_HEADER }],
    ["a prefix with a line break", { Authorization: { ...TOKEN_HEADER, prefix: "Bearer\r\n" } }],
    ["a prefix placeholder", { Authorization: { ...TOKEN_HEADER, prefix: "{env:HOME}" } }],
    ["an unknown header field", { Authorization: { ...TOKEN_HEADER, value: "x" } }],
    [
      "more than eight headers",
      Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`X-H${String(index)}`, TOKEN_HEADER]),
      ),
    ],
  ])("refuses a remote server with %s", (_label, headers) => {
    expect(parseMcpServerRegistry(registry(withHeaders(headers)))).toEqual({
      ok: false,
      reason: "server-invalid",
    });
  });

  it("refuses credential headers together with OAuth: the relay is not the OAuth resource", () => {
    expect(
      parseMcpServerRegistry(
        registry(withHeaders({ Authorization: TOKEN_HEADER }, { oauth: { issuer: ISSUER } })),
      ),
    ).toEqual({ ok: false, reason: "server-invalid" });
  });

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
    ["an http issuer", withOAuth({ issuer: "http://login.example.test" })],
    ["an issuer with a query", withOAuth({ issuer: "https://login.example.test/?tenant=a" })],
    ["an issuer with a fragment", withOAuth({ issuer: "https://login.example.test/#a" })],
    ["an issuer with credentials", withOAuth({ issuer: "https://u:p@login.example.test" })],
    ["a placeholder in the issuer", withOAuth({ issuer: "https://login.test/{env:HOME}" })],
    ["a client secret", withOAuth({ issuer: ISSUER, clientSecret: "s" })],
    ["a client id with a space", withOAuth({ issuer: ISSUER, clientId: "a b" })],
    ["a client id placeholder", withOAuth({ issuer: ISSUER, clientId: "{env:CLIENT}" })],
    ["a scope with a quote", withOAuth({ issuer: ISSUER, scope: 'read "all"' })],
    ["OAuth without an issuer", withOAuth({ clientId: "keiko" })],
    ["an unknown transport", { ...LOCAL, transport: { kind: "sse", url: "https://x.test" } }],
  ])("refuses a server with %s", (_label, server) => {
    expect(parseMcpServerRegistry(registry(server))).toEqual({
      ok: false,
      reason: "server-invalid",
    });
  });
});

describe("private MCP registry generation", () => {
  const generation = "751aee5d-e2b8-4e60-a609-2995005266a5";
  it("reads legacy documents and preserves a committed opaque generation", () => {
    expect(parseMcpServerRegistry({ schemaVersion: 1, servers: [LOCAL] })).toMatchObject({
      ok: true,
    });
    expect(
      parseMcpServerRegistry({ schemaVersion: 1, servers: [LOCAL], generation }),
    ).toMatchObject({ ok: true, generation });
  });
  it.each([null, 1, "", "stale", "a".repeat(1024)])("refuses malformed generation %s", (value) => {
    expect(
      parseMcpServerRegistry({ schemaVersion: 1, servers: [LOCAL], generation: value }),
    ).toEqual({ ok: false, reason: "malformed" });
  });
  it("never accepts a client-selected Settings generation", () => {
    expect(
      parseMcpSettingsUpdate({
        expectedRevision: "a".repeat(64),
        servers: [LOCAL],
        secrets: {},
        generation,
      }),
    ).toBeUndefined();
  });
});
