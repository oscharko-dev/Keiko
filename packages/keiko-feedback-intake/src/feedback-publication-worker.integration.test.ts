import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FeedbackPublicationTargetPolicySnapshotV1 } from "@oscharko-dev/keiko-contracts/feedback-publication";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresFeedbackPublicationRepository } from "./feedback-publication-store.js";
import { digestFeedbackTargetPolicyV1 } from "./feedback-publication-projection.js";
import { PostgresFeedbackPublicationWorkerStore } from "./feedback-publication-worker-store.js";
import { WORKER_CANDIDATE_SQL } from "./feedback-publication-worker-sql.js";
import {
  leaseIdentity,
  type FeedbackPublicationWorkerLease,
} from "./feedback-publication-worker-types.js";
import { clientAdapter, preparedReport, schemaRows } from "./postgres-integration-helpers.js";
import type { PgClientLike, PgPoolLike, PgQueryResult } from "./postgres-types.js";
import { GovernedGithubIssueAdapter } from "./github-issue-adapter.js";
import type {
  GithubHttpOperation,
  GithubHttpResponse,
  GithubTransport,
} from "./github-app-transport.js";
import type { GithubAppSignerSnapshot } from "./github-app-key.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl === undefined ? it.skip : it;
const AT = new Date("2026-07-12T12:00:00.000Z");
const TARGET: FeedbackPublicationTargetPolicySnapshotV1 = {
  apiOrigin: "https://api.github.com",
  repositoryId: "123456",
  owner: "oscharko-dev",
  repository: "Keiko",
  installationId: "987654",
  labels: ["source: feedback"],
  targetKey: "worker-target",
  labelPolicyVersion: "labels-v1",
  targetPolicyVersion: "target-v1",
};
const ACTOR = {
  issuer: "https://issuer.example",
  subject: "publisher-1",
  permissionPolicyVersion: "publish-v1",
} as const;

class CoordinatorTransport implements GithubTransport {
  readonly operations: GithubHttpOperation[] = [];

  constructor(private readonly failPreflight = false) {}

  execute(operation: GithubHttpOperation): Promise<GithubHttpResponse> {
    this.operations.push(operation);
    if (operation.kind === "inspect-app")
      return Promise.resolve(
        jsonResponse(200, { permissions: { issues: "write", metadata: "read" } }),
      );
    if (operation.kind === "inspect-installation")
      return Promise.resolve(
        jsonResponse(200, {
          id: Number(TARGET.installationId),
          repository_selection: "selected",
          permissions: { issues: "write", metadata: "read" },
        }),
      );
    if (operation.kind === "inspect-repository-installation")
      return Promise.resolve(jsonResponse(200, { id: Number(TARGET.installationId) }));
    if (operation.kind === "mint-token") {
      return Promise.resolve(
        this.failPreflight
          ? jsonResponse(503, {})
          : jsonResponse(201, {
              token: "coordinator-token",
              expires_at: "2026-07-12T12:59:00.000Z",
              permissions: { issues: "write" },
              repositories: [
                {
                  id: Number(TARGET.repositoryId),
                  name: TARGET.repository,
                  full_name: `${TARGET.owner}/${TARGET.repository}`,
                  owner: { login: TARGET.owner },
                },
              ],
            }),
      );
    }
    if (operation.kind === "create-issue") {
      return Promise.resolve(
        jsonResponse(
          201,
          {
            repository_url: `${TARGET.apiOrigin}/repos/${TARGET.owner}/${TARGET.repository}`,
            html_url: `https://github.com/${TARGET.owner}/${TARGET.repository}/issues/2076`,
            number: 2076,
            node_id: "I_coordinator",
            title: operation.title,
            body: operation.body,
            labels: operation.labels.map((name) => ({ name })),
          },
          true,
        ),
      );
    }
    return Promise.resolve(jsonResponse(500, {}));
  }
}

function jsonResponse(status: number, value: unknown, committed = false): GithubHttpResponse {
  return {
    status,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(value)),
    requestCommitted: committed,
  };
}

async function coordinator(transport: CoordinatorTransport): Promise<GovernedGithubIssueAdapter> {
  const configuredTarget = { snapshot: TARGET, digest: digestFeedbackTargetPolicyV1(TARGET) };
  const adapter = new GovernedGithubIssueAdapter({
    config: {
      apiOrigin: TARGET.apiOrigin,
      appId: "42",
      privateKeyFile: "/unused",
      privateKeyRotatedAt: "2026-07-01T00:00:00.000Z",
      targets: new Map([[TARGET.targetKey, configuredTarget]]),
    },
    transport,
    trustedNow: (): Date => AT,
    keyProvider: {
      snapshot: (): GithubAppSignerSnapshot => ({
        keyId: "test",
        rotatedAt: AT,
        signRs256: (_payload: Uint8Array): Uint8Array => Uint8Array.from([1]),
      }),
    },
  });
  await adapter.inspectReadiness();
  return adapter;
}

async function createSchema(pool: Pool): Promise<string> {
  const schema = `publication_worker_${randomUUID().replaceAll("-", "")}`;
  await applySchemaMigrations(pool, schema, [
    "001_feedback_intake.sql",
    "002_feedback_review.sql",
    "003_feedback_publication.sql",
    "004_feedback_publication_worker.sql",
  ]);
  return schema;
}

