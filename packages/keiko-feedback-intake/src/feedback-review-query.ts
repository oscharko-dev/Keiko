import { createHash } from "node:crypto";
import type {
  FeedbackReviewAuditV1,
  FeedbackReviewDetailV1,
  FeedbackReviewHoldGovernanceV1,
  FeedbackReviewListItemV1,
  FeedbackReviewListPageV1,
} from "@oscharko-dev/keiko-contracts/feedback-maintainer";
import { parseFeedbackReportV1 } from "@oscharko-dev/keiko-contracts/feedback-report";
import type { FeedbackReviewStateV1 } from "@oscharko-dev/keiko-contracts/feedback-review";
import { FeedbackReviewError } from "./feedback-review-types.js";
import { acquirePostgresClient } from "./postgres-client.js";
import type { PgPoolLike } from "./postgres-types.js";

interface ReviewQueryRow {
  readonly id: string;
  readonly opaque_id: string;
  readonly group_count: string;
  readonly payload_digest: string;
  readonly exact_body_sha256: string;
  readonly canonical_bytes: Uint8Array;
  readonly state: FeedbackReviewStateV1;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly hold_policy_key?: string | null;
  readonly hold_review_at?: Date | null;
  readonly hold_expires_at?: Date | null;
  readonly hold_active?: boolean | null;
}

interface AuditRow {
  readonly event_id: string;
  readonly item_id: string;
  readonly payload_digest: string;
  readonly prior_version: number;
  readonly result_version: number;
  readonly action: string;
  readonly prior_state: FeedbackReviewStateV1;
  readonly result_state: FeedbackReviewStateV1;
  readonly result: "applied";
  readonly event_at: Date;
  readonly actor_issuer: string;
  readonly actor_sub: string;
  readonly permission_policy_version: string;
  readonly policy_key: string | null;
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface ReviewListInput {
  readonly state?: FeedbackReviewStateV1 | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly includePrivate: boolean;
}

function cursor(value: string | undefined): readonly [Date, string] | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 2) return undefined;
    const time: unknown = decoded[0];
    const id: unknown = decoded[1];
    if (typeof time !== "string" || typeof id !== "string" || !CANONICAL_UUID.test(id)) {
      return undefined;
    }
    const at = new Date(time);
    return Number.isFinite(at.getTime()) ? [at, id] : undefined;
  } catch {
    return undefined;
  }
}

function assertPayload(row: ReviewQueryRow): string {
  const actual = createHash("sha256").update(row.canonical_bytes).digest("hex");
  if (actual !== row.payload_digest || row.exact_body_sha256 !== row.payload_digest) {
    throw new FeedbackReviewError("payload-digest-drift");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(row.canonical_bytes);
  } catch {
    throw new FeedbackReviewError("payload-digest-drift");
  }
}

function listItem(row: ReviewQueryRow): FeedbackReviewListItemV1 {
  const parsed = parseFeedbackReportV1(JSON.parse(assertPayload(row)) as unknown);
  if (!parsed.ok) throw new FeedbackReviewError("payload-digest-drift");
  return {
    itemId: row.id,
    reviewGroupId: row.opaque_id,
    groupCount: Math.min(Number(row.group_count), 2_147_483_647),
    payloadDigest: row.payload_digest,
    state: row.state,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    category: parsed.value.diagnostics.category,
    featureArea: parsed.value.diagnostics.featureArea,
    impact: parsed.value.impact,
    ...(parsed.value.diagnostics.severityCounts === undefined
      ? {}
      : { severityCounts: parsed.value.diagnostics.severityCounts }),
  };
}

function legalHold(row: ReviewQueryRow): FeedbackReviewHoldGovernanceV1["legalHold"] {
  if (
    row.hold_policy_key === undefined ||
    row.hold_policy_key === null ||
    row.hold_review_at === undefined ||
    row.hold_review_at === null ||
    row.hold_expires_at === undefined ||
    row.hold_expires_at === null
  ) {
    return { status: "none" };
  }
  return {
    status: row.hold_active ? "active" : "expired",
    policyKey: row.hold_policy_key,
    reviewAt: row.hold_review_at.toISOString(),
    expiresAt: row.hold_expires_at.toISOString(),
  };
}

export class PostgresFeedbackReviewQuery {
  constructor(
    private readonly pool: PgPoolLike,
    private readonly deadlineMs = 5_000,
  ) {}

  async list(input: ReviewListInput): Promise<FeedbackReviewListPageV1> {
    const after = listCursor(input);
    const client = await acquirePostgresClient(this.pool, this.deadlineMs);
    try {
      const result = await client.query<ReviewQueryRow>(
        "SELECT i.id, g.opaque_id, COALESCE((SELECT max(d.bounded_count)::text FROM feedback_dedupe_entries d WHERE d.semantic_group_id = i.semantic_group_id AND d.expires_at > transaction_timestamp()), '1') AS group_count, i.payload_digest, p.exact_body_sha256, p.canonical_bytes, i.state, i.version, i.created_at, i.updated_at FROM feedback_review_items i JOIN feedback_payloads p ON p.id = i.payload_id JOIN feedback_review_groups g ON g.semantic_group_id = i.semantic_group_id LEFT JOIN feedback_private_semantic_groups private ON private.semantic_group_id = i.semantic_group_id LEFT JOIN feedback_legal_holds hold ON hold.item_id = i.id AND hold.expires_at > transaction_timestamp() WHERE ($1::text IS NULL OR i.state = $1) AND (p.expires_at > transaction_timestamp() OR hold.item_id IS NOT NULL) AND ($2::boolean OR (i.state <> 'private-security' AND private.semantic_group_id IS NULL)) AND ($3::timestamptz IS NULL OR (i.updated_at, i.id) < ($3,$4::uuid)) ORDER BY i.updated_at DESC, i.id DESC LIMIT $5",
        [
          input.state ?? null,
          input.includePrivate,
          after?.[0] ?? null,
          after?.[1] ?? null,
          input.limit + 1,
        ],
      );
      const items = result.rows.slice(0, input.limit).map(listItem);
      const last = items.at(-1);
      return result.rows.length <= input.limit || last === undefined
        ? { items }
        : { items, nextCursor: encodeReviewCursor(last) };
    } finally {
      client.release();
    }
  }

