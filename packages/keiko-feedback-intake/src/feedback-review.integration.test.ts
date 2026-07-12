import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresFeedbackReviewRepository } from "./feedback-review-store.js";
import type { FeedbackReviewCommand } from "./feedback-review-types.js";
import { clientAdapter, schemaRows, type ObservedQuery } from "./postgres-integration-helpers.js";
import { PostgresIntakeRepository, type PgClientLike } from "./postgres.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl === undefined ? it.skip : it;
const AT = new Date("2026-07-11T12:00:00.000Z");
const FIRST_BYTES = Buffer.from("SENTINEL_REPORT_CONTENT");
const DIGEST = createHash("sha256").update(FIRST_BYTES).digest("hex");

function archive(itemId: string, key: string): FeedbackReviewCommand {
  return {
    itemId,
    expectedVersion: 1,
    expectedPayloadDigest: DIGEST,
    idempotencyKey: key,
    actor: {
      issuer: "https://issuer.example",
      subject: "operator-1",
      permissionPolicyVersion: "policy-v1",
    },
    action: "archive",
  };
}

async function migration(name: string): Promise<string> {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

async function waitForMigrationLock(pool: Pool, schema: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ readonly locked: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'feedback_payloads' AND l.mode = 'ShareRowExclusiveLock' AND l.granted) AS locked",
      [schema],
    );
    if (result.rows[0]?.locked === true) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Migration lock was not observed");
}

