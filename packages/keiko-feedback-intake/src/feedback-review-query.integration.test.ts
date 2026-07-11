import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresFeedbackReviewQuery } from "./feedback-review-query.js";
import { PostgresFeedbackReviewRepository } from "./feedback-review-store.js";
import type { FeedbackReviewCommand } from "./feedback-review-types.js";
import {
  clientAdapter,
  preparedReport,
  schemaRows,
  type ObservedQuery,
} from "./postgres-integration-helpers.js";
import type { PgClientLike } from "./postgres-types.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl === undefined ? it.skip : it;

async function migration(name: string): Promise<string> {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

describe("PostgreSQL feedback review query", () => {
  integration(
    "paginates metadata, uses accepted counts, hides logical expiry, and durably restricts private history",
    async (): Promise<void> => {
      const pool = new Pool({ connectionString: databaseUrl, max: 6 });
      const schema = `feedback_query_${randomUUID().replaceAll("-", "")}`;
      const groupId = randomUUID();
      const itemIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()] as const;
      const reports = [
        preparedReport("First review query", { errors: 1, warnings: 2, infos: 3 }),
        preparedReport("Private sibling query"),
        preparedReport("Expired unheld query"),
        preparedReport("Expired held query"),
      ] as const;
      const setup = await pool.connect();
      try {
        await setup.query(`CREATE SCHEMA "${schema}"`);
        await setup.query(`SET search_path TO "${schema}"`);
        await setup.query(await migration("001_feedback_intake.sql"));
        await setup.query(await migration("002_feedback_review.sql"));
        await setup.query(
          "INSERT INTO feedback_semantic_groups (id, created_at) VALUES ($1, transaction_timestamp())",
          [groupId],
        );
        await setup.query(
          "INSERT INTO feedback_dedupe_entries (dedupe_key_id, dedupe_hmac, semantic_group_id, created_at, expires_at, bounded_count) VALUES ('dedupe-v1:test', $1, $2, transaction_timestamp(), transaction_timestamp() + interval '180 days', 3)",
          [Buffer.alloc(32, 7), groupId],
        );
        await setup.query(
          "INSERT INTO feedback_dedupe_entries (dedupe_key_id, dedupe_hmac, semantic_group_id, created_at, expires_at, bounded_count) VALUES ('dedupe-v1:rotated', $1, $2, transaction_timestamp(), transaction_timestamp() + interval '180 days', 2)",
          [Buffer.alloc(32, 8), groupId],
        );
        for (let index = 0; index < itemIds.length; index += 1) {
          const report = reports[index];
          if (report === undefined) throw new Error("Expected report fixture");
          await setup.query(
            "INSERT INTO feedback_payloads (id, semantic_group_id, exact_body_sha256, canonical_bytes, created_at, expires_at) VALUES ($1,$2,$3,$4,transaction_timestamp() - interval '1 day' + ($5::int * interval '1 second'),transaction_timestamp() + interval '90 days')",
            [
              itemIds[index],
              groupId,
              report.exactBodySha256,
              report.canonicalBody.copyBytes(),
              index,
            ],
          );
        }
        for (let index = 0; index < 3; index += 1) {
          await setup.query(
            "INSERT INTO feedback_receipts (id, payload_id, secret_hash, created_at, expires_at) VALUES ($1,$2,$3,transaction_timestamp(),transaction_timestamp() + interval '30 days')",
            [String.fromCharCode(65 + index).repeat(22), itemIds[0], Buffer.alloc(32, index)],
          );
        }
        await setup.query(
          "INSERT INTO feedback_legal_holds (item_id, policy_key, placed_at, review_at, expires_at, actor_issuer, actor_sub, permission_policy_version) VALUES ($1,'policy-1',transaction_timestamp(),transaction_timestamp() + interval '1 hour',transaction_timestamp() + interval '2 hours','https://idp.example/','holder','policy-v1')",
          [itemIds[3]],
        );
        await setup.query(
          "UPDATE feedback_payloads SET expires_at = transaction_timestamp() - interval '1 second' WHERE id IN ($1,$2)",
          [itemIds[2], itemIds[3]],
        );
      } finally {
        setup.release();
      }
      const observed: ObservedQuery[] = [];
      const connect = async (): Promise<PgClientLike> => {
        const client = await pool.connect();
        await client.query(`SET search_path TO "${schema}"`);
        return clientAdapter(client, observed);
      };
      const query = new PostgresFeedbackReviewQuery({ connect });
      const repository = new PostgresFeedbackReviewRepository({ connect });
      const command = (
        itemId: string,
        reportIndex: number,
        action: "archive" | "route-private-security" | "release-legal-hold",
        idempotencyKey: string,
      ): FeedbackReviewCommand => ({
        itemId,
        expectedVersion: 1,
        expectedPayloadDigest: reports[reportIndex]?.exactBodySha256 ?? "",
        idempotencyKey,
        actor: {
          issuer: "https://idp.example/",
          subject: "maintainer-1",
          permissionPolicyVersion: "policy-v1",
        },
        action,
      });
      try {
        const detail = await query.detail(itemIds[0], false);
        expect(detail).toMatchObject({
          groupCount: 3,
          category: "defect",
          featureArea: "model-configuration",
          impact: "Degrades core workflow",
          severityCounts: { errors: 1, warnings: 2, infos: 3 },
        });
        expect(JSON.stringify(detail)).not.toMatch(/dedupe-v1:test|dedupeHmac|dedupeKey/iu);
        const first = await query.list({ limit: 1, includePrivate: false });
        expect(first.items).toHaveLength(1);
        expect(first.nextCursor).toEqual(expect.any(String));
        const second = await query.list({
          limit: 1,
          includePrivate: false,
          cursor: first.nextCursor,
        });
        expect(second.items[0]?.itemId).not.toBe(first.items[0]?.itemId);
        await expect(query.detail(itemIds[2], false)).resolves.toBeUndefined();
        await expect(repository.find(itemIds[2], false)).resolves.toBeUndefined();
        await expect(
          repository.execute(command(itemIds[2], 2, "archive", "expired-command-key")),
        ).rejects.toMatchObject({ code: "payload-expired" });
        await expect(query.detail(itemIds[3], false)).resolves.toBeDefined();
        await expect(repository.find(itemIds[3], false)).resolves.toMatchObject({
          hasActiveLegalHold: true,
        });

        const archived = command(itemIds[0], 0, "archive", "archive-sibling-key");
        await repository.execute(archived);
        await repository.execute(
          command(itemIds[1], 1, "route-private-security", "private-sibling-key"),
        );
        await expect(query.audit(20, false)).resolves.toEqual([]);
        await expect(query.audit(20, true)).resolves.toHaveLength(2);
        const originalExpiry = await schemaRows<{ readonly expires_at: Date }>(
          pool,
          schema,
          "UPDATE feedback_private_review_group_tombstones SET restricted_at = transaction_timestamp() - interval '365 days' + interval '1 hour', expires_at = transaction_timestamp() + interval '1 hour' RETURNING expires_at",
        );
        await repository.execute(
          command(itemIds[3], 3, "release-legal-hold", "later-private-hold-key"),
          true,
        );
        const extended = await schemaRows<{ readonly expires_at: Date }>(
          pool,
          schema,
          "SELECT expires_at FROM feedback_private_review_group_tombstones",
        );
        expect(extended[0]?.expires_at.getTime()).toBeGreaterThan(
          (originalExpiry[0]?.expires_at.getTime() ?? 0) + 364 * 86_400_000,
        );
        await expect(query.audit(20, false)).resolves.toEqual([]);
        await expect(query.audit(20, true)).resolves.toHaveLength(3);
        await expect(repository.execute(archived)).rejects.toMatchObject({ code: "not-found" });
        await expect(
          repository.execute({ ...archived, action: "route-private-security" }),
        ).rejects.toMatchObject({ code: "not-found" });
        await expect(repository.execute(archived, true)).resolves.toMatchObject({ replayed: true });

        await schemaRows(pool, schema, "DELETE FROM feedback_receipts");
        await schemaRows(pool, schema, "DELETE FROM feedback_payloads");
        await schemaRows(pool, schema, "DELETE FROM feedback_dedupe_entries");
        await schemaRows(pool, schema, "DELETE FROM feedback_semantic_groups");
        await expect(query.audit(20, false)).resolves.toEqual([]);
        await expect(query.audit(20, true)).resolves.toHaveLength(3);
        await expect(repository.execute(archived)).rejects.toMatchObject({ code: "not-found" });
        await expect(repository.execute(archived, true)).resolves.toMatchObject({ replayed: true });
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT review_group_id FROM feedback_private_review_group_tombstones",
          ),
        ).toHaveLength(1);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
      }
    },
  );
});
