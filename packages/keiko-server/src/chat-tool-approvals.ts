import type {
  ChatToolReadGrantView,
  ChatToolWriteApprovalView,
} from "@oscharko-dev/keiko-contracts";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { UiHandlerDeps } from "./deps.js";
import type { ChatMessage } from "./store/index.js";
import { projectChatReadGrant } from "./atlassian/chatReadGrantState.js";
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
