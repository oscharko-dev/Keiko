import { describe, expect, it, vi } from "vitest";
import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

import { createMcpCredentialRelay } from "../mcp/mcpCredentialRelay.js";
import { openCodeNativeMcpAdmission } from "./opencodeNativeMcp.js";
import { bindNativeMcpRelays, recoverNativeMcpRun } from "./opencodeNativeMcpRelay.js";

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
      // The bare credential too, so a server that echoes it is answered without it (#3903 AC3).
      secrets: [SECRET],
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

it("routes local and token-backed servers through the shared manager and revokes stale bindings", async () => {
  const relay = createMcpCredentialRelay();
  const generation = new AbortController();
  const local: McpServerDefinition = {
    ...credentialed("local", "KEIKO_MCP_SECRET_LOCAL"),
    transport: {
      kind: "local",
      command: ["/synthetic/executable"],
      environment: {},
      secretEnvironment: { TOKEN: { secretEnv: "KEIKO_MCP_SECRET_LOCAL" } },
    },
  };
  const remote = credentialed("remote", "KEIKO_MCP_SECRET_REMOTE");
  const serve = vi.fn(() => Promise.resolve(new Response("managed")));
  const endpoints = bindNativeMcpRelays({
    servers: [local, remote],
    mode: "autonomous-delivery",
    runId: "shared-run",
    relay: {
      relay,
      origin: ORIGIN,
      secrets: {},
      managed: { generation: () => generation.signal, serve },
    },
    activityLog: undefined,
  });
  expect([...endpoints.keys()]).toEqual(["local", "remote"]);
  for (const mode of ["governed-assist", "supervised-coding"]) {
    const grants = openCodeNativeMcpAdmission({
      servers: [local, remote],
      mode,
      home: "/synthetic/home",
      relays: endpoints,
      managed: true,
    });
    expect(Object.keys(grants.config.servers)).toEqual(["local", "remote"]);
    expect(grants.grants.actions.get("local_find")).toMatchObject({ remote: true, managed: true });
  }
  const admission = openCodeNativeMcpAdmission({
    servers: [local, remote],
    mode: "autonomous-delivery",
    home: "/synthetic/home",
    relays: endpoints,
    managed: true,
  });
  expect(JSON.stringify(admission.config)).not.toContain("KEIKO_MCP_SECRET");
  expect(JSON.stringify(admission.config)).not.toContain("/synthetic/executable");
  const endpoint = endpoints.get("local");
  if (endpoint === undefined) throw new Error("Missing relay");
  const relayId = new URL(endpoint.url).pathname.split("/").at(-1) ?? "";
  const bound = relay.authenticate(relayId, endpoint.capability);
  const request = {
    method: "POST" as const,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode("{}"),
    signal: new AbortController().signal,
  };
  await bound?.target.upstream?.(bound.target.url, request);
  expect(serve).toHaveBeenCalledOnce();
  generation.abort();
  expect(bound?.signal.aborted).toBe(true);
  expect(relay.authenticate(relayId, endpoint.capability)).toBeUndefined();
  const unavailable = openCodeNativeMcpAdmission({
    servers: [local, remote],
    mode: "autonomous-delivery",
    home: "/synthetic/home",
    relays: new Map(),
    managed: true,
  });
  expect(unavailable.config.servers).toEqual({});
});

it("withdraws all native relay capabilities once before requesting uncertain-write recovery", async () => {
  const relay = createMcpCredentialRelay();
  const generation = new AbortController();
  const { sink: activityLog, records } = sink();
  const other = relay.bind({
    runId: "other-run",
    url: "https://other.example.test",
    headers: {},
    secrets: [],
  });
  if (other === undefined) throw new TypeError("missing synthetic second run");
  const recover = vi.fn((): Promise<void> => {
    if (endpoint === undefined) throw new TypeError("missing synthetic endpoint");
    const id = new URL(endpoint.url).pathname.split("/").at(-1) ?? "";
    expect(relay.authenticate(id, endpoint.capability)).toBeUndefined();
    return Promise.resolve();
  });
  const bindings = bindNativeMcpRelays({
    servers: [credentialed("synthetic", "KEIKO_MCP_SECRET_SYNTHETIC")],
    mode: "autonomous-delivery",
    runId: "uncertain-run",
    activityLog,
    onUncertainMutation: recover,
    relay: {
      relay,
      origin: ORIGIN,
      secrets: {},
      managed: {
        generation: () => generation.signal,
        serve: async (_name, _request, context): Promise<Response> => {
          await Promise.all([context.onUncertainMutation?.(), context.onUncertainMutation?.()]);
          return new Response("synthetic failure", { status: 502 });
        },
      },
    },
  });
  const endpoint = bindings.get("synthetic");
  if (endpoint === undefined) throw new TypeError("missing synthetic binding");
  const id = new URL(endpoint.url).pathname.split("/").at(-1) ?? "";
  const bound = relay.authenticate(id, endpoint.capability);
  await bound?.target.upstream?.(bound.target.url, {
    method: "POST",
    headers: {},
    body: new TextEncoder().encode("{}"),
    signal: new AbortController().signal,
  });
  expect(recover).toHaveBeenCalledOnce();
  expect(bound?.signal.aborted).toBe(true);
  expect(relay.authenticate(other.relayId, other.capability)).toBeDefined();
  expect(lines(records)).toContainEqual(
    expect.objectContaining({
      action: "request",
      outcome: "failed",
      reason: "mutation-outcome-unknown",
      correlationId: "uncertain-run",
    }),
  );
});

it("publishes recovery before authority revocation and retains revocation when publication fails", async () => {
  const order: string[] = [];
  const revoke = vi.fn(() => {
    order.push("revoke");
    return true;
  });
  const mark = vi.fn(() => {
    order.push("mark");
    return true;
  });
  const owner = {
    runId: "uncertain-run",
    authorityLifecycle: { revokeRuntime: revoke, markRuntimeRecoveryRequired: mark },
  };
  const event = vi.fn(() => {
    order.push("recovery");
  });
  await recoverNativeMcpRun({ ...owner, onRuntimeEvent: event });
  expect(order).toEqual(["recovery", "revoke", "mark"]);
  expect(event).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "failure-redacted",
      failureCode: "recovery-required",
      runId: "uncertain-run",
    }),
  );
  await expect(
    recoverNativeMcpRun({
      ...owner,
      onRuntimeEvent: () => {
        throw new Error("synthetic event owner unavailable");
      },
    }),
  ).rejects.toThrow("synthetic event owner unavailable");
  expect(revoke).toHaveBeenCalledTimes(2);
  expect(mark).toHaveBeenCalledTimes(2);
});
