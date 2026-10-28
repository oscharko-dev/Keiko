import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import {
  type McpServerDefinition,
  parseMcpServerRegistry,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createMcpSettingsStore } from "./mcpSettingsStore.js";

const roots: string[] = [];
afterEach(() => {
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
