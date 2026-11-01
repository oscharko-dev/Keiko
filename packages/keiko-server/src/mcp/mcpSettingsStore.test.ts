import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  type McpServerDefinition,
  parseMcpServerRegistry,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createMcpServerSecretStore } from "./mcpOAuthCredentialStore.js";
import { makeOwnerPrivateDirectory } from "../ownerPrivateFixture.test-support.js";
import * as privateJson from "../private-json.js";
import { createMcpSettingsStore } from "./mcpSettingsStore.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const reference = "KEIKO_MCP_SECRET_FIXTURE";
const token = "synthetic-private-token-which-must-remain-sealed";
function fixture(): {
  input: Parameters<typeof createMcpSettingsStore>[0];
  events: ServerLogEvent[];
  server: McpServerDefinition;
  store: ReturnType<typeof createMcpSettingsStore>;
} {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-mcp-settings-")));
  roots.push(stateDir);
  makeOwnerPrivateDirectory(stateDir);
  const events: ServerLogEvent[] = [];
  const input = {
    stateDir,
    env: { KEIKO_MCP_OAUTH_CREDENTIALS_KEY: randomBytes(32).toString("base64") },
    keychainAccess: (): undefined => undefined,
    activityLog: {
      write: (event: ServerLogEvent): void => {
        events.push(event);
      },
    },
  };
  const parsed = parseMcpServerRegistry({
    schemaVersion: 1,
    servers: [
      {
        name: "notes-api",
        discovery: "automatic",
        transport: {
          kind: "remote",
          url: "https://fixture.example.test/mcp",
          headers: { Authorization: { secretEnv: reference, prefix: "Bearer " } },
        },
        tools: {},
      },
    ],
  });
  if (!parsed.ok || parsed.servers[0] === undefined) throw new Error("fixture registry invalid");
  return { input, events, server: parsed.servers[0], store: createMcpSettingsStore(input) };
}

