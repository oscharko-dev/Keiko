import { describe, expect, it } from "vitest";

import {
  MCP_SERVER_MAX,
  mcpToolAction,
  mcpToolActions,
  parseMcpServerRegistry,
  parseCodingWorkbenchRuntimeMcpChannelPayload,
  parseCodingWorkbenchMcpAuthorizationStart,
  parseCodingWorkbenchMcpAuthorizationStatus,
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

function registryWithCommand(command: unknown): unknown {
  return registry({ ...LOCAL, transport: { ...LOCAL.transport, command } });
}

function expectAdmittedCommand(command: unknown, expected: readonly string[]): void {
  const result = parseMcpServerRegistry(registryWithCommand(command));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new TypeError("Expected an admitted local command");
  expect(result.servers[0]?.transport).toEqual({
    kind: "local",
    command: expected,
    environment: LOCAL.transport.environment,
  });
}

describe("captured MCP command admission", () => {
  it("refuses a command whose later physical slot is absent", (): void => {
    const command = new Array<unknown>(2);
    command[0] = "/bin/x";
    expect(parseMcpServerRegistry(registryWithCommand(command))).toEqual({
      ok: false,
      reason: "server-invalid",
    });
  });

  it.each([undefined, 42, "{env:TOKEN}"])(
    "refuses an invalid argument actually yielded by the command iterator: %s",
    (argument): void => {
      const command = ["/bin/x", "--stdio"];
      Object.defineProperty(command, Symbol.iterator, {
        value: (): ArrayIterator<unknown> => ["/bin/x", argument][Symbol.iterator](),
      });
      expect(parseMcpServerRegistry(registryWithCommand(command))).toEqual({
        ok: false,
        reason: "server-invalid",
      });
    },
  );

  it("refuses an iterator that materializes more than the command argument bound", (): void => {
    const command = ["/bin/x"];
    const materialized = ["/bin/x", ...Array.from({ length: 32 }, () => "--stdio")];
    Object.defineProperty(command, Symbol.iterator, {
      value: (): ArrayIterator<string> => materialized[Symbol.iterator](),
    });
    expect(parseMcpServerRegistry(registryWithCommand(command))).toEqual({
      ok: false,
      reason: "server-invalid",
    });
  });

  it("continues to admit inherited valid command members", (): void => {
    const command = new Array<unknown>(2);
    command[0] = "/bin/x";
    Object.setPrototypeOf(command, Object.assign([], { 1: "--stdio" }));
    expectAdmittedCommand(command, ["/bin/x", "--stdio"]);
  });

  it("retains both command read phases and their original receivers", (): void => {
    const reads: string[] = [];
    const receivers: unknown[] = [];
    const command = Object.defineProperties([], {
      0: {
        get: function (this: unknown): string {
          reads.push("executable");
          receivers.push(this);
          return "/bin/x";
        },
        configurable: true,
      },
      1: {
        get: function (this: unknown): string {
          reads.push("argument");
          receivers.push(this);
          return "--stdio";
        },
        configurable: true,
      },
    });
    expectAdmittedCommand(command, ["/bin/x", "--stdio"]);
    expect(reads).toEqual(["executable", "argument", "executable", "argument"]);
    expect(receivers).toHaveLength(4);
    for (const receiver of receivers) expect(receiver).toBe(command);
  });

  it("preserves the exact command iterator failure", (): void => {
    const failure: TypeError = Object.freeze(new TypeError("command iterator failed"));
    const command = ["/bin/x"];
    Object.defineProperty(command, Symbol.iterator, {
      value: (): never => {
        throw failure;
      },
    });
    let caught: unknown;
    try {
      parseMcpServerRegistry(registryWithCommand(command));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
  });
});

it("captures guarded optional MCP fields once and omits absent values", (): void => {
  const reads: string[] = [];
  const header = {
    secretEnv: "KEIKO_MCP_SECRET_TRACKER",
    get prefix(): undefined {
      reads.push("prefix");
      return undefined;
    },
  };
  const oauth = {
    issuer: ISSUER,
    get clientId(): undefined {
      reads.push("clientId");
      return undefined;
    },
    get scope(): string {
      reads.push("scope");
      return "tracker.read";
    },
  };
  const headerResult = parseMcpServerRegistry(registry(withHeaders({ Authorization: header })));
  const oauthResult = parseMcpServerRegistry(registry(withOAuth(oauth)));
  expect(reads).toEqual(["prefix", "clientId", "scope"]);
  expect(headerResult).toMatchObject({
    ok: true,
    servers: [{ transport: { headers: { Authorization: { secretEnv: header.secretEnv } } } }],
  });
  expect(oauthResult).toMatchObject({
    ok: true,
    servers: [{ transport: { oauth: { issuer: ISSUER, scope: "tracker.read" } } }],
  });
  if (!headerResult.ok || !oauthResult.ok) throw new TypeError("Expected admitted remote fields");
  expect(headerResult.servers[0]?.transport).not.toHaveProperty("headers.Authorization.prefix");
  expect(oauthResult.servers[0]?.transport).not.toHaveProperty("oauth.clientId");
});

it("retains captured environment and tool values without rereading their properties", (): void => {
  const reads: string[] = [];
  const environment = {
    get DOCS_INDEX(): string {
      reads.push("environment");
      return "/srv/docs";
    },
  };
  const tools = {
    get search(): "read" {
      reads.push("tool");
      return "read";
    },
  };
  const result = parseMcpServerRegistry(
    registry({
      ...LOCAL,
      transport: { ...LOCAL.transport, environment },
      tools,
    }),
  );
  expect(reads).toEqual(["environment", "tool"]);
  expect(result).toMatchObject({
    ok: true,
    servers: [
      { transport: { environment: { DOCS_INDEX: "/srv/docs" } }, tools: { search: "read" } },
    ],
  });
});

it("retains the MCP channel's closed statuses and authorization vocabularies", (): void => {
  for (const status of ["connected", "needs-authorization", "failed", "disabled", "pending"]) {
    const server = { name: "docs", status, authorization: "none" };
    expect(
      parseCodingWorkbenchRuntimeMcpChannelPayload({ session: "active", servers: [server] }),
    ).toEqual({ session: "active", servers: [server] });
  }
  for (const reason of ["unavailable", "not-oauth", "connected", "url-refused", "failed"]) {
    expect(parseCodingWorkbenchMcpAuthorizationStart({ outcome: "refused", reason })).toEqual({
      outcome: "refused",
      reason,
    });
  }
  for (const state of ["pending", "complete", "failed", "expired", "cancelled", "unavailable"]) {
    expect(parseCodingWorkbenchMcpAuthorizationStatus({ state })).toEqual({ state });
  }
});

it("refuses foreign and nonstring MCP catalog values without coercion", (): void => {
  let coercions = 0;
  const hostile = {
    [Symbol.toPrimitive](): string {
      coercions += 1;
      return "connected";
    },
  };
  for (const value of ["foreign", "", undefined, null, 1, hostile]) {
    expect(
      parseCodingWorkbenchRuntimeMcpChannelPayload({
        session: "active",
        servers: [{ name: "docs", status: value, authorization: "none" }],
      }),
    ).toBeUndefined();
    expect(
      parseCodingWorkbenchMcpAuthorizationStart({ outcome: "refused", reason: value }),
    ).toBeUndefined();
    expect(parseCodingWorkbenchMcpAuthorizationStatus({ state: value })).toBeUndefined();
  }
  expect(coercions).toBe(0);
});

it("retains MCP channel iteration over inherited members and refuses a missing member", (): void => {
  const server = { name: "docs", status: "connected", authorization: "none" };
  const inherited = new Array<unknown>(1);
  Object.setPrototypeOf(inherited, Object.assign([], { 0: server }));
  expect(
    parseCodingWorkbenchRuntimeMcpChannelPayload({ session: "active", servers: inherited }),
  ).toEqual({ session: "active", servers: [server] });
  expect(
    parseCodingWorkbenchRuntimeMcpChannelPayload({
      session: "active",
      servers: new Array<unknown>(1),
    }),
  ).toBeUndefined();
  expect(
    parseCodingWorkbenchRuntimeMcpChannelPayload({ session: "active", servers: [server, server] }),
  ).toBeUndefined();
});

it("closes command capture at the first overflow without requesting a later value", (): void => {
  const failure: TypeError = Object.freeze(
    new TypeError("unexpected thirty-fourth command observation"),
  );
  let yielded = 0;
  let closed = 0;
  const command = ["/bin/x"];
  Object.defineProperty(command, Symbol.iterator, {
    value: function* (): Generator<string, void, unknown> {
      try {
        for (let index = 0; index < 33; index += 1) {
          yielded += 1;
          yield index === 0 ? "/bin/x" : "--stdio";
        }
        throw failure;
      } finally {
        closed += 1;
      }
    },
  });
  let caught: unknown;
  let result: ReturnType<typeof parseMcpServerRegistry> | undefined;
  try {
    result = parseMcpServerRegistry(registryWithCommand(command));
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeUndefined();
  expect(result).toEqual({ ok: false, reason: "server-invalid" });
  expect(yielded).toBe(33);
  expect(closed).toBe(1);
});

it("admits the full thirty-two-member command iterator boundary", (): void => {
  const materialized = ["/bin/x", ...Array.from({ length: 31 }, () => "--stdio")];
  const command = ["/bin/x"];
  Object.defineProperty(command, Symbol.iterator, {
    value: (): ArrayIterator<string> => materialized[Symbol.iterator](),
  });
  expectAdmittedCommand(command, materialized);
});

it("preserves a command iterator failure after an in-budget yielded member", (): void => {
  const failure: TypeError = Object.freeze(new TypeError("in-budget command iterator failed"));
  let yielded = 0;
  const command = ["/bin/x"];
  Object.defineProperty(command, Symbol.iterator, {
    value: function* (): Generator<string, void, unknown> {
      yielded += 1;
      yield "/bin/x";
      throw failure;
    },
  });
  let caught: unknown;
  try {
    parseMcpServerRegistry(registryWithCommand(command));
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(failure);
  expect(yielded).toBe(1);
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

function settingsEnvironmentInput(environmentFiles: unknown): unknown {
  return {
    expectedRevision: "a".repeat(64),
    servers: [LOCAL, REMOTE],
    secrets: {},
    environmentFiles,
  };
}

describe("MCP Settings environment file admission", () => {
  it("retains the original environment file object and its getter observations", () => {
    const reads: string[] = [];
    const receivers: unknown[] = [];
    const files = {
      get docs(): string {
        reads.push("docs");
        receivers.push(this);
        return "DOCS_INDEX=/srv/docs";
      },
    };
    const parsed = parseMcpSettingsUpdate(settingsEnvironmentInput(files));
    expect(parsed?.environmentFiles).toBe(files);
    expect(reads).toEqual(["docs"]);
    expect(receivers).toHaveLength(1);
    expect(receivers[0]).toBe(files);
    expect(parsed?.environmentFiles?.docs).toBe("DOCS_INDEX=/srv/docs");
    expect(reads).toEqual(["docs", "docs"]);
    expect(receivers).toHaveLength(2);
    expect(receivers[1]).toBe(files);
  });

  it("preserves native proxy observation order without copying admitted values", () => {
    const observations: string[] = [];
    const receivers: unknown[] = [];
    const files = new Proxy(
      { docs: "DOCS_INDEX=/srv/docs" },
      {
        ownKeys(target): (string | symbol)[] {
          observations.push("keys");
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, property): PropertyDescriptor | undefined {
          observations.push("descriptor");
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
        get(target, property, receiver): unknown {
          observations.push("value");
          receivers.push(receiver);
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const parsed = parseMcpSettingsUpdate(settingsEnvironmentInput(files));
    expect(parsed?.environmentFiles).toBe(files);
    expect(observations).toEqual(["keys", "descriptor", "value", "keys", "descriptor"]);
    expect(receivers).toHaveLength(1);
    expect(receivers[0]).toBe(files);
  });

  it.each(["keys", "descriptor", "value"])(
    "preserves the exact environment file proxy failure at %s",
    (phase): void => {
      const failure: TypeError = Object.freeze(
        new TypeError("environment file observation failed"),
      );
      const files = new Proxy(
        { docs: "DOCS_INDEX=/srv/docs" },
        {
          ownKeys(target): (string | symbol)[] {
            if (phase === "keys") throw failure;
            return Reflect.ownKeys(target);
          },
          getOwnPropertyDescriptor(target, property): PropertyDescriptor | undefined {
            if (phase === "descriptor") throw failure;
            return Reflect.getOwnPropertyDescriptor(target, property);
          },
          get(target, property, receiver): unknown {
            if (phase === "value") throw failure;
            return Reflect.get(target, property, receiver);
          },
        },
      );
      let caught: unknown;
      try {
        parseMcpSettingsUpdate(settingsEnvironmentInput(files));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
    },
  );

  it.each([
    ["a nonstring value", { docs: 42 }],
    ["an oversized value", { docs: "x".repeat(64 * 1024 + 1) }],
    ["a NUL value", { docs: "DOCS_INDEX=\0" }],
    ["a remote server", { tracker: "DOCS_INDEX=/srv/docs" }],
    ["an unknown server", { missing: "DOCS_INDEX=/srv/docs" }],
    ["an array", []],
    ["null", null],
  ])("refuses environment files with %s", (_name, files): void => {
    expect(parseMcpSettingsUpdate(settingsEnvironmentInput(files))).toBeUndefined();
  });

  it("omits absent and empty environment files from the admitted update", () => {
    const absent = parseMcpSettingsUpdate({
      expectedRevision: "a".repeat(64),
      servers: [LOCAL],
      secrets: {},
    });
    const empty = parseMcpSettingsUpdate(settingsEnvironmentInput({}));
    expect(absent).toBeDefined();
    expect(empty).toBeDefined();
    expect(absent).not.toHaveProperty("environmentFiles");
    expect(empty).not.toHaveProperty("environmentFiles");
  });
});