async function applySchemaMigrations(
  pool: Pool,
  schema: string,
  names: readonly string[],
): Promise<void> {
  const client = await pool.connect();
  try {
    if (names[0] === "001_feedback_intake.sql") await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    for (const name of names) {
      await client.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
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

function physicalSessionPool(schema: string): { readonly pool: Pool; readonly scoped: PgPoolLike } {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  return { pool, scoped: scopedPool(pool, schema) };
}

async function approvedOutbox(
  pool: Pool,
  schema: string,
  repository: PostgresFeedbackPublicationRepository,
  title: string,
  target: FeedbackPublicationTargetPolicySnapshotV1 = TARGET,
): Promise<string> {
  const report = preparedReport(title);
  const itemId = randomUUID();
  const groupId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schema}"`);
    await client.query("INSERT INTO feedback_semantic_groups (id,created_at) VALUES ($1,$2)", [
      groupId,
      AT,
    ]);
    await client.query(
      "INSERT INTO feedback_payloads (id,semantic_group_id,exact_body_sha256,canonical_bytes,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$5::timestamptz+interval '90 days')",
      [itemId, groupId, report.exactBodySha256, report.canonicalBody.copyBytes(), AT],
    );
    await client.query(
      "INSERT INTO feedback_receipts (id,payload_id,secret_hash,created_at,expires_at) VALUES ($1,$2,$3,$4,$4::timestamptz+interval '90 days')",
      [randomBytes(16).toString("base64url"), itemId, Buffer.alloc(32), AT],
    );
  } finally {
    client.release();
  }
  const prepared = await repository.prepare({
    action: "prepare-publication",
    itemId,
    expectedVersion: 1,
    expectedPayloadDigest: report.exactBodySha256,
    idempotencyKey: `prepare-${randomUUID()}`,
    actor: ACTOR,
    targetKey: target.targetKey,
  });
  const approved = await repository.approve({
    action: "approve-publication",
    itemId,
    expectedVersion: 1,
    expectedPayloadDigest: report.exactBodySha256,
    idempotencyKey: `approve-${randomUUID()}`,
    actor: ACTOR,
    preparationId: prepared.preparationId,
    expectedProjectionDigest: prepared.projectionDigest,
    expectedTargetPolicyDigest: prepared.targetPolicyDigest,
  });
  if (approved.status !== "approved") throw new Error("Expected approved outbox");
  return approved.outboxId;
}

function requireLease(
  value: FeedbackPublicationWorkerLease | undefined,
): FeedbackPublicationWorkerLease {
  if (value === undefined) throw new Error("Expected worker lease");
  return value;
}

describe("PostgreSQL feedback publication worker", () => {
  it("rejects reuse of the primary pool for installation sessions", () => {
    const unused: PgPoolLike = {
      connect: () => Promise.reject(new Error("unused")),
    };
    expect(() => new PostgresFeedbackPublicationWorkerStore(unused, unused, () => TARGET)).toThrow(
      "require a distinct pool",
    );
  });

  integration("conservatively backfills legacy armed delivery evidence", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
    const installationPool = new Pool({ connectionString: databaseUrl, max: 2 });
    const schema = `publication_worker_upgrade_${randomUUID().replaceAll("-", "")}`;
    await applySchemaMigrations(pool, schema, [
      "001_feedback_intake.sql",
      "002_feedback_review.sql",
      "003_feedback_publication.sql",
    ]);
    const scoped = scopedPool(pool, schema);
    const repository = new PostgresFeedbackPublicationRepository(
      scoped,
      ACTOR.permissionPolicyVersion,
      () => TARGET,
    );
    try {
      const mhcId = await approvedOutbox(pool, schema, repository, "LEGACY_MHC");
      const claimedId = await approvedOutbox(pool, schema, repository, "LEGACY_CLAIMED");
      const manualId = await approvedOutbox(pool, schema, repository, "LEGACY_MANUAL");
      const cancelledId = await approvedOutbox(pool, schema, repository, "LEGACY_CANCELLED");
      const succeededId = await approvedOutbox(pool, schema, repository, "LEGACY_SUCCEEDED");
      await schemaRows(
        pool,
        schema,
        "UPDATE feedback_publication_outbox SET status='may-have-committed',updated_at=created_at+interval '1 second' WHERE id=$1",
        [mhcId],
      );
      await schemaRows(
        pool,
        schema,
        `UPDATE feedback_publication_outbox
         SET status='claimed',lease_owner='legacy-worker',
           lease_expires_at=created_at+interval '1 minute',updated_at=created_at
         WHERE id=$1`,
        [claimedId],
      );
      await schemaRows(
        pool,
        schema,
        "UPDATE feedback_publication_outbox SET status='manual-reconciliation',failure_code='manual-reconciliation-required',updated_at=created_at+interval '2 seconds' WHERE id=$1",
        [manualId],
      );
      await schemaRows(
        pool,
        schema,
        "UPDATE feedback_publication_outbox SET status='cancelled-private',failure_code='payload-private',updated_at=created_at+interval '2 seconds' WHERE id=$1",
        [cancelledId],
      );
      await schemaRows(
        pool,
        schema,
        "UPDATE feedback_publication_outbox SET status='succeeded',updated_at=created_at+interval '2 seconds' WHERE id=$1",
        [succeededId],
      );
      await applySchemaMigrations(pool, schema, ["004_feedback_publication_worker.sql"]);

      expect(
        await schemaRows(
          pool,
          schema,
          `SELECT outbox.status,outbox.create_eligible,outbox.create_attempt_count,
             prep.create_armed_at IS NOT NULL AS armed
           FROM feedback_publication_outbox outbox
           JOIN feedback_publication_preparations prep ON prep.id=outbox.preparation_id
           ORDER BY outbox.status`,
        ),
      ).toEqual([
        {
          status: "cancelled-private",
          create_eligible: false,
          create_attempt_count: 0,
          armed: false,
        },
        {
          status: "manual-reconciliation",
          create_eligible: false,
          create_attempt_count: 1,
          armed: true,
        },
        {
          status: "may-have-committed",
          create_eligible: false,
          create_attempt_count: 1,
          armed: true,
        },
        {
          status: "may-have-committed",
          create_eligible: false,
          create_attempt_count: 1,
          armed: true,
        },
        { status: "succeeded", create_eligible: false, create_attempt_count: 1, armed: true },
      ]);
      expect(
        await schemaRows(
          pool,
          schema,
          `SELECT status,create_eligible,create_attempt_count,lease_owner,lease_expires_at,
             next_attempt_at,failure_code
           FROM feedback_publication_outbox WHERE id=$1`,
          [claimedId],
        ),
      ).toEqual([
        {
          status: "may-have-committed",
          create_eligible: false,
          create_attempt_count: 1,
          lease_owner: null,
          lease_expires_at: null,
          next_attempt_at: null,
          failure_code: "ambiguous-reconciliation",
        },
      ]);
      await expect(
        schemaRows(
          pool,
          schema,
          `UPDATE feedback_publication_preparations SET create_armed_at=NULL
           WHERE id=(SELECT preparation_id FROM feedback_publication_outbox WHERE id=$1)`,
          [mhcId],
        ),
      ).rejects.toThrow("arm evidence is immutable");
      await expect(
        schemaRows(
          pool,
          schema,
          "UPDATE feedback_publication_outbox SET create_eligible=true,status='unclaimed',failure_code=NULL WHERE id=$1",
          [manualId],
        ),
      ).rejects.toThrow("create eligibility is monotonic");
      await schemaRows(
        pool,
        schema,
        "UPDATE feedback_publication_outbox SET next_attempt_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
        [mhcId],
      );
      const worker = new PostgresFeedbackPublicationWorkerStore(
        scoped,
        scopedPool(installationPool, schema),
        () => TARGET,
      );
      const transport = new CoordinatorTransport();
      const governed = await coordinator(transport);
      await worker.withCandidate(
        { workerId: "legacy-reconcile", leaseDurationMs: 60_000 },
        async (candidate) => {
          expect(candidate.outboxId).toBe(claimedId);
          expect(candidate.mode).toBe("reconcile-only");
          await expect(worker.armCreate(candidate)).rejects.toMatchObject({
            code: "claim-unavailable",
          });
          await expect(governed.publishClaimedCandidate(worker, candidate)).rejects.toBeDefined();
        },
      );
      expect(
        transport.operations.filter((operation) => operation.kind === "create-issue"),
      ).toHaveLength(0);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await installationPool.end();
      await pool.end();
    }
  });

  integration(
    "uses bounded index candidates with a 100k future-retry backlog",
    async () => {
      const pool = new Pool({ connectionString: databaseUrl, max: 6 });
      const installationSessions = new Pool({ connectionString: databaseUrl, max: 2 });
      const schema = await createSchema(pool);
      const scoped = scopedPool(pool, schema);
      const repository = new PostgresFeedbackPublicationRepository(
        scoped,
        ACTOR.permissionPolicyVersion,
        () => TARGET,
      );
      try {
        const templateId = await approvedOutbox(pool, schema, repository, "PERF_TEMPLATE");
        await schemaRows(
          pool,
          schema,
          `INSERT INTO feedback_publication_preparations
             (id,item_id,payload_digest,source_record_version,projection_version,title_bytes,
              body_bytes,projection_digest,reconciliation_marker,target_api_origin,
              target_repository_id,target_owner,target_repository,target_installation_id,
              target_labels,target_key,label_policy_version,target_policy_version,
              target_policy_digest,status,created_at,approved_at,cancelled_at,expires_at)
           SELECT (lpad(to_hex(series + 1000000),32,'0'))::uuid,prep.item_id,
             prep.payload_digest,prep.source_record_version + series,prep.projection_version,
             prep.title_bytes,prep.body_bytes,prep.projection_digest,
             '<!-- keiko-feedback-reconciliation-v1:' || lpad(series::text,43,'0') || ' -->',
             prep.target_api_origin,prep.target_repository_id,prep.target_owner,
             prep.target_repository,prep.target_installation_id,prep.target_labels,
             prep.target_key,prep.label_policy_version,prep.target_policy_version,
             prep.target_policy_digest,prep.status,prep.created_at,prep.approved_at,
             prep.cancelled_at,prep.expires_at
           FROM feedback_publication_preparations prep
           JOIN feedback_publication_outbox template ON template.preparation_id=prep.id
           CROSS JOIN generate_series(1,100000) series
           WHERE template.id=$1`,
          [templateId],
        );
        await schemaRows(
          pool,
          schema,
          `INSERT INTO feedback_publication_outbox
             (id,preparation_id,idempotency_key,status,attempt_count,lease_owner,
              lease_expires_at,next_attempt_at,failure_code,created_at,updated_at,expires_at,
              create_eligible,create_attempt_count)
           SELECT (lpad(to_hex(series + 2000000),32,'0'))::uuid,
             (lpad(to_hex(series + 1000000),32,'0'))::uuid,
             'perf_future_' || lpad(series::text,16,'0'),'retryable-failure',0,NULL,NULL,
             clock_timestamp()+interval '1 day','provider-unavailable',template.created_at,
             template.updated_at,template.expires_at,true,0
           FROM feedback_publication_outbox template
           CROSS JOIN generate_series(1,100000) series
           WHERE template.id=$1`,
          [templateId],
        );
        await schemaRows(
          pool,
          schema,
          "UPDATE feedback_publication_outbox SET status='manual-reconciliation',create_eligible=false,failure_code='manual-reconciliation-required' WHERE id=$1",
          [templateId],
        );
        const eligibleId = await approvedOutbox(pool, schema, repository, "PERF_ELIGIBLE");
        await schemaRows(
          pool,
          schema,
          "ANALYZE feedback_publication_outbox; ANALYZE feedback_publication_preparations",
        );
        const explained = await schemaRows<{
          readonly "QUERY PLAN": readonly [{ readonly Plan: Record<string, unknown> }];
        }>(pool, schema, `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${WORKER_CANDIDATE_SQL}`, [[], 16]);
        const plan = explained[0]?.["QUERY PLAN"]?.[0]?.Plan;
        expect(plan).toBeDefined();
        expect(JSON.stringify(plan)).toContain("feedback_publication_outbox_worker_retry_idx");
        expect(plan?.["Actual Rows"]).toBe(1);
        const candidateBuffers =
          Number(plan?.["Shared Hit Blocks"] ?? 0) + Number(plan?.["Shared Read Blocks"] ?? 0);
        expect(candidateBuffers, JSON.stringify(plan)).toBeLessThan(1_000);

        const worker = new PostgresFeedbackPublicationWorkerStore(
          scoped,
          scopedPool(installationSessions, schema),
          () => TARGET,
        );
        await expect(
          worker.withCandidate({ workerId: "worker-perf", leaseDurationMs: 60_000 }, (candidate) =>
            Promise.resolve(candidate.outboxId),
          ),
        ).resolves.toBe(eligibleId);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await installationSessions.end();
        await pool.end();
      }
    },
    60_000,
  );

  integration("widens the bounded state head when earlier candidates are locked", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
    const schema = await createSchema(pool);
    const sessions = physicalSessionPool(schema);
    const scoped = scopedPool(pool, schema);
    const repository = new PostgresFeedbackPublicationRepository(
      scoped,
      ACTOR.permissionPolicyVersion,
      () => TARGET,
    );
    const blocker = await pool.connect();
    try {
      for (let index = 0; index < 17; index += 1) {
        await approvedOutbox(pool, schema, repository, `LOCKED_HEAD_${String(index)}`);
      }
      const ordered = await schemaRows<{ readonly id: string }>(
        pool,
        schema,
        "SELECT id FROM feedback_publication_outbox ORDER BY created_at,id",
      );
      const expected = ordered[16]?.id;
      if (expected === undefined) throw new Error("Expected bounded-race fixture");
      await blocker.query(`SET search_path TO "${schema}"`);
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM feedback_publication_outbox WHERE id=ANY($1::uuid[]) FOR UPDATE",
        [ordered.slice(0, 16).map(({ id }) => id)],
      );
      const worker = new PostgresFeedbackPublicationWorkerStore(
        scoped,
        sessions.scoped,
        () => TARGET,
      );
      await expect(
        worker.withCandidate(
          { workerId: "worker-raced-head", leaseDurationMs: 60_000 },
          (candidate) => Promise.resolve(candidate.outboxId),
        ),
      ).resolves.toBe(expected);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sessions.pool.end();
      await pool.end();
    }
  });

  integration("coordinates preflight-before-arm and permits at most one POST", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 10 });
    const schema = await createSchema(pool);
    const scoped = scopedPool(pool, schema);
    const installationSessions = physicalSessionPool(schema);
    const repository = new PostgresFeedbackPublicationRepository(
      scoped,
      ACTOR.permissionPolicyVersion,
      () => TARGET,
    );
    const worker = new PostgresFeedbackPublicationWorkerStore(
      scoped,
      installationSessions.scoped,
      () => TARGET,
    );
    try {
      await approvedOutbox(pool, schema, repository, "PREFLIGHT_RETRY");
      const failingTransport = new CoordinatorTransport(true);
      const failingCoordinator = await coordinator(failingTransport);
      await worker.withCandidate(
        { workerId: "worker-preflight", leaseDurationMs: 60_000 },
        async (candidate) => {
          await expect(
            failingCoordinator.publishClaimedCandidate(worker, candidate),
          ).rejects.toMatchObject({ commitCertainty: "definite-pre-send" });
          await expect(
            worker.scheduleRetry(leaseIdentity(candidate), "provider-unavailable", 1_000),
          ).resolves.toBe("retryable-failure");
        },
      );
      expect(
        failingTransport.operations.filter((operation) => operation.kind === "create-issue"),
      ).toHaveLength(0);

      await schemaRows(
        pool,
        schema,
        "UPDATE feedback_publication_outbox SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE status='retryable-failure'",
      );
      const oneShotTransport = new CoordinatorTransport();
      const oneShot = await coordinator(oneShotTransport);
      let retained: FeedbackPublicationWorkerLease | undefined;
      await worker.withCandidate(
        { workerId: "worker-one-shot", leaseDurationMs: 60_000 },
        async (candidate) => {
          retained = candidate;
          const results = await Promise.allSettled([
            oneShot.publishClaimedCandidate(worker, candidate),
            oneShot.publishClaimedCandidate(worker, candidate),
          ]);
          expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
          await expect(oneShot.publishClaimedCandidate(worker, candidate)).rejects.toBeDefined();
        },
      );
      expect(
        oneShotTransport.operations.filter((operation) => operation.kind === "create-issue"),
      ).toHaveLength(1);
      const retainedTransport = new CoordinatorTransport();
      const retainedCoordinator = await coordinator(retainedTransport);
      if (retained === undefined) throw new Error("Expected retained lease test fixture");
      await expect(
        retainedCoordinator.publishClaimedCandidate(worker, retained),
      ).rejects.toMatchObject({ code: "invalid-transition" });
      expect(
        retainedTransport.operations.filter((operation) => operation.kind === "create-issue"),
      ).toHaveLength(0);

      await approvedOutbox(pool, schema, repository, "TWO_COORDINATOR_RACE");
      const raceTransport = new CoordinatorTransport();
      const [firstCoordinator, secondCoordinator] = await Promise.all([
        coordinator(raceTransport),
        coordinator(raceTransport),
      ]);
      await worker.withCandidate(
        { workerId: "worker-two-coordinators", leaseDurationMs: 60_000 },
        async (candidate) => {
          const results = await Promise.allSettled([
            firstCoordinator.publishClaimedCandidate(worker, candidate),
            secondCoordinator.publishClaimedCandidate(worker, candidate),
          ]);
          expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        },
      );
      expect(
        raceTransport.operations.filter((operation) => operation.kind === "create-issue"),
      ).toHaveLength(1);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await installationSessions.pool.end();
      await pool.end();
    }
  });

  integration(
    "arms before create and permanently recovers an armed crash as reconcile-only",
    async () => {
      const pool = new Pool({ connectionString: databaseUrl, max: 8 });
      const schema = await createSchema(pool);
      const scoped = scopedPool(pool, schema);
      const installationSessions = physicalSessionPool(schema);
      const repository = new PostgresFeedbackPublicationRepository(
        scoped,
        ACTOR.permissionPolicyVersion,
        (key) => (key === TARGET.targetKey ? TARGET : undefined),
      );
      const worker = new PostgresFeedbackPublicationWorkerStore(
        scoped,
        installationSessions.scoped,
        () => TARGET,
      );
      try {
        const outboxId = await approvedOutbox(pool, schema, repository, "ARMING_SENTINEL");
        const first = await worker.withCandidate(
          { workerId: "worker-a", leaseDurationMs: 60_000 },
          async (candidate) => {
            expect(candidate.mode).toBe("create-eligible");
            await worker.armCreate(candidate);
            const visible = await schemaRows<{
              readonly status: string;
              readonly create_eligible: boolean;
              readonly create_attempt_count: number;
            }>(
              pool,
              schema,
              "SELECT status,create_eligible,create_attempt_count FROM feedback_publication_outbox WHERE id=$1",
              [outboxId],
            );
            expect(visible).toEqual([
              { status: "may-have-committed", create_eligible: false, create_attempt_count: 1 },
            ]);
            await expect(
              schemaRows(
                pool,
                schema,
                "UPDATE feedback_publication_outbox SET create_eligible=true WHERE id=$1",
                [outboxId],
              ),
            ).rejects.toThrow("create eligibility is monotonic");
            return candidate;
          },
        );
        const armed = requireLease(first);
        await pool.query(`SET search_path TO "${schema}"`);
        await schemaRows(
          pool,
          schema,
          "UPDATE feedback_publication_outbox SET lease_expires_at=clock_timestamp()-interval '1 second',updated_at=clock_timestamp()-interval '2 seconds' WHERE id=$1",
          [outboxId],
        );
        const recovered = await worker.withCandidate(
          { workerId: "worker-b", leaseDurationMs: 60_000 },
          (candidate) => Promise.resolve(candidate),
        );
        expect(requireLease(recovered).mode).toBe("reconcile-only");
        expect(requireLease(recovered).createAttemptCount).toBe(armed.createAttemptCount + 1);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await installationSessions.pool.end();
        await pool.end();
      }
    },
  );

  integration("preserves ever-arm evidence after outbox deletion", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
    const schema = await createSchema(pool);
    const scoped = scopedPool(pool, schema);
    const installationSessions = physicalSessionPool(schema);
    const repository = new PostgresFeedbackPublicationRepository(
      scoped,
      ACTOR.permissionPolicyVersion,
      () => TARGET,
    );
    const worker = new PostgresFeedbackPublicationWorkerStore(
      scoped,
      installationSessions.scoped,
      () => TARGET,
    );
    try {
      const outboxId = await approvedOutbox(pool, schema, repository, "EVER_ARM");
      await expect(
        schemaRows(
          pool,
          schema,
          `UPDATE feedback_publication_outbox
           SET status='may-have-committed',create_eligible=false,create_attempt_count=1
           WHERE id=$1`,
          [outboxId],
        ),
      ).rejects.toThrow("invalid feedback publication armed outbox state");
      await worker.withCandidate(
        { workerId: "worker-ever-arm", leaseDurationMs: 60_000 },
        (candidate) => worker.armCreate(candidate),
      );
      const saved = await schemaRows<{
        readonly preparation_id: string;
        readonly idempotency_key: string;
        readonly created_at: Date;
        readonly expires_at: Date;
      }>(
        pool,
        schema,
        "SELECT preparation_id,idempotency_key,created_at,expires_at FROM feedback_publication_outbox WHERE id=$1",
        [outboxId],
      );
      const row = saved[0];
      if (row === undefined) throw new Error("Expected armed outbox");
      await schemaRows(pool, schema, "DELETE FROM feedback_publication_outbox WHERE id=$1", [
        outboxId,
      ]);
      await expect(
        schemaRows(
          pool,
          schema,
          `INSERT INTO feedback_publication_outbox
            (id,preparation_id,idempotency_key,status,created_at,updated_at,expires_at)
           VALUES ($1,$2,$3,'unclaimed',$4,$4,$5)`,
          [randomUUID(), row.preparation_id, row.idempotency_key, row.created_at, row.expires_at],
        ),
      ).rejects.toThrow("preparation was already armed");
      expect(
        await schemaRows(
          pool,
          schema,
          "SELECT create_armed_at IS NOT NULL AS armed FROM feedback_publication_preparations WHERE id=$1",
          [row.preparation_id],
        ),
      ).toEqual([{ armed: true }]);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await installationSessions.pool.end();
      await pool.end();
    }
  });

  integration(
    "clamps retries and atomically records an idempotent non-divergent success",
    async () => {
      const pool = new Pool({ connectionString: databaseUrl, max: 8 });
      const schema = await createSchema(pool);
      const scoped = scopedPool(pool, schema);
      const installationSessions = physicalSessionPool(schema);
      const repository = new PostgresFeedbackPublicationRepository(
        scoped,
        ACTOR.permissionPolicyVersion,
        () => TARGET,
      );
      const worker = new PostgresFeedbackPublicationWorkerStore(
        scoped,
        installationSessions.scoped,
        () => TARGET,
      );
      try {
        await approvedOutbox(pool, schema, repository, "SUCCESS_SENTINEL");
        await worker.withCandidate(
          { workerId: "worker-a", leaseDurationMs: 60_000 },
          async (candidate) => {
            await worker.scheduleRetry(
              leaseIdentity(candidate),
              "rate-limited",
              Number.POSITIVE_INFINITY,
            );
          },
        );
        const retry = await schemaRows<{ readonly delay: string }>(
          pool,
          schema,
          "SELECT extract(epoch FROM (next_attempt_at-updated_at))::text AS delay FROM feedback_publication_outbox",
        );
        expect(Number(retry[0]?.delay)).toBeLessThanOrEqual(3600);
        await schemaRows(
          pool,
          schema,
          "UPDATE feedback_publication_outbox SET next_attempt_at=clock_timestamp()-interval '1 second'",
        );
        await worker.withCandidate(
          { workerId: "worker-b", leaseDurationMs: 60_000 },
          async (candidate) => {
            await worker.armCreate(candidate);
            await worker.recordSuccess(leaseIdentity(candidate), {
              repositoryId: TARGET.repositoryId,
              issueNodeId: "I_worker_success",
              issueNumber: 2076,
            });
          },
        );
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT status,create_eligible FROM feedback_publication_outbox",
          ),
        ).toEqual([{ status: "succeeded", create_eligible: false }]);
        const audit = await schemaRows<Record<string, unknown>>(
          pool,
          schema,
          "SELECT * FROM feedback_publication_delivery_audit",
        );
        expect(JSON.stringify(audit)).not.toContain("SUCCESS_SENTINEL");

        await approvedOutbox(pool, schema, repository, "POST_ARM_RETRY_SENTINEL");
        await worker.withCandidate(
          { workerId: "worker-post-arm", leaseDurationMs: 60_000 },
          async (candidate) => {
            await worker.armCreate(candidate);
            await expect(
              worker.scheduleRetry(leaseIdentity(candidate), "provider-unavailable", -1),
            ).rejects.toMatchObject({ code: "claim-unavailable" });
          },
        );
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT status,create_eligible,create_attempt_count FROM feedback_publication_outbox WHERE create_attempt_count=1 AND status='may-have-committed'",
          ),
        ).toEqual([
          { status: "may-have-committed", create_eligible: false, create_attempt_count: 1 },
        ]);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await installationSessions.pool.end();
        await pool.end();
      }
    },
  );

  integration(
    "serializes the same installation while allowing a different installation",
    async () => {
      const pool = new Pool({ connectionString: databaseUrl, max: 10 });
      const schema = await createSchema(pool);
      const scoped = scopedPool(pool, schema);
      const installationSessions = physicalSessionPool(schema);
      const secondTarget: FeedbackPublicationTargetPolicySnapshotV1 = {
        ...TARGET,
        repositoryId: "123457",
        repository: "Keiko-Other",
        installationId: "987655",
        targetKey: "worker-target-other",
      };
      const resolve = (key: string): FeedbackPublicationTargetPolicySnapshotV1 | undefined =>
        [TARGET, secondTarget].find((target) => target.targetKey === key);
      const repository = new PostgresFeedbackPublicationRepository(
        scoped,
        ACTOR.permissionPolicyVersion,
        resolve,
      );
      const firstWorker = new PostgresFeedbackPublicationWorkerStore(
        scoped,
        installationSessions.scoped,
        resolve,
      );
      const secondWorker = new PostgresFeedbackPublicationWorkerStore(
        scoped,
        installationSessions.scoped,
        resolve,
        5_000,
        3,
        {},
      );
      let releaseFirst: (() => void) | undefined;
      const blocked = new Promise<void>((resolveRelease) => {
        releaseFirst = resolveRelease;
      });
      let enteredFirst: (() => void) | undefined;
      const entered = new Promise<void>((resolveEntered) => {
        enteredFirst = resolveEntered;
      });
      try {
        for (let index = 0; index < 12; index += 1) {
          await approvedOutbox(pool, schema, repository, `SERIAL_${String(index)}`);
        }
        await approvedOutbox(pool, schema, repository, "PARALLEL_OTHER", secondTarget);
        const first = firstWorker.withCandidate(
          { workerId: "worker-first", leaseDurationMs: 60_000 },
          async (candidate) => {
            expect(candidate.target.installationId).toBe(TARGET.installationId);
            enteredFirst?.();
            await blocked;
            return candidate.outboxId;
          },
        );
        await entered;
        const parallel = await secondWorker.withCandidate(
          { workerId: "worker-second", leaseDurationMs: 60_000 },
          (candidate) => Promise.resolve(candidate.target.installationId),
        );
        expect(parallel).toBe(secondTarget.installationId);
        releaseFirst?.();
        await expect(first).resolves.toEqual(expect.any(String));
      } finally {
        releaseFirst?.();
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await installationSessions.pool.end();
        await pool.end();
      }
    },
  );

  integration(
    "atomically rolls back load settlement and bounds a conflicting row lock",
    async () => {
      const pool = new Pool({ connectionString: databaseUrl, max: 8 });
      const schema = await createSchema(pool);
      const scoped = scopedPool(pool, schema);
      const installationSessions = physicalSessionPool(schema);
      const repository = new PostgresFeedbackPublicationRepository(
        scoped,
        ACTOR.permissionPolicyVersion,
        () => TARGET,
      );
      try {
        const outboxId = await approvedOutbox(pool, schema, repository, "LOAD_SETTLEMENT");
        const injected = new PostgresFeedbackPublicationWorkerStore(
          scoped,
          installationSessions.scoped,
          () => undefined,
          1_000,
          3,
          {
            afterLoadFailureUpdate: (): Promise<void> =>
              Promise.reject(new Error("injected-load-settlement-failure")),
          },
        );
        await expect(
          injected.withCandidate(
            { workerId: "worker-load-injection", leaseDurationMs: 60_000 },
            () => Promise.resolve(undefined),
          ),
        ).rejects.toThrow("injected-load-settlement-failure");
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT status,failure_code FROM feedback_publication_outbox WHERE id=$1",
            [outboxId],
          ),
        ).toEqual([{ status: "claimed", failure_code: null }]);
        expect(
          await schemaRows(
            pool,
            schema,
            "SELECT action FROM feedback_publication_delivery_audit WHERE outbox_id=$1 ORDER BY event_id",
            [outboxId],
          ),
        ).toEqual([{ action: "claimed-create" }]);

        await schemaRows(
          pool,
          schema,
          "UPDATE feedback_publication_outbox SET lease_expires_at=clock_timestamp()-interval '1 second',updated_at=clock_timestamp()-interval '2 seconds' WHERE id=$1",
          [outboxId],
        );
        const blocker = await pool.connect();
        await blocker.query(`SET search_path TO "${schema}"`);
        const sessionPool: PgPoolLike = {
          connect: async (): Promise<PgClientLike> => {
            await blocker.query("BEGIN");
            await blocker.query(
              "SELECT id FROM feedback_publication_outbox WHERE id=$1 FOR UPDATE",
              [outboxId],
            );
            const client = await installationSessions.pool.connect();
            await client.query(`SET search_path TO "${schema}"`);
            return clientAdapter(client, []);
          },
        };
        const bounded = new PostgresFeedbackPublicationWorkerStore(
          scoped,
          sessionPool,
          () => TARGET,
          100,
          1,
          {},
        );
        const started = performance.now();
        await expect(
          bounded.withCandidate({ workerId: "worker-lock-timeout", leaseDurationMs: 60_000 }, () =>
            Promise.resolve(undefined),
          ),
        ).rejects.toBeDefined();
        expect(performance.now() - started).toBeLessThan(1_000);
        await blocker.query("ROLLBACK");
        blocker.release();
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await installationSessions.pool.end();
        await pool.end();
      }
    },
  );

  integration("discards a session when advisory unlock cannot prove ownership", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const schema = await createSchema(pool);
    const scoped = scopedPool(pool, schema);
    const installationSessions = physicalSessionPool(schema);
    const repository = new PostgresFeedbackPublicationRepository(
      scoped,
      ACTOR.permissionPolicyVersion,
      () => TARGET,
    );
    let discarded: Error | undefined;
    const dirtySessionPool: PgPoolLike = {
      connect: async (): Promise<PgClientLike> => {
        const client = await installationSessions.pool.connect();
        await client.query(`SET search_path TO "${schema}"`);
        const base = clientAdapter(client, []);
        return {
          query: async <Row extends object>(
            text: string,
            values?: readonly unknown[],
          ): Promise<PgQueryResult<Row>> => {
            if (text.includes("AS unlocked")) {
              return { rows: [{ unlocked: false } as Row], rowCount: 1 };
            }
            return base.query<Row>(text, values);
          },
          release(error?: Error): void {
            discarded = error;
            base.release(error);
          },
        };
      },
    };
    try {
      await approvedOutbox(pool, schema, repository, "UNLOCK_DISCARD");
      const worker = new PostgresFeedbackPublicationWorkerStore(
        scoped,
        dirtySessionPool,
        () => TARGET,
        1_000,
        3,
        {},
      );
      await worker.withCandidate({ workerId: "worker-unlock", leaseDurationMs: 60_000 }, () =>
        Promise.resolve(undefined),
      );
      expect(discarded?.message).toContain("ownership was lost");
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await installationSessions.pool.end();
      await pool.end();
    }
  });

  integration(
    "rolls back injected success failure and never overwrites divergent linkage",
    async () => {
      const pool = new Pool({ connectionString: databaseUrl, max: 8 });
      const schema = await createSchema(pool);
      const scoped = scopedPool(pool, schema);
      const installationSessions = physicalSessionPool(schema);
      const repository = new PostgresFeedbackPublicationRepository(
        scoped,
        ACTOR.permissionPolicyVersion,
        () => TARGET,
      );
      const worker = new PostgresFeedbackPublicationWorkerStore(
        scoped,
        installationSessions.scoped,
        () => TARGET,
      );
      const failing = new PostgresFeedbackPublicationWorkerStore(
        scoped,
        installationSessions.scoped,
        () => TARGET,
        5_000,
        3,
        {
          afterLinkageInsert: (): Promise<void> =>
            Promise.reject(new Error("injected-success-failure")),
        },
      );
      try {
        await approvedOutbox(pool, schema, repository, "ATOMIC_SUCCESS");
        await failing.withCandidate(
          { workerId: "worker-failure", leaseDurationMs: 60_000 },
          async (candidate) => {
            await failing.armCreate(candidate);
            await expect(
              failing.recordSuccess(leaseIdentity(candidate), {
                repositoryId: TARGET.repositoryId,
                issueNodeId: "I_rolled_back",
                issueNumber: 11,
              }),
            ).rejects.toThrow("injected-success-failure");
            expect(
              await schemaRows(pool, schema, "SELECT item_id FROM feedback_github_issue_linkage"),
            ).toEqual([]);
            expect(
              await schemaRows(pool, schema, "SELECT status FROM feedback_publication_outbox"),
            ).toEqual([{ status: "may-have-committed" }]);
            await worker.recordSuccess(leaseIdentity(candidate), {
              repositoryId: TARGET.repositoryId,
              issueNodeId: "I_exact",
              issueNumber: 12,
            });
          },
        );

        const gatedOutbox = await approvedOutbox(pool, schema, repository, "LINKAGE_STATE_GATE");
        const binding = await schemaRows<{
          readonly item_id: string;
          readonly preparation_id: string;
          readonly target_policy_digest: string;
        }>(
          pool,
          schema,
          `SELECT prep.item_id,outbox.preparation_id,prep.target_policy_digest
           FROM feedback_publication_outbox outbox
           JOIN feedback_publication_preparations prep ON prep.id=outbox.preparation_id
           WHERE outbox.id=$1`,
          [gatedOutbox],
        );
        const unclaimed = binding[0];
        if (unclaimed === undefined) throw new Error("Expected linkage binding");
        await expect(
          schemaRows(
            pool,
            schema,
            `INSERT INTO feedback_github_issue_linkage
              (item_id,preparation_id,target_policy_digest,github_repository_id,
               github_issue_node_id,github_issue_number,linked_at,expires_at)
             VALUES ($1,$2,$3,$4::bigint,'I_unclaimed',13,$5,
               $5::timestamptz+interval '365 days')`,
            [
              unclaimed.item_id,
              unclaimed.preparation_id,
              unclaimed.target_policy_digest,
              TARGET.repositoryId,
              AT,
            ],
          ),
        ).rejects.toThrow("invalid feedback github issue linkage");
        await worker.withCandidate(
          { workerId: "worker-linkage-gate", leaseDurationMs: 60_000 },
          async (candidate) => {
            await expect(
              schemaRows(
                pool,
                schema,
                `INSERT INTO feedback_github_issue_linkage
                  (item_id,preparation_id,target_policy_digest,github_repository_id,
                   github_issue_node_id,github_issue_number,linked_at,expires_at)
                 VALUES ($1,$2,$3,$4::bigint,'I_claimed',13,$5,
                   $5::timestamptz+interval '365 days')`,
                [
                  candidate.itemId,
                  candidate.preparationId,
                  candidate.targetPolicyDigest,
                  TARGET.repositoryId,
                  AT,
                ],
              ),
            ).rejects.toThrow("invalid feedback github issue linkage");
            await worker.armCreate(candidate);
            await expect(
              schemaRows(
                pool,
                schema,
                `INSERT INTO feedback_github_issue_linkage
                  (item_id,preparation_id,target_policy_digest,github_repository_id,
                   github_issue_node_id,github_issue_number,linked_at,expires_at)
                 VALUES ($1,$2,$3,$4::bigint,'I_mhc',13,$5,
                   $5::timestamptz+interval '365 days')`,
                [
                  candidate.itemId,
                  candidate.preparationId,
                  candidate.targetPolicyDigest,
                  TARGET.repositoryId,
                  AT,
                ],
              ),
            ).rejects.toThrow("invalid feedback github issue linkage");
            await worker.recordSuccess(leaseIdentity(candidate), {
              repositoryId: TARGET.repositoryId,
              issueNodeId: "I_succeeded",
              issueNumber: 13,
            });
          },
        );

        await approvedOutbox(pool, schema, repository, "REPOSITORY_NUMBER_UNIQUE");
        await worker.withCandidate(
          { workerId: "worker-repository-number", leaseDurationMs: 60_000 },
          async (candidate) => {
            await worker.armCreate(candidate);
            await schemaRows(
              pool,
              schema,
              "UPDATE feedback_publication_outbox SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
              [candidate.outboxId],
            );
            await expect(
              schemaRows(
                pool,
                schema,
                `INSERT INTO feedback_github_issue_linkage
                  (item_id,preparation_id,target_policy_digest,github_repository_id,
                   github_issue_node_id,github_issue_number,linked_at,expires_at)
                 VALUES ($1,$2,$3,$4::bigint,'I_other_node',13,$5,
                   $5::timestamptz+interval '365 days')`,
                [
                  candidate.itemId,
                  candidate.preparationId,
                  candidate.targetPolicyDigest,
                  TARGET.repositoryId,
                  AT,
                ],
              ),
            ).rejects.toMatchObject({ code: "23505" });
          },
        );
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await installationSessions.pool.end();
        await pool.end();
      }
    },
  );
});
