import { isFeedbackPublicationTargetPolicySnapshotV1 } from "@oscharko-dev/keiko-contracts/feedback-publication";
import { leasedProjectionFromRow, lockDispatchCandidate } from "./feedback-publication-dispatch.js";
import type { FeedbackPublicationPreparationRow } from "./feedback-publication-records.js";
import { digestFeedbackTargetPolicyV1 } from "./feedback-publication-projection.js";
import type { FeedbackPublicationTargetPolicyResolver } from "./feedback-publication-store.js";
import { FeedbackPublicationError } from "./feedback-publication-types.js";
import {
  appendDeliveryAudit,
  candidateMode,
  claimWorkerCandidate,
  databaseNow,
  EXACT_LEASE_WHERE,
  exactLeaseValues,
  selectWorkerCandidate,
  type WorkerCandidateRow,
} from "./feedback-publication-worker-sql.js";
import { persistWorkerSuccess } from "./feedback-publication-worker-success.js";
import {
  FEEDBACK_PUBLICATION_MAX_CREATE_ATTEMPTS,
  FEEDBACK_PUBLICATION_MAX_RETRY_MS,
  FEEDBACK_PUBLICATION_MIN_RETRY_MS,
  type FeedbackPublicationCircuitGate,
  type FeedbackPublicationLeaseIdentity,
  type FeedbackPublicationManualCode,
  type FeedbackPublicationRetryCode,
  type FeedbackPublicationSuccess,
  type FeedbackPublicationWorkerLease,
  type FeedbackPublicationWorkerOptions,
} from "./feedback-publication-worker-types.js";
import { acquirePostgresClient, isRetryablePostgresError } from "./postgres-client.js";
import type { PgClientLike, PgPoolLike } from "./postgres-types.js";

interface ClaimedCandidate {
  readonly row: WorkerCandidateRow;
  readonly leaseExpiresAt: Date;
}

export interface FeedbackPublicationWorkerStoreHooks {
  readonly afterLinkageInsert?: (() => Promise<void>) | undefined;
  readonly afterLoadFailureUpdate?: (() => Promise<void>) | undefined;
}

function boundedRetryDelay(delayMs: number): number {
  return Math.max(
    FEEDBACK_PUBLICATION_MIN_RETRY_MS,
    Math.min(Math.trunc(delayMs), FEEDBACK_PUBLICATION_MAX_RETRY_MS),
  );
}

export class PostgresFeedbackPublicationWorkerStore {
  private readonly activeLeases = new WeakSet();

  constructor(
    private readonly pool: PgPoolLike,
    private readonly installationSessionPool: PgPoolLike,
    private readonly resolveTargetPolicy: FeedbackPublicationTargetPolicyResolver,
    private readonly deadlineMs = 5_000,
    private readonly maxRetries = 3,
    private readonly hooks: FeedbackPublicationWorkerStoreHooks = {},
  ) {
    if (installationSessionPool === pool) {
      throw new Error("Feedback publication installation sessions require a distinct pool");
    }
  }

  async withCandidate<T>(
    options: FeedbackPublicationWorkerOptions,
    handle: (lease: FeedbackPublicationWorkerLease) => Promise<T>,
  ): Promise<T | undefined> {
    this.assertOptions(options);
    const excludedInstallationIds: string[] = [];
    const limit = Math.min(options.candidateLimit ?? 10, 100);
    while (excludedInstallationIds.length < limit) {
      const candidate = await this.claimCandidate(options, excludedInstallationIds);
      if (candidate === undefined) return undefined;
      const guarded = await this.runUnderInstallationLock(candidate, options, handle);
      if (guarded.acquired) return guarded.value;
      excludedInstallationIds.push(candidate.row.target_installation_id);
    }
    return undefined;
  }

