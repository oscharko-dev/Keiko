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
    expect(statSync(registryPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(registryPath, "utf8")).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(f.events)).not.toContain(token);
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
