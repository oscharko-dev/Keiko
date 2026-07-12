import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  FeedbackPublicationApproveCommandV1,
  FeedbackPublicationCancelCommandV1,
  FeedbackPublicationPrepareCommandV1,
  FeedbackPublicationPreparedResponseV1,
  FeedbackPublicationTargetPolicySnapshotV1,
} from "@oscharko-dev/keiko-contracts/feedback-publication";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresFeedbackPublicationRepository } from "./feedback-publication-store.js";
import type {
  ApprovedFeedbackIssueProjection,
  FeedbackPublicationClaim,
} from "./feedback-publication-types.js";
import { PUBLICATION_RETENTION_BATCH_SIZE } from "./postgres-retention.js";
import { clientAdapter, preparedReport, schemaRows } from "./postgres-integration-helpers.js";
import { PostgresIntakeRepository } from "./postgres.js";
import type { PgClientLike, PgPoolLike, PgQueryResult } from "./postgres-types.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl === undefined ? it.skip : it;
const AT = new Date("2026-07-12T12:00:00.000Z");
const DAY_MS = 86_400_000;
const ACTOR = {
  issuer: "https://issuer.example",
  subject: "publisher-1",
  permissionPolicyVersion: "publish-policy-v1",
} as const;
const TARGET: FeedbackPublicationTargetPolicySnapshotV1 = {
  apiOrigin: "https://api.github.com",
  repositoryId: "123456",
  owner: "oscharko-dev",
  repository: "Keiko",
  installationId: "987654",
  labels: ["source: feedback", "type: user finding"],
  targetKey: "keiko-public-findings",
  labelPolicyVersion: "labels-2026-07",
  targetPolicyVersion: "github-target-v1",
};

async function migration(name: string): Promise<string> {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

async function migrate(client: import("pg").PoolClient, names: readonly string[]): Promise<void> {
  for (const name of names) await client.query(await migration(name));
}

async function createSchema(pool: Pool, prefix: string): Promise<string> {
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await migrate(client, [
      "001_feedback_intake.sql",
      "002_feedback_review.sql",
      "003_feedback_publication.sql",
      "004_feedback_publication_worker.sql",
    ]);
    return schema;
  } finally {
    client.release();
  }
}

function scopedPool(pool: Pool, schema: string): PgPoolLike {
  return {
    connect: async (): Promise<PgClientLike> => {
      const client = await pool.connect();
      await client.query(`SET search_path TO "${schema}"`);
      return clientAdapter(client, []);
    },
  };
}

async function insertReport(
  pool: Pool,
  schema: string,
  title: string,
  createdAt = AT,
  expiresAt = new Date(AT.getTime() + 90 * DAY_MS),
): Promise<{ readonly itemId: string; readonly digest: string; readonly receiptId: string }> {
  const report = preparedReport(title);
  const itemId = randomUUID();
  const groupId = randomUUID();
  const receiptId = randomBytes(16).toString("base64url");
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schema}"`);
    await client.query("INSERT INTO feedback_semantic_groups (id,created_at) VALUES ($1,$2)", [
      groupId,
      createdAt,
    ]);
    await client.query(
      "INSERT INTO feedback_payloads (id,semantic_group_id,exact_body_sha256,canonical_bytes,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [
        itemId,
        groupId,
        report.exactBodySha256,
        report.canonicalBody.copyBytes(),
        createdAt,
        expiresAt,
      ],
    );
    await client.query(
      "INSERT INTO feedback_receipts (id,payload_id,secret_hash,created_at,expires_at) VALUES ($1,$2,$3,$4,$5)",
      [receiptId, itemId, Buffer.alloc(32, 7), createdAt, expiresAt],
    );
    return { itemId, digest: report.exactBodySha256, receiptId };
  } finally {
    client.release();
  }
}

function prepareCommand(
  item: { readonly itemId: string; readonly digest: string },
  key: string,
): FeedbackPublicationPrepareCommandV1 {
  return {
    action: "prepare-publication",
    itemId: item.itemId,
    expectedVersion: 1,
    expectedPayloadDigest: item.digest,
    idempotencyKey: key,
    actor: ACTOR,
    targetKey: TARGET.targetKey,
  };
}

function approveCommand(
  item: { readonly itemId: string; readonly digest: string },
  preparation: Awaited<ReturnType<PostgresFeedbackPublicationRepository["prepare"]>>,
  key: string,
): FeedbackPublicationApproveCommandV1 {
  return {
    action: "approve-publication",
    itemId: item.itemId,
    expectedVersion: 1,
    expectedPayloadDigest: item.digest,
    idempotencyKey: key,
    actor: ACTOR,
    preparationId: preparation.preparationId,
    expectedProjectionDigest: preparation.projectionDigest,
    expectedTargetPolicyDigest: preparation.targetPolicyDigest,
  };
}

function cancelCommand(
  item: { readonly itemId: string; readonly digest: string },
  preparationId: string,
  version: number,
  key: string,
): FeedbackPublicationCancelCommandV1 {
  return {
    action: "cancel-publication-route-private",
    itemId: item.itemId,
    expectedVersion: version,
    expectedPayloadDigest: item.digest,
    idempotencyKey: key,
    actor: ACTOR,
    preparationId,
  };
}

