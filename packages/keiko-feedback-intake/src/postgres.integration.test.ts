import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { DEFAULT_TEST_LIMITS } from "./config.js";
import {
  FIXED_DEDUPE_LIFETIME_MS,
  FIXED_OPEN_PAYLOAD_LIFETIME_MS,
  FIXED_RECEIPT_LIFETIME_MS,
  NOW,
  UNAVAILABLE,
  clientAdapter,
  options,
  preparedReport,
  rollbackAdmission,
  schemaRows,
  type ObservedQuery,
} from "./postgres-integration-helpers.js";
import { PostgresIntakeRepository, type PgClientLike } from "./postgres.js";
import { createPostgresFeedbackIntake } from "./production-service.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl === undefined ? it.skip : it;

describe("PostgreSQL production intake integration", () => {
  integration(
    "exercises production transactions (skipped only when DATABASE_URL is absent)",
    async () => {
      const pool = new Pool({ connectionString: databaseUrl, max: 6 });
      const schema = `feedback_${randomUUID().replaceAll("-", "")}`;
      const observed: ObservedQuery[] = [];
      const migrationClient = await pool.connect();
      try {
        await migrationClient.query(`CREATE SCHEMA "${schema}"`);
        await migrationClient.query(`SET search_path TO "${schema}"`);
        for (const name of [
          "001_feedback_intake.sql",
          "002_feedback_review.sql",
          "003_feedback_publication.sql",
        ]) {
          await migrationClient.query(
            await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
          );
        }
      } finally {
        migrationClient.release();
      }
      const repository = new PostgresIntakeRepository(
        {
          connect: async (): Promise<PgClientLike> => {
            const client = await pool.connect();
            await client.query(`SET search_path TO "${schema}"`);
            return clientAdapter(client, observed);
          },
        },
        3,
        2_000,
      );
      try {
        const report = preparedReport();
        const service = createPostgresFeedbackIntake(options(repository));
        const address = new Uint8Array([127, 0, 0, 1]);
        const submissions = await Promise.all([
          service.submit(report.canonicalBody.copyBytes(), report.exactBodySha256, address),
          service.submit(report.canonicalBody.copyBytes(), report.exactBodySha256, address),
        ]);
        expect(submissions.map((result) => result.status)).toEqual([202, 202]);
        expect(
          await schemaRows<{ readonly count: string }>(
            pool,
            schema,
            "SELECT count(*)::text AS count FROM feedback_payloads",
          ),
        ).toEqual([{ count: "1" }]);
        expect(
          await schemaRows<{ readonly count: string }>(
            pool,
            schema,
            "SELECT count(*)::text AS count FROM feedback_receipts",
          ),
        ).toEqual([{ count: "2" }]);
        expect(
          await schemaRows<{ readonly bounded_count: string }>(
            pool,
            schema,
            "SELECT bounded_count::text FROM feedback_dedupe_entries",
          ),
        ).toEqual([{ bounded_count: "2" }]);

        const countSaturated = createPostgresFeedbackIntake(options(repository, 10, 1));
        const countUnique = preparedReport("Unique count-capacity report");
        const countResults = await Promise.all([
          countSaturated.submit(
            report.canonicalBody.copyBytes(),
            report.exactBodySha256,
            new Uint8Array([127, 0, 0, 3]),
          ),
          countSaturated.submit(
            countUnique.canonicalBody.copyBytes(),
            countUnique.exactBodySha256,
            new Uint8Array([127, 0, 0, 4]),
          ),
        ]);
        expect(countResults).toEqual([UNAVAILABLE, UNAVAILABLE]);
        await expect(repository.keyInUse("abuse", "integration-1", NOW)).resolves.toBe(true);
        await expect(repository.keyInUse("dedupe", "integration-2", NOW)).resolves.toBe(true);
        const liveKeys = await repository.liveKeyIdsSnapshot(NOW);
        expect(liveKeys.abuse).toEqual(["integration-1"]);
        expect(liveKeys.dedupe).toEqual(["integration-2"]);
        const accepted = submissions[0];
        if (accepted.status !== 202) throw new Error("Expected accepted integration receipt");
        expect(accepted.body.expiresAt).toBe(
          new Date(NOW.getTime() + FIXED_RECEIPT_LIFETIME_MS).toISOString(),
        );
        await expect(
          service.receipt(accepted.body.receiptId, accepted.body.receiptSecret),
        ).resolves.toEqual({
          status: 200,
          body: {
            receiptId: accepted.body.receiptId,
            status: "received",
            expiresAt: accepted.body.expiresAt,
          },
        });

        const firstPayload = await schemaRows<{
          readonly id: string;
          readonly semantic_group_id: string;
          readonly canonical_bytes: Buffer;
          readonly created_at: Date;
          readonly expires_at: Date;
        }>(
          pool,
          schema,
          "SELECT id, semantic_group_id, canonical_bytes, created_at, expires_at FROM feedback_payloads",
        );
        const dedupeBeforeLate = await schemaRows<{
          readonly semantic_group_id: string;
          readonly created_at: Date;
          readonly expires_at: Date;
          readonly bounded_count: string;
        }>(
          pool,
          schema,
          "SELECT semantic_group_id, created_at, expires_at, bounded_count::text FROM feedback_dedupe_entries",
        );
        const storedFirstPayload = firstPayload[0];
        const storedFirstDedupe = dedupeBeforeLate[0];
        if (storedFirstPayload === undefined || storedFirstDedupe === undefined)
          throw new Error("Expected first PostgreSQL payload and dedupe entry");

        const lateTime = new Date(NOW.getTime() + 61 * 86_400_000);
        expect(storedFirstPayload.expires_at.getTime() - lateTime.getTime()).toBeLessThan(
          FIXED_RECEIPT_LIFETIME_MS,
        );
        const lateService = createPostgresFeedbackIntake(
          options(repository, 10, DEFAULT_TEST_LIMITS.openPayloadCount, () => lateTime),
        );
        const late = await lateService.submit(
          report.canonicalBody.copyBytes(),
          report.exactBodySha256,
          new Uint8Array([127, 0, 0, 4]),
        );
        const unique = preparedReport("Unique PostgreSQL receipt oracle");
        const other = await lateService.submit(
          unique.canonicalBody.copyBytes(),
          unique.exactBodySha256,
          new Uint8Array([127, 0, 0, 5]),
        );
        if (late.status !== 202 || other.status !== 202)
          throw new Error("Expected late duplicate and unique receipts");
        expect(late.body.expiresAt).toBe(other.body.expiresAt);
        expect(late.body.expiresAt).toBe(
          new Date(lateTime.getTime() + FIXED_RECEIPT_LIFETIME_MS).toISOString(),
        );
        await expect(
          lateService.receipt(late.body.receiptId, late.body.receiptSecret),
        ).resolves.toEqual({
          status: 200,
          body: {
            receiptId: late.body.receiptId,
            status: "received",
            expiresAt: late.body.expiresAt,
          },
        });
        expect(
          await schemaRows<{ readonly count: string }>(
            pool,
            schema,
            "SELECT count(*)::text AS count FROM feedback_payloads",
          ),
        ).toEqual([{ count: "3" }]);
        expect(
          await schemaRows<{
            readonly semantic_group_id: string;
            readonly count: string;
          }>(
            pool,
            schema,
            "SELECT semantic_group_id, count(*)::text AS count FROM feedback_payloads GROUP BY semantic_group_id ORDER BY count(*) DESC",
          ),
        ).toEqual([
          { semantic_group_id: storedFirstPayload.semantic_group_id, count: "2" },
          expect.objectContaining({ count: "1" }),
        ]);

        const storedBytes = await schemaRows<{ readonly bytes: string }>(
          pool,
          schema,
          "SELECT COALESCE(sum(octet_length(canonical_bytes)),0)::text AS bytes FROM feedback_payloads",
        );
        const currentBytes = Number(storedBytes[0]?.bytes ?? "0");
        const byteUnique = preparedReport("Unique byte-capacity report");
        const byteSaturated = createPostgresFeedbackIntake(
          options(
            repository,
            10,
            DEFAULT_TEST_LIMITS.openPayloadCount,
            () => lateTime,
            currentBytes,
          ),
        );
        const byteResults = await Promise.all([
          byteSaturated.submit(
            report.canonicalBody.copyBytes(),
            report.exactBodySha256,
            new Uint8Array([127, 0, 0, 6]),
          ),
          byteSaturated.submit(
            byteUnique.canonicalBody.copyBytes(),
            byteUnique.exactBodySha256,
            new Uint8Array([127, 0, 0, 7]),
          ),
        ]);
        expect(byteResults).toEqual([UNAVAILABLE, UNAVAILABLE]);
        expect(
          await schemaRows<{
            readonly canonical_bytes: Buffer;
            readonly created_at: Date;
            readonly expires_at: Date;
          }>(
            pool,
            schema,
            "SELECT canonical_bytes, created_at, expires_at FROM feedback_payloads WHERE id = $1",
            [storedFirstPayload.id],
          ),
        ).toEqual([
          {
            canonical_bytes: storedFirstPayload.canonical_bytes,
            created_at: storedFirstPayload.created_at,
            expires_at: new Date(NOW.getTime() + FIXED_OPEN_PAYLOAD_LIFETIME_MS),
          },
        ]);
        expect(
          await schemaRows<{
            readonly semantic_group_id: string;
            readonly created_at: Date;
            readonly expires_at: Date;
            readonly bounded_count: string;
          }>(
            pool,
            schema,
            "SELECT semantic_group_id, created_at, expires_at, bounded_count::text FROM feedback_dedupe_entries WHERE semantic_group_id = $1",
            [storedFirstDedupe.semantic_group_id],
          ),
        ).toEqual([
          {
            semantic_group_id: storedFirstDedupe.semantic_group_id,
            created_at: storedFirstDedupe.created_at,
            expires_at: new Date(NOW.getTime() + FIXED_DEDUPE_LIFETIME_MS),
            bounded_count: "3",
          },
        ]);

        const beforeRollback = await schemaRows<{ readonly count: string }>(
          pool,
          schema,
          "SELECT count(*)::text AS count FROM feedback_semantic_groups",
        );
        await expect(repository.admit(rollbackAdmission())).rejects.toThrow();
        expect(
          await schemaRows<{ readonly count: string }>(
            pool,
            schema,
            "SELECT count(*)::text AS count FROM feedback_semantic_groups",
          ),
        ).toEqual(beforeRollback);

        const limited = createPostgresFeedbackIntake(options(repository, 1));
        const limitedAddress = new Uint8Array([127, 0, 0, 2]);
        expect(
          (
            await limited.submit(
              report.canonicalBody.copyBytes(),
              report.exactBodySha256,
              limitedAddress,
            )
          ).status,
        ).toBe(202);
        const rejected = await limited.submit(
          report.canonicalBody.copyBytes(),
          report.exactBodySha256,
          limitedAddress,
        );
        expect(rejected).toMatchObject({ status: 429, body: { error: "rate-limited" } });
        const cutoff = new Date(NOW.getTime() + 242 * 86_400_000);
        expect((await repository.purge(cutoff)).some((count) => count > 0)).toBe(true);
        expect(await repository.purge(cutoff)).toEqual([
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ]);
        await expect(repository.keyInUse("abuse", "integration-1", cutoff)).resolves.toBe(false);
        await expect(repository.keyInUse("dedupe", "integration-2", cutoff)).resolves.toBe(false);
        const expiredKeys = await repository.liveKeyIdsSnapshot(cutoff);
        expect(expiredKeys.abuse).toEqual([]);
        expect(expiredKeys.dedupe).toEqual([]);
        expect(
          await schemaRows<{ readonly count: string }>(
            pool,
            schema,
            "SELECT count(*)::text AS count FROM feedback_deletion_ledger",
          ),
        ).toEqual([{ count: "16" }]);
        const delayedPendingAt = new Date(cutoff.getTime() - 366 * 86_400_000);
        const pendingDeletion = {
          keyClass: "dedupe" as const,
          keyId: "dedupe-v1:2026-01-02",
          timestamp: delayedPendingAt,
          result: "pending" as const,
        };
        await repository.beginDeletion(pendingDeletion);
        await repository.beginDeletion(pendingDeletion);
        await expect(repository.pendingDeletions("dedupe")).resolves.toEqual([pendingDeletion]);
        const replayedCompletionAt = cutoff;
        const completedDeletion = {
          ...pendingDeletion,
          timestamp: replayedCompletionAt,
          result: "destroyed" as const,
        };
        await repository.completeDeletion(completedDeletion);
        await repository.completeDeletion(completedDeletion);
        expect(
          await schemaRows<{
            readonly key_class: string;
            readonly key_id: string;
            readonly event_at: Date;
            readonly result: string;
          }>(
            pool,
            schema,
            "SELECT key_class, key_id, event_at, result FROM feedback_key_deletion_evidence",
          ),
        ).toEqual([
          {
            key_class: "dedupe",
            key_id: "dedupe-v1:2026-01-02",
            event_at: replayedCompletionAt,
            result: "destroyed",
          },
        ]);
        const pendingRecovery = {
          keyClass: "abuse" as const,
          keyId: "2026-01-01",
          timestamp: delayedPendingAt,
          result: "pending" as const,
        };
        await repository.beginDeletion(pendingRecovery);
        const beforeEvidenceExpiry = new Date(
          replayedCompletionAt.getTime() + 365 * 86_400_000 - 1,
        );
        expect((await repository.purge(beforeEvidenceExpiry)).at(-1)).toBe(0);
        const evidenceCutoff = new Date(replayedCompletionAt.getTime() + 365 * 86_400_000);
        expect((await repository.purge(evidenceCutoff)).at(-1)).toBe(1);
        expect(
          await schemaRows<{
            readonly key_class: string;
            readonly key_id: string;
            readonly event_at: Date;
            readonly result: string;
          }>(
            pool,
            schema,
            "SELECT key_class, key_id, event_at, result FROM feedback_key_deletion_evidence ORDER BY key_class, key_id",
          ),
        ).toEqual([
          {
            key_class: "abuse",
            key_id: pendingRecovery.keyId,
            event_at: delayedPendingAt,
            result: "pending",
          },
        ]);

        const deadlineQueries = observed.filter((item) =>
          item.text.startsWith("SELECT set_config('statement_timeout'"),
        );
        expect(deadlineQueries.length).toBeGreaterThan(0);
        expect(deadlineQueries.every((item) => item.values[0] === "2000")).toBe(true);
        expect(observed.some((item) => item.text === "ROLLBACK")).toBe(true);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
      }
    },
    30_000,
  );
});
