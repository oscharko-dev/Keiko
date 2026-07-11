import type {
  FeedbackReviewActionV1,
  FeedbackReviewStateV1,
} from "@oscharko-dev/keiko-contracts/feedback-review";
import type { FeedbackReviewCommand } from "./feedback-review-types.js";
import type { PgClientLike } from "./postgres-types.js";

interface PersistenceRow {
  readonly payload_id: string;
  readonly review_group_id: string;
  readonly payload_digest: string;
  readonly version: number;
  readonly state: FeedbackReviewStateV1;
  readonly hold_policy_key: string | null;
}

const TERMINAL_ACTIONS: readonly FeedbackReviewActionV1[] = [
  "mark-duplicate",
  "reject",
  "archive",
  "route-private-security",
  "expire",
];

async function terminalRetention(
  client: PgClientLike,
  command: FeedbackReviewCommand,
  row: PersistenceRow,
  at: Date,
): Promise<void> {
  if (!TERMINAL_ACTIONS.includes(command.action)) return;
  await client.query(
    "UPDATE feedback_payloads SET expires_at = LEAST(expires_at, $2::timestamptz + interval '30 days') WHERE id = $1",
    [row.payload_id, at],
  );
  await client.query(
    "UPDATE feedback_receipts SET closed = true, closed_at = COALESCE(closed_at, $2), expires_at = LEAST(expires_at, $2::timestamptz + interval '30 days') WHERE payload_id = $1",
    [row.payload_id, at],
  );
}

async function audit(
  client: PgClientLike,
  command: FeedbackReviewCommand,
  row: PersistenceRow,
  state: FeedbackReviewStateV1,
  version: number,
  at: Date,
): Promise<void> {
  const policyKey =
    command.action === "place-legal-hold"
      ? command.policyKey
      : command.action === "release-legal-hold" || command.action === "expire-legal-hold"
        ? row.hold_policy_key
        : null;
  await client.query(
    "INSERT INTO feedback_review_audit (item_id, review_group_id, payload_digest, prior_version, result_version, action, prior_state, result_state, result, event_at, actor_issuer, actor_sub, permission_policy_version, policy_key, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'applied',$9,$10,$11,$12,$13,$9::timestamptz + interval '365 days')",
    [
      command.itemId,
      row.review_group_id,
      row.payload_digest,
      row.version,
      version,
      command.action,
      row.state,
      state,
      at,
      command.actor.issuer,
      command.actor.subject,
      command.actor.permissionPolicyVersion,
      policyKey,
    ],
  );
}

async function extendPrivateTombstone(
  client: PgClientLike,
  row: PersistenceRow,
  at: Date,
): Promise<void> {
  await client.query(
    "INSERT INTO feedback_private_review_group_tombstones (review_group_id, restricted_at, expires_at) SELECT $1,$2,$2::timestamptz + interval '365 days' WHERE EXISTS (SELECT 1 FROM feedback_private_review_group_tombstones existing WHERE existing.review_group_id = $1 UNION ALL SELECT 1 FROM feedback_review_groups groups JOIN feedback_private_semantic_groups active ON active.semantic_group_id = groups.semantic_group_id WHERE groups.opaque_id = $1) ON CONFLICT (review_group_id) DO UPDATE SET restricted_at = GREATEST(feedback_private_review_group_tombstones.restricted_at, EXCLUDED.restricted_at), expires_at = GREATEST(feedback_private_review_group_tombstones.expires_at, EXCLUDED.expires_at)",
    [row.review_group_id, at],
  );
}

export async function persistReviewMutation(
  client: PgClientLike,
  command: FeedbackReviewCommand,
  digest: string,
  row: PersistenceRow,
  state: FeedbackReviewStateV1,
  version: number,
  at: Date,
): Promise<void> {
  await terminalRetention(client, command, row, at);
  await extendPrivateTombstone(client, row, at);
  await audit(client, command, row, state, version, at);
  await client.query(
    "INSERT INTO feedback_review_idempotency (idempotency_key, request_digest, item_id, review_group_id, result_state, result_version, result_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7::timestamptz + interval '365 days')",
    [command.idempotencyKey, digest, command.itemId, row.review_group_id, state, version, at],
  );
}
