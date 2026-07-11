import { createHash } from "node:crypto";
import {
  feedbackReviewTransitionV1,
  isFeedbackLegalHoldPolicyAllowlistV1,
  type FeedbackReviewStateV1,
} from "@oscharko-dev/keiko-contracts/feedback-review";
import {
  assertFeedbackReviewCommand,
  feedbackReviewCommandDigest,
  feedbackReviewReplayResult,
} from "./feedback-review-command.js";
import { persistReviewMutation } from "./feedback-review-persistence.js";
import { acquirePostgresClient, isRetryablePostgresError } from "./postgres-client.js";
import type { PgClientLike, PgPoolLike } from "./postgres-types.js";
import {
  FeedbackReviewError,
  type FeedbackReviewCommand,
  type FeedbackReviewMutationResult,
  type FeedbackReviewRecord,
} from "./feedback-review-types.js";

interface ReviewRow {
  readonly id: string;
  readonly payload_id: string;
  readonly semantic_group_id: string;
  readonly review_group_id: string;
  readonly payload_digest: string;
  readonly state: FeedbackReviewStateV1;
  readonly version: number;
  readonly hold_policy_key: string | null;
  readonly hold_expires_at: Date | null;
  readonly hold_active: boolean;
  readonly payload_exact_digest: string;
  readonly canonical_bytes: Uint8Array;
  readonly payload_expires_at: Date;
  readonly payload_eligible: boolean;
}

interface ReplayRow {
  readonly request_digest: string;
  readonly item_id: string;
  readonly result_state: FeedbackReviewStateV1;
  readonly result_version: number;
  readonly result_at: Date;
  readonly restricted_review_group_id: string | null;
  readonly active_private_group_id: string | null;
}

async function findReplay(
  client: PgClientLike,
  command: FeedbackReviewCommand,
  digest: string,
  allowPrivate: boolean,
): Promise<FeedbackReviewMutationResult | undefined> {
  const result = await client.query<ReplayRow>(
    "SELECT replay.request_digest, replay.item_id, replay.result_state, replay.result_version, replay.result_at, private.review_group_id AS restricted_review_group_id, active.semantic_group_id AS active_private_group_id FROM feedback_review_idempotency replay LEFT JOIN feedback_private_review_group_tombstones private ON private.review_group_id = replay.review_group_id AND private.expires_at > transaction_timestamp() LEFT JOIN feedback_review_groups groups ON groups.opaque_id = replay.review_group_id LEFT JOIN feedback_private_semantic_groups active ON active.semantic_group_id = groups.semantic_group_id WHERE replay.idempotency_key = $1 FOR UPDATE OF replay",
    [command.idempotencyKey],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  if (
    !allowPrivate &&
    (row.result_state === "private-security" ||
      row.restricted_review_group_id !== null ||
      row.active_private_group_id !== null)
  ) {
    throw new FeedbackReviewError("not-found");
  }
  if (row.request_digest !== digest) throw new FeedbackReviewError("idempotency-mismatch");
  return feedbackReviewReplayResult(row);
}

async function lockReviewItem(
  client: PgClientLike,
  itemId: string,
  allowPrivate: boolean,
): Promise<ReviewRow> {
  const result = await client.query<ReviewRow>(
    "SELECT i.id, i.payload_id, i.semantic_group_id, groups.opaque_id AS review_group_id, i.payload_digest, i.state, i.version, h.policy_key AS hold_policy_key, h.expires_at AS hold_expires_at, COALESCE(h.expires_at > transaction_timestamp(), false) AS hold_active, p.exact_body_sha256 AS payload_exact_digest, p.canonical_bytes, p.expires_at AS payload_expires_at, (p.expires_at > transaction_timestamp() OR COALESCE(h.expires_at > transaction_timestamp(), false)) AS payload_eligible FROM feedback_review_items i JOIN feedback_payloads p ON p.id = i.payload_id JOIN feedback_review_groups groups ON groups.semantic_group_id = i.semantic_group_id LEFT JOIN feedback_legal_holds h ON h.item_id = i.id LEFT JOIN feedback_private_semantic_groups private ON private.semantic_group_id = i.semantic_group_id WHERE i.id = $1 AND ($2::boolean OR (i.state <> 'private-security' AND private.semantic_group_id IS NULL)) FOR UPDATE OF i, p",
    [itemId, allowPrivate],
  );
  const row = result.rows[0];
  if (row === undefined) throw new FeedbackReviewError("not-found");
  return row;
}

function assertPayloadEligible(row: ReviewRow, command?: FeedbackReviewCommand): void {
  if (
    !row.payload_eligible &&
    !(command?.action === "expire-legal-hold" && row.hold_policy_key !== null)
  ) {
    throw new FeedbackReviewError("payload-expired");
  }
}

function assertPayloadIntegrity(row: ReviewRow): void {
  const actual = createHash("sha256").update(row.canonical_bytes).digest("hex");
  if (row.payload_digest !== row.payload_exact_digest || actual !== row.payload_digest) {
    throw new FeedbackReviewError("payload-digest-drift");
  }
}

function assertCas(row: ReviewRow, command: FeedbackReviewCommand): void {
  if (
    row.version !== command.expectedVersion ||
    row.payload_digest !== command.expectedPayloadDigest
  ) {
    throw new FeedbackReviewError("cas-mismatch");
  }
}

function assertLegalHold(
  command: FeedbackReviewCommand,
  row: ReviewRow,
  policyKeys: ReadonlySet<string>,
  at: Date,
): void {
  if (command.action === "place-legal-hold") {
    if (row.payload_expires_at <= at) throw new FeedbackReviewError("payload-expired");
    if (
      row.hold_policy_key !== null ||
      !policyKeys.has(command.policyKey) ||
      !(command.reviewAt > at && command.expiresAt > command.reviewAt)
    ) {
      throw new FeedbackReviewError("invalid-legal-hold");
    }
  }
  if (command.action === "expire-legal-hold" && (row.hold_expires_at === null || row.hold_active)) {
    throw new FeedbackReviewError("invalid-legal-hold");
  }
}

async function applyDuplicate(
  client: PgClientLike,
  command: Extract<FeedbackReviewCommand, { readonly action: "mark-duplicate" }>,
  at: Date,
  allowPrivate: boolean,
): Promise<void> {
  if (command.targetItemId === command.itemId) {
    throw new FeedbackReviewError("invalid-duplicate-target");
  }
  const target = await lockReviewItem(client, command.targetItemId, allowPrivate);
  assertPayloadEligible(target);
  assertPayloadIntegrity(target);
  if (target.state === "duplicate") throw new FeedbackReviewError("invalid-duplicate-target");
  await client.query(
    "INSERT INTO feedback_manual_duplicate_links (source_item_id, target_item_id, created_at) VALUES ($1,$2,$3)",
    [command.itemId, command.targetItemId, at],
  );
}

async function applyLegalHold(
  client: PgClientLike,
  command: FeedbackReviewCommand,
  at: Date,
): Promise<void> {
  if (command.action === "place-legal-hold") {
    await client.query(
      "INSERT INTO feedback_legal_holds (item_id, policy_key, placed_at, review_at, expires_at, actor_issuer, actor_sub, permission_policy_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        command.itemId,
        command.policyKey,
        at,
        command.reviewAt,
        command.expiresAt,
        command.actor.issuer,
        command.actor.subject,
        command.actor.permissionPolicyVersion,
      ],
    );
  } else if (command.action === "release-legal-hold" || command.action === "expire-legal-hold") {
    await client.query("DELETE FROM feedback_legal_holds WHERE item_id = $1", [command.itemId]);
  }
}

