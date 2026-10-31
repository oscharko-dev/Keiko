import { randomUUID } from "node:crypto";
import type {
  ChatToolAuthoritySubject,
  ChatToolReadGrant,
  ChatToolWriteApprovalView,
  EditorAgentGovernedAuthorityReference,
  AtlassianConnectorPendingApproval,
  JiraLiveSearchRequest,
  KnowledgeCapsuleId,
} from "@oscharko-dev/keiko-contracts";
import {
  invalidReadGrant,
  recordReadGrant,
  sameReadGrantAuthority,
  sameReadGrantSubject,
  snapshotReadGrant,
  validReadGrantRequest,
  type ChatReadGrantEntry,
  type ChatReadGrantStore,
  type ChatReadGrantResult,
  type RetainedChatReadGrant,
} from "./chatReadGrantState.js";
export type { ChatReadGrantEntry } from "./chatReadGrantState.js";
import {
  invalidWriteApproval,
  recordWriteApproval,
  sameWriteAction,
  snapshotWriteApproval,
  validWriteApprovalRequest,
  type ChatWriteApprovalEntry,
  type ChatWriteApprovalClaim,
  type ChatWriteApprovalResult,
  type ChatToolWriteActionIdentity,
  type RetainedChatWriteApproval,
} from "./chatWriteApprovalState.js";
export type {
  ChatWriteApprovalEntry,
  ChatWriteApprovalClaim,
  ChatToolWriteActionIdentity,
} from "./chatWriteApprovalState.js";

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

// Chat read-consent entries use the existing private UiStore for bounded, validated retention.
// Decisions persist before publication; exact-entry comparison prevents stale state replacement.
// Shutdown cancels pending decisions while retaining accepted consent through its original TTL.
// Every later invocation still requires fresh authority, custody, generations and budget admission.

