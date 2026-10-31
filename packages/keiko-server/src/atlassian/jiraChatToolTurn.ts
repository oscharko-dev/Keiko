import { reserveChatToolPrompt } from "../chat-tool-approvals.js";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import type { ChatMessage } from "../store/index.js";
import {
  JIRA_MUTATION_OPERATIONS,
  type JiraMutationOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { UiHandlerDeps } from "../deps.js";
import { correlationIdOrUnknown } from "../correlation.js";
import { ConversationModelNotReadyError } from "../conversation-readiness-admission.js";
import { logConversationAdmission } from "../conversation-readiness-log.js";
import { requireDispatch } from "../tool-catalog/catalogToolErrors.js";
import {
  mintAcceptedJiraChatAuthority,
  reserveCurrentJiraChatAuthority,
  type JiraChatAuthorityDeps,
} from "./jiraChatAuthority.js";
import {
  createJiraChatCatalogAdmission,
  jiraChatCatalogConsumerPort,
  type JiraChatCatalogConsumer,
  type JiraChatCatalogContext,
} from "./jiraChatCatalogConsumer.js";
import type { ManagedProviderCatalog } from "../tool-catalog/managedProviderCatalog.js";
import { createJiraChatMutationIntent } from "./jiraChatMutationIntent.js";
import { jiraChatMutationOutcome } from "./jiraChatMutationOutcome.js";
import type { ToolResultEnvelope } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  ChatToolTurn,
  bindChatToolCatalog,
  chatModelSupportsTools as jiraChatModelSupportsTools,
} from "../chat-tool-turn.js";
export { chatModelSupportsTools as jiraChatModelSupportsTools } from "../chat-tool-turn.js";
type TurnDeps = JiraChatAuthorityDeps &
  Pick<
    UiHandlerDeps,
    "jiraChatCatalog" | "gatewayConfig" | "atlassianActionApprovalRegistry" | "diagnostics"
  >;
type Accepted = Extract<ReturnType<typeof mintAcceptedJiraChatAuthority>, { ok: true }>;
export interface JiraChatTurnOptions {
  readonly deps: TurnDeps;
  readonly message: ChatMessage;
  readonly authority: Accepted;
  readonly managed: ManagedProviderCatalog<JiraChatCatalogConsumer>;
  readonly signal: AbortSignal;
  readonly correlationId: string;
}

export class JiraChatToolTurn extends ChatToolTurn<JiraChatCatalogContext> {
  public constructor(private readonly jiraOptions: JiraChatTurnOptions) {
    const { authority, deps, managed, signal, correlationId, message } = jiraOptions;
    const context: JiraChatCatalogContext = {
      runId: authority.envelope.runId,
      correlationId,
      chatId: message.chatId,
      userMessageId: message.id,
      authority: authority.reference.envelopeDigest,
      authorityReference: authority.reference,
      authorityExpiresAt: authority.envelope.expiresAt,
      deadlineAt: authority.envelope.expiresAt,
      signal,
    };
    super({
      deps,
      message,
      managed,
      context,
      correlationId,
      budget: authority.envelope.budget,
      bind: (current, budgetPort) =>
        bindChatToolCatalog<JiraChatCatalogConsumer>({
          deps,
          managed,
          context: current,
          budgetPort,
          consumerPort: jiraChatCatalogConsumerPort,
          admission: createJiraChatCatalogAdmission({
            deps,
            context: () => current,
            now: Date.now,
            ...this.consentPorts(),
          }),
        }),
    });
  }
  protected override reserveAuthorityPrompt(promptTokens: number): boolean {
    return reserveChatToolPrompt(this.jiraOptions, reserveCurrentJiraChatAuthority, promptTokens);
  }

  protected override observedMutation(
    call: NormalizedResponse["toolCalls"][number],
    identity: string,
    result: ToolResultEnvelope,
  ): JiraMutationOutcome | undefined {
    return observeJiraChatMutation(this.jiraOptions, call, identity, result);
  }
}

export function observeJiraChatMutation(
  options: JiraChatTurnOptions,
  call: NormalizedResponse["toolCalls"][number],
  identity: string,
  result: ToolResultEnvelope,
): JiraMutationOutcome | undefined {
  const operation = JIRA_MUTATION_OPERATIONS.find(
    (value) => result.toolRef?.canonicalId === `keiko.${value}`,
  );
  if (operation === undefined) return undefined;
  const { message, authority, correlationId, deps } = options;
  const expected = createJiraChatMutationIntent(
    message,
    authority.envelope.subject,
    authority.reference,
    {
      tool: operation,
      actionId: identity,
      idempotencyKey: identity,
      argumentsDigest: sha256Hex(canonicalise(call.arguments)),
    },
    correlationId,
  );
  return jiraChatMutationOutcome({
    result,
    expected,
    record: deps.store.chatToolMutations?.find(identity),
  });
}

export async function createJiraChatToolTurn(
  deps: TurnDeps,
  modelId: string,
  message: ChatMessage,
  signal: AbortSignal,
  correlationId: string | undefined,
): Promise<JiraChatToolTurn | undefined> {
  if (deps.store.findChatById(message.chatId)?.jiraPodBinding === undefined) return undefined;
  if (!jiraChatModelSupportsTools(deps, modelId)) {
    const generation = deps.gatewayConfig?.generation();
    logConversationAdmission("observation-unavailable", correlationId, generation, generation);
    throw new ConversationModelNotReadyError("tool-calling");
  }
  const authority = mintAcceptedJiraChatAuthority(deps, {
    chatId: message.chatId,
    userMessageId: message.id,
    startedAtMs: message.timestamp,
    nowMs: Date.now(),
    correlationId: correlationIdOrUnknown(correlationId),
  });
  requireDispatch(
    authority.ok && deps.jiraChatCatalog !== undefined,
    "denied",
    "authority-invalid",
  );
  const remaining = Date.parse(authority.envelope.expiresAt) - Date.now();
  requireDispatch(remaining > 0, "denied", "authority-expired");
  return new JiraChatToolTurn({
    deps,
    message,
    authority,
    managed: await deps.jiraChatCatalog.get(),
    signal: AbortSignal.any([signal, AbortSignal.timeout(remaining)]),
    correlationId: correlationIdOrUnknown(correlationId),
  });
}
export function scopeJiraChatToolTurn(
  deps: UiHandlerDeps,
  turn: JiraChatToolTurn | undefined,
): UiHandlerDeps {
  if (turn === undefined) return deps;
  return {
    ...deps,
    chatToolTurn: turn,
    modelPortFactory: (id): ReturnType<UiHandlerDeps["modelPortFactory"]> => {
      const model = deps.modelPortFactory(id);
      return model === undefined ? undefined : turn.meter(model);
    },
  };
}