async function applyActionEffects(
  client: PgClientLike,
  command: FeedbackReviewCommand,
  row: ReviewRow,
  at: Date,
  allowPrivate: boolean,
): Promise<void> {
  if (command.action === "mark-duplicate") await applyDuplicate(client, command, at, allowPrivate);
  if (command.action === "route-private-security") {
    await client.query(
      "INSERT INTO feedback_private_semantic_groups (semantic_group_id, restricted_at) VALUES ($1,$2) ON CONFLICT (semantic_group_id) DO NOTHING",
      [row.semantic_group_id, at],
    );
    await client.query(
      "INSERT INTO feedback_private_review_group_tombstones (review_group_id, restricted_at, expires_at) VALUES ($1,$2,$2::timestamptz + interval '365 days') ON CONFLICT (review_group_id) DO UPDATE SET restricted_at = GREATEST(feedback_private_review_group_tombstones.restricted_at, EXCLUDED.restricted_at), expires_at = GREATEST(feedback_private_review_group_tombstones.expires_at, EXCLUDED.expires_at)",
      [row.review_group_id, at],
    );
  }
  await applyLegalHold(client, command, at);
}

function rejectionReason(command: FeedbackReviewCommand): string | null {
  return command.action === "reject" ? command.reason : null;
}

async function updateReviewItem(
  client: PgClientLike,
  command: FeedbackReviewCommand,
  state: FeedbackReviewStateV1,
  at: Date,
): Promise<number> {
  const result = await client.query<{ readonly version: number }>(
    "UPDATE feedback_review_items SET state = $2, rejection_reason = $3, version = version + 1, updated_at = $4, approval_payload_digest = NULL, approval_marker = NULL, approval_projection_digest = NULL, approval_target_key = NULL, approval_label_policy_version = NULL, approval_actor_issuer = NULL, approval_actor_sub = NULL, approval_permission_policy_version = NULL, approval_record_version = NULL WHERE id = $1 AND version = $5 AND payload_digest = $6 RETURNING version",
    [
      command.itemId,
      state,
      rejectionReason(command),
      at,
      command.expectedVersion,
      command.expectedPayloadDigest,
    ],
  );
  const version = result.rows[0]?.version;
  if (version === undefined) throw new FeedbackReviewError("cas-mismatch");
  return version;
}