import {
  ATLASSIAN_APPROVAL_CONTENT_PREVIEW_MAX_CHARS,
  isAtlassianContentPreviewUnpresentable,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/runtime/text-safety";
import type { UiHandlerDeps } from "../deps.js";
import type { AtlassianActionAuthorityContext } from "./actionPolicy.js";
import {
  ATLASSIAN_ACTION_APPROVAL_TTL_MS,
  ATLASSIAN_ACTION_APPROVAL_MAX_PENDING,
} from "./actionApprovalLimits.js";
export { ATLASSIAN_ACTION_APPROVAL_TTL_MS, ATLASSIAN_ACTION_APPROVAL_MAX_PENDING };

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
  | RetainedChatReadGrant
  | RetainedChatWriteApproval;

export class AtlassianActionApprovalRegistry {
  private readonly entries = new Map<string, RetainedApproval>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly now: () => number;

  public constructor(
    now: () => number = Date.now,
    private readonly readGrants?: ChatReadGrantStore,
  ) {
    this.now = now;
  }

  public create(entry: PendingAtlassianActionEntry): PendingApprovalCreation {
    this.evictExpired();
    if (
      this.entries.size >= ATLASSIAN_ACTION_APPROVAL_MAX_PENDING ||
      (this.entries.has(entry.approval.approvalId) &&
        this.entries.get(entry.approval.approvalId)?.kind !== "connector")
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

  public createChatWriteApproval(
    entry: ChatWriteApprovalEntry,
    correlationId?: string,
  ): PendingApprovalCreation | { readonly ok: false; readonly reason: "invalid" } {
    this.evictExpired(correlationId);
    if (
      !validWriteApprovalRequest(entry, this.now(), ATLASSIAN_ACTION_APPROVAL_TTL_MS) ||
      this.entries.has(entry.approval.approvalId)
    )
      return invalidWriteApproval(correlationId);
    if (this.entries.size >= ATLASSIAN_ACTION_APPROVAL_MAX_PENDING) {
      invalidWriteApproval(correlationId);
      return { ok: false, reason: "capacity-exhausted" };
    }
    this.retainWriteApproval(entry, correlationId);
    return { ok: true };
  }

  public getChatWriteApproval(
    approvalId: string,
    correlationId?: string,
  ): ChatWriteApprovalEntry | undefined {
    this.evictExpired(correlationId);
    const record = this.entries.get(approvalId);
    return record?.kind === "chat-write" ? record.entry : undefined;
  }

  public findChatWriteApproval(
    subject: ChatToolAuthoritySubject,
    authority: EditorAgentGovernedAuthorityReference,
    invocationId: string,
    correlationId?: string,
  ): ChatWriteApprovalEntry | undefined {
    this.evictExpired(correlationId);
    for (const record of this.entries.values())
      if (
        record.kind === "chat-write" &&
        record.entry.approval.invocationId === invocationId &&
        sameReadGrantSubject(record.entry, subject) &&
        sameReadGrantAuthority(record.entry, authority)
      )
        return record.entry;
    return undefined;
  }

  public acceptChatWriteApproval(
    approvalId: string,
    subject: ChatToolAuthoritySubject,
    authority: EditorAgentGovernedAuthorityReference,
    action: ChatToolWriteActionIdentity,
    proofDigest: string,
    correlationId?: string,
    excludedItemRefs: readonly string[] = [],
  ): ChatWriteApprovalResult {
    const entry = this.currentWriteApproval(approvalId, subject, authority, action, correlationId);
    if (entry === undefined || !/^[a-f0-9]{64}$/u.test(proofDigest))
      return invalidWriteApproval(correlationId);
    if (entry.approval.state === "approved") return { ok: true, approval: entry.approval };
    const draft =
      entry.approval.kind === "jira-chat-write" && entry.approval.operation === "jira.draft";
    // Only a backlog draft has items a human can leave out (#4178).
    if (entry.approval.state !== "pending" || (!draft && excludedItemRefs.length > 0))
      return invalidWriteApproval(correlationId);
    return {
      ok: true,
      approval: this.retainWriteApproval(
        {
          ...entry,
          approval: {
            ...entry.approval,
            state: "approved",
            ...(excludedItemRefs.length === 0
              ? {}
              : { excludedItemRefs: Object.freeze([...excludedItemRefs]) }),
          },
          approvalProofDigest: proofDigest,
        },
        correlationId,
      ),
    };
  }

  public rejectChatWriteApproval(
    approvalId: string,
    subject: ChatToolAuthoritySubject,
    authority: EditorAgentGovernedAuthorityReference,
    action: ChatToolWriteActionIdentity,
    correlationId?: string,
  ): ChatWriteApprovalResult {
    const entry = this.currentWriteApproval(approvalId, subject, authority, action, correlationId);
    if (entry?.approval.state !== "pending") return invalidWriteApproval(correlationId);
    return {
      ok: true,
      approval: this.retainWriteApproval(
        { ...entry, approval: { ...entry.approval, state: "rejected" } },
        correlationId,
      ),
    };
  }

  /** Called only within the durable journal's begin-dispatch transaction. */
  public claimChatWriteApproval(
    approvalId: string,
    subject: ChatToolAuthoritySubject,
    authority: EditorAgentGovernedAuthorityReference,
    action: ChatToolWriteActionIdentity,
    correlationId?: string,
  ):
    | { readonly ok: true; readonly claim: ChatWriteApprovalClaim }
    | { readonly ok: false; readonly reason: "invalid" } {
    const entry = this.currentWriteApproval(approvalId, subject, authority, action, correlationId);
    if (entry?.approval.state !== "approved") return invalidWriteApproval(correlationId);
    const claimId = randomUUID();
    this.retainWriteApproval(
      { ...entry, approval: { ...entry.approval, state: "claimed" } },
      correlationId,
      claimId,
    );
    return { ok: true, claim: Object.freeze({ approvalId, claimId }) };
  }

  public isChatWriteClaimCurrent(
    claim: ChatWriteApprovalClaim,
    subject: ChatToolAuthoritySubject,
    authority: EditorAgentGovernedAuthorityReference,
    action: ChatToolWriteActionIdentity,
    correlationId?: string,
  ): boolean {
    const entry = this.currentWriteApproval(
      claim.approvalId,
      subject,
      authority,
      action,
      correlationId,
    );
    const record = this.entries.get(claim.approvalId);
    if (
      entry?.approval.state !== "claimed" ||
      record?.kind !== "chat-write" ||
      record.claimId !== claim.claimId
    ) {
      invalidWriteApproval(correlationId);
      return false;
    }
    recordWriteApproval(record, 0);
    return true;
  }

  public revokeChatWriteApproval(approvalId: string, correlationId?: string): boolean {
    this.evictExpired(correlationId);
    const record = this.entries.get(approvalId);
    return record?.kind === "chat-write" && this.revokeWriteApproval(record, correlationId);
  }

  public revokeChatApprovals(chatId: string, correlationId?: string): number {
    let count = this.revokeChatReadGrants(chatId, correlationId);
    for (const record of this.entries.values())
      if (
        record.kind === "chat-write" &&
        record.entry.subject.chatId === chatId &&
        this.revokeWriteApproval(record, correlationId)
      )
        count++;
    return count;
  }

  private currentWriteApproval(
    approvalId: string,
    subject: ChatToolAuthoritySubject,
    authority: EditorAgentGovernedAuthorityReference,
    action: ChatToolWriteActionIdentity,
    correlationId?: string,
  ): ChatWriteApprovalEntry | undefined {
    const entry = this.getChatWriteApproval(approvalId, correlationId);
    return entry !== undefined &&
      sameReadGrantSubject(entry, subject) &&
      sameReadGrantAuthority(entry, authority) &&
      sameWriteAction(entry.approval, action)
      ? entry
      : undefined;
  }

  private retainWriteApproval(
    entry: ChatWriteApprovalEntry,
    correlationId?: string,
    claimId?: string,
  ): ChatToolWriteApprovalView {
    const record = snapshotWriteApproval(entry, correlationId, claimId);
    this.entries.set(entry.approval.approvalId, record);
    recordWriteApproval(record);
    if (entry.approval.state !== "pending") this.wakeWaiters(entry.approval.approvalId);
    return record.entry.approval;
  }

  private revokeWriteApproval(record: RetainedChatWriteApproval, correlationId?: string): boolean {
    if (!new Set(["pending", "approved", "claimed"]).has(record.entry.approval.state)) return false;
    this.retainWriteApproval(
      { ...record.entry, approval: { ...record.entry.approval, state: "revoked" } },
      correlationId ?? record.correlationId,
    );
    return true;
  }

  public waitForChatWriteApproval(approvalId: string, signal: AbortSignal): Promise<void> {
    const entry = this.getChatWriteApproval(approvalId);
    return entry?.approval.state === "pending"
      ? this.waitForDecision(approvalId, entry.approval.expiresAt, signal)
      : Promise.resolve();
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
    if (this.readGrants?.save(record.entry) === false) return invalidReadGrant(correlationId);
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
    const retained = this.retainReadGrant({ ...entry, grant }, correlationId);
    return retained === undefined ? invalidReadGrant(correlationId) : { ok: true, grant: retained };
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
    const retained = this.retainReadGrant({ ...entry, grant }, correlationId);
    return retained === undefined ? invalidReadGrant(correlationId) : { ok: true, grant: retained };
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

  /** Wake on a state change; completion itself is never proof of consent. */
  public waitForChatReadGrant(grantId: string, signal: AbortSignal): Promise<void> {
    const entry = this.getChatReadGrant(grantId);
    return entry?.grant.state === "pending"
      ? this.waitForDecision(grantId, entry.grant.expiresAt, signal)
      : Promise.resolve();
  }

  private waitForDecision(grantId: string, expiresAt: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    const waiters = this.waiters.get(grantId) ?? new Set<() => void>();
    if (waiters.size >= ATLASSIAN_ACTION_APPROVAL_MAX_PENDING) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        waiters.delete(finish);
        if (waiters.size === 0) this.waiters.delete(grantId);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, expiresAt - this.now()));
      waiters.add(finish);
      this.waiters.set(grantId, waiters);
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  private wakeWaiters(grantId: string): void {
    for (const finish of this.waiters.get(grantId) ?? []) finish();
  }

  private retainReadGrant(
    entry: ChatReadGrantEntry,
    correlationId?: string,
  ): ChatToolReadGrant | undefined {
    const record = snapshotReadGrant(entry, correlationId);
    const previous = this.entries.get(entry.grant.grantId);
    if (
      previous?.kind !== "chat-read" ||
      this.readGrants?.save(record.entry, previous.entry) === false
    )
      return undefined;
    this.entries.set(entry.grant.grantId, record);
    recordReadGrant(record);
    if (record.entry.grant.state !== "pending") this.wakeWaiters(entry.grant.grantId);
    return record.entry.grant;
  }

  private revokeReadGrant(record: RetainedChatReadGrant, correlationId?: string): boolean {
    const grant = record.entry.grant;
    if (grant.state !== "pending" && grant.state !== "granted") return false;
    return (
      this.retainReadGrant(
        { ...record.entry, grant: { ...grant, state: "revoked" } },
        correlationId ?? record.correlationId,
      ) !== undefined
    );
  }

  public reset(correlationId?: string): void {
    this.clearEntries(false, correlationId);
  }

  /** Shutdown cancels pending work; already accepted disclosure consent survives its original TTL. */
  public dispose(correlationId?: string): void {
    this.clearEntries(true, correlationId);
  }

  private clearEntries(preserveGrantedConsent: boolean, correlationId?: string): void {
    // Shutdown handles work actually retained by this graph; it does not reopen an unused store.
    if (!preserveGrantedConsent) this.evictExpired(correlationId);
    for (const record of this.entries.values()) {
      if (
        record.kind === "chat-read" &&
        (!preserveGrantedConsent || record.entry.grant.state !== "granted")
      )
        this.revokeReadGrant(record, correlationId);
      if (record.kind === "chat-write") this.revokeWriteApproval(record, correlationId);
    }
    // A persisted state may have advanced in another graph, so a failed revocation CAS
    // must not retain this graph's pending waiters after shutdown.
    for (const id of this.waiters.keys()) this.wakeWaiters(id);
    this.entries.clear();
  }

  private evictExpired(correlationId?: string): void {
    this.refreshReadGrants(correlationId);
    const cutoff = this.now();
    for (const [id, record] of this.entries) {
      const expiresAt =
        record.kind === "chat-read"
          ? record.entry.grant.expiresAt
          : record.entry.approval.expiresAt;
      if (expiresAt > cutoff) continue;
      if (record.kind === "chat-read") this.expireReadGrant(record, correlationId);
      if (record.kind === "chat-write")
        recordWriteApproval(
          snapshotWriteApproval(
            { ...record.entry, approval: { ...record.entry.approval, state: "expired" } },
            correlationId ?? record.correlationId,
          ),
        );
      this.entries.delete(id);
      this.wakeWaiters(id);
    }
  }

  private expireReadGrant(record: RetainedChatReadGrant, correlationId?: string): void {
    const grant = { ...record.entry.grant, state: "expired" } as const;
    this.readGrants?.remove(grant.grantId);
    recordReadGrant(
      snapshotReadGrant({ ...record.entry, grant }, correlationId ?? record.correlationId),
      record.entry.grant.state === "pending" || record.entry.grant.state === "granted" ? 1 : 0,
    );
  }

  private restoreReadGrant(entry: ChatReadGrantEntry, correlationId?: string): void {
    const id = entry.grant.grantId;
    const existing = this.entries.get(id);
    if (existing !== undefined && existing.kind !== "chat-read")
      throw new TypeError("Conflicting retained Chat consent identity");
    this.entries.set(id, snapshotReadGrant(entry, correlationId ?? existing?.correlationId));
    if (entry.grant.state !== "pending") this.wakeWaiters(id);
  }

  private refreshReadGrants(correlationId?: string): void {
    if (this.readGrants === undefined) return;
    const retained = new Map(this.readGrants.list().map((entry) => [entry.grant.grantId, entry]));
    for (const [id, record] of this.entries) {
      if (record.kind === "chat-read" && !retained.has(id)) {
        this.entries.delete(id);
        this.wakeWaiters(id);
      }
    }
    for (const entry of retained.values()) this.restoreReadGrant(entry, correlationId);
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
