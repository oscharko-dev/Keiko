import { randomUUID } from "node:crypto";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import type { ToolResultEnvelope } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { UiHandlerDeps } from "./deps.js";
import type { ChatMessage } from "./store/index.js";
import { ChatToolTurn, chatModelSupportsTools, type ChatToolTurnPort } from "./chat-tool-turn.js";
import { createCatalogToolBinder } from "./tool-catalog/catalogToolDispatch.js";
import { requireDispatch } from "./tool-catalog/catalogToolErrors.js";
import { createCodingToolInvocationRegistry } from "./coding-runtime/codingToolInvocationRegistry.js";
import { defaultServerDiagnosticSink } from "./diagnostics-log.js";
import { processServerLogSink } from "./process-log-sink.js";
import { correlationIdOrUnknown } from "./correlation.js";
import { logConversationAdmission } from "./conversation-readiness-log.js";
import { ConversationModelNotReadyError } from "./conversation-readiness-admission.js";
import {
  waitForChatToolReadConsent,
  waitForChatToolWriteConsent,
  refreshChatToolWriteApproval,
  type ChatToolApprovalContext,
} from "./chat-tool-approvals.js";
import {
  prepareAcceptedJiraChatAuthority,
  reserveCurrentJiraChatAuthority,
} from "./atlassian/jiraChatAuthority.js";
import { prepareAcceptedMcpChatAuthority } from "./mcp/mcpChatAuthority.js";
import { observeJiraChatMutation, type JiraChatTurnOptions } from "./atlassian/jiraChatToolTurn.js";
import {
  observeMcpChatMutation,
  mcpChatTurnContext,
  type McpChatTurnOptions,
} from "./mcp/mcpChatToolTurn.js";
import type { McpChatCatalog } from "./mcp/mcpChatCatalogRuntime.js";
import type { JiraChatCatalogContext } from "./atlassian/jiraChatCatalogConsumer.js";
import {
  combineChatCatalogs,
  chatSourcesAuthorityDigest,
  chatSourcesConsumerPort,
  createChatSourcesAdmission,
  currentChatSources,
  type ChatSourcesConsumer,
  type ChatSourcesContext,
} from "./chat-tool-sources.js";

