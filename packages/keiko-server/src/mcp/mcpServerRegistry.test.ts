import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { loadMcpServerRegistry, MCP_SERVER_REGISTRY_FILE } from "./mcpServerRegistry.js";

const RUN_ID = "run-mcp-registry";
const SECRET_PATH = "/opt/secret-tools/bin/docs-mcp";
const REGISTRY = {
  schemaVersion: 1,
  servers: [
    {
      name: "docs",
      transport: { kind: "local", command: [SECRET_PATH], environment: { INDEX: "/srv" } },
      tools: { search: "read", update: "write" },
    },
    {
      name: "tracker",
      enabled: false,
      transport: { kind: "remote", url: "https://tracker.example.test/mcp" },
      tools: { find: "read" },
    },
  ],
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-mcp-registry-"));
  roots.push(root);
  return root;
}

function load(dir: string): { readonly servers: number; readonly line: Record<string, unknown> } {
  const records: ServerLogEvent[] = [];
  const activityLog: ServerLogSink = { write: (event) => void records.push(event) };
  const result = loadMcpServerRegistry({ stateDir: dir, activityLog, correlationId: RUN_ID });
  expect(records).toHaveLength(1);
  const event = records[0];
  if (event === undefined) throw new Error("expected the registry line");
  const line = expectActivityLogProof(
    "mcp.registry.loaded.emitted-line",
    formatActivityLogProofLine(event),
  );
  expect(line.correlationId).toBe(RUN_ID);
  // Nothing of the operator's file reaches the log: no path, no name, no URL.
  for (const secret of [SECRET_PATH, "docs", "tracker.example.test", "/srv"])
    expect(JSON.stringify(line)).not.toContain(secret);
  return { servers: result.servers.length, line };
}

function writeRegistry(dir: string, content: string, mode = 0o600): string {
  const path = join(dir, MCP_SERVER_REGISTRY_FILE);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

describe("the operator's MCP server registry file (#3903)", () => {
  it("is an empty registry when the file does not exist", () => {
    expect(load(stateDir())).toMatchObject({
      servers: 0,
      line: { state: "absent", serverCount: 0, toolCount: 0 },
    });
  });

  it("loads an owner-private registry and records its counts and digest", () => {
    const dir = stateDir();
    writeRegistry(dir, JSON.stringify(REGISTRY));
    const { servers, line } = load(dir);
    expect(servers).toBe(2);
    expect(line).toMatchObject({
      state: "loaded",
      consumer: "coding-run",
      serverCount: 2,
      enabledServerCount: 1,
      remoteServerCount: 0,
      toolCount: 2,
    });
    expect(line.registrySha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    [
      "a group-writable file",
      (dir: string): string => writeRegistry(dir, JSON.stringify(REGISTRY), 0o620),
      "not-owner-private",
    ],
    [
      "a world-writable file",
      (dir: string): string => writeRegistry(dir, JSON.stringify(REGISTRY), 0o602),
      "not-owner-private",
    ],
    [
      "text that is not JSON",
      (dir: string): string => writeRegistry(dir, "{ not json"),
      "not-json",
    ],
    [
      "an invalid server",
      (dir: string): string =>
        writeRegistry(dir, JSON.stringify({ schemaVersion: 1, servers: [{ name: "x" }] })),
      "server-invalid",
    ],
    [
      "a file over 64 KiB",
      (dir: string): string => writeRegistry(dir, " ".repeat(64 * 1024 + 1)),
      "too-large",
    ],
  ] as const)("admits no server from %s", (_label, prepare, reason) => {
    const dir = stateDir();
    prepare(dir);
    expect(load(dir)).toMatchObject({ servers: 0, line: { state: "refused", reason } });
  });

  it("never follows a link to a registry elsewhere", () => {
    const dir = stateDir();
    const elsewhere = stateDir();
    const target = writeRegistry(elsewhere, JSON.stringify(REGISTRY));
    symlinkSync(target, join(dir, MCP_SERVER_REGISTRY_FILE));
    expect(load(dir)).toMatchObject({
      servers: 0,
      line: { state: "refused", reason: "not-regular-file" },
    });
  });
});
