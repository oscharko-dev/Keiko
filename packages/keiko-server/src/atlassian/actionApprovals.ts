// Server-side pending-approval state for review-required connector actions (Issue #2244, Epic
// #2238, ADR-0128 D4; rendered by the #2245 UI).
//
// A `review-required` disposition surfaces a pending approval INSTEAD of executing: the bounded
// registry below holds the validated action input server-side while the wire only ever carries
// the content-free `AtlassianConnectorPendingApproval` projection (identifiers, D4 row, review
// reason, TTL — no summaries, descriptions, comment text, or page bodies). Credentials never
// enter an entry: the payload references the opaque `authRef` only, and the executor resolves
// the live secret at execution time through the port closure (ADR-0128 D2).
//
// Lifecycle: single-use and fail-closed. `consume` (approve) and `reject` remove the entry
// atomically; an unknown, already-resolved, or EXPIRED id answers `undefined` (the routes map
// that to 404 — no oracle distinguishing the cases). Expired entries are evicted on every
// operation; nothing was executed for them, so the `pending-review` activity record emitted at
// creation remains the complete audit trail for an expired approval. The registry is bounded on
// both axes: a hard cap on simultaneously-pending entries and the TTL after which an unresolved
// entry is dropped.

import type {
  AtlassianConnectorPendingApproval,
  JiraLiveSearchRequest,
  KnowledgeCapsuleId,
} from "@oscharko-dev/keiko-contracts";
import type { AtlassianActionAuthorityContext } from "./actionPolicy.js";

export const ATLASSIAN_ACTION_APPROVAL_TTL_MS = 600_000;
export const ATLASSIAN_ACTION_APPROVAL_MAX_PENDING = 64;

// The validated write-action request a pending approval executes on approve. Text fields carry
// the caller's composed input (bodies) — which is exactly why this union exists ONLY inside the
// server-side entry and never crosses the wire in an approval projection or activity record.
export type AtlassianWriteActionInput =
  | {
      readonly type: "create-issue";
      readonly projectKey: string;
      readonly issueTypeId?: string | undefined;
      readonly issueTypeName?: string | undefined;
      readonly summary: string;
      readonly descriptionText?: string | undefined;
    }
  | {
      readonly type: "update-issue-fields";
      readonly issueKey: string;
      readonly summary?: string | undefined;
      readonly descriptionText?: string | undefined;
      readonly labels?: readonly string[] | undefined;
      readonly priorityName?: string | undefined;
    }
  | {
      readonly type: "transition-issue";
      readonly issueKey: string;
      readonly transitionId: string;
    }
  | {
      readonly type: "add-issue-comment";
      readonly issueKey: string;
      readonly commentText: string;
    }
  | {
      readonly type: "create-page";
      readonly spaceId: string;
      readonly parentId?: string | undefined;
      readonly title: string;
      readonly bodyText: string;
    }
  | {
      readonly type: "update-page";
      readonly pageId: string;
      readonly title: string;
      readonly bodyText: string;
      readonly currentVersion: number;
    }
  | {
      readonly type: "add-page-comment";
      readonly pageId: string;
      readonly commentText: string;
    };

// The validated sync-start request a pending sync approval executes on approve (agent-initiated
// `sync-space`/`sync-project` under an Ask-for-approval envelope, closing the #2242 open item).
// The provider is re-resolved from the credential metadata at approve time, never stored here.
export interface AtlassianSyncStartPayload {
  readonly spaceKeys?: readonly string[] | undefined;
  readonly projectKeys?: readonly string[] | undefined;
  readonly jql?: string | undefined;
  readonly displayName?: string | undefined;
  readonly capsuleId?: KnowledgeCapsuleId | undefined;
}

// The validated live-search request a pending `search-issues-live` approval executes on approve
// (Issue #2248). The free-form JQL text parks server-side ONLY — exactly like write bodies — and
// the digest computed once at admission travels with it so approve/reject/denied records carry
// the same correlation digest without recomputation (ADR-0128 D6: hashed, never verbatim).
export interface AtlassianLiveSearchPayload {
  readonly request: JiraLiveSearchRequest;
  readonly jqlDigest: string;
}

export type PendingAtlassianActionPayload =
  | { readonly kind: "write-action"; readonly action: AtlassianWriteActionInput }
  | { readonly kind: "sync-start"; readonly syncStart: AtlassianSyncStartPayload }
  | { readonly kind: "live-search"; readonly liveSearch: AtlassianLiveSearchPayload };

export interface PendingAtlassianActionEntry {
  readonly approval: AtlassianConnectorPendingApproval;
  readonly authority: AtlassianActionAuthorityContext;
  readonly authRef: string;
  readonly payload: PendingAtlassianActionPayload;
}

export type PendingApprovalCreation =
  { readonly ok: true } | { readonly ok: false; readonly reason: "capacity-exhausted" };

export class AtlassianActionApprovalRegistry {
  private readonly entries = new Map<string, PendingAtlassianActionEntry>();
  private readonly now: () => number;

  public constructor(now: () => number = Date.now) {
    this.now = now;
  }

  public create(entry: PendingAtlassianActionEntry): PendingApprovalCreation {
    this.evictExpired();
    if (this.entries.size >= ATLASSIAN_ACTION_APPROVAL_MAX_PENDING) {
      return { ok: false, reason: "capacity-exhausted" };
    }
    this.entries.set(entry.approval.approvalId, entry);
    return { ok: true };
  }

  public get(approvalId: string): PendingAtlassianActionEntry | undefined {
    this.evictExpired();
    return this.entries.get(approvalId);
  }

  public listPending(): readonly AtlassianConnectorPendingApproval[] {
    this.evictExpired();
    return Array.from(this.entries.values(), (entry) => entry.approval);
  }

  // Single-use resolution: approve consumes the entry so a second approve (or a replayed
  // request) finds nothing and fails closed.
  public consume(approvalId: string): PendingAtlassianActionEntry | undefined {
    const entry = this.get(approvalId);
    if (entry !== undefined) this.entries.delete(approvalId);
    return entry;
  }

  public reject(approvalId: string): PendingAtlassianActionEntry | undefined {
    return this.consume(approvalId);
  }

  public reset(): void {
    this.entries.clear();
  }

  private evictExpired(): void {
    const cutoff = this.now();
    for (const [approvalId, entry] of this.entries) {
      if (entry.approval.expiresAt <= cutoff) {
        this.entries.delete(approvalId);
      }
    }
  }
}

export const atlassianActionApprovalRegistry = new AtlassianActionApprovalRegistry();