function claimCommand(
  outboxId: string,
  workerId = "publication-worker-1",
  leaseDurationMs = 60_000,
): FeedbackPublicationClaim {
  return { outboxId, workerId, leaseDurationMs };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

async function assertConcurrentClaim(
  pool: Pool,
  schema: string,
  repository: PostgresFeedbackPublicationRepository,
  outboxId: string,
  prepared: FeedbackPublicationPreparedResponseV1,
): Promise<void> {
  const claims = await Promise.allSettled([
    repository.claimApprovedProjection(claimCommand(outboxId, "worker-a")),
    repository.claimApprovedProjection(claimCommand(outboxId, "worker-b")),
  ]);
  expect(claims.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  expect(claims.filter(({ status }) => status === "rejected")).toHaveLength(1);
  const winner = required(
    claims.find(
      (result): result is PromiseFulfilledResult<ApprovedFeedbackIssueProjection | undefined> =>
        result.status === "fulfilled",
    ),
    "Expected one dispatch claimant",
  );
  const projection = required(winner.value, "Expected claimed projection");
  expect(projection).toMatchObject({ title: prepared.title, body: prepared.body });
  const claimedLease = await schemaRows<{
    readonly updated_at: Date;
    readonly lease_expires_at: Date;
  }>(
    pool,
    schema,
    "SELECT updated_at,lease_expires_at FROM feedback_publication_outbox WHERE id=$1",
    [outboxId],
  );
  const lease = required(claimedLease[0], "Expected durable claimed lease");
  expect(lease.lease_expires_at).toEqual(projection.leaseExpiresAt);
  expect(lease.lease_expires_at.getTime() - lease.updated_at.getTime()).toBe(60_000);
  const loser = required(
    claims.find((result): result is PromiseRejectedResult => result.status === "rejected"),
    "Expected one rejected claimant",
  );
  expect(loser.reason).toMatchObject({ code: "claim-unavailable" });
  expect(JSON.stringify(loser.reason)).not.toContain("DISPATCH_CONTENT_SENTINEL");
}

async function expectDeferredConstraintFailure(
  pool: Pool,
  schema: string,
  statements: readonly { readonly sql: string; readonly values?: readonly unknown[] }[],
): Promise<void> {
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query(`SET search_path TO "${schema}"`);
    await client.query("BEGIN");
    for (const statement of statements) {
      await client.query(
        statement.sql,
        statement.values === undefined ? [] : [...statement.values],
      );
    }
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("COMMIT");
  } catch {
    failed = true;
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  expect(failed).toBe(true);
}

async function executeTransaction(
  pool: Pool,
  schema: string,
  statements: readonly { readonly sql: string; readonly values?: readonly unknown[] }[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    for (const statement of statements) {
      await client.query(
        statement.sql,
        statement.values === undefined ? [] : [...statement.values],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function explainPlan(
  pool: Pool,
  schema: string,
  query: string,
  values: readonly unknown[],
  disableSequentialScan = false,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    if (disableSequentialScan) {
      await client.query("SET LOCAL enable_seqscan=off");
      await client.query("SET LOCAL enable_bitmapscan=off");
    }
    const result = await client.query<{ readonly "QUERY PLAN": string }>(
      `EXPLAIN (COSTS OFF) ${query}`,
      [...values],
    );
    await client.query("ROLLBACK");
    return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("PostgreSQL feedback publication integration", () => {
  integration(
    "migrates v2 to v3 and creates a complete fresh v3 schema",
    async (): Promise<void> => {
      const pool = new Pool({ connectionString: databaseUrl });
      const upgraded = `publication_upgrade_${randomUUID().replaceAll("-", "")}`;
      const fresh = `publication_fresh_${randomUUID().replaceAll("-", "")}`;
      try {
        for (const [schema, names] of [
          [upgraded, ["001_feedback_intake.sql", "002_feedback_review.sql"]],
          [
            fresh,
            ["001_feedback_intake.sql", "002_feedback_review.sql", "003_feedback_publication.sql"],
          ],
        ] as const) {
          const client = await pool.connect();
          try {
            await client.query(`CREATE SCHEMA "${schema}"`);
            await client.query(`SET search_path TO "${schema}"`);
            await migrate(client, names);
            if (schema === upgraded)
              await client.query(await migration("003_feedback_publication.sql"));
          } finally {
            client.release();
          }
          expect(
            await schemaRows(
              pool,
              schema,
              "SELECT version FROM feedback_schema_migrations ORDER BY version",
            ),
          ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
          expect(
            await schemaRows(
              pool,
              schema,
              "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'feedback_publication_%' ORDER BY table_name",
              [schema],
            ),
          ).toHaveLength(4);
        }
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${upgraded}" CASCADE`);
        await pool.query(`DROP SCHEMA IF EXISTS "${fresh}" CASCADE`);
        await pool.end();
      }
    },
  );

  integration(
    "serializes concurrent prepare/approve replay and atomically closes receipts",
    async (): Promise<void> => {
      const pool = new Pool({ connectionString: databaseUrl, max: 8 });
      const schema = await createSchema(pool, "publication_concurrent");
      const item = await insertReport(pool, schema, "Concurrent publication");
      const repository = new PostgresFeedbackPublicationRepository(
        scopedPool(pool, schema),
        ACTOR.permissionPolicyVersion,
        () => TARGET,
        2_000,
        () => AT,
        () => new Uint8Array(32).fill(4),
      );
      try {
        const prepared = await Promise.all([
          repository.prepare(prepareCommand(item, "prepare-concurrent-key")),
          repository.prepare(prepareCommand(item, "prepare-concurrent-key")),
        ]);
        expect(prepared.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
        expect(new Set(prepared.map(({ preparationId }) => preparationId))).toHaveLength(1);
        const first = prepared[0];
        expect(first.targetDisplay).toEqual({
          owner: TARGET.owner,
          repository: TARGET.repository,
          labels: TARGET.labels,
          labelPolicyVersion: TARGET.labelPolicyVersion,
          targetPolicyVersion: TARGET.targetPolicyVersion,
        });
        expect(JSON.stringify(first)).not.toContain(TARGET.installationId);
        expect(JSON.stringify(first)).not.toContain(TARGET.repositoryId);
        const approvals = await Promise.all([
          repository.approve(approveCommand(item, first, "approve-concurrent-key")),
          repository.approve(approveCommand(item, first, "approve-concurrent-key")),
        ]);
        expect(approvals.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
        expect(approvals[0]).toMatchObject({ status: "approved", recordVersion: 2 });
        expect(
          await repository.claimApprovedProjection(
            claimCommand(approvals[0].status === "approved" ? approvals[0].outboxId : ""),
          ),
        ).toMatchObject({
          title: first.title,
          body: first.body,
          targetPolicyDigest: first.targetPolicyDigest,
        });
        expect(
          await new PostgresIntakeRepository(scopedPool(pool, schema)).findReceipt(item.receiptId),
        ).toMatchObject({ closed: true });
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT state,version,approval_record_version FROM feedback_review_items WHERE id=$1",
            [item.itemId],
          ),
        ).toEqual([{ state: "approved", version: 2, approval_record_version: 2 }]);
        expect(
          await schemaRows(pool, schema, "SELECT idempotency_key FROM feedback_publication_outbox"),
        ).toEqual([
          {
            idempotency_key: createHash("sha256")
              .update("keiko-feedback-publication-outbox-v1")
              .update("\0")
              .update(item.itemId)
              .update("\0")
              .update(first.projectionDigest)
              .update("\0")
              .update(first.targetPolicyDigest)
              .digest("hex"),
          },
        ]);
        expect(
          await schemaRows(pool, schema, "SELECT event_id FROM feedback_publication_audit"),
        ).toHaveLength(2);
        expect(
          JSON.stringify(
            await schemaRows(pool, schema, "SELECT * FROM feedback_publication_outbox"),
          ),
        ).not.toContain("Concurrent publication");
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
      }
    },
  );

  integration(
    "fails closed for target, private, expiry, CAS, digest, policy, and projection drift",
    async (): Promise<void> => {
      const pool = new Pool({ connectionString: databaseUrl, max: 6 });
      const schema = await createSchema(pool, "publication_negative");
      let target = TARGET;
      let now = AT;
      const repository = new PostgresFeedbackPublicationRepository(
        scopedPool(pool, schema),
        ACTOR.permissionPolicyVersion,
        () => target,
        2_000,
        () => now,
      );
      try {
        const rawTargetItem = await insertReport(pool, schema, "Raw target rejected");
        const rawTargetCommand = prepareCommand(rawTargetItem, "raw-target-rejected-key");
        for (const raw of [
          { owner: TARGET.owner },
          { repository: TARGET.repository },
          { repositoryId: TARGET.repositoryId },
          { installationId: TARGET.installationId },
          { labels: TARGET.labels },
          { target: TARGET },
        ]) {
          await expect(repository.prepare({ ...rawTargetCommand, ...raw })).rejects.toMatchObject({
            code: "invalid-request",
          });
        }
        const maximumTarget = {
          ...TARGET,
          targetKey: "t".repeat(100),
          labelPolicyVersion: "l".repeat(64),
          targetPolicyVersion: "p".repeat(128),
        } as const;
        target = maximumTarget;
        const maximumItem = await insertReport(pool, schema, "Maximum target policy fields");
        const maximumPrepared = await repository.prepare({
          ...prepareCommand(maximumItem, "maximum-target-prepare"),
          targetKey: maximumTarget.targetKey,
        });
        await expect(
          repository.approve(
            approveCommand(maximumItem, maximumPrepared, "maximum-target-approve"),
          ),
        ).resolves.toMatchObject({ status: "approved" });
        await expect(
          repository.prepare({
            ...prepareCommand(rawTargetItem, "target-key-over-limit"),
            targetKey: "t".repeat(101),
          }),
        ).rejects.toMatchObject({ code: "invalid-request" });
        target = { ...TARGET, labelPolicyVersion: "l".repeat(65) };
        await expect(
          repository.prepare(prepareCommand(rawTargetItem, "label-policy-over-limit")),
        ).rejects.toMatchObject({ code: "target-policy-drift" });
        target = TARGET;
        const drift = await insertReport(pool, schema, "Target drift");
        const prepared = await repository.prepare(prepareCommand(drift, "target-drift-prepare"));
        await expect(
          repository.approve({
            ...approveCommand(drift, prepared, "projection-digest-mismatch"),
            expectedProjectionDigest: "0".repeat(64),
          }),
        ).rejects.toMatchObject({ code: "cas-mismatch" });
        target = { ...TARGET, installationId: "987655" };
        await expect(
          repository.approve(approveCommand(drift, prepared, "target-drift-approve")),
        ).rejects.toMatchObject({ code: "target-policy-drift" });
        target = TARGET;
        const privateItem = await insertReport(pool, schema, "Private item");
        await schemaRows(
          pool,
          schema,
          "UPDATE feedback_review_items SET state='private-security' WHERE id=$1",
          [privateItem.itemId],
        );
        await expect(
          repository.prepare(prepareCommand(privateItem, "private-item-prepare")),
        ).rejects.toMatchObject({ code: "payload-private" });
        const privateApproval = await insertReport(pool, schema, "Private after preparation");
        const privatePrepared = await repository.prepare(
          prepareCommand(privateApproval, "private-approval-prepare"),
        );
        await schemaRows(
          pool,
          schema,
          "UPDATE feedback_review_items SET state='private-security' WHERE id=$1",
          [privateApproval.itemId],
        );
        await expect(
          repository.approve(
            approveCommand(privateApproval, privatePrepared, "private-approval-command"),
          ),
        ).rejects.toMatchObject({ code: "payload-private" });
        const expired = await insertReport(
          pool,
          schema,
          "Expired after preparation",
          AT,
          new Date(AT.getTime() + DAY_MS),
        );
        const expiredPrepared = await repository.prepare(
          prepareCommand(expired, "expired-approval-prepare"),
        );
        now = new Date(AT.getTime() + 2 * DAY_MS);
        await expect(
          repository.approve(approveCommand(expired, expiredPrepared, "expired-approval-command")),
        ).rejects.toMatchObject({ code: "payload-expired" });
        now = AT;
        const stale = await insertReport(pool, schema, "Stale");
        const stalePrepared = await repository.prepare(prepareCommand(stale, "stale-prepare-key"));
        await expect(
          repository.approve({
            ...approveCommand(stale, stalePrepared, "stale-version-key"),
            expectedVersion: 2,
          }),
        ).rejects.toMatchObject({ code: "cas-mismatch" });
        await expect(
          repository.approve({
            ...approveCommand(stale, stalePrepared, "digest-mismatch-key"),
            expectedPayloadDigest: "0".repeat(64),
          }),
        ).rejects.toMatchObject({ code: "cas-mismatch" });
        await expect(
          repository.approve({
            ...approveCommand(stale, stalePrepared, "policy-mismatch-key"),
            actor: { ...ACTOR, permissionPolicyVersion: "old-policy" },
          }),
        ).rejects.toMatchObject({ code: "permission-denied" });
        const corrupt = await insertReport(pool, schema, "Projection drift");
        const corruptPrepared = await repository.prepare(
          prepareCommand(corrupt, "projection-drift-prepare"),
        );
        await schemaRows(
          pool,
          schema,
          "ALTER TABLE feedback_payloads DISABLE TRIGGER feedback_payload_content_immutable",
        );
        await schemaRows(
          pool,
          schema,
          "UPDATE feedback_payloads SET canonical_bytes=$2 WHERE id=$1",
          [corrupt.itemId, Buffer.from("{}")],
        );
        await schemaRows(
          pool,
          schema,
          "ALTER TABLE feedback_payloads ENABLE TRIGGER feedback_payload_content_immutable",
        );
        await expect(
          repository.approve(approveCommand(corrupt, corruptPrepared, "projection-drift-approve")),
        ).rejects.toMatchObject({ code: "projection-drift" });

        const replaySentinel = "REPLAY_CONTENT_SENTINEL";
        const replayItem = await insertReport(pool, schema, replaySentinel);
        const replayPrepared = await repository.prepare(
          prepareCommand(replayItem, "sentinel-replay-key"),
        );
        target = { ...TARGET, labels: [...TARGET.labels, "drift"] };
        const driftReplay = await repository
          .prepare(prepareCommand(replayItem, "sentinel-replay-key"))
          .catch((error: unknown) => error);
        expect(driftReplay).toMatchObject({ code: "target-policy-drift" });
        expect(JSON.stringify(driftReplay)).not.toContain(replaySentinel);
        target = TARGET;
        await schemaRows(
          pool,
          schema,
          "UPDATE feedback_review_items SET state='private-security' WHERE id=$1",
          [replayItem.itemId],
        );
        const privateReplay = await repository
          .prepare(prepareCommand(replayItem, "sentinel-replay-key"))
          .catch((error: unknown) => error);
        expect(privateReplay).toMatchObject({ code: "payload-private" });
        expect(JSON.stringify(privateReplay)).not.toContain(replayPrepared.title);

        const expiredReplayItem = await insertReport(
          pool,
          schema,
          "EXPIRED_REPLAY_SENTINEL",
          AT,
          new Date(AT.getTime() + DAY_MS),
        );
        const expiredReplayCommand = prepareCommand(
          expiredReplayItem,
          "expired-prepare-replay-key",
        );
        await repository.prepare(expiredReplayCommand);
        now = new Date(AT.getTime() + 2 * DAY_MS);
        const expiredReplay = await repository
          .prepare(expiredReplayCommand)
          .catch((error: unknown) => error);
        expect(expiredReplay).toMatchObject({ code: "payload-expired" });
        expect(JSON.stringify(expiredReplay)).not.toContain("EXPIRED_REPLAY_SENTINEL");
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
      }
    },
  );

  integration(
    "revalidates every target field and outbox state before dispatch bytes are returned",
    async (): Promise<void> => {
      const pool = new Pool({ connectionString: databaseUrl });
      const schema = await createSchema(pool, "publication_dispatch");
      let target: FeedbackPublicationTargetPolicySnapshotV1 | undefined = TARGET;
      const now = AT;
      const repository = new PostgresFeedbackPublicationRepository(
        scopedPool(pool, schema),
        ACTOR.permissionPolicyVersion,
        () => target,
        2_000,
        () => now,
      );
      try {
        const item = await insertReport(pool, schema, "DISPATCH_CONTENT_SENTINEL");
        const prepared = await repository.prepare(prepareCommand(item, "dispatch-prepare-key"));
        const approval = await repository.approve(
          approveCommand(item, prepared, "dispatch-approve-key"),
        );
        if (approval.status !== "approved") throw new Error("Expected approval");
        for (const claim of [
          claimCommand(approval.outboxId, "", 60_000),
          claimCommand(approval.outboxId, "w".repeat(65), 60_000),
          claimCommand(approval.outboxId, "worker", 999),
          claimCommand(approval.outboxId, "worker", 300_001),
        ]) {
          await expect(repository.claimApprovedProjection(claim)).rejects.toMatchObject({
            code: "invalid-request",
          });
        }
        const variants: readonly unknown[] = [
          { ...TARGET, apiOrigin: "https://example.invalid" },
          { ...TARGET, repositoryId: "123457" },
          { ...TARGET, owner: "other-owner" },
          { ...TARGET, repository: "Other" },
          { ...TARGET, installationId: "987655" },
          { ...TARGET, labels: [...TARGET.labels, "drift"] },
          { ...TARGET, targetKey: "remapped-alias" },
          { ...TARGET, labelPolicyVersion: "labels-2026-08" },
          { ...TARGET, targetPolicyVersion: "github-target-v2" },
          undefined,
        ];
        for (const variant of variants) {
          target = variant as FeedbackPublicationTargetPolicySnapshotV1 | undefined;
          const failure = await repository
            .claimApprovedProjection(claimCommand(approval.outboxId))
            .catch((error: unknown) => error);
          expect(failure).toMatchObject({ code: "target-policy-drift" });
          expect(JSON.stringify(failure)).not.toContain("DISPATCH_CONTENT_SENTINEL");
        }
        target = TARGET;
        await assertConcurrentClaim(pool, schema, repository, approval.outboxId, prepared);
        await schemaRows(
          pool,
          schema,
          "UPDATE feedback_publication_outbox SET status='unclaimed',lease_owner=NULL,lease_expires_at=NULL,created_at=clock_timestamp()-interval '2 seconds',updated_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [approval.outboxId],
        );
        await expect(
          repository.claimApprovedProjection(claimCommand(approval.outboxId, "worker-d")),
        ).rejects.toMatchObject({ code: "payload-expired" });
        await executeTransaction(pool, schema, [
          {
            sql: "UPDATE feedback_publication_outbox SET status='may-have-committed',create_eligible=false,create_attempt_count=1 WHERE id=$1",
            values: [approval.outboxId],
          },
          {
            sql: "UPDATE feedback_publication_preparations SET create_armed_at=$2 WHERE id=$1",
            values: [prepared.preparationId, AT],
          },
        ]);
        const claimed = await repository
          .claimApprovedProjection(claimCommand(approval.outboxId, "worker-c"))
          .catch((error: unknown) => error);
        expect(claimed).toMatchObject({ code: "claim-unavailable" });
        expect(JSON.stringify(claimed)).not.toContain("DISPATCH_CONTENT_SENTINEL");
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
      }
    },
  );

  integration(
    "starts full leases after lock wait, rejects non-fitting leases, and refreshes time on retry",
    async (): Promise<void> => {
      const pool = new Pool({ connectionString: databaseUrl, max: 8 });
      const schema = await createSchema(pool, "publication_lease_time");
      const repository = new PostgresFeedbackPublicationRepository(
        scopedPool(pool, schema),
        ACTOR.permissionPolicyVersion,
        () => TARGET,
        4_000,
        () => AT,
      );
      try {
        const lockedItem = await insertReport(pool, schema, "LOCK_WAIT_CONTENT_SENTINEL");
        const lockedPrepared = await repository.prepare(
          prepareCommand(lockedItem, "lock-wait-prepare-key"),
        );
        const lockedApproval = await repository.approve(
          approveCommand(lockedItem, lockedPrepared, "lock-wait-approve-key"),
        );
        if (lockedApproval.status !== "approved") throw new Error("Expected approval");
        const locker = await pool.connect();
        let releasedAt: Date;
        try {
          await locker.query(`SET search_path TO "${schema}"`);
          await locker.query("BEGIN");
          await locker.query("SELECT id FROM feedback_publication_outbox WHERE id=$1 FOR UPDATE", [
            lockedApproval.outboxId,
          ]);
          const claimPromise = repository.claimApprovedProjection(
            claimCommand(lockedApproval.outboxId, "lock-wait-worker", 1_000),
          );
          await delay(1_100);
          releasedAt =
            (
              await locker.query<{ readonly database_now: Date }>(
                "SELECT clock_timestamp() AS database_now",
              )
            ).rows[0]?.database_now ?? new Date(0);
          await locker.query("COMMIT");
          const claimed = await claimPromise;
          if (claimed === undefined) throw new Error("Expected post-lock claim");
          expect(claimed.leaseExpiresAt.getTime() - releasedAt.getTime()).toBeGreaterThanOrEqual(
            900,
          );
          const postClaimClock = await schemaRows<{ readonly database_now: Date }>(
            pool,
            schema,
            "SELECT clock_timestamp() AS database_now",
          );
          expect(
            claimed.leaseExpiresAt > (postClaimClock[0]?.database_now ?? claimed.leaseExpiresAt),
          ).toBe(true);
        } finally {
          await locker.query("ROLLBACK").catch(() => undefined);
          locker.release();
        }

        await expectDeferredConstraintFailure(pool, schema, [
          {
            sql: "UPDATE feedback_publication_outbox SET status='claimed',lease_owner='direct-worker',updated_at=expires_at - interval '1 minute',lease_expires_at=expires_at + interval '1 millisecond' WHERE id=$1",
            values: [lockedApproval.outboxId],
          },
        ]);

        const nearItem = await insertReport(pool, schema, "NEAR_EXPIRY_CONTENT_SENTINEL");
        const nearPrepared = await repository.prepare(
          prepareCommand(nearItem, "near-expiry-prepare-key"),
        );
        const nearApproval = await repository.approve(
          approveCommand(nearItem, nearPrepared, "near-expiry-approve-key"),
        );
        if (nearApproval.status !== "approved") throw new Error("Expected approval");
        await schemaRows(
          pool,
          schema,
          "UPDATE feedback_publication_outbox SET created_at=clock_timestamp()-interval '1 second',updated_at=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()+interval '5 seconds' WHERE id=$1",
          [nearApproval.outboxId],
        );
        const nearFailure = await repository
          .claimApprovedProjection(claimCommand(nearApproval.outboxId, "near-worker", 6_000))
          .catch((error: unknown) => error);
        expect(nearFailure).toMatchObject({ code: "claim-unavailable" });
        expect(JSON.stringify(nearFailure)).not.toContain("NEAR_EXPIRY_CONTENT_SENTINEL");
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT status,lease_owner,lease_expires_at FROM feedback_publication_outbox WHERE id=$1",
            [nearApproval.outboxId],
          ),
        ).toEqual([{ status: "unclaimed", lease_owner: null, lease_expires_at: null }]);

        const retryItem = await insertReport(pool, schema, "Serialization retry lease");
        const retryPrepared = await repository.prepare(
          prepareCommand(retryItem, "retry-lease-prepare-key"),
        );
        const retryApproval = await repository.approve(
          approveCommand(retryItem, retryPrepared, "retry-lease-approve-key"),
        );
        if (retryApproval.status !== "approved") throw new Error("Expected approval");
        let injected = false;
        let clockSamples = 0;
        const retryPool: PgPoolLike = {
          connect: async (): Promise<PgClientLike> => {
            const raw = await pool.connect();
            await raw.query(`SET search_path TO "${schema}"`);
            const adapted = clientAdapter(raw, []);
            return {
              query: <Row extends object>(
                text: string,
                values: readonly unknown[] = [],
              ): Promise<PgQueryResult<Row>> => {
                if (text === "SELECT clock_timestamp() AS database_now") clockSamples += 1;
                if (
                  !injected &&
                  text.startsWith("UPDATE feedback_publication_outbox SET status='claimed'")
                ) {
                  injected = true;
                  return Promise.reject(
                    Object.assign(new Error("injected serialization"), { code: "40001" }),
                  );
                }
                return adapted.query<Row>(text, values);
              },
              release: (): void => {
                adapted.release();
              },
            };
          },
        };
        const retryRepository = new PostgresFeedbackPublicationRepository(
          retryPool,
          ACTOR.permissionPolicyVersion,
          () => TARGET,
          2_000,
          () => AT,
        );
        const retryClaim = await retryRepository.claimApprovedProjection(
          claimCommand(retryApproval.outboxId, "retry-worker", 60_000),
        );
        expect(retryClaim).toMatchObject({ leaseOwner: "retry-worker" });
        expect(clockSamples).toBe(2);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
      }
    },
  );

  integration(
    "rejects direct SQL review and linkage identity mismatches at commit",
    async (): Promise<void> => {
      const pool = new Pool({ connectionString: databaseUrl });
      const schema = await createSchema(pool, "publication_constraints");
      const repository = new PostgresFeedbackPublicationRepository(
        scopedPool(pool, schema),
        ACTOR.permissionPolicyVersion,
        () => TARGET,
        2_000,
        () => AT,
      );
      try {
        const item = await insertReport(pool, schema, "Constraint binding");
        const other = await insertReport(pool, schema, "Constraint other item");
        const prepared = await repository.prepare(prepareCommand(item, "constraint-prepare-key"));
        await repository.approve(approveCommand(item, prepared, "constraint-approve-key"));
        const mutations = [
          {
            sql: "UPDATE feedback_publication_preparations SET item_id=$2 WHERE id=$1",
            values: [prepared.preparationId, other.itemId],
          },
          {
            sql: "UPDATE feedback_publication_preparations SET payload_digest=$2 WHERE id=$1",
            values: [prepared.preparationId, "0".repeat(64)],
          },
          {
            sql: "UPDATE feedback_publication_preparations SET projection_digest=$2 WHERE id=$1",
            values: [prepared.preparationId, "1".repeat(64)],
          },
          {
            sql: "UPDATE feedback_publication_preparations SET target_policy_digest=$2 WHERE id=$1",
            values: [prepared.preparationId, "2".repeat(64)],
          },
          {
            sql: "UPDATE feedback_publication_preparations SET status='cancelled-private',cancelled_at=$2 WHERE id=$1",
            values: [prepared.preparationId, AT],
          },
          {
            sql: "UPDATE feedback_publication_preparations SET source_record_version=2 WHERE id=$1",
            values: [prepared.preparationId],
          },
        ] as const;
        for (const mutation of mutations) {
          await expectDeferredConstraintFailure(pool, schema, [
            {
              sql: "ALTER TABLE feedback_publication_preparations DISABLE TRIGGER feedback_publication_preparation_immutable",
            },
            mutation,
          ]);
        }
        for (const labels of [["duplicate", "duplicate"], ["control\nlabel"], ["x".repeat(51)]]) {
          await expectDeferredConstraintFailure(pool, schema, [
            {
              sql: "ALTER TABLE feedback_publication_preparations DISABLE TRIGGER feedback_publication_preparation_immutable",
            },
            {
              sql: "UPDATE feedback_publication_preparations SET target_labels=$2 WHERE id=$1",
              values: [prepared.preparationId, labels],
            },
          ]);
        }

        const linkageSql =
          "INSERT INTO feedback_github_issue_linkage (item_id,preparation_id,target_policy_digest,github_repository_id,github_issue_node_id,github_issue_number,linked_at,expires_at) VALUES ($1,$2,$3,$4,$5,42,$6,$6::timestamptz + interval '365 days')";
        const linkageValues = [
          item.itemId,
          prepared.preparationId,
          prepared.targetPolicyDigest,
          TARGET.repositoryId,
          "constraint-node",
          AT,
        ] as const;
        await executeTransaction(pool, schema, [
          {
            sql: "UPDATE feedback_publication_outbox SET status='succeeded',create_eligible=false,create_attempt_count=1 WHERE preparation_id=$1",
            values: [prepared.preparationId],
          },
          {
            sql: "UPDATE feedback_publication_preparations SET create_armed_at=$2 WHERE id=$1",
            values: [prepared.preparationId, AT],
          },
        ]);
        for (const [index, value] of [
          [0, other.itemId],
          [1, randomUUID()],
          [2, "3".repeat(64)],
          [3, "123457"],
        ] as const) {
          const values = [...linkageValues];
          values[index] = value;
          values[4] = `constraint-node-${String(index)}`;
          await expectDeferredConstraintFailure(pool, schema, [{ sql: linkageSql, values }]);
        }
        await schemaRows(pool, schema, linkageSql, linkageValues);
        await expect(repository.linkage(item.itemId)).resolves.toMatchObject({
          preparationId: prepared.preparationId,
          targetPolicyDigest: prepared.targetPolicyDigest,
          repositoryId: TARGET.repositoryId,
        });
        const receiptIndexes = await schemaRows<{ readonly indexdef: string }>(
          pool,
          schema,
          "SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='feedback_receipts_payload_idx'",
          [schema],
        );
        expect(receiptIndexes[0]?.indexdef).toContain("(payload_id)");
        const expiryIndexes = await schemaRows<{
          readonly indexname: string;
          readonly indexdef: string;
        }>(
          pool,
          schema,
          "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname IN ('feedback_publication_preparation_expiry_idx','feedback_publication_outbox_expiry_idx','feedback_github_issue_linkage_expiry_idx','feedback_publication_idempotency_expiry_idx','feedback_publication_audit_expiry_idx','feedback_review_items_approval_preparation_idx') ORDER BY indexname",
          [schema],
        );
        const indexDefinitions = new Map(
          expiryIndexes.map(({ indexname, indexdef }) => [indexname, indexdef]),
        );
        expect(indexDefinitions.get("feedback_publication_preparation_expiry_idx")).toContain(
          "(expires_at, id)",
        );
        expect(indexDefinitions.get("feedback_publication_outbox_expiry_idx")).toContain(
          "(expires_at, id)",
        );
        expect(indexDefinitions.get("feedback_github_issue_linkage_expiry_idx")).toContain(
          "(expires_at, item_id)",
        );
        expect(indexDefinitions.get("feedback_publication_idempotency_expiry_idx")).toContain(
          "(expires_at, idempotency_key)",
        );
        expect(indexDefinitions.get("feedback_publication_audit_expiry_idx")).toContain(
          "(expires_at, event_id)",
        );
        expect(indexDefinitions.get("feedback_review_items_approval_preparation_idx")).toContain(
          "(approval_preparation_id)",
        );

        await schemaRows(
          pool,
          schema,
          "BEGIN; CREATE TEMP TABLE publication_plan_rows (payload_id uuid,group_id uuid) ON COMMIT DROP; INSERT INTO publication_plan_rows SELECT gen_random_uuid(),gen_random_uuid() FROM generate_series(1,2000); INSERT INTO feedback_semantic_groups (id,created_at) SELECT group_id,'2026-07-12T12:00:00.000Z'::timestamptz FROM publication_plan_rows; INSERT INTO feedback_payloads (id,semantic_group_id,exact_body_sha256,canonical_bytes,created_at,expires_at) SELECT payload_id,group_id,repeat('f',64),decode('7b7d','hex'),'2026-07-12T12:00:00.000Z'::timestamptz,'2026-10-10T12:00:00.000Z'::timestamptz FROM publication_plan_rows; ANALYZE feedback_review_items; COMMIT",
        );
        const approvalPlan = await explainPlan(
          pool,
          schema,
          "SELECT 1 FROM feedback_review_items WHERE approval_preparation_id=$1",
          [prepared.preparationId],
        );
        expect(approvalPlan).toContain("feedback_review_items_approval_preparation_idx");

        const batchPlans = [
          [
            "feedback_publication_preparation_expiry_idx",
            "SELECT id FROM feedback_publication_preparations WHERE expires_at <= $1 AND NOT EXISTS (SELECT 1 FROM feedback_review_items item WHERE item.approval_preparation_id=feedback_publication_preparations.id AND item.state='approved') ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT 100",
          ],
          [
            "feedback_publication_outbox_expiry_idx",
            "SELECT id FROM feedback_publication_outbox WHERE expires_at <= $1 ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT 100",
          ],
          [
            "feedback_github_issue_linkage_expiry_idx",
            "SELECT item_id FROM feedback_github_issue_linkage WHERE expires_at <= $1 ORDER BY expires_at,item_id FOR UPDATE SKIP LOCKED LIMIT 100",
          ],
          [
            "feedback_publication_idempotency_expiry_idx",
            "SELECT idempotency_key FROM feedback_publication_idempotency WHERE expires_at <= $1 ORDER BY expires_at,idempotency_key FOR UPDATE SKIP LOCKED LIMIT 100",
          ],
          [
            "feedback_publication_audit_expiry_idx",
            "SELECT event_id FROM feedback_publication_audit WHERE expires_at <= $1 ORDER BY expires_at,event_id FOR UPDATE SKIP LOCKED LIMIT 100",
          ],
        ] as const;
        for (const [indexName, query] of batchPlans) {
          const plan = await explainPlan(pool, schema, query, [AT], true);
          expect(plan).toContain(indexName);
          expect(plan).not.toContain("Sort");
        }
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
      }
    },
  );

  integration(
    "rolls approval back completely when an audit insert fails",
    async (): Promise<void> => {
      const pool = new Pool({ connectionString: databaseUrl });
      const schema = await createSchema(pool, "publication_rollback");
      const item = await insertReport(pool, schema, "Rollback sentinel");
      const repository = new PostgresFeedbackPublicationRepository(
        scopedPool(pool, schema),
        ACTOR.permissionPolicyVersion,
        () => TARGET,
        2_000,
        () => AT,
      );
      try {
        const prepared = await repository.prepare(prepareCommand(item, "rollback-prepare-key"));
        await schemaRows(
          pool,
          schema,
          "CREATE FUNCTION reject_publication_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='approve-publication' THEN RAISE EXCEPTION 'injected approval failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_publication_approval BEFORE INSERT ON feedback_publication_audit FOR EACH ROW EXECUTE FUNCTION reject_publication_approval()",
        );
        await expect(
          repository.approve(approveCommand(item, prepared, "rollback-approve-key")),
        ).rejects.toThrow("injected approval failure");
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT state,version FROM feedback_review_items WHERE id=$1",
            [item.itemId],
          ),
        ).toEqual([{ state: "pending", version: 1 }]);
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT status FROM feedback_publication_preparations WHERE id=$1",
            [prepared.preparationId],
          ),
        ).toEqual([{ status: "prepared" }]);
        expect(
          await schemaRows(pool, schema, "SELECT id FROM feedback_publication_outbox"),
        ).toEqual([]);
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT closed FROM feedback_receipts WHERE payload_id=$1",
            [item.itemId],
          ),
        ).toEqual([{ closed: false }]);
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT idempotency_key FROM feedback_publication_idempotency WHERE action='approve-publication'",
          ),
        ).toEqual([]);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
      }
    },
  );

  integration(
    "purges approved content after 30 days, honors legal hold, and drains publication batches",
    async (): Promise<void> => {
      const pool = new Pool({ connectionString: databaseUrl });
      const schema = await createSchema(pool, "publication_retention");
      const repository = new PostgresFeedbackPublicationRepository(
        scopedPool(pool, schema),
        ACTOR.permissionPolicyVersion,
        () => TARGET,
        2_000,
        () => AT,
      );
      const retention = new PostgresIntakeRepository(scopedPool(pool, schema));
      try {
        const ordinary = await insertReport(pool, schema, "Approved purge");
        const ordinaryPrepared = await repository.prepare(
          prepareCommand(ordinary, "retention-ordinary-prepare"),
        );
        await repository.approve(
          approveCommand(ordinary, ordinaryPrepared, "retention-ordinary-approve"),
        );
        const held = await insertReport(pool, schema, "Approved legal hold");
        const heldPrepared = await repository.prepare(
          prepareCommand(held, "retention-held-prepare"),
        );
        await repository.approve(approveCommand(held, heldPrepared, "retention-held-approve"));
        const pending = await insertReport(pool, schema, "Pending preparation purge");
        const pendingPrepared = await repository.prepare(
          prepareCommand(pending, "retention-pending-prepare"),
        );
        const cancelled = await insertReport(pool, schema, "Cancelled preparation purge");
        const cancelledPrepared = await repository.prepare(
          prepareCommand(cancelled, "retention-cancelled-prepare"),
        );
        await repository.cancelAndRoutePrivate(
          cancelCommand(
            cancelled,
            cancelledPrepared.preparationId,
            1,
            "retention-cancelled-command",
          ),
        );
        await schemaRows(
          pool,
          schema,
          "INSERT INTO feedback_legal_holds (item_id,policy_key,placed_at,review_at,expires_at,actor_issuer,actor_sub,permission_policy_version) VALUES ($1,'publication-retention',$2,$3,$4,$5,$6,$7)",
          [
            held.itemId,
            AT,
            new Date(AT.getTime() + 10 * DAY_MS),
            new Date(AT.getTime() + 60 * DAY_MS),
            ACTOR.issuer,
            ACTOR.subject,
            ACTOR.permissionPolicyVersion,
          ],
        );
        await expect(retention.purge(new Date(AT.getTime() + 31 * DAY_MS))).resolves.toBeDefined();
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT (SELECT count(*)::int FROM feedback_payloads WHERE id=$1) AS payloads,(SELECT count(*)::int FROM feedback_review_items WHERE id=$1) AS reviews,(SELECT count(*)::int FROM feedback_publication_preparations WHERE id=$2) AS preparations,(SELECT count(*)::int FROM feedback_receipts WHERE payload_id=$1) AS receipts",
            [ordinary.itemId, ordinaryPrepared.preparationId],
          ),
        ).toEqual([{ payloads: 0, reviews: 0, preparations: 0, receipts: 0 }]);
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT (SELECT count(*)::int FROM feedback_payloads WHERE id=$1) AS payloads,(SELECT count(*)::int FROM feedback_review_items WHERE id=$1) AS reviews,(SELECT count(*)::int FROM feedback_publication_preparations WHERE id=$2) AS preparations,(SELECT count(*)::int FROM feedback_publication_outbox WHERE preparation_id=$2) AS outboxes,(SELECT count(*)::int FROM feedback_receipts WHERE payload_id=$1) AS receipts",
            [held.itemId, heldPrepared.preparationId],
          ),
        ).toEqual([{ payloads: 1, reviews: 1, preparations: 1, outboxes: 0, receipts: 0 }]);
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT count(*)::int AS preparations FROM feedback_publication_preparations WHERE id IN ($1,$2)",
            [pendingPrepared.preparationId, cancelledPrepared.preparationId],
          ),
        ).toEqual([{ preparations: 0 }]);
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT count(*)::int AS audits FROM feedback_publication_audit WHERE item_id IN ($1,$2)",
            [ordinary.itemId, held.itemId],
          ),
        ).toEqual([{ audits: 4 }]);
        await expect(retention.purge(new Date(AT.getTime() + 61 * DAY_MS))).resolves.toBeDefined();
        expect(
          await schemaRows(pool, schema, "SELECT id FROM feedback_payloads WHERE id=$1", [
            held.itemId,
          ]),
        ).toEqual([]);

        const batchCount = PUBLICATION_RETENTION_BATCH_SIZE + 1;
        await schemaRows(
          pool,
          schema,
          "DELETE FROM feedback_publication_audit; DELETE FROM feedback_deletion_ledger WHERE class_code='publication-audit'",
        );
        await schemaRows(
          pool,
          schema,
          "INSERT INTO feedback_publication_audit (item_id,preparation_id,payload_digest,projection_digest,target_policy_digest,prior_version,result_version,action,result_status,event_at,actor_issuer,actor_sub,permission_policy_version,expires_at) SELECT gen_random_uuid(),gen_random_uuid(),repeat('a',64),repeat('b',64),repeat('c',64),1,1,'prepare-publication','prepared',$1,'issuer','subject','policy',$1::timestamptz + interval '365 days' FROM generate_series(1,$2)",
          [AT, batchCount],
        );
        const cutoff = new Date(AT.getTime() + 366 * DAY_MS);
        const first = await retention.purge(cutoff);
        expect(first[2]).toBe(PUBLICATION_RETENTION_BATCH_SIZE);
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT class_code FROM feedback_deletion_ledger WHERE class_code='publication-audit'",
          ),
        ).toEqual([]);
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT count(*)::int AS remaining FROM feedback_publication_audit WHERE expires_at <= $1",
            [cutoff],
          ),
        ).toEqual([{ remaining: 1 }]);
        const second = await retention.purge(cutoff);
        expect(second[2]).toBe(1);
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT deleted_count FROM feedback_deletion_ledger WHERE class_code='publication-audit'",
          ),
        ).toEqual([{ deleted_count: 1 }]);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
      }
    },
  );

  integration(
    "cancels before claim, routes claimed work to manual reconciliation, and purges publication classes",
    async (): Promise<void> => {
      const pool = new Pool({ connectionString: databaseUrl, max: 6 });
      const schema = await createSchema(pool, "publication_cancel");
      const repository = new PostgresFeedbackPublicationRepository(
        scopedPool(pool, schema),
        ACTOR.permissionPolicyVersion,
        () => TARGET,
        2_000,
        () => AT,
      );
      try {
        const beforeClaim = await insertReport(pool, schema, "Cancel before claim");
        const beforePrepareCommand = prepareCommand(beforeClaim, "cancel-before-prepare");
        const beforePrepared = await repository.prepare(beforePrepareCommand);
        await expect(
          repository.cancelAndRoutePrivate(
            cancelCommand(beforeClaim, beforePrepared.preparationId, 1, "cancel-before-command"),
          ),
        ).resolves.toMatchObject({ status: "cancelled-private", recordVersion: 2 });
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT r.closed,r.closed_at,r.expires_at,p.expires_at AS payload_expires_at FROM feedback_receipts r JOIN feedback_payloads p ON p.id=r.payload_id WHERE r.payload_id=$1",
            [beforeClaim.itemId],
          ),
        ).toEqual([
          {
            closed: true,
            closed_at: AT,
            expires_at: new Date(AT.getTime() + 30 * DAY_MS),
            payload_expires_at: new Date(AT.getTime() + 30 * DAY_MS),
          },
        ]);
        const cancelledPrepareReplay = await repository
          .prepare(beforePrepareCommand)
          .catch((error: unknown) => error);
        expect(cancelledPrepareReplay).toMatchObject({ code: "payload-private" });
        expect(JSON.stringify(cancelledPrepareReplay)).not.toContain(beforePrepared.title);
        const afterClaim = await insertReport(pool, schema, "Cancel after claim");
        const afterPrepared = await repository.prepare(
          prepareCommand(afterClaim, "cancel-after-prepare"),
        );
        const approval = await repository.approve(
          approveCommand(afterClaim, afterPrepared, "cancel-after-approve"),
        );
        if (approval.status !== "approved") throw new Error("Expected approval");
        await expect(
          repository.claimApprovedProjection(
            claimCommand(approval.outboxId, "cancellation-worker", 300_000),
          ),
        ).resolves.toMatchObject({ leaseOwner: "cancellation-worker" });
        const cancellationLease = await schemaRows<{
          readonly status: string;
          readonly lease_owner: string;
          readonly updated_at: Date;
          readonly lease_expires_at: Date;
        }>(
          pool,
          schema,
          "SELECT status,lease_owner,updated_at,lease_expires_at FROM feedback_publication_outbox WHERE id=$1",
          [approval.outboxId],
        );
        expect(cancellationLease[0]).toMatchObject({
          status: "claimed",
          lease_owner: "cancellation-worker",
        });
        expect(
          (cancellationLease[0]?.lease_expires_at.getTime() ?? 0) -
            (cancellationLease[0]?.updated_at.getTime() ?? 0),
        ).toBe(300_000);
        const cancel = cancelCommand(
          afterClaim,
          afterPrepared.preparationId,
          2,
          "cancel-after-command",
        );
        await expect(repository.cancelAndRoutePrivate(cancel)).resolves.toMatchObject({
          status: "manual-reconciliation",
          recordVersion: 3,
          replayed: false,
        });
        await expect(repository.cancelAndRoutePrivate(cancel)).resolves.toMatchObject({
          status: "manual-reconciliation",
          replayed: true,
        });
        expect(
          await schemaRows(pool, schema, "SELECT state FROM feedback_review_items WHERE id=$1", [
            afterClaim.itemId,
          ]),
        ).toEqual([{ state: "private-security" }]);
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT status,lease_owner,lease_expires_at,failure_code FROM feedback_publication_outbox WHERE id=$1",
            [approval.outboxId],
          ),
        ).toEqual([
          {
            status: "manual-reconciliation",
            lease_owner: null,
            lease_expires_at: null,
            failure_code: "manual-reconciliation-required",
          },
        ]);
        await executeTransaction(pool, schema, [
          {
            sql: "UPDATE feedback_publication_outbox SET status='succeeded',create_eligible=false,create_attempt_count=1,failure_code=NULL WHERE id=$1",
            values: [approval.outboxId],
          },
          {
            sql: "UPDATE feedback_publication_preparations SET create_armed_at=$2 WHERE id=$1",
            values: [afterPrepared.preparationId, AT],
          },
        ]);
        await schemaRows(
          pool,
          schema,
          "INSERT INTO feedback_github_issue_linkage (item_id,preparation_id,target_policy_digest,github_repository_id,github_issue_node_id,github_issue_number,linked_at,expires_at) VALUES ($1,$2,$3,123456,'issue-node-1',42,$4,$4::timestamptz + interval '365 days')",
          [afterClaim.itemId, afterPrepared.preparationId, afterPrepared.targetPolicyDigest, AT],
        );
        expect(await repository.linkage(afterClaim.itemId)).toMatchObject({
          issueNumber: 42,
          repositoryId: "123456",
        });
        const counts = await new PostgresIntakeRepository(scopedPool(pool, schema)).purge(
          new Date(AT.getTime() + 366 * DAY_MS),
        );
        expect(
          counts
            .slice(0, 6)
            .filter((_, index) => index !== 3)
            .every((count) => count > 0),
        ).toBe(true);
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT class_code FROM feedback_deletion_ledger WHERE class_code LIKE 'publication-%' OR class_code='github-issue-linkage' ORDER BY class_code",
          ),
        ).toHaveLength(6);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
      }
    },
  );
});