function readInNewProcess(input: Parameters<typeof createMcpSettingsStore>[0]): unknown {
  const program = `
    import { readFileSync } from "node:fs";
    const input = JSON.parse(readFileSync(0, "utf8"));
    const { createMcpSettingsStore } = await import(input.moduleUrl);
    const store = createMcpSettingsStore({ stateDir: input.stateDir, env: input.env, keychainAccess: () => undefined });
    process.stdout.write(JSON.stringify(store.read("settings-restart")));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    input: JSON.stringify({
      stateDir: input.stateDir,
      env: input.env,
      moduleUrl: new URL("../../dist/mcp/mcpSettingsStore.js", import.meta.url).href,
    }),
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

describe("shared MCP settings custody", () => {
  it("never persists or returns a bearer credential embedded in a resource URL", () => {
    const f = fixture();
    const result = f.store.update(
      {
        expectedRevision: f.store.read("url-credential").revision,
        servers: [
          {
            ...f.server,
            transport: {
              kind: "remote",
              url: `https://fixture.example.test/mcp?access_token=${token}`,
            },
          },
        ],
        secrets: {},
      },
      "url-credential",
    );
    expect(JSON.stringify(result)).not.toContain(token);
    expect(readFileSync(join(f.input.stateDir, "mcp-servers.json"), "utf8")).not.toContain(token);
    const server = result.snapshot.servers[0];
    expect(server?.transport.kind).toBe("remote");
    if (server?.transport.kind !== "remote") throw new Error("expected remote migration");
    const header = server.transport.headers?.Authorization;
    expect(header?.prefix).toBe("Bearer ");
    expect(
      header === undefined
        ? undefined
        : createMcpSettingsStore(f.input).secret(header.secretEnv, server),
    ).toBe(token);
    expect(JSON.stringify(f.events)).not.toContain(token);
  });
  it("migrates a legacy bearer URL before returning its first public snapshot", () => {
    const f = fixture();
    writeFileSync(
      join(f.input.stateDir, "mcp-servers.json"),
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            ...f.server,
            transport: {
              kind: "remote",
              protocol: "sse",
              network: "private",
              url: `https://fixture.example.test/sse?region=eu&access_token=${token}`,
            },
          },
        ],
      }),
      { mode: 0o600 },
    );
    // The registry reader deliberately refuses public files, including legacy fixtures.
    const state = f.store.read("legacy-url");
    expect(JSON.stringify(state)).not.toContain(token);
    expect(readFileSync(join(f.input.stateDir, "mcp-servers.json"), "utf8")).not.toContain(token);
    expect(state.servers[0]?.transport).toMatchObject({
      url: "https://fixture.example.test/sse?region=eu",
      protocol: "sse",
      network: "private",
    });
    expect(f.store.read("legacy-url")).toEqual(state);
  });
  it.each(["duplicate", "empty", "conflicting-header"])(
    "refuses %s URI credentials before custody or registry effects",
    (failure) => {
      const f = fixture();
      const current = f.store.read("bad-url");
      const query =
        failure === "duplicate"
          ? `access_token=${token}&access_token=other`
          : failure === "empty"
            ? "access_token="
            : `access_token=${token}`;
      expect(() =>
        f.store.update(
          {
            expectedRevision: current.revision,
            secrets: {},
            servers: [
              {
                ...f.server,
                transport: {
                  kind: "remote",
                  url: `https://fixture.example.test/mcp?${query}`,
                  ...(failure === "conflicting-header"
                    ? { headers: { authorization: { secretEnv: reference } } }
                    : {}),
                },
              },
            ],
          },
          "bad-url",
        ),
      ).toThrow(/ambiguous/iu);
      expect(f.store.read("bad-url")).toEqual(current);
    },
  );
  it("removes stale URL bearer data from OAuth entries without adding static authorization", () => {
    const f = fixture();
    const result = f.store.update(
      {
        expectedRevision: f.store.read("oauth-url").revision,
        secrets: {},
        servers: [
          {
            ...f.server,
            transport: {
              kind: "remote",
              url: `https://fixture.example.test/mcp?access_token=${token}`,
              oauth: { issuer: "https://identity.example.test", clientId: "public-client" },
            },
          },
        ],
      },
      "oauth-url",
    );
    expect(result.snapshot.servers[0]?.transport).toMatchObject({
      url: "https://fixture.example.test/mcp",
      oauth: { issuer: "https://identity.example.test" },
    });
    expect(result.snapshot.servers[0]?.transport).not.toHaveProperty("headers");
    expect(JSON.stringify(result)).not.toContain(token);
  });
  it("persists one private registry and recovers sealed credentials after restart", () => {
    const f = fixture();
    const before = f.store.read("settings-test");
    const result = f.store.update(
      {
        expectedRevision: before.revision,
        servers: [f.server],
        secrets: { [reference]: { server: f.server.name, value: token } },
      },
      "settings-test",
    );
    expect(result.ok).toBe(true);
    const reopened = createMcpSettingsStore(f.input);
    expect(reopened.read("settings-test")).toEqual(result.snapshot);
    expect(reopened.secret(reference, f.server)).toBe(token);
    const registryPath = join(f.input.stateDir, "mcp-servers.json");
    expect(readFileSync(registryPath, "utf8")).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(f.events)).not.toContain(token);
  });
  // A Windows host reports synthesized permission bits (0o666 for every writable file, whatever
  // `chmod` was asked), so the registry's owner-private mode is asserted where POSIX modes exist
  // (#4068).
  it.skipIf(process.platform === "win32")("persists the registry owner-private", () => {
    const f = fixture();
    const result = f.store.update(
      {
        expectedRevision: f.store.read("settings-test").revision,
        servers: [f.server],
        secrets: { [reference]: { server: f.server.name, value: token } },
      },
      "settings-test",
    );
    expect(result.ok).toBe(true);
    expect(statSync(join(f.input.stateDir, "mcp-servers.json")).mode & 0o777).toBe(0o600);
  });
  it("rejects a stale writer before persisting its credentials", () => {
    const f = fixture();
    const stale = f.store.read("settings-test");
    f.store.update(
      { expectedRevision: stale.revision, servers: [f.server], secrets: {} },
      "settings-test",
    );
    const second = createMcpSettingsStore(f.input);
    expect(
      second.update({ expectedRevision: stale.revision, servers: [], secrets: {} }, "settings-test")
        .ok,
    ).toBe(false);
    expect(second.read("settings-test").servers).toHaveLength(1);
  });
  it("never reuses a credential for an edited remote target or a different server", () => {
    const f = fixture();
    f.store.update(
      {
        expectedRevision: f.store.read("settings-test").revision,
        servers: [f.server],
        secrets: { [reference]: { server: f.server.name, value: token } },
      },
      "settings-test",
    );
    expect(f.store.secret(reference, { ...f.server, name: "other" })).toBeUndefined();
    expect(
      f.store.secret(reference, {
        ...f.server,
        transport: { kind: "remote", url: "https://other.example.test/mcp" },
      }),
    ).toBeUndefined();
  });
  it("refuses silent replacement of an existing secret reference", () => {
    const f = fixture();
    const saved = f.store.update(
      {
        expectedRevision: f.store.read("settings-test").revision,
        servers: [f.server],
        secrets: { [reference]: { server: f.server.name, value: token } },
      },
      "settings-test",
    );
    expect(() =>
      f.store.update(
        {
          expectedRevision: saved.snapshot.revision,
          servers: [f.server],
          secrets: { [reference]: { server: f.server.name, value: "changed" } },
        },
        "settings-test",
      ),
    ).toThrow();
    expect(f.store.secret(reference, f.server)).toBe(token);
  });
  it("does not replace corrupt operator state with an empty registry", () => {
    const f = fixture();
    writeFileSync(join(f.input.stateDir, "mcp-servers.json"), "broken", { mode: 0o600 });
    expect(() => f.store.read("settings-test")).toThrow("unavailable");
    expect(readFileSync(join(f.input.stateDir, "mcp-servers.json"), "utf8")).toBe("broken");
  });
  it("removes deleted credentials and refuses disabled or superseded bindings", () => {
    const f = fixture();
    const saved = f.store.update(
      {
        expectedRevision: f.store.read("settings-test").revision,
        servers: [f.server],
        secrets: { [reference]: { server: f.server.name, value: token } },
      },
      "settings-test",
    );
    const disabled = f.store.update(
      {
        expectedRevision: saved.snapshot.revision,
        servers: [{ ...f.server, enabled: false }],
        secrets: {},
      },
      "settings-test",
    );
    expect(f.store.secret(reference, f.server)).toBeUndefined();
    f.store.update(
      { expectedRevision: disabled.snapshot.revision, servers: [], secrets: {} },
      "settings-test",
    );
    expect(f.store.secret(reference, f.server)).toBeUndefined();
    expect(createMcpServerSecretStore(f.input).get(reference, f.server)).toBeUndefined();
  });
  it("recovery: credential-free updates do not require a vault key", () => {
    const f = fixture();
    const store = createMcpSettingsStore({
      ...f.input,
      env: { KEIKO_MCP_OAUTH_CREDENTIALS_KEY: "invalid" },
    });
    expect(
      store.update(
        { expectedRevision: store.read("settings-test").revision, servers: [], secrets: {} },
        "settings-test",
      ).ok,
    ).toBe(true);
  });
  it("recovery: retries the same mutation after sealing succeeds but registry persistence fails", () => {
    const f = fixture();
    const update = {
      expectedRevision: f.store.read("settings-test").revision,
      servers: [f.server],
      secrets: { [reference]: { server: f.server.name, value: token } },
    };
    vi.spyOn(privateJson, "savePrivateJson").mockImplementationOnce((): never => {
      throw new Error("synthetic-write-failure");
    });
    expect(() => f.store.update(update, "settings-test")).toThrow("synthetic-write-failure");
    expect(createMcpServerSecretStore(f.input).get(reference, f.server)).toBe(token);
    expect(createMcpSettingsStore(f.input).update(update, "settings-test").ok).toBe(true);
    expect(f.store.secret(reference, f.server)).toBe(token);
  });
  it("recovery: reports committed deletion while cleanup is unavailable and reconciles after restart", () => {
    const f = fixture();
    const saved = f.store.update(
      {
        expectedRevision: f.store.read("settings-test").revision,
        servers: [f.server],
        secrets: { [reference]: { server: f.server.name, value: token } },
      },
      "settings-test",
    );
    const unavailable = createMcpSettingsStore({
      ...f.input,
      env: { KEIKO_MCP_OAUTH_CREDENTIALS_KEY: "invalid" },
    });
    const result = unavailable.update(
      { expectedRevision: saved.snapshot.revision, servers: [], secrets: {} },
      "settings-test",
    );
    expect(result).toMatchObject({
      ok: true,
      snapshot: { servers: [], credentialCleanup: "pending" },
    });
    expect(unavailable.read("settings-test").revision).toBe(result.snapshot.revision);
    expect(unavailable.secret(reference, f.server)).toBeUndefined();
    expect(readInNewProcess(f.input)).toEqual({
      revision: result.snapshot.revision,
      servers: [],
    });
    expect(createMcpServerSecretStore(f.input).get(reference, f.server)).toBeUndefined();
  });
  it("mcp.settings.updated.emitted-line records counts and a digest without configuration content", () => {
    const f = fixture();
    f.store.update(
      {
        expectedRevision: f.store.read("settings-test").revision,
        servers: [f.server],
        secrets: {},
      },
      "settings-test",
    );
    const event = f.events.find((event) => event.op === "mcp.settings.updated");
    if (event === undefined) throw new Error("missing settings event");
    const line = expectActivityLogProof(
      "mcp.settings.updated.emitted-line",
      formatActivityLogProofLine(event),
    );
    expect(line).toMatchObject({ serverCount: 1, secretCount: 0, outcome: "applied" });
    for (const privateValue of [f.server.name, "fixture.example.test", reference, token])
      expect(JSON.stringify(line)).not.toContain(privateValue);
  });
});

