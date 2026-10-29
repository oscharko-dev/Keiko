import { reserveChatToolPrompt } from "../chat-tool-approvals.js";
import { createMcpChatMutationIntent } from "./mcpChatMutation.js";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ToolResultEnvelope } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { bindChatToolCatalog, ChatToolTurn, chatModelSupportsTools } from "../chat-tool-turn.js";
import type { UiHandlerDeps } from "../deps.js";
import type { ChatMessage } from "../store/index.js";
import {
  observedChatToolMutationOutcome,
  sameMutationIdentity,
} from "../store/chatToolMutationState.js";
import { requireDispatch } from "../tool-catalog/catalogToolErrors.js";
import { ConversationModelNotReadyError } from "../conversation-readiness-admission.js";
import { logConversationAdmission } from "../conversation-readiness-log.js";
import { correlationIdOrUnknown } from "../correlation.js";
import { createMcpChatCatalogAdmission } from "./mcpChatCatalogAdmission.js";
import {
  mcpChatCatalogConsumerPort,
  type McpChatCatalogConsumer,
  type McpChatCatalogContext,
} from "./mcpChatCatalogConsumer.js";
import type { McpChatCatalog } from "./mcpChatCatalogRuntime.js";
import {
  mintAcceptedMcpChatAuthority,
  reserveCurrentMcpChatAuthority,
  type McpChatAuthorityDeps,
} from "./mcpChatAuthority.js";

type TurnDeps = McpChatAuthorityDeps &
  Pick<UiHandlerDeps, "mcpChatCatalog" | "gatewayConfig" | "diagnostics">;
type Accepted = Extract<ReturnType<typeof mintAcceptedMcpChatAuthority>, { ok: true }>;
export interface McpChatTurnOptions {
  readonly deps: TurnDeps;
  readonly message: ChatMessage;
  readonly authority: Accepted;
  readonly managed: McpChatCatalog;
  readonly signal: AbortSignal;
  readonly correlationId: string;
}

export function mcpChatTurnContext(options: McpChatTurnOptions): McpChatCatalogContext {
  const { authority, message, managed, signal, correlationId } = options;
  return {
    runId: authority.envelope.runId,
    correlationId,
    chatId: message.chatId,
    userMessageId: message.id,
    configurationDigest: managed.configurationDigest,
    authority: authority.reference.envelopeDigest,
    authorityReference: authority.reference,
    authorityExpiresAt: authority.envelope.expiresAt,
    deadlineAt: authority.envelope.expiresAt,
    signal,
  };
}
export class McpChatToolTurn extends ChatToolTurn<McpChatCatalogContext> {
  constructor(private readonly mcpOptions: McpChatTurnOptions) {
    const { deps, message, managed, correlationId } = mcpOptions;
    super({
      deps,
      message,
      managed,
      correlationId,
      context: mcpChatTurnContext(mcpOptions),
      bind: (context, budgetPort) =>
        bindChatToolCatalog<McpChatCatalogConsumer>({
          deps,
          managed,
          context: context,
          budgetPort,
          consumerPort: mcpChatCatalogConsumerPort,
          admission: createMcpChatCatalogAdmission({
            deps,
            context: () => context,
            tools: managed.tools,
            now: Date.now,
            ...this.consentPorts(),
          }),
        }),
    });
  }
  protected override reserveAuthorityPrompt(promptTokens: number): boolean {
    return reserveChatToolPrompt(this.mcpOptions, reserveCurrentMcpChatAuthority, promptTokens);
  }
  protected override observedMutation(
    call: NormalizedResponse["toolCalls"][number],
    identity: string,
    result: ToolResultEnvelope,
  ): ChatToolExchange["mutationOutcome"] {
    return observeMcpChatMutation(this.mcpOptions, call, identity, result);
  }
}

export function observeMcpChatMutation(
  options: McpChatTurnOptions,
  call: NormalizedResponse["toolCalls"][number],
  identity: string,
  result: ToolResultEnvelope,
): ChatToolExchange["mutationOutcome"] {
  const { deps, message, authority, managed } = options;
  const tool = managed.tools.find(
    (entry) => entry.descriptor.toolRef.canonicalId === result.toolRef?.canonicalId,
  );
  if (tool?.risk !== "write") return undefined;
  const record = deps.store.chatToolMutations?.find(identity);
  const expected = createMcpChatMutationIntent(
    message,
    authority.envelope.subject,
    authority.reference,
    {
      ...tool,
      actionId: identity,
      idempotencyKey: identity,
      argumentsDigest: sha256Hex(canonicalise(call.arguments)),
    },
    options.correlationId,
  );
  if (record?.userMessageId !== message.id || !sameMutationIdentity(record, expected))
    return undefined;
  return observedChatToolMutationOutcome(record);
}

export async function createMcpChatToolTurn(
  deps: TurnDeps,
  modelId: string,
  message: ChatMessage,
  signal: AbortSignal,
  correlationId: string | undefined,
): Promise<McpChatToolTurn | undefined> {
  const correlation = correlationIdOrUnknown(correlationId);
  const managed = await deps.mcpChatCatalog?.get(correlation);
  if (managed === undefined) return undefined;
  if (!chatModelSupportsTools(deps, modelId)) {
    const generation = deps.gatewayConfig?.generation();
    logConversationAdmission("observation-unavailable", correlation, generation, generation);
    throw new ConversationModelNotReadyError("tool-calling");
  }
  const authority = mintAcceptedMcpChatAuthority(deps, {
    chatId: message.chatId,
    userMessageId: message.id,
    startedAtMs: message.timestamp,
    nowMs: Date.now(),
    correlationId: correlation,
  });
  requireDispatch(
    authority.ok && authority.envelope.subject.configurationDigest === managed.configurationDigest,
    "denied",
    "authority-invalid",
  );
  const remaining = Date.parse(authority.envelope.expiresAt) - Date.now();
  requireDispatch(remaining > 0, "denied", "authority-expired");
  return new McpChatToolTurn({
    deps,
    message,
    authority,
    managed,
    signal: AbortSignal.any([signal, managed.signal, AbortSignal.timeout(remaining)]),
    correlationId: correlation,
  });
}
