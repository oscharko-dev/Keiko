import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { causeChain, keikoStackFrames, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import type { McpOAuthCredentialStore } from "../mcp/mcpOAuthCredentialStore.js";
import type { AdmittedMcpOAuthServer } from "./opencodeNativeMcp.js";
import type { OpenCodeV2HttpClient } from "./opencodeV2HttpClient.js";

/**
 * The OAuth credential of an admitted MCP server between runs (#3903 AC3). The runtime keeps the
 * credential its own authorization obtained in the run's private database. Keiko seeds a kept one
 * into a new run once the run is ready (the runtime then connects the server without a prompt) and,
 * when the run ends and its runtime is reaped, takes back what the runtime holds (its refresh may
 * have rotated the tokens) and removes every credential from that database: a retained session
 * never carries a token, so the retention audit's credential refusal stays a hard guard. Only a
 * credential the runtime issued for an admitted server's URL by its expected issuer (and the
 * operator's client, when named) is kept; any other is dropped. No token, URL or issuer is logged.
 */
export interface McpCredentialRun {
  readonly runId: string;
  readonly mcpOAuth?: ReadonlyMap<string, AdmittedMcpOAuthServer> | undefined;
}

/** Hands the run's runtime every kept credential of its admitted servers; never rejects. */
export async function seedMcpCredentials(
  run: McpCredentialRun,
  client: Pick<OpenCodeV2HttpClient, "createMcpCredential">,
  store: McpOAuthCredentialStore,
  activityLog: ServerLogSink | undefined,
): Promise<void> {
  const servers = [...(run.mcpOAuth ?? new Map<string, AdmittedMcpOAuthServer>())];
  if (servers.length === 0) return;
  let seeded = 0;
  try {
    for (const [server, admitted] of servers) {
      const stored = store.load({ server, url: admitted.url, oauth: admitted.oauth });
      if (stored === undefined) continue;
      await client.createMcpCredential({
        integrationId: stored.integrationId,
        label: server,
        value: stored.value,
      });
      seeded += 1;
    }
    recordMcpCredentials(activityLog, run.runId, {
      action: "seeded",
      outcome: "ok",
      count: seeded,
    });
  } catch (error) {
    recordMcpCredentials(activityLog, run.runId, {
      action: "seeded",
      outcome: "failed",
      count: seeded,
      error,
    });
  }
}

/**
 * Keeps the credentials the run's runtime holds for its admitted servers. With `scrub`, the run's
 * runtime is reaped and every credential row is removed afterwards. Never throws: a failure keeps
 * nothing, and a scrub that failed leaves the retention audit to refuse the database.
 */
export function harvestMcpCredentials(
  run: McpCredentialRun,
  database: string,
  store: McpOAuthCredentialStore | undefined,
  activityLog: ServerLogSink | undefined,
  scrub: boolean,
): void {
  const action = scrub ? "scrubbed" : "harvested";
  if (!existsSync(database)) return;
  let handle: DatabaseSync | undefined;
  try {
    handle = new DatabaseSync(database, { readOnly: !scrub });
    const rows = credentialRows(handle);
    const kept = store === undefined ? 0 : keepMatching(run, rows, store);
    if (scrub) handle.exec("DELETE FROM credential");
    if (rows.length > 0 || scrub)
      recordMcpCredentials(activityLog, run.runId, {
        action,
        outcome: "ok",
        count: kept,
        droppedCount: rows.length - kept,
      });
  } catch (error) {
    recordMcpCredentials(activityLog, run.runId, { action, outcome: "failed", count: 0, error });
  } finally {
    handle?.close();
  }
}

interface CredentialRow {
  readonly integrationId: string;
  readonly value: Readonly<Record<string, unknown>>;
}

function credentialRows(handle: DatabaseSync): readonly CredentialRow[] {
  const rows = handle.prepare("SELECT integration_id, value FROM credential").all();
  return rows.flatMap((row): CredentialRow[] => {
    const integrationId = row.integration_id;
    const text = row.value;
    if (typeof integrationId !== "string" || typeof text !== "string") return [];
    // A row that is not JSON is no credential Keiko could keep; it is still scrubbed.
    const value = parsedValue(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? [{ integrationId, value: value as Readonly<Record<string, unknown>> }]
      : [];
  });
}

function parsedValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function keepMatching(
  run: McpCredentialRun,
  rows: readonly CredentialRow[],
  store: McpOAuthCredentialStore,
): number {
  let kept = 0;
  for (const row of rows) {
    const match = [...(run.mcpOAuth ?? [])].find(([, admitted]) => issuedFor(row, admitted));
    if (match === undefined) continue;
    const [server, admitted] = match;
    store.save({ server, url: admitted.url, oauth: admitted.oauth }, row);
    kept += 1;
  }
  return kept;
}

// The runtime records the server URL, the issuer and the client it obtained the credential from.
function issuedFor(row: CredentialRow, admitted: AdmittedMcpOAuthServer): boolean {
  const metadata = plainRecord(row.value.metadata);
  const client = plainRecord(metadata?.client);
  return (
    row.value.type === "oauth" &&
    metadata?.serverUrl === admitted.url &&
    metadata.issuer === admitted.oauth.issuer &&
    (admitted.oauth.clientId === undefined || client?.client_id === admitted.oauth.clientId)
  );
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

const ACTIONS = ["seeded", "harvested", "scrubbed"] as const;

const MCP_CREDENTIALS_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.mcp-credentials",
  category: "security",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeNativeMcpCredentials.recordMcpCredentials",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    action: { type: "string", dataClass: "closed-enum", required: true, values: [...ACTIONS] },
    outcome: { type: "string", dataClass: "closed-enum", required: true, values: ["ok", "failed"] },
    // Credentials seeded, or kept for an admitted server.
    count: { type: "integer", dataClass: "count", required: true },
    // Credentials the runtime held that no admitted server's issuer and URL account for.
    droppedCount: { type: "integer", dataClass: "count", required: false },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  diagnosticWhen: [{ field: "outcome", values: ["failed"] }],
  failureClasses: ["coding-runtime-mcp-credentials"],
  proofIds: ["coding-runtime.mcp-credentials.emitted-line"],
  releaseImpact: "patch",
});

interface CredentialsLine {
  readonly action: (typeof ACTIONS)[number];
  readonly outcome: "ok" | "failed";
  readonly count: number;
  readonly droppedCount?: number | undefined;
  readonly error?: unknown;
}

/** Counts and closed values only; never a token, a URL or an issuer. */
export function recordMcpCredentials(
  activityLog: ServerLogSink | undefined,
  runId: string,
  line: CredentialsLine,
): void {
  const failed = line.outcome === "failed";
  activityLog?.write(
    activityLogEvent(
      MCP_CREDENTIALS_OPERATION,
      {
        correlationId: runId,
        ...(failed ? { level: "warn" as const, errorKind: "internal" as const } : {}),
      },
      {
        runId,
        action: line.action,
        outcome: line.outcome,
        count: line.count,
        ...(line.droppedCount === undefined ? {} : { droppedCount: line.droppedCount }),
        ...(line.error === undefined
          ? {}
          : { frames: keikoStackFrames(line.error), causeChain: causeChain(line.error) }),
      },
    ),
  );
}