  async armCreate(lease: FeedbackPublicationWorkerLease): Promise<void> {
    if (!this.activeLeases.has(lease)) throw new FeedbackPublicationError("invalid-transition");
    await this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE feedback_publication_outbox outbox
         SET status='may-have-committed',create_eligible=false,
           create_attempt_count=create_attempt_count+1,updated_at=clock_timestamp()
         FROM feedback_publication_preparations prep
         WHERE prep.id=outbox.preparation_id AND ${EXACT_LEASE_WHERE}
           AND outbox.status='claimed' AND outbox.create_eligible
           AND outbox.create_attempt_count < $7
           AND prep.status='approved' AND prep.create_armed_at IS NULL
           AND EXISTS (
             SELECT 1 FROM feedback_review_items review
             WHERE review.id=prep.item_id AND review.state='approved'
               AND review.approval_preparation_id=prep.id
               AND review.payload_digest=prep.payload_digest
               AND review.approval_projection_digest=prep.projection_digest
               AND review.approval_target_policy_digest=prep.target_policy_digest
           )
         RETURNING outbox.id`,
        [...exactLeaseValues(lease), FEEDBACK_PUBLICATION_MAX_CREATE_ATTEMPTS],
      );
      if (result.rowCount !== 1) throw new FeedbackPublicationError("claim-unavailable");
      const armed = await client.query(
        `UPDATE feedback_publication_preparations SET create_armed_at=clock_timestamp()
         WHERE id=$1 AND create_armed_at IS NULL RETURNING id`,
        [lease.preparationId],
      );
      if (armed.rowCount !== 1) throw new FeedbackPublicationError("claim-unavailable");
      await appendDeliveryAudit(client, lease.outboxId, "create-armed", "may-have-committed");
    });
    await this.assertCommittedLease(lease, "may-have-committed");
  }

  async enterProviderCircuit(
    lease: FeedbackPublicationWorkerLease,
  ): Promise<FeedbackPublicationCircuitGate> {
    return this.transaction(async (client) => {
      const at = await databaseNow(client);
      const result = await client.query<{
        readonly consecutive_failures: number;
        readonly open_until: Date | null;
        readonly probe_owner: string | null;
        readonly probe_expires_at: Date | null;
      }>(
        `SELECT consecutive_failures,open_until,probe_owner,probe_expires_at
         FROM feedback_publication_installation_circuits
         WHERE installation_id=$1 FOR UPDATE`,
        [lease.target.installationId],
      );
      const state = result.rows[0];
      if (state === undefined || state.consecutive_failures < 3) {
        return { allowed: true, probe: false };
      }
      const blockedUntil = [state.open_until, state.probe_expires_at]
        .filter((value): value is Date => value !== null && value > at)
        .sort((left, right) => left.getTime() - right.getTime())[0];
      if (blockedUntil !== undefined) {
        return { allowed: false, delayMs: Math.max(1_000, blockedUntil.getTime() - at.getTime()) };
      }
      const probeExpiresAt = lease.leaseExpiresAt;
      const changed = await client.query(
        `UPDATE feedback_publication_installation_circuits
         SET open_until=NULL,probe_owner=$2,probe_expires_at=$3,updated_at=$4,
           expires_at=$4::timestamptz + interval '7 days'
         WHERE installation_id=$1 AND consecutive_failures=3
           AND (open_until IS NULL OR open_until <= $4)
           AND (probe_expires_at IS NULL OR probe_expires_at <= $4)`,
        [lease.target.installationId, lease.outboxId, probeExpiresAt, at],
      );
      if (changed.rowCount !== 1) return { allowed: false, delayMs: 1_000 };
      return { allowed: true, probe: true };
    });
  }

  async recordProviderFailure(
    lease: FeedbackPublicationWorkerLease,
    cooldownMs: number,
    openImmediately = false,
  ): Promise<void> {
    const bounded = Math.max(1_000, Math.min(Math.trunc(cooldownMs), 3_600_000));
    await this.transaction(async (client) => {
      const at = await databaseNow(client);
      const result = await client.query(
        `INSERT INTO feedback_publication_installation_circuits
           (installation_id,consecutive_failures,open_until,probe_owner,probe_expires_at,
            updated_at,expires_at)
         VALUES ($1,CASE WHEN $5 THEN 3 ELSE 1 END,
           CASE WHEN $5 THEN $3::timestamptz + $2::integer * interval '1 millisecond'
             ELSE NULL END,NULL,NULL,$3,$3::timestamptz + interval '7 days')
         ON CONFLICT (installation_id) DO UPDATE SET
           consecutive_failures=CASE WHEN $5 THEN 3 ELSE LEAST(3,
             feedback_publication_installation_circuits.consecutive_failures+1) END,
           open_until=CASE
             WHEN $5 OR feedback_publication_installation_circuits.consecutive_failures+1 >= 3
               THEN $3::timestamptz + $2::integer * interval '1 millisecond'
             ELSE NULL END,
           probe_owner=NULL,probe_expires_at=NULL,updated_at=$3,
           expires_at=$3::timestamptz + interval '7 days'
         WHERE feedback_publication_installation_circuits.probe_owner IS NULL
           OR feedback_publication_installation_circuits.probe_owner=$4::uuid`,
        [lease.target.installationId, bounded, at, lease.outboxId, openImmediately],
      );
      if (result.rowCount !== 1) throw new FeedbackPublicationError("claim-unavailable");
    });
  }

  async scheduleRetry(
    lease: FeedbackPublicationLeaseIdentity,
    code: FeedbackPublicationRetryCode,
    delayMs: number,
  ): Promise<"retryable-failure" | "manual-reconciliation"> {
    return this.transaction(async (client) => {
      const attempts = await this.createAttempts(client, lease, ["claimed"]);
      if (attempts >= FEEDBACK_PUBLICATION_MAX_CREATE_ATTEMPTS) {
        await this.manualTx(client, lease, "retry-exhausted");
        return "manual-reconciliation";
      }
      const bounded = boundedRetryDelay(delayMs);
      const result = await client.query(
        `UPDATE feedback_publication_outbox outbox
         SET status='retryable-failure',create_eligible=true,lease_owner=NULL,lease_expires_at=NULL,
           next_attempt_at=LEAST(clock_timestamp() + $7::integer * interval '1 millisecond',
             outbox.expires_at),failure_code=$8,updated_at=clock_timestamp()
         FROM feedback_publication_preparations prep
         WHERE prep.id=outbox.preparation_id AND ${EXACT_LEASE_WHERE}
           AND outbox.status='claimed' AND outbox.create_eligible RETURNING outbox.id`,
        [...exactLeaseValues(lease), bounded, code],
      );
      if (result.rowCount !== 1) throw new FeedbackPublicationError("claim-unavailable");
      await appendDeliveryAudit(client, lease.outboxId, "retry-scheduled", code);
      return "retryable-failure";
    });
  }

  async scheduleReconciliation(
    lease: FeedbackPublicationLeaseIdentity,
    delayMs: number,
  ): Promise<void> {
    const bounded = boundedRetryDelay(delayMs);
    await this.transition(
      lease,
      "may-have-committed",
      `status='may-have-committed',create_eligible=false,lease_owner=NULL,lease_expires_at=NULL,
       next_attempt_at=LEAST(clock_timestamp() + $7::integer * interval '1 millisecond',expires_at),
       failure_code='ambiguous-reconciliation',updated_at=clock_timestamp()`,
      [bounded],
      "reconciliation-scheduled",
      "not-observed",
    );
  }

  async scheduleCircuitDeferral(
    lease: FeedbackPublicationWorkerLease,
    delayMs: number,
  ): Promise<void> {
    const bounded = boundedRetryDelay(delayMs);
    const claimedStatus = lease.mode === "create-eligible" ? "claimed" : "may-have-committed";
    const deferredStatus =
      lease.mode === "create-eligible" ? "retryable-failure" : "may-have-committed";
    const failureCode =
      lease.mode === "create-eligible" ? "provider-unavailable" : "ambiguous-reconciliation";
    await this.transaction(async (client) => {
      const changed = await client.query(
        `UPDATE feedback_publication_outbox outbox
         SET status=$8,create_eligible=$9,lease_owner=NULL,lease_expires_at=NULL,
           next_attempt_at=LEAST(clock_timestamp() + $7::integer * interval '1 millisecond',
             outbox.expires_at),failure_code=$10,attempt_count=attempt_count-1,
           updated_at=clock_timestamp()
         FROM feedback_publication_preparations prep
         WHERE prep.id=outbox.preparation_id AND ${EXACT_LEASE_WHERE}
           AND outbox.status=$11 AND outbox.attempt_count > 0 RETURNING outbox.id`,
        [
          ...exactLeaseValues(lease),
          bounded,
          deferredStatus,
          lease.mode === "create-eligible",
          failureCode,
          claimedStatus,
        ],
      );
      if (changed.rowCount !== 1) throw new FeedbackPublicationError("claim-unavailable");
      await appendDeliveryAudit(
        client,
        lease.outboxId,
        lease.mode === "create-eligible" ? "retry-scheduled" : "reconciliation-scheduled",
        "circuit-open",
      );
    });
  }

  async recordManual(
    lease: FeedbackPublicationLeaseIdentity,
    code: FeedbackPublicationManualCode,
  ): Promise<void> {
    await this.transaction((client) => this.manualTx(client, lease, code));
  }

  async recordSuccess(
    lease: FeedbackPublicationLeaseIdentity,
    issue: FeedbackPublicationSuccess,
    source: "created" | "reconciled" = "created",
  ): Promise<void> {
    await this.transaction(async (client) => {
      const installationId = await this.validateSuccessLease(client, lease);
      await persistWorkerSuccess(client, lease, issue, this.hooks.afterLinkageInsert, source);
      await client.query(
        "DELETE FROM feedback_publication_installation_circuits WHERE installation_id=$1",
        [installationId],
      );
    });
  }

  private assertOptions(options: FeedbackPublicationWorkerOptions): void {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(options.workerId) ||
      !Number.isInteger(options.leaseDurationMs) ||
      options.leaseDurationMs < 1_000 ||
      options.leaseDurationMs > 300_000 ||
      (options.candidateLimit !== undefined &&
        (!Number.isInteger(options.candidateLimit) || options.candidateLimit < 1))
    ) {
      throw new FeedbackPublicationError("invalid-request");
    }
  }

  private assertCurrentTarget(row: FeedbackPublicationPreparationRow): void {
    const current = this.resolveTargetPolicy(row.target_key);
    if (
      current?.targetKey !== row.target_key ||
      !isFeedbackPublicationTargetPolicySnapshotV1(current) ||
      digestFeedbackTargetPolicyV1(current) !== row.target_policy_digest
    ) {
      throw new FeedbackPublicationError("target-policy-drift");
    }
  }

  private async claimCandidate(
    options: FeedbackPublicationWorkerOptions,
    excludedInstallationIds: readonly string[],
  ): Promise<ClaimedCandidate | undefined> {
    return this.transaction(async (client) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const row = await selectWorkerCandidate(client, excludedInstallationIds, 16 * 2 ** attempt);
        if (row === undefined) continue;
        const at = await databaseNow(client);
        const leaseExpiresAt = await claimWorkerCandidate(
          client,
          row,
          options.workerId,
          at,
          options.leaseDurationMs,
        );
        if (leaseExpiresAt === undefined) {
          await this.expireCandidate(client, row.id);
          continue;
        }
        await appendDeliveryAudit(
          client,
          row.id,
          candidateMode(row) === "create-eligible" ? "claimed-create" : "claimed-reconcile",
          "leased",
        );
        return { row, leaseExpiresAt };
      }
      return undefined;
    });
  }

  private async runUnderInstallationLock<T>(
    candidate: ClaimedCandidate,
    options: FeedbackPublicationWorkerOptions,
    handle: (lease: FeedbackPublicationWorkerLease) => Promise<T>,
  ): Promise<{ readonly acquired: false } | { readonly acquired: true; readonly value: T }> {
    const client = await acquirePostgresClient(this.installationSessionPool, this.deadlineMs);
    let locked = false;
    let transactionOpen = false;
    let discardError: Error | undefined;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await this.configureGuardTransaction(client);
      const result = await client.query<{ readonly locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended('keiko-feedback-publication-installation-v1:' || $1,0)) AS locked",
        [candidate.row.target_installation_id],
      );
      locked = result.rows[0]?.locked === true;
      if (!locked) {
        await this.restoreCandidate(client, candidate, options.workerId);
        await client.query("COMMIT");
        transactionOpen = false;
        return { acquired: false };
      }
      const lease = await this.loadOrSettle(client, candidate, options.workerId);
      await client.query("COMMIT");
      transactionOpen = false;
      this.activeLeases.add(lease);
      try {
        return { acquired: true, value: await handle(lease) };
      } finally {
        this.activeLeases.delete(lease);
      }
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      if (locked) {
        try {
          await this.unlockInstallation(client, candidate.row.target_installation_id);
        } catch (error) {
          discardError =
            error instanceof Error ? error : new Error("Publication advisory unlock failed");
        }
      }
      client.release(discardError);
    }
  }

  private async loadOrSettle(
    client: PgClientLike,
    candidate: ClaimedCandidate,
    workerId: string,
  ): Promise<FeedbackPublicationWorkerLease> {
    try {
      return await this.loadExactLease(client, candidate, workerId);
    } catch (error) {
      await this.settleLoadFailure(client, candidate, workerId, error);
      await client.query("COMMIT");
      throw error;
    }
  }

  private async configureGuardTransaction(client: PgClientLike): Promise<void> {
    await client.query("SELECT set_config('statement_timeout',$1::text,true)", [
      String(this.deadlineMs),
    ]);
    await client.query("SELECT set_config('lock_timeout',$1::text,true)", [
      String(this.deadlineMs),
    ]);
  }

  private async unlockInstallation(client: PgClientLike, installationId: string): Promise<void> {
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await this.configureGuardTransaction(client);
      const result = await client.query<{ readonly unlocked: boolean }>(
        "SELECT pg_advisory_unlock(hashtextextended('keiko-feedback-publication-installation-v1:' || $1,0)) AS unlocked",
        [installationId],
      );
      if (result.rows[0]?.unlocked !== true) {
        throw new Error("Publication advisory lock ownership was lost");
      }
      await client.query("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  private async loadExactLease(
    client: PgClientLike,
    candidate: ClaimedCandidate,
    workerId: string,
  ): Promise<FeedbackPublicationWorkerLease> {
    const row = await lockDispatchCandidate(client, candidate.row.id);
    if (row === undefined) throw new FeedbackPublicationError("claim-unavailable");
    this.assertCurrentTarget(row);
    const at = await databaseNow(client);
    const mode = candidateMode(candidate.row);
    const projection = leasedProjectionFromRow(
      row,
      at,
      workerId,
      candidate.leaseExpiresAt,
      mode === "create-eligible" ? "claimed" : "may-have-committed",
    );
    return { ...projection, mode, createAttemptCount: candidate.row.create_attempt_count };
  }

  private async restoreCandidate(
    client: PgClientLike,
    candidate: ClaimedCandidate,
    workerId: string,
  ): Promise<void> {
    const restored =
      candidate.row.status === "claimed"
        ? "unclaimed"
        : candidate.row.status === "may-have-committed"
          ? "may-have-committed"
          : candidate.row.status;
    await client.query(
      `UPDATE feedback_publication_outbox SET status=$4,lease_owner=NULL,lease_expires_at=NULL,
       next_attempt_at=CASE WHEN $4='retryable-failure' THEN clock_timestamp() ELSE next_attempt_at END,
       updated_at=clock_timestamp() WHERE id=$1 AND lease_owner=$2 AND lease_expires_at=$3`,
      [candidate.row.id, workerId, candidate.leaseExpiresAt, restored],
    );
  }

  private async expireCandidate(client: PgClientLike, outboxId: string): Promise<void> {
    await client.query(
      `UPDATE feedback_publication_outbox SET status='manual-reconciliation',create_eligible=false,
       lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,failure_code='lease-expired',
       updated_at=clock_timestamp() WHERE id=$1`,
      [outboxId],
    );
    await appendDeliveryAudit(client, outboxId, "manual-reconciliation", "lease-expired");
  }

  private async createAttempts(
    client: PgClientLike,
    lease: FeedbackPublicationLeaseIdentity,
    statuses: readonly string[],
  ): Promise<number> {
    const row = await this.lockExactLease(client, lease);
    if (row === undefined || !statuses.includes(row.status)) {
      throw new FeedbackPublicationError("claim-unavailable");
    }
    return row.create_attempt_count;
  }

  private async lockExactLease(
    client: PgClientLike,
    lease: FeedbackPublicationLeaseIdentity,
  ): Promise<{ readonly status: string; readonly create_attempt_count: number } | undefined> {
    const result = await client.query<{
      readonly status: string;
      readonly create_attempt_count: number;
    }>(
      `SELECT outbox.status,outbox.create_attempt_count
       FROM feedback_publication_outbox outbox
       JOIN feedback_publication_preparations prep ON prep.id=outbox.preparation_id
       WHERE ${EXACT_LEASE_WHERE} FOR UPDATE OF outbox`,
      exactLeaseValues(lease),
    );
    return result.rows[0];
  }

  private async manualTx(
    client: PgClientLike,
    lease: FeedbackPublicationLeaseIdentity,
    code: FeedbackPublicationManualCode,
  ): Promise<void> {
    const locked = await this.lockExactLease(client, lease);
    if (locked === undefined) throw new FeedbackPublicationError("claim-unavailable");
    await client.query(
      `UPDATE feedback_publication_outbox SET status='manual-reconciliation',create_eligible=false,
       lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,failure_code=$2,
       updated_at=clock_timestamp() WHERE id=$1`,
      [lease.outboxId, code],
    );
    await appendDeliveryAudit(client, lease.outboxId, "manual-reconciliation", code);
  }

  private async transition(
    lease: FeedbackPublicationLeaseIdentity,
    status: string,
    assignment: string,
    extra: readonly unknown[],
    action: string,
    result: string,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const changed = await client.query(
        `UPDATE feedback_publication_outbox outbox SET ${assignment}
         FROM feedback_publication_preparations prep
         WHERE prep.id=outbox.preparation_id AND ${EXACT_LEASE_WHERE}
           AND outbox.status=$${String(7 + extra.length)} RETURNING outbox.id`,
        [...exactLeaseValues(lease), ...extra, status],
      );
      if (changed.rowCount !== 1) throw new FeedbackPublicationError("claim-unavailable");
      await appendDeliveryAudit(client, lease.outboxId, action, result);
    });
  }

  private async assertCommittedLease(
    lease: FeedbackPublicationWorkerLease,
    status: "claimed" | "may-have-committed",
  ): Promise<void> {
    const client = await acquirePostgresClient(this.pool, this.deadlineMs);
    try {
      const row = await lockDispatchCandidate(client, lease.outboxId);
      if (row === undefined) throw new FeedbackPublicationError("claim-unavailable");
      this.assertCurrentTarget(row);
      const at = await databaseNow(client);
      leasedProjectionFromRow(row, at, lease.leaseOwner, lease.leaseExpiresAt, status);
      if (
        row.id !== lease.preparationId ||
        row.item_id !== lease.itemId ||
        row.target_policy_digest !== lease.targetPolicyDigest ||
        row.create_armed_at === null ||
        row.create_attempt_count !== lease.createAttemptCount + 1
      ) {
        throw new FeedbackPublicationError("claim-unavailable");
      }
    } finally {
      client.release();
    }
  }

  private async validateSuccessLease(
    client: PgClientLike,
    lease: FeedbackPublicationLeaseIdentity,
  ): Promise<string> {
    const row = await lockDispatchCandidate(client, lease.outboxId);
    if (row === undefined || !["claimed", "may-have-committed"].includes(row.outbox_status)) {
      throw new FeedbackPublicationError("claim-unavailable");
    }
    this.assertCurrentTarget(row);
    leasedProjectionFromRow(
      row,
      await databaseNow(client),
      lease.leaseOwner,
      lease.leaseExpiresAt,
      row.outbox_status as "claimed" | "may-have-committed",
    );
    if (
      row.id !== lease.preparationId ||
      row.item_id !== lease.itemId ||
      row.target_policy_digest !== lease.targetPolicyDigest
    ) {
      throw new FeedbackPublicationError("claim-unavailable");
    }
    return row.target_installation_id;
  }

  private async settleLoadFailure(
    client: PgClientLike,
    candidate: ClaimedCandidate,
    workerId: string,
    error: unknown,
  ): Promise<void> {
    const code =
      error instanceof FeedbackPublicationError &&
      ["target-policy-drift", "projection-drift", "payload-private", "payload-expired"].includes(
        error.code,
      )
        ? error.code
        : "lease-expired";
    const updated = await client.query(
      `UPDATE feedback_publication_outbox SET status='manual-reconciliation',create_eligible=false,
       lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,failure_code=$4,
       updated_at=clock_timestamp() WHERE id=$1 AND lease_owner=$2 AND lease_expires_at=$3
       RETURNING id`,
      [candidate.row.id, workerId, candidate.leaseExpiresAt, code],
    );
    if (updated.rowCount !== 1) throw new FeedbackPublicationError("claim-unavailable");
    await this.hooks.afterLoadFailureUpdate?.();
    await appendDeliveryAudit(client, candidate.row.id, "manual-reconciliation", code);
  }

  private async transaction<T>(operation: (client: PgClientLike) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      const client = await acquirePostgresClient(this.pool, this.deadlineMs);
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await client.query("SELECT set_config('statement_timeout',$1::text,true)", [
          String(this.deadlineMs),
        ]);
        const value = await operation(client);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (!isRetryablePostgresError(error) || attempt + 1 === this.maxRetries) throw error;
      } finally {
        client.release();
      }
    }
    throw new Error("Feedback publication worker retry bound exhausted");
  }
}