it("revokes whole-catalog authority on additions without revoking unchanged server connections", () => {
  const f = fixture();
  const initial = f.store.read("revision-proof");
  const initialSignal = f.store.revisionSignal(initial.revision, "revision-proof");
  const saved = f.store.update(
    {
      expectedRevision: initial.revision,
      servers: [f.server],
      secrets: { [reference]: { server: f.server.name, value: token } },
    },
    "revision-proof",
  );
  expect(initialSignal.aborted).toBe(true);
  const signal = f.store.revisionSignal(saved.snapshot.revision, "revision-proof");
  const savedServer = saved.snapshot.servers[0];
  if (savedServer === undefined) throw new Error("Expected saved server");
  const serverSignal = f.store.generation(savedServer, "revision-proof");
  f.store.update(
    { expectedRevision: saved.snapshot.revision, servers: saved.snapshot.servers, secrets: {} },
    "revision-proof",
  );
  expect(signal.aborted).toBe(false);
  f.store.update(
    {
      expectedRevision: saved.snapshot.revision,
      servers: [
        ...saved.snapshot.servers,
        {
          name: "added",
          discovery: "automatic",
          description: "Synthetic additional server",
          enabled: true,
          transport: { kind: "local", command: ["/synthetic/mcp"], environment: {} },
          tools: {},
        },
      ],
      secrets: {},
    },
    "revision-proof",
  );
  expect(signal.aborted).toBe(true);
  expect(serverSignal.aborted).toBe(false);
  expect(f.store.revisionSignal(saved.snapshot.revision, "revision-proof").aborted).toBe(true);
});