describe("PostgreSQL feedback review integration", () => {
  integration(
    "backfills, triggers, CASes, closes, audits, and inherits private routing",
    async (): Promise<void> => {
      const pool = new Pool({ connectionString: databaseUrl, max: 6 });
      const schema = `feedback_review_${randomUUID().replaceAll("-", "")}`;
      const groupId = randomUUID();
      const firstId = randomUUID();
      const secondId = randomUUID();
      const thirdId = randomUUID();
      const expiredId = randomUUID();
      const secondBytes = Buffer.from("SECOND_PAYLOAD");
      const secondDigest = createHash("sha256").update(secondBytes).digest("hex");
      const observed: ObservedQuery[] = [];
      const setup = await pool.connect();
      try {
        await setup.query(`CREATE SCHEMA "${schema}"`);
        await setup.query(`SET search_path TO "${schema}"`);
        await setup.query(await migration("001_feedback_intake.sql"));
        await setup.query("INSERT INTO feedback_semantic_groups (id, created_at) VALUES ($1,$2)", [
          groupId,
          AT,
        ]);
        await setup.query(
          "INSERT INTO feedback_payloads (id, semantic_group_id, exact_body_sha256, canonical_bytes, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$5::timestamptz + interval '90 days')",
          [firstId, groupId, DIGEST, FIRST_BYTES, AT],
        );
        await setup.query(
          "INSERT INTO feedback_receipts (id, payload_id, secret_hash, created_at, expires_at) VALUES ($1,$2,$3,$4,$4::timestamptz + interval '30 days')",
          ["A".repeat(22), firstId, Buffer.alloc(32), AT],
        );
        await setup.query(await migration("002_feedback_review.sql"));
        await setup.query(
          "INSERT INTO feedback_payloads (id, semantic_group_id, exact_body_sha256, canonical_bytes, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$5::timestamptz + interval '90 days')",
          [secondId, groupId, secondDigest, secondBytes, AT],
        );
        await setup.query(await migration("003_feedback_publication.sql"));
        await setup.query(await migration("004_feedback_publication_worker.sql"));
      } finally {
        setup.release();
      }
      const connect = async (): Promise<PgClientLike> => {
        const client = await pool.connect();
        await client.query(`SET search_path TO "${schema}"`);
        return clientAdapter(client, observed);
      };
      const repository = new PostgresFeedbackReviewRepository(
        { connect },
        2_000,
        ["operator-policy-1"],
        () => AT,
      );
      try {
        expect(
          await schemaRows<{ readonly state: string }>(
            pool,
            schema,
            "SELECT state FROM feedback_review_items ORDER BY id",
          ),
        ).toHaveLength(2);
        const commands = [
          archive(firstId, "concurrent-key-01"),
          archive(firstId, "concurrent-key-01"),
        ];
        const outcomes = await Promise.allSettled(
          commands.map((command) => repository.execute(command)),
        );
        expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(2);
        const results = outcomes.flatMap((outcome) =>
          outcome.status === "fulfilled" ? [outcome.value] : [],
        );
        expect(results.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
        const winningCommand = commands[0];
        if (winningCommand === undefined) throw new Error("Expected command");
        await expect(repository.execute(winningCommand)).resolves.toMatchObject({ replayed: true });
        await expect(
          repository.execute({
            ...winningCommand,
            action: "route-private-security",
          }),
        ).rejects.toMatchObject({ code: "idempotency-mismatch" });
        expect(
          await schemaRows<{ readonly closed: boolean }>(
            pool,
            schema,
            "SELECT closed FROM feedback_receipts WHERE payload_id = $1",
            [firstId],
          ),
        ).toEqual([{ closed: true }]);
        const audit = await schemaRows<Record<string, unknown>>(
          pool,
          schema,
          "SELECT * FROM feedback_review_audit",
        );
        expect(audit).toHaveLength(1);
        expect(JSON.stringify(audit)).not.toContain("SENTINEL_REPORT_CONTENT");
        await expect(
          schemaRows(
            pool,
            schema,
            "UPDATE feedback_payloads SET canonical_bytes = $2 WHERE id = $1",
            [firstId, Buffer.from("changed")],
          ),
        ).rejects.toThrow();
        const corrupt = await pool.connect();
        try {
          await corrupt.query(`SET search_path TO "${schema}"`);
          await corrupt.query(
            "ALTER TABLE feedback_payloads DISABLE TRIGGER feedback_payload_content_immutable",
          );
          await corrupt.query("UPDATE feedback_payloads SET canonical_bytes = $2 WHERE id = $1", [
            firstId,
            Buffer.from("corrupted"),
          ]);
          await corrupt.query(
            "ALTER TABLE feedback_payloads ENABLE TRIGGER feedback_payload_content_immutable",
          );
        } finally {
          corrupt.release();
        }
        await expect(repository.find(firstId, true)).rejects.toMatchObject({
          code: "payload-digest-drift",
        });
        await expect(
          repository.execute({ ...winningCommand, idempotencyKey: "drift-check-key-1" }),
        ).rejects.toMatchObject({
          code: "payload-digest-drift",
        });
        const restore = await pool.connect();
        try {
          await restore.query(`SET search_path TO "${schema}"`);
          await restore.query(
            "ALTER TABLE feedback_payloads DISABLE TRIGGER feedback_payload_content_immutable",
          );
          await restore.query("UPDATE feedback_payloads SET canonical_bytes = $2 WHERE id = $1", [
            firstId,
            FIRST_BYTES,
          ]);
          await restore.query(
            "ALTER TABLE feedback_payloads ENABLE TRIGGER feedback_payload_content_immutable",
          );
        } finally {
          restore.release();
        }

        const approvalFields = [
          ["approval_payload_digest", secondDigest],
          ["approval_marker", "marker-1234567890"],
          ["approval_projection_digest", "c".repeat(64)],
          ["approval_target_key", "target"],
          ["approval_label_policy_version", "labels-v1"],
          ["approval_actor_issuer", "https://issuer.example"],
          ["approval_actor_sub", "operator-1"],
          ["approval_permission_policy_version", "policy-v1"],
          ["approval_record_version", 1],
        ] as const;
        for (const [nullable] of approvalFields) {
          const assignments = approvalFields.map(
            ([field], index) => `${field} = $${String(index + 2)}`,
          );
          const values = approvalFields.map(([field, value]) =>
            field === nullable ? null : value,
          );
          await expect(
            schemaRows(
              pool,
              schema,
              `UPDATE feedback_review_items SET state = 'approved', ${assignments.join(", ")} WHERE id = $1`,
              [secondId, ...values],
            ),
          ).rejects.toThrow();
        }
        await repository.execute({
          ...archive(secondId, "private-route-key"),
          expectedPayloadDigest: secondDigest,
          action: "route-private-security",
        });
        const insert = await pool.connect();
        try {
          await insert.query(`SET search_path TO "${schema}"`);
          await insert.query(
            "INSERT INTO feedback_payloads (id, semantic_group_id, exact_body_sha256, canonical_bytes, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$5::timestamptz + interval '90 days')",
            [thirdId, groupId, "c".repeat(64), Buffer.from("{}"), AT],
          );
        } finally {
          insert.release();
        }
        expect(
          await schemaRows<{ readonly state: string }>(
            pool,
            schema,
            "SELECT state FROM feedback_review_items WHERE id = $1",
            [thirdId],
          ),
        ).toEqual([{ state: "private-security" }]);

        const expiredGroup = randomUUID();
        const expiredBytes = Buffer.from("EXPIRED");
        const expiredDigest = createHash("sha256").update(expiredBytes).digest("hex");
        const expired = await pool.connect();
        try {
          await expired.query(`SET search_path TO "${schema}"`);
          await expired.query(
            "INSERT INTO feedback_semantic_groups (id, created_at) VALUES ($1,$2)",
            [expiredGroup, new Date(AT.getTime() - 86_400_000)],
          );
          await expired.query(
            "INSERT INTO feedback_payloads (id, semantic_group_id, exact_body_sha256, canonical_bytes, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
            [
              expiredId,
              expiredGroup,
              expiredDigest,
              expiredBytes,
              new Date(AT.getTime() - 86_400_000),
              AT,
            ],
          );
        } finally {
          expired.release();
        }
        await expect(
          repository.execute({
            ...archive(expiredId, "expired-hold-key"),
            expectedPayloadDigest: expiredDigest,
            action: "place-legal-hold",
            policyKey: "operator-policy-1",
            reviewAt: new Date(AT.getTime() + 86_400_000),
            expiresAt: new Date(AT.getTime() + 2 * 86_400_000),
          }),
        ).rejects.toMatchObject({ code: "payload-expired" });
        await expect(
          schemaRows(
            pool,
            schema,
            "INSERT INTO feedback_legal_holds (item_id, policy_key, placed_at, review_at, expires_at, actor_issuer, actor_sub, permission_policy_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              expiredId,
              "operator-policy-1",
              AT,
              new Date(AT.getTime() + 86_400_000),
              new Date(AT.getTime() + 2 * 86_400_000),
              "https://issuer.example",
              "operator-1",
              "policy-v1",
            ],
          ),
        ).rejects.toThrow();
        await new PostgresIntakeRepository({ connect }).purge(AT);
        expect(
          await schemaRows(pool, schema, "SELECT id FROM feedback_payloads WHERE id = $1", [
            expiredId,
          ]),
        ).toEqual([]);
        await new PostgresIntakeRepository({ connect }).purge(
          new Date(AT.getTime() + 31 * 86_400_000),
        );
        expect(
          await schemaRows(pool, schema, "SELECT id FROM feedback_review_items WHERE id = $1", [
            firstId,
          ]),
        ).toEqual([]);
        await expect(repository.execute(winningCommand)).rejects.toMatchObject({
          code: "not-found",
        });
        await expect(repository.execute(winningCommand, true)).resolves.toMatchObject({
          replayed: true,
          state: "archived",
        });
        await expect(
          repository.execute({ ...winningCommand, action: "route-private-security" }),
        ).rejects.toMatchObject({ code: "not-found" });
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
      }
    },
  );

  integration(
    "closes the migration admission gap with a write-conflicting payload lock",
    async (): Promise<void> => {
      const pool = new Pool({ connectionString: databaseUrl, max: 4 });
      const schema = `feedback_review_lock_${randomUUID().replaceAll("-", "")}`;
      const groupId = randomUUID();
      const payloadId = randomUUID();
      const bytes = Buffer.from("CONCURRENT_ADMISSION");
      const digest = createHash("sha256").update(bytes).digest("hex");
      const migrate = await pool.connect();
      const admit = await pool.connect();
      try {
        await migrate.query(`CREATE SCHEMA "${schema}"`);
        await migrate.query(`SET search_path TO "${schema}"`);
        await migrate.query(await migration("001_feedback_intake.sql"));
        await migrate.query(
          "INSERT INTO feedback_semantic_groups (id, created_at) VALUES ($1,$2)",
          [groupId, AT],
        );
        await migrate.query("BEGIN");
        const source = (await migration("002_feedback_review.sql")).replace(
          "LOCK TABLE feedback_payloads IN SHARE ROW EXCLUSIVE MODE;",
          "LOCK TABLE feedback_payloads IN SHARE ROW EXCLUSIVE MODE; SELECT pg_sleep(0.2);",
        );
        const migrating = migrate.query(source);
        await waitForMigrationLock(pool, schema);
        await admit.query(`SET search_path TO "${schema}"`);
        const admitting = admit.query(
          "INSERT INTO feedback_payloads (id, semantic_group_id, exact_body_sha256, canonical_bytes, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$5::timestamptz + interval '90 days')",
          [payloadId, groupId, digest, bytes, AT],
        );
        await migrating;
        await migrate.query("COMMIT");
        await admitting;
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT payload_id FROM feedback_review_items WHERE payload_id = $1",
            [payloadId],
          ),
        ).toEqual([{ payload_id: payloadId }]);
      } finally {
        await migrate.query("ROLLBACK").catch(() => undefined);
        migrate.release();
        admit.release();
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
      }
    },
  );

  integration("expires a stale raw hold before CAS replacement", async (): Promise<void> => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const schema = `feedback_hold_${randomUUID().replaceAll("-", "")}`;
    const groupId = randomUUID();
    const itemId = randomUUID();
    const observed: ObservedQuery[] = [];
    const setup = await pool.connect();
    try {
      await setup.query(`CREATE SCHEMA "${schema}"`);
      await setup.query(`SET search_path TO "${schema}"`);
      await setup.query(await migration("001_feedback_intake.sql"));
      await setup.query(await migration("002_feedback_review.sql"));
      await setup.query(
        "INSERT INTO feedback_semantic_groups (id, created_at) VALUES ($1,transaction_timestamp())",
        [groupId],
      );
      await setup.query(
        "INSERT INTO feedback_payloads (id, semantic_group_id, exact_body_sha256, canonical_bytes, created_at, expires_at) VALUES ($1,$2,$3,$4,transaction_timestamp(),transaction_timestamp() + interval '90 days')",
        [itemId, groupId, DIGEST, FIRST_BYTES],
      );
      await setup.query(
        "INSERT INTO feedback_legal_holds (item_id, policy_key, placed_at, review_at, expires_at, actor_issuer, actor_sub, permission_policy_version) VALUES ($1,'operator-policy-1',transaction_timestamp() - interval '3 hours',transaction_timestamp() - interval '2 hours',transaction_timestamp() - interval '1 hour','https://issuer.example','operator-1','policy-v1')",
        [itemId],
      );
    } finally {
      setup.release();
    }
    const connect = async (): Promise<PgClientLike> => {
      const client = await pool.connect();
      await client.query(`SET search_path TO "${schema}"`);
      return clientAdapter(client, observed);
    };
    const repository = new PostgresFeedbackReviewRepository({ connect }, 2_000, [
      "operator-policy-1",
    ]);
    try {
      await expect(
        repository.execute({
          ...archive(itemId, "expire-raw-hold-key"),
          action: "expire-legal-hold",
        }),
      ).resolves.toMatchObject({ state: "pending", version: 2 });
      expect(await schemaRows(pool, schema, "SELECT policy_key FROM feedback_legal_holds")).toEqual(
        [],
      );
      expect(
        await schemaRows<{ readonly policy_key: string }>(
          pool,
          schema,
          "SELECT policy_key FROM feedback_review_audit",
        ),
      ).toEqual([{ policy_key: "operator-policy-1" }]);
      await expect(
        repository.execute({
          ...archive(itemId, "replace-raw-hold-key"),
          expectedVersion: 2,
          action: "place-legal-hold",
          policyKey: "operator-policy-1",
          reviewAt: new Date(Date.now() + 60_000),
          expiresAt: new Date(Date.now() + 120_000),
        }),
      ).resolves.toMatchObject({ state: "pending", version: 3 });
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});
