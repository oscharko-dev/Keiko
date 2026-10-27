import type {
  ChatToolAuthoritySubject,
  ChatToolReadGrant,
  EditorAgentGovernedAuthorityReference,
} from "@oscharko-dev/keiko-contracts";
import {
  invalidReadGrant,
  recordReadGrant,
  sameReadGrantAuthority,
  sameReadGrantSubject,
  snapshotReadGrant,
  validReadGrantRequest,
  type ChatReadGrantEntry,
  type ChatReadGrantResult,
  type RetainedChatReadGrant,
} from "./chatReadGrantState.js";
export type { ChatReadGrantEntry } from "./chatReadGrantState.js";
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
import {
  ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS,
  isAtlassianContentPreviewUnpresentable,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/runtime/text-safety";
import type { UiHandlerDeps } from "../deps.js";
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

// KEIKO-0186: whether a write action's derived content preview is available (and the bounded,
// sanitized text itself), unavailable (the action had text, but nothing presentable survived
// sanitization/bounding), or simply not applicable (the action has no text field at all).
// `"unavailable"` is its own outcome rather than folded into `"none"` — see contentPreviewFor —
// because the two mean different things to a reviewer: "none" is silent (an ordinary action with
// nothing to preview, e.g. transition-issue), "unavailable" must say plainly that content existed
// but could not be safely shown, or a reviewer approving in good faith over what looks like a
// contentless action would actually be approving invisible content going out unseen.
export type AtlassianContentPreviewOutcome =
  | { readonly status: "none" }
  | { readonly status: "available"; readonly text: string }
  | { readonly status: "unavailable" };

// KEIKO-0186: the bounded, sanitized text a human reviewer sees before approving a governed
// write — never the raw, unbounded action input. Pure: no I/O, no clock, no randomness. Combines
// only the write action's own text field(s) (never other action metadata like keys or ids),
// strips Unicode bidi/zero-width/control-character display spoofing the same way every other
// untrusted display surface in keiko-contracts does (stripUnsafeFormatChars), then truncates to
// ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS — the exact bound isSafeAtlassianContentPreview
// enforces on the wire, so the producer and the contract's own validation agree on one bound
// rather than carrying two that could drift. `transition-issue` carries no text field and always
// returns "none"; `update-issue-fields` also returns "none" when neither `summary` nor
// `descriptionText` is present (only labels/priority changing — nothing to preview).
//
// KEIKO-0186 P1 (Codex): a non-empty `raw` does not guarantee a presentable result. An
// all-bidi/all-zero-width payload sanitizes to the empty string; a payload that is (or, after
// bounding, becomes) nothing but floating Unicode combining marks carries no base character to
// attach to and is exactly as uninformative as empty. The bounded candidate is checked with
// isAtlassianContentPreviewUnpresentable AFTER both sanitization and truncation — the same
// predicate isSafeAtlassianContentPreview checks on the wire side — so this function and the
// contract's own validation can never disagree about what counts as presentable.
export function contentPreviewFor(
  action: AtlassianWriteActionInput,
): AtlassianContentPreviewOutcome {
  const raw = rawContentFor(action);
  if (raw === undefined || raw.length === 0) return { status: "none" };
  const sanitized = stripUnsafeFormatChars(raw);
  const bounded =
    sanitized.length <= ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS
      ? sanitized
      : sanitized.slice(0, ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS);
  return isAtlassianContentPreviewUnpresentable(bounded)
    ? { status: "unavailable" }
    : { status: "available", text: bounded };
}

function rawContentFor(action: AtlassianWriteActionInput): string | undefined {
  switch (action.type) {
    case "create-issue":
    case "update-issue-fields":
      return joinTextFields(action.summary, action.descriptionText);
    case "transition-issue":
      return undefined;
    case "add-issue-comment":
    case "add-page-comment":
      return action.commentText;
    case "create-page":
    case "update-page":
      return joinTextFields(action.title, action.bodyText);
  }
}

// Title/summary first, then description/body on its own paragraph — either half may be absent
// (create-issue's descriptionText is optional; update-issue-fields' summary is too).
function joinTextFields(first: string | undefined, second: string | undefined): string | undefined {
  if (first === undefined || first.length === 0) return second;
  if (second === undefined || second.length === 0) return first;
  return `${first}\n\n${second}`;
}

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

type RetainedApproval =
  | { readonly kind: "connector"; readonly entry: PendingAtlassianActionEntry }
  | RetainedChatReadGrant;

export class AtlassianActionApprovalRegistry {
  private readonly entries = new Map<string, RetainedApproval>();
  private readonly now: () => number;

  public constructor(now: () => number = Date.now) {
    this.now = now;
  }

  public create(entry: PendingAtlassianActionEntry): PendingApprovalCreation {
    this.evictExpired();
    if (
      this.entries.size >= ATLASSIAN_ACTION_APPROVAL_MAX_PENDING ||
      this.entries.get(entry.approval.approvalId)?.kind === "chat-read"
    )
      return { ok: false, reason: "capacity-exhausted" };
    this.entries.set(entry.approval.approvalId, { kind: "connector", entry });
    return { ok: true };
  }

  public get(approvalId: string): PendingAtlassianActionEntry | undefined {
    this.evictExpired();
    const record = this.entries.get(approvalId);
    return record?.kind === "connector" ? record.entry : undefined;
  }

  public listPending(): readonly AtlassianConnectorPendingApproval[] {
    this.evictExpired();
    return Array.from(this.entries.values()).flatMap((record) =>
      record.kind === "connector" ? [record.entry.approval] : [],
    );
  }

  public consume(approvalId: string): PendingAtlassianActionEntry | undefined {
    const entry = this.get(approvalId);
    if (entry !== undefined) this.entries.delete(approvalId);
    return entry;
  }

  public reject(approvalId: string): PendingAtlassianActionEntry | undefined {
    return this.consume(approvalId);
  }

  public createChatReadGrant(
    entry: ChatReadGrantEntry,
    correlationId?: string,
  ): PendingApprovalCreation | { readonly ok: false; readonly reason: "invalid" } {
    this.evictExpired(correlationId);
    if (
      !validReadGrantRequest(entry, this.now(), ATLASSIAN_ACTION_APPROVAL_TTL_MS) ||
      this.entries.has(entry.grant.grantId)
    )
      return invalidReadGrant(correlationId);
    if (this.entries.size >= ATLASSIAN_ACTION_APPROVAL_MAX_PENDING) {
      invalidReadGrant(correlationId);
      return { ok: false, reason: "capacity-exhausted" };
    }
    const record = snapshotReadGrant(entry, correlationId);
    this.entries.set(entry.grant.grantId, record);
    recordReadGrant(record);
    return { ok: true };
  }

  public getChatReadGrant(grantId: string, correlationId?: string): ChatReadGrantEntry | undefined {
    this.evictExpired(correlationId);
    const record = this.entries.get(grantId);
    return record?.kind === "chat-read" ? record.entry : undefined;
  }

  public findGrantedChatReadGrant(
    subject: ChatToolAuthoritySubject,
    correlationId?: string,
  ): ChatToolReadGrant | undefined {
    this.evictExpired(correlationId);
    for (const record of this.entries.values())
      if (
        record.kind === "chat-read" &&
        record.entry.grant.state === "granted" &&
        sameReadGrantSubject(record.entry.grant, subject)
      ) {
        recordReadGrant(snapshotReadGrant(record.entry, correlationId), 0);
        return record.entry.grant;
      }
    return undefined;
  }

  public findChatReadGrantForRequest(
    subject: ChatToolAuthoritySubject,
    authority: EditorAgentGovernedAuthorityReference,
    correlationId?: string,
  ): ChatReadGrantEntry | undefined {
    const granted = this.findGrantedChatReadGrant(subject, correlationId);
    const active =
      granted === undefined ? undefined : this.getChatReadGrant(granted.grantId, correlationId);
    if (active !== undefined) return active;
    const matching = Array.from(this.entries.values()).filter(
      (record): record is RetainedChatReadGrant =>
        record.kind === "chat-read" && sameReadGrantSubject(record.entry.grant, subject),
    );
    const found =
      matching.find((record) => record.entry.grant.state === "pending") ??
      matching.find((record) => sameReadGrantAuthority(record.entry, authority));
    if (found !== undefined) recordReadGrant(snapshotReadGrant(found.entry, correlationId), 0);
    return found?.entry;
  }

  public revokeChatReadGrant(grantId: string, correlationId?: string): boolean {
    this.evictExpired(correlationId);
    const record = this.entries.get(grantId);
    return record?.kind === "chat-read" && this.revokeReadGrant(record, correlationId);
  }

  public acceptChatReadGrant(
    grantId: string,
    subject: ChatToolAuthoritySubject,
    authority: EditorAgentGovernedAuthorityReference,
    consentProofDigest: string,
    correlationId?: string,
  ): ChatReadGrantResult {
    const entry = this.currentReadGrant(grantId, subject, authority, correlationId);
    if (entry === undefined || !/^[a-f0-9]{64}$/.test(consentProofDigest))
      return invalidReadGrant(correlationId);
    if (entry.grant.state === "granted") {
      recordReadGrant(snapshotReadGrant(entry, correlationId), 0);
      return { ok: true, grant: entry.grant };
    }
    if (entry.grant.state !== "pending") return invalidReadGrant(correlationId);
    const grant = { ...entry.grant, state: "granted", consentProofDigest } as const;
    return { ok: true, grant: this.retainReadGrant({ ...entry, grant }, correlationId) };
  }

  public rejectChatReadGrant(
    grantId: string,
    subject: ChatToolAuthoritySubject,
    authority: EditorAgentGovernedAuthorityReference,
    correlationId?: string,
  ): ChatReadGrantResult {
    const entry = this.currentReadGrant(grantId, subject, authority, correlationId);
    if (entry?.grant.state !== "pending") return invalidReadGrant(correlationId);
    const grant = { ...entry.grant, state: "rejected", consentProofDigest: null } as const;
    return { ok: true, grant: this.retainReadGrant({ ...entry, grant }, correlationId) };
  }

  public revokeChatReadGrants(chatId: string, correlationId?: string): number {
    this.evictExpired(correlationId);
    let count = 0;
    for (const record of this.entries.values()) {
      if (record.kind !== "chat-read" || record.entry.grant.subject.chatId !== chatId) continue;
      if (this.revokeReadGrant(record, correlationId)) count++;
    }
    return count;
  }

  private currentReadGrant(
    grantId: string,
    subject: ChatToolAuthoritySubject,
    authority: EditorAgentGovernedAuthorityReference,
    correlationId?: string,
  ): ChatReadGrantEntry | undefined {
    const entry = this.getChatReadGrant(grantId, correlationId);
    return entry !== undefined &&
      sameReadGrantSubject(entry.grant, subject) &&
      sameReadGrantAuthority(entry, authority)
      ? entry
      : undefined;
  }

  private retainReadGrant(entry: ChatReadGrantEntry, correlationId?: string): ChatToolReadGrant {
    const record = snapshotReadGrant(entry, correlationId);
    this.entries.set(entry.grant.grantId, record);
    recordReadGrant(record);
    return record.entry.grant;
  }

  private revokeReadGrant(record: RetainedChatReadGrant, correlationId?: string): boolean {
    const grant = record.entry.grant;
    if (grant.state !== "pending" && grant.state !== "granted") return false;
    this.retainReadGrant(
      { ...record.entry, grant: { ...grant, state: "revoked" } },
      correlationId ?? record.correlationId,
    );
    return true;
  }

  public reset(correlationId?: string): void {
    this.evictExpired(correlationId);
    for (const record of this.entries.values())
      if (record.kind === "chat-read") this.revokeReadGrant(record, correlationId);
    this.entries.clear();
  }

  private evictExpired(correlationId?: string): void {
    const cutoff = this.now();
    for (const [id, record] of this.entries) {
      const expiresAt =
        record.kind === "connector"
          ? record.entry.approval.expiresAt
          : record.entry.grant.expiresAt;
      if (expiresAt > cutoff) continue;
      if (record.kind === "chat-read") {
        const grant = { ...record.entry.grant, state: "expired" } as const;
        recordReadGrant(
          snapshotReadGrant({ ...record.entry, grant }, correlationId ?? record.correlationId),
          record.entry.grant.state === "pending" || record.entry.grant.state === "granted" ? 1 : 0,
        );
      }
      this.entries.delete(id);
    }
  }
}

export const atlassianActionApprovalRegistry = new AtlassianActionApprovalRegistry();

// KEIKO-0565 remediation (PR #3289 review): every consumer must resolve the registry through this
// function, never through the bare `atlassianActionApprovalRegistry` import above — reading the
// module-level singleton directly is exactly the bug that let two independently composed
// `UiHandlerDeps` graphs share one approval registry even though `buildUiHandlerDeps` already
// constructs a fresh instance per graph. Falls back to the process-wide singleton only for a
// `UiHandlerDeps`-shaped value that was not built through that real composition root (e.g. a
// hand-rolled test double that omits the field) — a deliberate, narrow compat shim, not the
// primary path.
export function resolveAtlassianActionApprovalRegistry(
  deps: Pick<UiHandlerDeps, "atlassianActionApprovalRegistry">,
): AtlassianActionApprovalRegistry {
  return deps.atlassianActionApprovalRegistry ?? atlassianActionApprovalRegistry;
}