interface Options {
  readonly deps: UiHandlerDeps;
  readonly message: ChatMessage;
  readonly jira: JiraChatTurnOptions;
  readonly mcp: McpChatTurnOptions;
  readonly correlationId: string;
  readonly signal: AbortSignal;
}
function sourceContext(options: Options): ChatSourcesContext {
  const {
    jira: { authority },
    message,
    signal,
    correlationId,
  } = options;
  const jira: JiraChatCatalogContext = {
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
  const mcp = mcpChatTurnContext(options.mcp);
  return {
    runId: jira.runId,
    correlationId,
    authority: chatSourcesAuthorityDigest({ jira, mcp }),
    authorityExpiresAt: jira.authorityExpiresAt,
    deadlineAt: jira.deadlineAt,
    signal,
    jira,
    mcp,
  };
}

/** One binder, harness and model loop; source adapters keep their existing consent and effect owners. */
class ChatSourcesToolTurn extends ChatToolTurn<ChatSourcesContext> {
  constructor(private readonly sourceOptions: Options) {
    const { deps, message, correlationId, jira, mcp } = sourceOptions;
    const managed = combineChatCatalogs(jira.managed, mcp.managed);
    super({
      deps,
      message,
      correlationId,
      managed,
      context: sourceContext(sourceOptions),
      bind: (context, budgetPort) =>
        createCatalogToolBinder<ChatSourcesConsumer>(
          {
            ...createChatSourcesAdmission({
              deps,
              context: () => context,
              tools: mcp.managed.tools,
              requestReadConsent: (grant, signal) =>
                waitForChatToolReadConsent(this.approvalContext(signal), grant),
              requestWriteConsent: (approval, signal) =>
                waitForChatToolWriteConsent(this.approvalContext(signal), approval),
              reviewableWrite: (action) => this.reviewableWrite(action),
            }),
            consumerPort: chatSourcesConsumerPort,
            projection: managed.projection,
            handlerBindings: managed.handlerBindings,
            budgetPort,
            logPort: {
              primary: processServerLogSink(),
              diagnostics: deps.diagnostics ?? defaultServerDiagnosticSink,
            },
          },
          {
            catalog: managed.catalog,
            context: () => context,
            now: Date.now,
            mintId: randomUUID,
            invocationRegistry: createCodingToolInvocationRegistry({ now: Date.now }),
          },
        ),
    });
  }
  private approvalContext(signal: AbortSignal): ChatToolApprovalContext {
    return {
      ...this.sourceOptions,
      signal,
      publish: () => this.publish(),
      writeExchange: (id) => this.writeExchange(id),
    };
  }
  private reviewableWrite(action: ChatSourcesConsumer["action"]): boolean {
    const exchange = this.writeExchange(action.actionId);
    return (
      exchange !== undefined &&
      sha256Hex(canonicalise(exchange.call.arguments)) === action.argumentsDigest
    );
  }
  protected override reserveAuthorityPrompt(promptTokens: number): boolean {
    const { deps, message, jira, correlationId } = this.sourceOptions;
    return (
      currentChatSources(deps, this.context) &&
      reserveCurrentJiraChatAuthority(
        deps,
        message.chatId,
        jira.authority.reference,
        { toolCalls: 0, promptTokens, patchBytes: 0 },
        new Date().toISOString(),
        correlationId,
      ).ok
    );
  }
  protected override observedMutation(
    call: NormalizedResponse["toolCalls"][number],
    identity: string,
    result: ToolResultEnvelope,
  ): ChatToolExchange["mutationOutcome"] {
    return (
      observeJiraChatMutation(this.sourceOptions.jira, call, identity, result) ??
      observeMcpChatMutation(this.sourceOptions.mcp, call, identity, result)
    );
  }
  protected override refreshWriteApproval(callId: string): void {
    refreshChatToolWriteApproval(this.sourceOptions, callId);
  }
}

function acceptedSources(
  deps: UiHandlerDeps,
  message: ChatMessage,
  correlationId: string,
): Pick<JiraChatTurnOptions, "authority"> & {
  readonly mcpAuthority: McpChatTurnOptions["authority"];
} {
  const turn = {
    chatId: message.chatId,
    userMessageId: message.id,
    startedAtMs: message.timestamp,
    nowMs: Date.now(),
    correlationId,
  };
  const jira = prepareAcceptedJiraChatAuthority(deps, turn);
  const mcp = prepareAcceptedMcpChatAuthority(deps, turn);
  requireDispatch(jira.ok && mcp.ok, "denied", "authority-invalid");
  const registered = deps.agentAuthorityRegistry?.registerChatSources(
    [jira.envelope, mcp.envelope],
    jira.envelope.deploymentCeiling,
    new Date(turn.nowMs).toISOString(),
    correlationId,
  );
  requireDispatch(registered?.ok === true, "denied", "authority-invalid");
  const [jiraReference, mcpReference] = registered.authorityRefs;
  requireDispatch(
    jiraReference !== undefined && mcpReference !== undefined,
    "denied",
    "authority-invalid",
  );
  return {
    authority: { ok: true, envelope: jira.envelope, reference: jiraReference },
    mcpAuthority: { ok: true, envelope: mcp.envelope, reference: mcpReference },
  };
}

export async function createChatSourcesToolTurn(
  deps: UiHandlerDeps,
  modelId: string,
  message: ChatMessage,
  signal: AbortSignal,
  correlationId: string | undefined,
  mcp: McpChatCatalog,
): Promise<ChatToolTurnPort> {
  const correlation = correlationIdOrUnknown(correlationId);
  if (!chatModelSupportsTools(deps, modelId)) {
    const generation = deps.gatewayConfig?.generation();
    logConversationAdmission("observation-unavailable", correlation, generation, generation);
    throw new ConversationModelNotReadyError("tool-calling");
  }
  const jira = await deps.jiraChatCatalog?.get();
  requireDispatch(jira !== undefined, "denied", "authority-invalid");
  const { authority, mcpAuthority } = acceptedSources(deps, message, correlation);
  requireDispatch(
    mcpAuthority.envelope.subject.configurationDigest === mcp.configurationDigest,
    "denied",
    "authority-invalid",
  );
  const remaining = Date.parse(authority.envelope.expiresAt) - Date.now();
  requireDispatch(remaining > 0, "denied", "authority-expired");
  const sharedSignal = AbortSignal.any([signal, mcp.signal, AbortSignal.timeout(remaining)]);
  const common = { deps, message, signal: sharedSignal, correlationId: correlation };
  return new ChatSourcesToolTurn({
    ...common,
    jira: { ...common, authority, managed: jira },
    mcp: { ...common, authority: mcpAuthority, managed: mcp },
  });
}
