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

export interface ChatToolApprovalContext {
  readonly deps: Pick<UiHandlerDeps, "store" | "atlassianActionApprovalRegistry">;
  readonly message: ChatMessage;
  readonly correlationId: string;
  readonly signal: AbortSignal;
  readonly publish: () => Promise<void>;
  readonly writeExchange: (invocationId: string) => ChatToolExchange | undefined;
}
export async function waitForChatToolReadConsent(
  input: ChatToolApprovalContext,
  grant: ChatToolReadGrantView,
): Promise<void> {
  const { deps, message, correlationId, signal } = input;
  const registry = deps.atlassianActionApprovalRegistry;
  requireDispatch(registry !== undefined, "denied", "approval-required");
  deps.store.updateChatToolTranscript(message.id, { kind: "read-consent", grant }, correlationId);
  await input.publish();
  await registry.waitForChatReadGrant(grant.grantId, signal);
  if (
    signal.aborted &&
    registry.getChatReadGrant(grant.grantId, correlationId)?.grant.state === "pending"
  )
    registry.revokeChatReadGrant(grant.grantId, correlationId);
  const current = registry.getChatReadGrant(grant.grantId, correlationId);
  const view =
    current === undefined
      ? { ...grant, state: "expired" as const }
      : projectChatReadGrant(current.grant);
  deps.store.updateChatToolTranscript(
    message.id,
    { kind: "read-consent", grant: view },
    correlationId,
  );
  await input.publish();
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
      { kind: "write-approval", callId: exchange.call.id, approval: view },
      correlationId,
    );
  };
  save(approval);
  await input.publish();
  await registry.waitForChatWriteApproval(approval.approvalId, signal);
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
    { kind: "write-approval", callId, approval: observed },
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
      readonly reason: "authority-denied" | "invalid" | "rejected" | "capacity-exhausted";
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
  return state === "pending" || state === "approved" || state === "claimed"
    ? { kind: state === "pending" ? "review-required" : state, approval: retained.approval }
    : denyChatToolWriteApproval("rejected", chatId, correlationId);
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
    { toolCalls: 1, patchBytes: 0, promptTokens: 0 },
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
export function createChatWriteApprovalOwner<
  Deps extends Pick<UiHandlerDeps, "atlassianActionApprovalRegistry">,
  Envelope extends ChatToolAuthorityEnvelope,
  Action extends ChatToolWriteActionIdentity,
>(
  owner: ChatWriteApprovalOwnerConfiguration<Deps, Envelope, Action>,
): ChatWriteApprovalOwner<Deps, Action> {
  const factsFor = chatWriteFactsResolver(owner);
  const isCurrent = (
    deps: Deps,
    entry: ChatWriteApprovalEntry,
    nowIso: string,
    correlationId: string,
  ): boolean => {
    if (!owner.matchesEntry(entry)) return false;
    const facts = factsFor(deps, entry.subject.chatId, entry.authority, nowIso, correlationId);
    if (facts === undefined || !sameReadGrantSubject(entry, facts.envelope.subject)) return false;
    return (
      owner.policy(entry, facts.envelope) !== "denied" &&
      chatWriteApprovalWithinBounds(entry, facts, Date.parse(nowIso))
    );
  };
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
      const entry = owner.pending(facts, authority, action, Date.parse(nowIso), draftItemRefs);
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

export function reserveChatToolPrompt<Deps>(
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
  promptTokens: number,
): boolean {
  return reserve(
    options.deps,
    options.message.chatId,
    options.authority.reference,
    { toolCalls: 0, promptTokens, patchBytes: 0 },
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
