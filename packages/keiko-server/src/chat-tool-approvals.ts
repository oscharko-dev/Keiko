import { jiraOperationBindingForTool } from "./atlassian/jiraManagedProvider.js";
import type {
  CatalogConsumer,
  CatalogBoundAuthorityPort,
} from "./tool-catalog/catalogToolPorts.js";
import type {
  CodingWorkbenchRuntimeDelegationUsage,
  EditorAgentGovernedAuthorityReference,
  ChatToolAuthorityEnvelope,
  ChatToolReadGrantView,
  ChatToolWriteApprovalView,
} from "@oscharko-dev/keiko-contracts";
import { randomUUID } from "node:crypto";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { validateChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import { ATLASSIAN_ACTION_APPROVAL_TTL_MS } from "./atlassian/actionApprovals.js";
import {
  type ChatReadGrantEntry,
  projectChatReadGrant,
  sameReadGrantSubject,
} from "./atlassian/chatReadGrantState.js";
import {
  sameWriteAction,
  type ChatToolWriteActionIdentity,
  type ChatWriteApprovalEntry,
} from "./atlassian/chatWriteApprovalState.js";
import { recordChatAuthorityResult } from "./editor/chatAuthorityActivity.js";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { UiHandlerDeps } from "./deps.js";
import type { ChatMessage } from "./store/index.js";
import { requireDispatch } from "./tool-catalog/catalogToolErrors.js";
import { validateChatApprovalContinuation } from "./chat-approval-continuation-state.js";

export interface ChatToolApprovalContext {
  readonly deps: Pick<UiHandlerDeps, "store" | "atlassianActionApprovalRegistry">;
  readonly message: ChatMessage;
  readonly correlationId: string;
  readonly signal: AbortSignal;
  readonly publish: () => Promise<void>;
  readonly writeExchange: (invocationId: string) => ChatToolExchange | undefined;
}
/**
 * Accepts the read grant a Chat tool source requested (owner decision 2026-11-02). The person
 * connected the Jira Pod or configured the MCP server for this Chat; that connection is the consent,
 * so a read never waits for a separate approval. The grant keeps its lifecycle: a Pod switch, a
 * token or configuration change, or expiry revokes it and the next read requests a new one.
 */
export async function acceptChatToolReadGrant(
  input: Pick<ChatToolApprovalContext, "deps" | "message" | "correlationId" | "publish">,
  grant: ChatToolReadGrantView,
): Promise<void> {
  const { deps, message, correlationId } = input;
  const registry = deps.atlassianActionApprovalRegistry;
  requireDispatch(registry !== undefined, "denied", "approval-required");
  const entry = registry.getChatReadGrant(grant.grantId, correlationId);
  requireDispatch(entry !== undefined, "denied", "approval-required");
  const proof = sha256Hex(
    canonicalise({
      kind:
        entry.grant.kind === "mcp-chat-read-grant"
          ? "mcp-chat-read-binding"
          : "jira-chat-read-binding",
      grantId: entry.grant.grantId,
      subject: entry.grant.subject,
      authority: entry.authority,
      disclosureVersion: entry.grant.disclosureVersion,
      acceptedAt: new Date().toISOString(),
    }),
  );
  const accepted = registry.acceptChatReadGrant(
    entry.grant.grantId,
    entry.grant.subject,
    entry.authority,
    proof,
    correlationId,
  );
  requireDispatch(accepted.ok, "denied", "approval-required");
  // The granted grant is the turn's evidence of what it was allowed to read. No card shows it: the
  // Chat renders nothing for a granted read.
  deps.store.updateChatToolTranscript(
    message.id,
    { kind: "read-consent", grant: projectChatReadGrant(accepted.grant) },
    correlationId,
  );
  await input.publish();
}
function approvalOperationBinding(approval: ChatToolWriteApprovalView): {
  readonly operationBinding?: NonNullable<ReturnType<typeof jiraOperationBindingForTool>>;
} {
  const binding = jiraOperationBindingForTool(approval.operation);
  return binding === undefined ? {} : { operationBinding: binding };
}

export async function waitForChatToolWriteConsent(
  input: ChatToolApprovalContext,
  approval: ChatToolWriteApprovalView,
): Promise<void> {
  const { deps, message, correlationId, signal } = input;
  const registry = deps.atlassianActionApprovalRegistry;
  const exchange = input.writeExchange(approval.invocationId);
  requireDispatch(registry !== undefined && exchange !== undefined, "denied", "approval-required");
  const save = (view: ChatToolWriteApprovalView): void => {
    deps.store.updateChatToolTranscript(
      message.id,
      {
        kind: "write-approval",
        callId: exchange.call.id,
        approval: view,
        ...approvalOperationBinding(view),
      },
      correlationId,
    );
  };
  save(approval);
  await input.publish();
  await registry.waitForChatWriteApproval(approval.approvalId, signal);
  validateChatApprovalContinuation(deps.store, message);
  if (signal.aborted) registry.revokeChatWriteApproval(approval.approvalId, correlationId);
  save(
    registry.getChatWriteApproval(approval.approvalId, correlationId)?.approval ?? {
      ...approval,
      state: "expired",
    },
  );
  await input.publish();
}
export function refreshChatToolWriteApproval(
  input: Pick<ChatToolApprovalContext, "deps" | "message" | "correlationId">,
  callId: string,
): void {
  const { deps, message, correlationId } = input;
  const previous = deps.store
    .findMessageById(message.id)
    ?.toolTranscript?.exchanges.find((exchange) => exchange.call.id === callId)?.approval;
  if (previous === undefined) return;
  const observed = deps.atlassianActionApprovalRegistry?.getChatWriteApproval(
    previous.approvalId,
    correlationId,
  )?.approval;
  if (
    observed?.actionDigest !== previous.actionDigest ||
    observed.invocationId !== previous.invocationId
  )
    return;
  deps.store.updateChatToolTranscript(
    message.id,
    { kind: "write-approval", callId, approval: observed, ...approvalOperationBinding(observed) },
    correlationId,
  );
}

export interface ChatWriteFacts<
  Envelope extends ChatToolAuthorityEnvelope = ChatToolAuthorityEnvelope,
> {
  readonly envelope: Envelope;
  readonly readExpiresAt: number;
}
export type ChatToolWriteApprovalAdmission =
  | { readonly kind: "allowed" }
  | {
      readonly kind: "review-required" | "approved" | "claimed";
      readonly approval: ChatToolWriteApprovalView;
    }
  | {
      readonly kind: "denied";
      readonly reason:
        "authority-denied" | "invalid" | "rejected" | "expired" | "capacity-exhausted";
    };
type ApprovalRegistry = UiHandlerDeps["atlassianActionApprovalRegistry"];

/** The source owner supplies its current authority and read-grant validator. */
function currentChatWriteFacts<Envelope extends ChatToolAuthorityEnvelope>(
  current: { readonly ok: true; readonly envelope: Envelope } | { readonly ok: false },
  registry: ApprovalRegistry,
  isCurrentReadGrant: (entry: ChatReadGrantEntry) => boolean,
  correlationId: string,
): ChatWriteFacts<Envelope> | undefined {
  if (!current.ok || registry === undefined) return undefined;
  const grant = registry.findGrantedChatReadGrant(current.envelope.subject, correlationId);
  const entry =
    grant === undefined ? undefined : registry.getChatReadGrant(grant.grantId, correlationId);
  return entry !== undefined && isCurrentReadGrant(entry)
    ? { envelope: current.envelope, readExpiresAt: entry.grant.expiresAt }
    : undefined;
}
export function chatWriteApprovalTiming(
  facts: ChatWriteFacts,
  now: number,
): {
  readonly approvalId: string;
  readonly state: "pending";
  readonly requestedAt: number;
  readonly expiresAt: number;
} {
  return {
    approvalId: randomUUID(),
    state: "pending",
    requestedAt: now,
    expiresAt: Math.min(
      Date.parse(facts.envelope.expiresAt),
      facts.readExpiresAt,
      now + ATLASSIAN_ACTION_APPROVAL_TTL_MS,
    ),
  };
}
/** A review gets the full approval lifetime, whatever is left of the automatic read grant. */
function withFullDecisionTime<Envelope extends ChatToolAuthorityEnvelope>(
  registry: NonNullable<ApprovalRegistry>,
  facts: ChatWriteFacts<Envelope>,
  now: number,
  correlationId: string,
): ChatWriteFacts<Envelope> {
  const expiresAt = Math.min(
    Date.parse(facts.envelope.expiresAt),
    now + ATLASSIAN_ACTION_APPROVAL_TTL_MS,
  );
  if (facts.readExpiresAt >= expiresAt) return facts;
  const renewed = registry.renewChatReadGrant(
    facts.envelope.subject,
    now,
    expiresAt,
    correlationId,
  );
  return renewed === undefined ? facts : { ...facts, readExpiresAt: renewed.expiresAt };
}
const READ_GRANT_RENEWAL_MIN_ELAPSED_MS = 30_000;

/**
 * A running admitted invocation outlives the consent TTL of the automatic read grant (owner decision
 * 2026-11-02: the connection is the consent). Its effect guard calls this after authority, binding,
 * subject and mode were all proven current: a granted grant restarts its time on every passing check once 30 s have elapsed since its last start (sliding window, so one long model call between two checks is covered),
 * forward only, within the envelope and re-bound to the invocation's authority. A pending, rejected, revoked or expired grant is never
 * touched, so a hard denial still ends the invocation.
 */
export function renewRunningReadGrant(
  registry: ApprovalRegistry,
  envelope: Pick<ChatToolAuthorityEnvelope, "subject" | "expiresAt">,
  authority: EditorAgentGovernedAuthorityReference,
  now: number,
  correlationId: string,
): void {
  if (registry === undefined) return;
  const granted = registry.findGrantedChatReadGrant(envelope.subject, correlationId);
  if (granted === undefined || now - granted.requestedAt < READ_GRANT_RENEWAL_MIN_ELAPSED_MS)
    return;
  // Current authority, binding and subject were proven by the caller: the grant is re-bound to this
  // invocation's authority and never outlives that authority's envelope.
  const envelopeEnd = Date.parse(envelope.expiresAt);
  if (!Number.isFinite(envelopeEnd)) return;
  const expiresAt = Math.min(envelopeEnd, now + ATLASSIAN_ACTION_APPROVAL_TTL_MS);
  registry.renewChatReadGrant(envelope.subject, now, expiresAt, correlationId, authority);
}
function chatWriteApprovalWithinBounds(
  entry: ChatWriteApprovalEntry,
  facts: ChatWriteFacts,
  now: number,
): boolean {
  return (
    entry.approval.requestedAt <= now &&
    entry.approval.expiresAt > now &&
    entry.approval.expiresAt <= Date.parse(facts.envelope.expiresAt) &&
    entry.approval.expiresAt <= facts.readExpiresAt
  );
}
function denyChatToolWriteApproval(
  reason: Extract<ChatToolWriteApprovalAdmission, { kind: "denied" }>["reason"],
  chatId: string,
  correlationId: string,
): ChatToolWriteApprovalAdmission {
  recordChatAuthorityResult(
    "write-approval",
    { ok: false, reason: "invalid" },
    { chatId },
    correlationId,
  );
  return { kind: "denied", reason };
}
/** Existing registry owns persistence/claiming; policy and current-state checks remain source-owned. */
function requestRetainedChatWriteApproval(
  registry: NonNullable<ApprovalRegistry>,
  entry: ChatWriteApprovalEntry,
  action: ChatToolWriteActionIdentity,
  resolvePolicy: () => "allowed" | "review-required" | "denied",
  isCurrent: (retained: ChatWriteApprovalEntry) => boolean,
  correlationId: string,
): ChatToolWriteApprovalAdmission {
  const chatId = entry.subject.chatId;
  if (!validateChatToolWriteApprovalView(entry.approval).ok)
    return denyChatToolWriteApproval("invalid", chatId, correlationId);
  const policy = resolvePolicy();
  if (policy === "allowed") return { kind: "allowed" };
  if (policy !== "review-required")
    return denyChatToolWriteApproval("authority-denied", chatId, correlationId);
  const retained = registry.findChatWriteApproval(
    entry.subject,
    entry.authority,
    action.invocationId,
    correlationId,
  );
  if (retained === undefined) {
    const created = registry.createChatWriteApproval(entry, correlationId);
    return created.ok
      ? { kind: "review-required", approval: entry.approval }
      : denyChatToolWriteApproval(created.reason, chatId, correlationId);
  }
  return currentRetainedApproval(registry, retained, action, isCurrent, correlationId);
}

function currentRetainedApproval(
  registry: NonNullable<ApprovalRegistry>,
  retained: ChatWriteApprovalEntry,
  action: ChatToolWriteActionIdentity,
  isCurrent: (entry: ChatWriteApprovalEntry) => boolean,
  correlationId: string,
): ChatToolWriteApprovalAdmission {
  const chatId = retained.subject.chatId;
  if (!sameWriteAction(retained.approval, action))
    return denyChatToolWriteApproval("invalid", chatId, correlationId);
  if (!isCurrent(retained)) {
    registry.revokeChatWriteApproval(retained.approval.approvalId, correlationId);
    return denyChatToolWriteApproval("authority-denied", chatId, correlationId);
  }
  const state = retained.approval.state;
  if (state === "pending" || state === "approved" || state === "claimed")
    return { kind: state === "pending" ? "review-required" : state, approval: retained.approval };
  // An approval nobody decided before its deadline is not a declined one (#4354 AC4).
  return denyChatToolWriteApproval(
    state === "expired" ? "expired" : "rejected",
    chatId,
    correlationId,
  );
}

/** Source owners revalidate authority when reserving each invocation against the shared budget. */
export function reserveChatToolInvocation<Deps>(
  options: {
    readonly deps: Deps;
    readonly now: () => number;
    readonly context: () => {
      readonly chatId: string;
      readonly authorityReference: EditorAgentGovernedAuthorityReference;
      readonly correlationId: string;
    };
  },
  reserve: (
    deps: Deps,
    chatId: string,
    authority: EditorAgentGovernedAuthorityReference,
    usage: CodingWorkbenchRuntimeDelegationUsage,
    nowIso: string,
    correlationId: string,
  ) => { readonly ok: boolean },
): boolean {
  const context = options.context();
  return reserve(
    options.deps,
    context.chatId,
    context.authorityReference,
    { toolCalls: 1, patchBytes: 0 },
    new Date(options.now()).toISOString(),
    context.correlationId,
  ).ok;
}

interface ChatWriteApprovalOwnerConfiguration<
  Deps,
  Envelope extends ChatToolAuthorityEnvelope,
  Action extends ChatToolWriteActionIdentity,
> {
  readonly resolve: (
    deps: Deps,
    chatId: string,
    authority: EditorAgentGovernedAuthorityReference,
    nowIso: string,
    correlationId: string,
  ) => { readonly ok: true; readonly envelope: Envelope } | { readonly ok: false };
  readonly readCurrent: (
    deps: Deps,
    entry: ChatReadGrantEntry,
    nowIso: string,
    correlationId: string,
  ) => boolean;
  readonly matchesEntry: (entry: ChatWriteApprovalEntry) => boolean;
  readonly policy: (
    entry: ChatWriteApprovalEntry,
    envelope: Envelope,
  ) => "allowed" | "review-required" | "denied";
  readonly pending: (
    facts: ChatWriteFacts<Envelope>,
    authority: EditorAgentGovernedAuthorityReference,
    action: Action,
    now: number,
    draftItemRefs?: readonly string[],
  ) => ChatWriteApprovalEntry;
}
interface ChatWriteApprovalOwner<Deps, Action extends ChatToolWriteActionIdentity> {
  readonly isCurrent: (
    deps: Deps,
    entry: ChatWriteApprovalEntry,
    nowIso: string,
    correlationId: string,
  ) => boolean;
  readonly request: (
    deps: Deps,
    chatId: string,
    authority: EditorAgentGovernedAuthorityReference,
    action: Action,
    nowIso: string,
    correlationId: string,
    draftItemRefs?: readonly string[],
  ) => ChatToolWriteApprovalAdmission;
}

function chatWriteFactsResolver<
  Deps extends Pick<UiHandlerDeps, "atlassianActionApprovalRegistry">,
  Envelope extends ChatToolAuthorityEnvelope,
  Action extends ChatToolWriteActionIdentity,
>(
  owner: ChatWriteApprovalOwnerConfiguration<Deps, Envelope, Action>,
): (
  deps: Deps,
  chatId: string,
  authority: EditorAgentGovernedAuthorityReference,
  nowIso: string,
  correlationId: string,
) => ChatWriteFacts<Envelope> | undefined {
  return (
    deps: Deps,
    chatId: string,
    authority: EditorAgentGovernedAuthorityReference,
    nowIso: string,
    correlationId: string,
  ): ChatWriteFacts<Envelope> | undefined =>
    currentChatWriteFacts(
      owner.resolve(deps, chatId, authority, nowIso, correlationId),
      deps.atlassianActionApprovalRegistry,
      (entry) => owner.readCurrent(deps, entry, nowIso, correlationId),
      correlationId,
    );
}

/** Source-specific adapters retain policy and validation; this existing owner retains the workflow. */
function chatWriteApprovalCurrency<
  Deps extends Pick<UiHandlerDeps, "atlassianActionApprovalRegistry">,
  Envelope extends ChatToolAuthorityEnvelope,
  Action extends ChatToolWriteActionIdentity,
>(
  owner: ChatWriteApprovalOwnerConfiguration<Deps, Envelope, Action>,
  factsFor: ReturnType<typeof chatWriteFactsResolver<Deps, Envelope, Action>>,
): ChatWriteApprovalOwner<Deps, Action>["isCurrent"] {
  return (deps, entry, nowIso, correlationId) => {
    if (!owner.matchesEntry(entry)) return false;
    const facts = factsFor(deps, entry.subject.chatId, entry.authority, nowIso, correlationId);
    if (facts === undefined || !sameReadGrantSubject(entry, facts.envelope.subject)) return false;
    return (
      owner.policy(entry, facts.envelope) !== "denied" &&
      chatWriteApprovalWithinBounds(entry, facts, Date.parse(nowIso))
    );
  };
}
export function createChatWriteApprovalOwner<
  Deps extends Pick<UiHandlerDeps, "atlassianActionApprovalRegistry">,
  Envelope extends ChatToolAuthorityEnvelope,
  Action extends ChatToolWriteActionIdentity,
>(
  owner: ChatWriteApprovalOwnerConfiguration<Deps, Envelope, Action>,
): ChatWriteApprovalOwner<Deps, Action> {
  const factsFor = chatWriteFactsResolver(owner);
  const isCurrent = chatWriteApprovalCurrency(owner, factsFor);
  return {
    isCurrent,
    request: (
      deps,
      chatId,
      authority,
      action,
      nowIso,
      correlationId,
      draftItemRefs,
    ): ChatToolWriteApprovalAdmission => {
      const facts = factsFor(deps, chatId, authority, nowIso, correlationId);
      const registry = deps.atlassianActionApprovalRegistry;
      if (facts === undefined || registry === undefined)
        return denyChatToolWriteApproval("authority-denied", chatId, correlationId);
      const now = Date.parse(nowIso);
      const first = owner.pending(facts, authority, action, now, draftItemRefs);
      const entry =
        owner.policy(first, facts.envelope) === "review-required"
          ? owner.pending(
              withFullDecisionTime(registry, facts, now, correlationId),
              authority,
              action,
              now,
              draftItemRefs,
            )
          : first;
      return requestRetainedChatWriteApproval(
        registry,
        entry,
        action,
        () => owner.policy(entry, facts.envelope),
        (retained) => isCurrent(deps, retained, nowIso, correlationId),
        correlationId,
      );
    },
  };
}

/**
 * Admits one model call of a Chat tool turn: the turn's retained authority must still be live.
 * Keiko does not limit tokens (#4346), so nothing is charged — the reservation books no usage.
 */
export function admitChatToolModelCall<Deps>(
  options: {
    readonly deps: Deps;
    readonly message: { readonly chatId: string };
    readonly authority: { readonly reference: EditorAgentGovernedAuthorityReference };
    readonly correlationId: string;
  },
  reserve: (
    deps: Deps,
    chatId: string,
    authority: EditorAgentGovernedAuthorityReference,
    usage: CodingWorkbenchRuntimeDelegationUsage,
    nowIso: string,
    correlationId: string,
  ) => { readonly ok: boolean },
): boolean {
  return reserve(
    options.deps,
    options.message.chatId,
    options.authority.reference,
    { toolCalls: 0, patchBytes: 0 },
    new Date().toISOString(),
    options.correlationId,
  ).ok;
}
export function createChatToolAuthorityPort<Consumer extends CatalogConsumer, Options>(
  options: Options,
  owner: {
    readonly preview: (
      options: Options,
      capability: string | undefined,
      action: Consumer["action"],
    ) => ReturnType<CatalogBoundAuthorityPort<Consumer>["preview"]>;
    readonly reviewable: (options: Options, action: Consumer["action"]) => boolean;
    readonly reserve: (options: Options) => boolean;
    readonly guard: (
      options: Options,
      capability: string | undefined,
      action: Consumer["action"],
    ) => Consumer["guard"];
  },
): CatalogBoundAuthorityPort<Consumer> {
  return {
    preview: (capability, action) => owner.preview(options, capability, action),
    admit: (capability, action): ReturnType<CatalogBoundAuthorityPort<Consumer>["admit"]> => {
      if (
        !owner.preview(options, capability, action).ok ||
        !owner.reviewable(options, action) ||
        !owner.reserve(options)
      )
        return { ok: false, reason: "authority-invalid" };
      return { ok: true, mutationGuard: owner.guard(options, capability, action) };
    },
  };
}
