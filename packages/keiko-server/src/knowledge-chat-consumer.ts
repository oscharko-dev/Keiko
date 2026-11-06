import { chatCapabilityMatches } from "./chat-tool-authority.js";
import type { ToolAuthorityAvailability } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import type {
  CatalogConsumerPort,
  CatalogToolBinderInput,
} from "./tool-catalog/catalogToolPorts.js";
import {
  jiraChatCatalogConsumerPort,
  type JiraChatCatalogConsumer,
  type JiraChatCatalogContext,
  type JiraChatCatalogAction,
} from "./atlassian/jiraChatCatalogConsumer.js";
import { KNOWLEDGE_CHAT_TOOLS } from "./requirementsToolName.js";
import { createChatToolAuthorityPort, reserveChatToolInvocation } from "./chat-tool-approvals.js";
import {
  resolveCurrentKnowledgeChatAuthority,
  reserveCurrentKnowledgeChatAuthority,
  type KnowledgeChatAuthorityDeps,
} from "./knowledge-chat-authority.js";
import { recordChatAuthorityResult } from "./editor/chatAuthorityActivity.js";

/** Same action/binder contract as the existing local reads, with its own authority owner. */
export const knowledgeChatConsumerPort: CatalogConsumerPort<JiraChatCatalogConsumer> = {
  ...jiraChatCatalogConsumerPort,
  scope: (context) => ({ ...jiraChatCatalogConsumerPort.scope(context), kind: "knowledge-chat" }),
};
interface Options {
  readonly deps: KnowledgeChatAuthorityDeps;
  readonly context: () => JiraChatCatalogContext;
  readonly now: () => number;
}
type Ports = Pick<
  CatalogToolBinderInput<JiraChatCatalogConsumer>,
  "authorityPort" | "approvalPort"
>;
const READS: ReadonlySet<string> = new Set(KNOWLEDGE_CHAT_TOOLS);
function preview(
  options: Options,
  capability: string | undefined,
  action: JiraChatCatalogAction,
): ToolAuthorityAvailability {
  const context = options.context();
  const current = resolveCurrentKnowledgeChatAuthority(
    options.deps,
    context.chatId,
    context.authorityReference,
    new Date(options.now()).toISOString(),
    context.correlationId,
  );
  const allowed =
    current.ok &&
    READS.has(action.tool) &&
    chatCapabilityMatches(context, capability) &&
    current.envelope.expiresAt === context.authorityExpiresAt;
  recordChatAuthorityResult(
    "catalog-read",
    allowed ? { ok: true } : { ok: false, reason: "invalid" },
    { chatId: context.chatId },
    context.correlationId,
  );
  return allowed ? { ok: true } : { ok: false, reason: "authority-invalid" };
}
export function createKnowledgeChatAdmission(options: Options): Ports {
  return {
    authorityPort: createChatToolAuthorityPort<JiraChatCatalogConsumer, Options>(options, {
      preview,
      reviewable: (_options, action) => READS.has(action.tool),
      reserve: (current) =>
        reserveChatToolInvocation(current, reserveCurrentKnowledgeChatAuthority),
      guard: (current, capability, action) => ({
        check: () => preview(current, capability, action).ok,
      }),
    }),
    approvalPort: { available: () => false, request: () => Promise.resolve(undefined) },
  };
}
