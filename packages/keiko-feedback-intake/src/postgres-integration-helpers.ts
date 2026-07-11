import { randomUUID } from "node:crypto";
import {
  prepareFeedbackReportV1,
  type PreparedFeedbackReportV1,
} from "@oscharko-dev/keiko-security/feedback-report";
import type { Pool, PoolClient } from "pg";
import { DEFAULT_TEST_LIMITS, validateIntakeLimits } from "./config.js";
import type { PgAdmission, PgClientLike, PgQueryResult } from "./postgres.js";
import type { ProductionServiceOptions } from "./production-service.js";
import type { IntakeSecretProvider } from "./types.js";

export const NOW = new Date("2026-07-11T12:00:00.000Z");
const DAY_MS = 86_400_000;
export const FIXED_RECEIPT_LIFETIME_MS = 30 * DAY_MS;
export const FIXED_OPEN_PAYLOAD_LIFETIME_MS = 90 * DAY_MS;
export const FIXED_DEDUPE_LIFETIME_MS = 180 * DAY_MS;
export const UNAVAILABLE = { status: 503, body: { error: "temporarily-unavailable" } } as const;

export interface ObservedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

export function clientAdapter(client: PoolClient, observed: ObservedQuery[]): PgClientLike {
  return {
    query: async <Row extends object>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<PgQueryResult<Row>> => {
      observed.push({ text, values });
      const result = await client.query(text, [...values]);
      return { rows: result.rows as readonly Row[], rowCount: result.rowCount };
    },
    release: (): void => {
      client.release();
    },
  };
}

function secretProvider(fill: number): IntakeSecretProvider {
  const key = Object.freeze({
    id: `integration-${String(fill)}`,
    key: new Uint8Array(32).fill(fill),
    activatedAt: new Date(0),
  });
  return { snapshot: () => ({ active: key, predecessors: [] }) };
}

export function preparedReport(
  title = "PostgreSQL integration",
  diagnostics?: { readonly errors: number; readonly warnings: number; readonly infos: number },
): PreparedFeedbackReportV1 {
  const prepared = prepareFeedbackReportV1({
    schemaVersion: "1",
    category: "defect",
    title,
    description: "Production repository behavior is verified.",
    reproductionSteps: "Submit the same prepared report concurrently.",
    expectedBehavior: "One immutable payload backs separate receipts.",
    actualBehavior: "The integration path is exercised.",
    productVersion: "0.2.14",
    platform: "Linux",
    featureArea: "model-configuration",
    impact: "Degrades core workflow",
    ...(diagnostics === undefined ? {} : { diagnostics }),
  });
  if (!prepared.ok) throw new Error("Invalid integration fixture");
  return prepared.value;
}

export function options(
  repository: ProductionServiceOptions["repository"],
  perIdentity = 10,
  openPayloadCount = DEFAULT_TEST_LIMITS.openPayloadCount,
  now: () => Date = () => NOW,
  openPayloadBytes = DEFAULT_TEST_LIMITS.openPayloadBytes,
): ProductionServiceOptions {
  return {
    repository,
    limits: validateIntakeLimits({
      ...DEFAULT_TEST_LIMITS,
      perIdentity,
      openPayloadCount,
      openPayloadBytes,
      storageDeadlineMs: 2_000,
    }),
    abuseKeys: secretProvider(1),
    dedupeKeys: secretProvider(2),
    now,
    logger: { event: () => undefined },
    metrics: { increment: () => undefined },
  };
}

export function rollbackAdmission(): PgAdmission {
  return {
    groupId: randomUUID(),
    payloadId: randomUUID(),
    receiptId: "invalid",
    dedupeKeyId: "integration-rollback",
    dedupeHmac: new Uint8Array(32).fill(9),
    dedupeCandidates: [{ keyId: "integration-rollback", hmac: new Uint8Array(32).fill(9) }],
    canonicalBytes: new TextEncoder().encode("{}"),
    exactBodySha256: "0".repeat(64),
    receiptSecretHash: new Uint8Array(32),
    createdAt: NOW,
    payloadExpiresAt: new Date(NOW.getTime() + 90 * DAY_MS),
    receiptExpiresAt: new Date(NOW.getTime() + 90 * DAY_MS),
    dedupeExpiresAt: new Date(NOW.getTime() + 180 * DAY_MS),
    openPayloadCount: 10_000,
    openPayloadBytes: 256_000_000,
    storageDeadlineMs: 2_000,
  };
}

export async function schemaRows<Row extends object>(
  pool: Pool,
  schema: string,
  text: string,
  values: readonly unknown[] = [],
): Promise<readonly Row[]> {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schema}"`);
    return (await client.query<Row>(text, [...values])).rows;
  } finally {
    client.release();
  }
}
