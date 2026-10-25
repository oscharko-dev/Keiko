import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import type {
  McpOAuthCredentialBinding,
  McpOAuthCredentialStore,
  StoredMcpOAuthCredential,
} from "../mcp/mcpOAuthCredentialStore.js";
import { OPENCODE_PERSISTENCE_SCHEMAS } from "./opencodePersistenceContract.js";
import {
  harvestMcpCredentials,
  seedMcpCredentials,
  type McpCredentialRun,
} from "./opencodeNativeMcpCredentials.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ISSUER = "https://login.example.test/tenant";
const URL_ = "https://issues.example.test/mcp";
const RUN: McpCredentialRun = {
  runId: "run-mcp-credentials",
  mcpOAuth: new Map([
    [
      "issues",
      {
        url: URL_,
        oauth: { issuer: ISSUER },
        metadataUrl: `${ISSUER}/.well-known/openid-configuration`,
        authorizationEndpoint: `${ISSUER}/authorize`,
      },
    ],
  ]),
};

function credential(issuer: string, serverUrl = URL_): Readonly<Record<string, unknown>> {
  return {
    type: "oauth",
    methodID: "mcp_52c0335c7b3cc683",
    access: "access-token-canary",
    refresh: "refresh-token-canary",
    expires: 1,
    metadata: { serverUrl, tokenType: "Bearer", issuer, client: { client_id: "dyn-client" } },
  };
}

// The credential table exactly as the pinned 2.1.4 schema has it.
function database(rows: readonly Readonly<Record<string, unknown>>[]): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-mcp-credentials-"));
  roots.push(root);
  const path = join(root, "opencode.db");
  const handle = new DatabaseSync(path);
  const columns = OPENCODE_PERSISTENCE_SCHEMAS["2.1.4"]?.credential ?? [];
  handle.exec(`CREATE TABLE credential (${columns.map((column) => `"${column}"`).join(", ")})`);
  const insert = handle.prepare(
    "INSERT INTO credential (id, integration_id, label, value, active) VALUES (?, ?, ?, ?, 1)",
  );
  rows.forEach((value, index) => {
    insert.run(`cred_${String(index)}`, "mcp_52c0335c7b3cc683", "issues", JSON.stringify(value));
  });
  handle.close();
  return path;
}

function rowCount(path: string): number {
  const handle = new DatabaseSync(path, { readOnly: true });
  const row = handle.prepare("SELECT COUNT(*) AS n FROM credential").get() as { n: number };
  handle.close();
  return row.n;
}

function memoryStore(): McpOAuthCredentialStore & {
  readonly saved: Map<string, StoredMcpOAuthCredential>;
} {
  const saved = new Map<string, StoredMcpOAuthCredential>();
  const key = (binding: McpOAuthCredentialBinding): string => binding.server;
  return {
    saved,
    load: (binding) => saved.get(key(binding)),
    save: (binding, value) => void saved.set(key(binding), value),
  };
}

function sink(): { readonly sink: ServerLogSink; readonly records: ServerLogEvent[] } {
  const records: ServerLogEvent[] = [];
  return { sink: { write: (event) => void records.push(event) }, records };
}

function lines(records: readonly ServerLogEvent[]): readonly Readonly<Record<string, unknown>>[] {
  return records.map((record) =>
    expectActivityLogProof(
      "coding-runtime.mcp-credentials.emitted-line",
      formatActivityLogProofLine(record),
    ),
  );
}

describe("an admitted MCP server's credential across runs (#3903 AC3)", () => {
  it("keeps the credential issued for the server by its expected issuer, and only that one", () => {
    const path = database([credential(ISSUER), credential("https://evil.example.test")]);
    const store = memoryStore();
    const { sink: activityLog, records } = sink();
    harvestMcpCredentials(RUN, path, store, activityLog, false);
    expect(store.saved.get("issues")?.value).toEqual(credential(ISSUER));
    expect(rowCount(path)).toBe(2);
    expect(lines(records)).toEqual([
      expect.objectContaining({ action: "harvested", outcome: "ok", count: 1, droppedCount: 1 }),
    ]);
    expect(JSON.stringify(records)).not.toContain("token-canary");
  });

  it("removes every credential from a reaped runtime's database before it is retained", () => {
    const path = database([credential(ISSUER), credential(ISSUER, "https://other.test/mcp")]);
    const store = memoryStore();
    const { sink: activityLog, records } = sink();
    harvestMcpCredentials(RUN, path, store, activityLog, true);
    expect(rowCount(path)).toBe(0);
    expect(store.saved.size).toBe(1);
    expect(lines(records)).toEqual([
      expect.objectContaining({ action: "scrubbed", count: 1, droppedCount: 1 }),
    ]);
  });

  it("scrubs even without a store and records a failure without throwing", () => {
    const path = database([credential(ISSUER)]);
    harvestMcpCredentials(RUN, path, undefined, undefined, true);
    expect(rowCount(path)).toBe(0);
    const { sink: activityLog, records } = sink();
    const broken = join(roots[0] ?? tmpdir(), "not-a-database.db");
    rmSync(broken, { force: true });
    harvestMcpCredentials(
      RUN,
      path.replace("opencode.db", "absent.db"),
      undefined,
      activityLog,
      true,
    );
    expect(records).toEqual([]);
  });

  it("seeds a kept credential into the run's runtime under the server's name", async () => {
    const store = memoryStore();
    store.saved.set("issues", { integrationId: "mcp_52c0335c7b3cc683", value: credential(ISSUER) });
    const client = { createMcpCredential: vi.fn(() => Promise.resolve()) };
    const { sink: activityLog, records } = sink();
    await seedMcpCredentials(RUN, client, store, activityLog);
    expect(client.createMcpCredential).toHaveBeenCalledWith({
      integrationId: "mcp_52c0335c7b3cc683",
      label: "issues",
      value: credential(ISSUER),
    });
    expect(lines(records)).toEqual([expect.objectContaining({ action: "seeded", count: 1 })]);
  });

  it("records a failed seed with its frames and never rejects", async () => {
    const store = memoryStore();
    store.saved.set("issues", { integrationId: "mcp_52c0335c7b3cc683", value: credential(ISSUER) });
    const client = {
      createMcpCredential: vi.fn(() => Promise.reject(new Error("opencode-v2-status-500"))),
    };
    const { sink: activityLog, records } = sink();
    await expect(seedMcpCredentials(RUN, client, store, activityLog)).resolves.toBeUndefined();
    const [line] = lines(records);
    expect(line).toMatchObject({ action: "seeded", outcome: "failed", count: 0 });
    expect(line?.frames).toEqual(expect.any(Array));
    expect(records[0]?.level).toBe("warn");
  });
});