it("never restores old authority after delete/recreate of identical definitions across restart", () => {
  const f = fixture();
  const first = f.store.update(
    {
      expectedRevision: f.store.read("settings-test").revision,
      servers: [f.server],
      secrets: { [reference]: { server: f.server.name, value: token } },
    },
    "settings-test",
  );
  const deleted = f.store.update(
    { expectedRevision: first.snapshot.revision, servers: [], secrets: {} },
    "settings-test",
  );
  const reopened = createMcpSettingsStore(f.input);
  expect(reopened.read("settings-test").revision).toBe(deleted.snapshot.revision);
  const restored = reopened.update(
    {
      expectedRevision: deleted.snapshot.revision,
      servers: [f.server],
      secrets: { [reference]: { server: f.server.name, value: token } },
    },
    "settings-test",
  );
  expect(restored.ok).toBe(true);
  expect(restored.snapshot.servers).toEqual(first.snapshot.servers);
  expect(restored.snapshot.revision).not.toBe(first.snapshot.revision);
  expect(createMcpSettingsStore(f.input).read("settings-test")).toEqual(restored.snapshot);
});

it("retains the committed generation after interruption immediately following registry publication", () => {
  const f = fixture();
  const first = f.store.update(
    {
      expectedRevision: f.store.read("settings-test").revision,
      servers: [f.server],
      secrets: { [reference]: { server: f.server.name, value: token } },
    },
    "settings-test",
  );
  const original = privateJson.savePrivateJson;
  const interrupted = vi
    .spyOn(privateJson, "savePrivateJson")
    .mockImplementationOnce((path, value) => {
      original(path, value);
      throw new Error("Synthetic process interruption after atomic publication");
    });
  expect(() =>
    f.store.update(
      { expectedRevision: first.snapshot.revision, servers: [], secrets: {} },
      "settings-test",
    ),
  ).toThrow("Synthetic process interruption");
  interrupted.mockRestore();
  const reopened = createMcpSettingsStore(f.input);
  const committed = reopened.read("settings-test");
  expect(committed.servers).toEqual([]);
  const restored = reopened.update(
    {
      expectedRevision: committed.revision,
      servers: [f.server],
      secrets: { [reference]: { server: f.server.name, value: token } },
    },
    "settings-test",
  );
  expect(restored.ok).toBe(true);
  expect(restored.snapshot.revision).not.toBe(first.snapshot.revision);
});