  async detail(
    itemId: string,
    includePrivate: boolean,
  ): Promise<FeedbackReviewDetailV1 | undefined> {
    const client = await acquirePostgresClient(this.pool, this.deadlineMs);
    try {
      const result = await client.query<ReviewQueryRow>(
        "SELECT i.id, g.opaque_id, COALESCE((SELECT max(d.bounded_count)::text FROM feedback_dedupe_entries d WHERE d.semantic_group_id = i.semantic_group_id AND d.expires_at > transaction_timestamp()), '1') AS group_count, i.payload_digest, p.exact_body_sha256, p.canonical_bytes, i.state, i.version, i.created_at, i.updated_at, hold.policy_key AS hold_policy_key, hold.review_at AS hold_review_at, hold.expires_at AS hold_expires_at, (hold.expires_at > transaction_timestamp()) AS hold_active FROM feedback_review_items i JOIN feedback_payloads p ON p.id = i.payload_id JOIN feedback_review_groups g ON g.semantic_group_id = i.semantic_group_id LEFT JOIN feedback_private_semantic_groups private ON private.semantic_group_id = i.semantic_group_id LEFT JOIN feedback_legal_holds hold ON hold.item_id = i.id WHERE i.id = $1 AND (p.expires_at > transaction_timestamp() OR hold.expires_at > transaction_timestamp()) AND ($2::boolean OR (i.state <> 'private-security' AND private.semantic_group_id IS NULL))",
        [itemId, includePrivate],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : { ...listItem(row), canonicalPayload: assertPayload(row), legalHold: legalHold(row) };
    } finally {
      client.release();
    }
  }

  async hold(
    itemId: string,
    includePrivate: boolean,
  ): Promise<FeedbackReviewHoldGovernanceV1 | undefined> {
    const client = await acquirePostgresClient(this.pool, this.deadlineMs);
    try {
      const result = await client.query<ReviewQueryRow>(
        "SELECT i.id, i.payload_digest, i.version, h.policy_key AS hold_policy_key, h.review_at AS hold_review_at, h.expires_at AS hold_expires_at, (h.expires_at > transaction_timestamp()) AS hold_active FROM feedback_review_items i JOIN feedback_payloads p ON p.id = i.payload_id JOIN feedback_legal_holds h ON h.item_id = i.id LEFT JOIN feedback_private_semantic_groups private ON private.semantic_group_id = i.semantic_group_id WHERE i.id = $1 AND ($2::boolean OR (i.state <> 'private-security' AND private.semantic_group_id IS NULL))",
        [itemId, includePrivate],
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : {
            itemId: row.id,
            payloadDigest: row.payload_digest,
            version: row.version,
            legalHold: legalHold(row),
          };
    } finally {
      client.release();
    }
  }

  async audit(limit: number, includePrivate: boolean): Promise<readonly FeedbackReviewAuditV1[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new FeedbackReviewError("invalid-request");
    const client = await acquirePostgresClient(this.pool, this.deadlineMs);
    try {
      const result = await client.query<AuditRow>(
        "SELECT audit.event_id::text, audit.item_id, audit.payload_digest, audit.prior_version, audit.result_version, audit.action, audit.prior_state, audit.result_state, audit.result, audit.event_at, audit.actor_issuer, audit.actor_sub, audit.permission_policy_version, audit.policy_key FROM feedback_review_audit audit LEFT JOIN feedback_private_review_group_tombstones private ON private.review_group_id = audit.review_group_id AND private.expires_at > transaction_timestamp() LEFT JOIN feedback_review_groups groups ON groups.opaque_id = audit.review_group_id LEFT JOIN feedback_private_semantic_groups active ON active.semantic_group_id = groups.semantic_group_id WHERE $2::boolean OR (audit.prior_state <> 'private-security' AND audit.result_state <> 'private-security' AND private.review_group_id IS NULL AND active.semantic_group_id IS NULL) ORDER BY audit.event_id DESC LIMIT $1",
        [limit, includePrivate],
      );
      return result.rows.map((row) => ({
        eventId: row.event_id,
        itemId: row.item_id,
        payloadDigest: row.payload_digest,
        priorVersion: row.prior_version,
        resultVersion: row.result_version,
        action: row.action,
        priorState: row.prior_state,
        resultState: row.result_state,
        result: row.result,
        eventAt: row.event_at.toISOString(),
        issuer: row.actor_issuer,
        subject: row.actor_sub,
        permissionPolicyVersion: row.permission_policy_version,
        ...(row.policy_key === null ? {} : { policyKey: row.policy_key }),
      }));
    } finally {
      client.release();
    }
  }
}

function listCursor(input: ReviewListInput): readonly [Date, string] | undefined {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new FeedbackReviewError("invalid-request");
  }
  const after = cursor(input.cursor);
  if (input.cursor !== undefined && after === undefined) {
    throw new FeedbackReviewError("invalid-request");
  }
  return after;
}

export function encodeReviewCursor(item: FeedbackReviewListItemV1): string {
  return Buffer.from(JSON.stringify([item.updatedAt, item.itemId]), "utf8").toString("base64url");
}