async function mutate(
  client: PgClientLike,
  command: FeedbackReviewCommand,
  digest: string,
  legalHoldPolicyKeys: ReadonlySet<string>,
  at: Date,
  allowPrivate: boolean,
): Promise<FeedbackReviewMutationResult> {
  const replay = await findReplay(client, command, digest, allowPrivate);
  if (replay !== undefined) return replay;
  const row = await lockReviewItem(client, command.itemId, allowPrivate);
  assertPayloadEligible(row, command);
  assertPayloadIntegrity(row);
  assertCas(row, command);
  assertLegalHold(command, row, legalHoldPolicyKeys, at);
  const decision = feedbackReviewTransitionV1(
    row.state,
    command.action,
    row.hold_policy_key !== null,
  );
  if (!decision.allowed) throw new FeedbackReviewError("invalid-transition");
  await applyActionEffects(client, command, row, at, allowPrivate);
  const version = await updateReviewItem(client, command, decision.state, at);
  await persistReviewMutation(client, command, digest, row, decision.state, version, at);
  return {
    itemId: command.itemId,
    state: decision.state,
    version,
    at,
    replayed: false,
  };
}

export class PostgresFeedbackReviewRepository {
  private readonly legalHoldPolicyKeys: ReadonlySet<string>;

  constructor(
    private readonly pool: PgPoolLike,
    private readonly deadlineMs = 5_000,
    legalHoldPolicyKeys: readonly string[] = [],
    private readonly now: () => Date = () => new Date(),
    private readonly maxRetries = 3,
  ) {
    if (
      legalHoldPolicyKeys.length > 0 &&
      !isFeedbackLegalHoldPolicyAllowlistV1(legalHoldPolicyKeys)
    ) {
      throw new FeedbackReviewError("invalid-legal-hold");
    }
    this.legalHoldPolicyKeys = new Set(legalHoldPolicyKeys);
  }

  async execute(
    command: FeedbackReviewCommand,
    allowPrivate = false,
  ): Promise<FeedbackReviewMutationResult> {
    assertFeedbackReviewCommand(command);
    const at = new Date(this.now().getTime());
    if (!Number.isFinite(at.getTime())) throw new Error("Feedback review clock is invalid");
    const digest = feedbackReviewCommandDigest(command);
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      try {
        return await this.executeAttempt(command, digest, at, allowPrivate);
      } catch (error) {
        if (!isRetryablePostgresError(error) || attempt + 1 === this.maxRetries) throw error;
      }
    }
    throw new Error("Feedback review retry bound exhausted");
  }

  private async executeAttempt(
    command: FeedbackReviewCommand,
    digest: string,
    at: Date,
    allowPrivate: boolean,
  ): Promise<FeedbackReviewMutationResult> {
    const client = await acquirePostgresClient(this.pool, this.deadlineMs);
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SELECT set_config('statement_timeout', $1::text, true)", [
        String(this.deadlineMs),
      ]);
      const result = await mutate(
        client,
        command,
        digest,
        this.legalHoldPolicyKeys,
        at,
        allowPrivate,
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async find(itemId: string, includePrivate = false): Promise<FeedbackReviewRecord | undefined> {
    const client = await acquirePostgresClient(this.pool, this.deadlineMs);
    try {
      const result = await client.query<ReviewRow>(
        "SELECT i.id, i.payload_id, i.semantic_group_id, groups.opaque_id AS review_group_id, i.payload_digest, i.state, i.version, h.policy_key AS hold_policy_key, h.expires_at AS hold_expires_at, COALESCE(h.expires_at > transaction_timestamp(), false) AS hold_active, p.exact_body_sha256 AS payload_exact_digest, p.canonical_bytes, p.expires_at AS payload_expires_at, (p.expires_at > transaction_timestamp() OR COALESCE(h.expires_at > transaction_timestamp(), false)) AS payload_eligible FROM feedback_review_items i JOIN feedback_payloads p ON p.id = i.payload_id JOIN feedback_review_groups groups ON groups.semantic_group_id = i.semantic_group_id LEFT JOIN feedback_legal_holds h ON h.item_id = i.id LEFT JOIN feedback_private_semantic_groups g ON g.semantic_group_id = i.semantic_group_id WHERE i.id = $1 AND (p.expires_at > transaction_timestamp() OR COALESCE(h.expires_at > transaction_timestamp(), false)) AND ($2 OR (i.state <> 'private-security' AND g.semantic_group_id IS NULL))",
        [itemId, includePrivate],
      );
      const row = result.rows[0];
      if (row !== undefined) assertPayloadIntegrity(row);
      return row === undefined
        ? undefined
        : {
            itemId: row.id,
            payloadId: row.payload_id,
            payloadDigest: row.payload_digest,
            state: row.state,
            version: row.version,
            hasActiveLegalHold: row.hold_active,
          };
    } finally {
      client.release();
    }
  }
}
