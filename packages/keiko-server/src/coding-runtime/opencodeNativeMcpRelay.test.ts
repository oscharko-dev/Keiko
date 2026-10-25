import { describe, expect, it } from "vitest";
import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

import { createMcpCredentialRelay } from "../mcp/mcpCredentialRelay.js";
import { bindNativeMcpRelays } from "./opencodeNativeMcpRelay.js";

const SECRET = "wiki-secret-canary";
const ORIGIN = "http://127.0.0.1:1983";

function credentialed(name: string, secretEnv: string): McpServerDefinition {
  return {
    name,
    description: undefined,
    enabled: true,
    transport: {
      kind: "remote",
      url: `https://${name}.example.test/mcp`,
      headers: { Authorization: { secretEnv, prefix: "Bearer " } },
    },
    tools: { find: "read" },
  };
}

function sink(): { readonly sink: ServerLogSink; readonly records: ServerLogEvent[] } {
  const records: ServerLogEvent[] = [];
  return { sink: { write: (event) => void records.push(event) }, records };
}

function lines(records: readonly ServerLogEvent[]): readonly Readonly<Record<string, unknown>>[] {
  return records.map((record) =>
    expectActivityLogProof(
      "coding-runtime.mcp-relay.emitted-line",
      formatActivityLogProofLine(record),
    ),
  );
}

describe("a native run's MCP relay bindings (#3903 AC3)", () => {
  it("binds each credentialed server whose secret Keiko holds and leaves the others out", () => {
    const relay = createMcpCredentialRelay();
    const { sink: activityLog, records } = sink();
    const endpoints = bindNativeMcpRelays({
      servers: [
        credentialed("wiki", "KEIKO_MCP_SECRET_WIKI"),
        credentialed("crm", "KEIKO_MCP_SECRET_CRM"),
      ],
      mode: "autonomous-delivery",
      runId: "run-relay",
      relay: { relay, origin: ORIGIN, secrets: { KEIKO_MCP_SECRET_WIKI: SECRET } },
      activityLog,
    });
    expect([...endpoints.keys()]).toEqual(["wiki"]);
    const endpoint = endpoints.get("wiki");
    expect(endpoint?.url).toMatch(
      /^http:\/\/127\.0\.0\.1:1983\/api\/coding-sidecar\/mcp\/[\w-]{22}$/u,
    );
    const relayId = endpoint?.url.split("/").at(-1) ?? "";
    expect(relay.authenticate(relayId, endpoint?.capability)?.target).toEqual({
      runId: "run-relay",
      url: "https://wiki.example.test/mcp",
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(lines(records)).toEqual([
      expect.objectContaining({
        action: "bind",
        outcome: "bound",
        relayedServerCount: 1,
        refusedServerCount: 1,
        reason: "secret-unavailable",
        correlationId: "run-relay",
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain(SECRET);
  });

  it("binds nothing below Full access, and refuses every server without a relay", () => {
    const servers = [credentialed("wiki", "KEIKO_MCP_SECRET_WIKI")];
    const { sink: activityLog, records } = sink();
    expect(
      bindNativeMcpRelays({
        servers,
        mode: "supervised-coding",
        runId: "run-relay",
        relay: undefined,
        activityLog,
      }).size,
    ).toBe(0);
    expect(records).toEqual([]);
    expect(
      bindNativeMcpRelays({
        servers,
        mode: "autonomous-delivery",
        runId: "run-relay",
        relay: undefined,
        activityLog,
      }).size,
    ).toBe(0);
    expect(lines(records)).toEqual([
      expect.objectContaining({
        outcome: "refused",
        reason: "relay-unavailable",
        refusedServerCount: 1,
      }),
    ]);
  });
});