it("requires a new reference before introducing a credential into an already active definition", () => {
  const f = fixture();
  const active = f.store.update(
    { expectedRevision: f.store.read("settings-test").revision, servers: [f.server], secrets: {} },
    "settings-test",
  );
  expect(() =>
    f.store.update(
      {
        expectedRevision: active.snapshot.revision,
        servers: [f.server],
        secrets: { [reference]: { server: f.server.name, value: token } },
      },
      "settings-test",
    ),
  ).toThrow("new reference");
  expect(f.store.secret(reference, f.server)).toBeUndefined();
  expect(f.store.read("settings-test").revision).toBe(active.snapshot.revision);
});

describe("legacy environment credential authority across restarts", () => {
  function environmentFixture(): ReturnType<typeof fixture> {
    const f = fixture();
    const input = { ...f.input, env: { ...f.input.env, [reference]: token } };
    return { ...f, input, store: createMcpSettingsStore(input) };
  }

  function configure(
    f: ReturnType<typeof fixture>,
    server = f.server,
  ): ReturnType<typeof f.store.read> {
    return f.store.update(
      {
        expectedRevision: f.store.read("env-startup").revision,
        servers: [server],
        secrets: {},
      },
      "env-startup",
    ).snapshot;
  }

  it("identifies environment fallback from reference metadata without decrypting sealed values", () => {
    const f = environmentFixture();
    const credentials = createMcpServerSecretStore(f.input);
    expect(credentials.usesEnvironment([])).toBe(false);
    expect(credentials.usesEnvironment(["KEIKO_UNUSED_SYNTHETIC"])).toBe(false);
    expect(credentials.usesEnvironment([reference])).toBe(true);
    credentials.put([{ reference, server: f.server, value: token }]);
    const metadataOnly = createMcpServerSecretStore({
      ...f.input,
      env: { ...f.input.env, KEIKO_MCP_OAUTH_CREDENTIALS_KEY: randomBytes(32).toString("base64") },
    });
    expect(metadataOnly.usesEnvironment([reference])).toBe(false);
    expect(() => metadataOnly.get(reference, f.server)).toThrow();
  });

  it("keeps one process scope through no-op saves and rejects a prior process revision", () => {
    const f = environmentFixture();
    const initial = configure(f);
    expect(f.store.read("env-noop")).toEqual(initial);
    expect(configure(f)).toEqual(initial);
    const next = createMcpSettingsStore(f.input);
    expect(next.read("env-restart").servers).toEqual(initial.servers);
    expect(
      next.update(
        { expectedRevision: initial.revision, servers: initial.servers, secrets: {} },
        "env-stale",
      ).ok,
    ).toBe(false);
    const scoped = f.events.filter(
      (event) =>
        event.op === "mcp.settings.updated" && event.extra?.credentialContext === "process-scoped",
    );
    expect(scoped).toHaveLength(2);
    for (const event of scoped) {
      const line = expectActivityLogProof(
        "mcp.settings.updated.emitted-line",
        formatActivityLogProofLine(event),
      );
      expect(line).toMatchObject({
        outcome: "reconciled",
        credentialContext: "process-scoped",
        serverCount: 1,
        secretCount: 0,
      });
    }
    expect(JSON.stringify(f.events)).not.toContain(token);
    expect(JSON.stringify(f.events)).not.toContain(reference);
  });

  it("rotates across an actual Node process restart without rewriting configuration", () => {
    const f = environmentFixture();
    const initial = configure(f);
    const file = join(f.input.stateDir, "mcp-servers.json");
    const contents = readFileSync(file, "utf8");
    const restarted = readInNewProcess(f.input) as ReturnType<typeof f.store.read>;
    expect(restarted.servers).toEqual(JSON.parse(JSON.stringify(initial.servers)) as unknown);
    expect(restarted.revision).not.toBe(initial.revision);
    expect(readFileSync(file, "utf8")).toBe(contents);
    const next = readInNewProcess(f.input) as ReturnType<typeof f.store.read>;
    expect(next.revision).not.toBe(restarted.revision);
  });

  it("keeps unused and disabled environment references out of the authority context", () => {
    const f = environmentFixture();
    const empty = f.store.read("unused-env");
    expect(createMcpSettingsStore(f.input).read("unused-env")).toEqual(empty);
    const disabled = configure(f, { ...f.server, enabled: false });
    expect(createMcpSettingsStore(f.input).read("disabled-env")).toEqual(disabled);
    expect(f.events.some((event) => event.extra?.credentialContext === "process-scoped")).toBe(
      false,
    );
  });

  it("requires a fresh reference when moving a legacy credential into the vault", () => {
    const f = environmentFixture();
    const initial = configure(f);
    const oldScope = f.store.revisionSignal(initial.revision, "env-migration");
    expect(() =>
      f.store.update(
        {
          expectedRevision: initial.revision,
          servers: initial.servers,
          secrets: { [reference]: { server: f.server.name, value: token } },
        },
        "env-in-place",
      ),
    ).toThrow("new reference");
    const sealedReference = `${reference}_SEALED`;
    const server = {
      ...f.server,
      transport: {
        kind: "remote" as const,
        url: "https://fixture.example.test/mcp",
        headers: { Authorization: { secretEnv: sealedReference, prefix: "Bearer " } },
      },
    };
    const saved = f.store.update(
      {
        expectedRevision: initial.revision,
        servers: [server],
        secrets: { [sealedReference]: { server: server.name, value: token } },
      },
      "env-migration",
    );
    expect(saved.ok).toBe(true);
    expect(oldScope.aborted).toBe(true);
    expect(saved.snapshot.revision).not.toBe(initial.revision);
    expect(f.store.read("env-migration")).toEqual(saved.snapshot);
    expect(createMcpSettingsStore(f.input).read("env-migration")).toEqual(saved.snapshot);
    expect(f.store.secret(sealedReference, server)).toBe(token);
    expect(f.events.some((event) => event.extra?.credentialContext === "persistent")).toBe(true);
  });

  it("keeps Settings available but revokes the prior scope if vault metadata is unavailable", () => {
    const f = environmentFixture();
    const initial = f.store.update(
      {
        expectedRevision: f.store.read("vault-before").revision,
        servers: [f.server],
        secrets: { [reference]: { server: f.server.name, value: token } },
      },
      "vault-before",
    ).snapshot;
    const vault = join(f.input.stateDir, "credentials", "mcp-oauth-credentials.vault");
    writeFileSync(vault, "invalid synthetic vault metadata");
    const next = f.store.read("vault-unavailable");
    expect(next.credentialCleanup).toBe("pending");
    expect(next.servers).toEqual(initial.servers);
    expect(next.revision).not.toBe(initial.revision);
    expect(f.store.revisionSignal(initial.revision, "vault-unavailable").aborted).toBe(true);
    expect(() => f.store.secret(reference, f.server)).toThrow();
    expect(JSON.stringify(f.events)).not.toContain("invalid synthetic vault metadata");
  });
});
