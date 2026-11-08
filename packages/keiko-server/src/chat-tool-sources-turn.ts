import { chatKnowledgeScopes } from "./requirement-inventory.js";
import {
  isKnowledgeChatAuthorityEnvelope,
  prepareAcceptedKnowledgeChatAuthority,
  reserveCurrentKnowledgeChatAuthority,
} from "./knowledge-chat-authority.js";
import type { KnowledgeChatTurnOptions } from "./knowledge-chat-turn.js";
import { reserveChatToolPrompt } from "./chat-tool-approvals.js";
import { jiraTurnGuidance } from "./atlassian/jiraOpenDraft.js";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import type { ToolResultEnvelope } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { UiHandlerDeps } from "./deps.js";
import type { ChatMessage } from "./store/index.js";
import {
  bindChatToolCatalog,
  ChatToolTurn,
  chatModelSupportsTools,
  type ChatToolTurnPort,
  type ChatToolTurnOptions,
} from "./chat-tool-turn.js";
import { requireDispatch } from "./tool-catalog/catalogToolErrors.js";
import { correlationIdOrUnknown } from "./correlation.js";
import { logConversationAdmission } from "./conversation-readiness-log.js";
import { ConversationModelNotReadyError } from "./conversation-readiness-admission.js";
import {
  isJiraEnvelope,
  prepareAcceptedJiraChatAuthority,
  reserveCurrentJiraChatAuthority,
} from "./atlassian/jiraChatAuthority.js";
import { prepareAcceptedMcpChatAuthority } from "./mcp/mcpChatAuthority.js";
import {
  createJiraChatTurnReviewPorts,
  observeJiraChatMutation,
  jiraSourcePreparationForTurn,
  type JiraChatTurnOptions,
} from "./atlassian/jiraChatToolTurn.js";
import { openTraceSession } from "./requirement-trace.js";
import {
  observeMcpChatMutation,
  mcpChatTurnContext,
  type McpChatTurnOptions,
} from "./mcp/mcpChatToolTurn.js";
import type { McpChatCatalog } from "./mcp/mcpChatCatalogRuntime.js";
import {
  createJiraChatCatalogConsumerPort,
  type JiraChatCatalogContext,
} from "./atlassian/jiraChatCatalogConsumer.js";
import type { JiraChatSourcePreparation } from "./atlassian/jiraChatRequirementBinding.js";
import { createJiraChatHumanInput } from "./atlassian/jiraChatHumanInput.js";
import { createJiraPrivateLifetime } from "./atlassian/httpPrivateIdentity.js";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import {
  combineChatCatalogs,
  chatSourcesAuthorityDigest,
  createChatSourcesConsumerPort,
  createChatSourcesAdmission,
  currentChatSources,
  type ChatSourcesConsumer,
  type ChatSourcesContext,
} from "./chat-tool-sources.js";

type Primary =
  | { readonly kind: "jira"; readonly options: JiraChatTurnOptions }
  | { readonly kind: "knowledge"; readonly options: KnowledgeChatTurnOptions };
interface Options {
  readonly deps: UiHandlerDeps;
  readonly message: ChatMessage;
  readonly primary: Primary;
  readonly mcp: McpChatTurnOptions;
  readonly correlationId: string;
  readonly signal: AbortSignal;
}
function sourceContext(options: Options): ChatSourcesContext {
  const {
    primary: {
      options: { authority },
    },
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
    primaryKind: options.primary.kind,
    correlationId,
    authority: chatSourcesAuthorityDigest({ jira, mcp }),
    authorityExpiresAt: jira.authorityExpiresAt,
    deadlineAt: jira.deadlineAt,
    signal,
    jira,
    mcp,
  };
}

function selectedSourceCatalog(
  deps: UiHandlerDeps,
  chatId: string,
  mcp: McpChatCatalog,
  bind: (
    managed: ReturnType<typeof combineChatCatalogs>,
  ) => ChatToolTurnOptions<ChatSourcesContext>["bind"],
): NonNullable<ChatToolTurnOptions<ChatSourcesContext>["selectTools"]> {
  return async (identities) => {
    requireDispatch(deps.jiraChatCatalog !== undefined, "failed", "handler-unavailable");
    const selected = await deps.jiraChatCatalog.select(identities, {
      knowledgeScoped: chatKnowledgeScopes(deps.store.findChatById(chatId)).length > 0,
    });
    try {
      const combined = combineChatCatalogs(selected, mcp);
      return { managed: combined, bind: bind(combined), close: selected.close };
    } catch (error) {
      await selected.close();
      throw error;
    }
  };
}

function sourcePreparationFor(options: Options): {
  readonly initialContext: ChatSourcesContext;
  readonly sourcePreparation: JiraChatSourcePreparation | undefined;
  readonly humanInput: ReturnType<typeof createJiraChatHumanInput> | undefined;
  readonly consumerPort: ReturnType<typeof createChatSourcesConsumerPort>;
} {
  const baseContext = sourceContext(options);
  const humanInput =
    options.primary.kind === "jira"
      ? createJiraChatHumanInput(options.primary.options, baseContext.jira)
      : undefined;
  const initialContext: ChatSourcesContext =
    humanInput === undefined
      ? baseContext
      : {
          ...baseContext,
          jira: {
            ...baseContext.jira,
            privateLifetime: createJiraPrivateLifetime(
              baseContext.jira.signal,
              options.correlationId,
            ),
            humanInputFor: (operation, digest) => humanInput.selectionFor(operation, digest),
            activeHumanInput: () => humanInput.currentSelection(),
          },
        };
  const sourcePreparation =
    options.primary.kind === "jira"
      ? jiraSourcePreparationForTurn(options.primary.options, initialContext.jira)
      : undefined;
  return {
    initialContext,
    sourcePreparation,
    humanInput,
    consumerPort: createChatSourcesConsumerPort(
      createJiraChatCatalogConsumerPort(
        sourcePreparation?.sourceDigestFor,
        humanInput === undefined
          ? undefined
          : (actionId, digest): string | undefined => humanInput.revisionFor(actionId, digest),
      ),
    ),
  };
}

function sourceInvocationPorts(
  source: JiraChatSourcePreparation | undefined,
  humanInput: ReturnType<typeof createJiraChatHumanInput> | undefined,
  context: ChatSourcesContext,
): Pick<
  ChatToolTurnOptions<ChatSourcesContext>,
  "prepareInvocation" | "finalizeInvocation" | "finalizeTurn"
> {
  if (source === undefined) return {};
  return {
    prepareInvocation: async (
      call,
      actionId,
      ports,
    ): Promise<{ readonly sourceDigest?: string } | undefined> => {
      const prepared = await source.prepareInvocation(call, actionId);
      await humanInput?.prepare(call, actionId, ports);
      return prepared;
    },
    finalizeInvocation: (actionId): void => {
      humanInput?.finalize(actionId);
    },
    finalizeTurn: async (): Promise<void> => {
      humanInput?.finish();
      await context.jira.privateLifetime?.finish();
    },
  };
}

function sourceReviewPorts(
  primary: Primary,
  sourcePreparation: JiraChatSourcePreparation | undefined,
  access: Parameters<typeof createJiraChatTurnReviewPorts>[1],
): Pick<Parameters<typeof createChatSourcesAdmission>[0], "jiraReview"> {
  return primary.kind === "jira"
    ? {
        jiraReview: {
          ...createJiraChatTurnReviewPorts(primary.options, access),
          ...(sourcePreparation === undefined ? {} : { sourcePreparation }),
        },
      }
    : {};
}

function sourceSelectionPorts(
  options: Options,
  bind: (
    selected: ReturnType<typeof combineChatCatalogs>,
  ) => ChatToolTurnOptions<ChatSourcesContext>["bind"],
): Pick<ChatToolTurnOptions<ChatSourcesContext>, "guidance" | "selectTools"> {
  if (options.primary.kind !== "jira") return {};
  const { deps, message, correlationId, mcp } = options;
  return {
    guidance: jiraTurnGuidance(
      deps.jiraDraftStore,
      message.chatId,
      deps.activityLog,
      correlationId,
    ),
    selectTools: selectedSourceCatalog(deps, message.chatId, mcp.managed, bind),
  };
}

/** One binder, harness and model loop; source adapters keep their existing consent and effect owners. */
class ChatSourcesToolTurn extends ChatToolTurn<ChatSourcesContext> {
  private readonly sourcePreparation: JiraChatSourcePreparation | undefined;
  private readonly humanInput: ReturnType<typeof createJiraChatHumanInput> | undefined;
  constructor(private readonly sourceOptions: Options) {
    const { deps, message, correlationId, primary, mcp } = sourceOptions;
    const managed = combineChatCatalogs(primary.options.managed, mcp.managed);
    const { initialContext, sourcePreparation, humanInput, consumerPort } =
      sourcePreparationFor(sourceOptions);
    const bind =
      (selected: typeof managed): ChatToolTurnOptions<ChatSourcesContext>["bind"] =>
      (context, budgetPort, invocationRegistry) =>
        bindChatToolCatalog<ChatSourcesConsumer>({
          deps,
          managed: selected,
          context: context,
          budgetPort,
          invocationRegistry,
          consumerPort,
          admission: createChatSourcesAdmission({
            deps,
            context: () => context,
            tools: mcp.managed.tools,
            ...this.consentPorts(),
            ...sourceReviewPorts(primary, sourcePreparation, {
              writeExchange: (actionId) => this.writeExchange(actionId),
              reviewableWrite: (action) => this.reviewableWrite(action),
              readAllowed: () => !context.signal.aborted && currentChatSources(deps, context),
            }),
          }),
        });
    super({
      deps,
      message,
      correlationId,
      managed,
      context: initialContext,
      budget: primary.options.authority.envelope.budget,
      ...sourceInvocationPorts(sourcePreparation, humanInput, initialContext),
      ...sourceSelectionPorts(sourceOptions, bind),
      bind: bind(managed),
    });
    this.sourcePreparation = sourcePreparation;
    this.humanInput = humanInput;
  }
  protected override reserveAuthorityPrompt(promptTokens: number): boolean {
    return (
      currentChatSources(this.sourceOptions.deps, this.context) &&
      reserveChatToolPrompt(
        this.sourceOptions.primary.options,
        this.sourceOptions.primary.kind === "knowledge"
          ? reserveCurrentKnowledgeChatAuthority
          : reserveCurrentJiraChatAuthority,
        promptTokens,
      )
    );
  }
  protected override observedMutation(
    call: NormalizedResponse["toolCalls"][number],
    identity: string,
    result: ToolResultEnvelope,
  ): ChatToolExchange["mutationOutcome"] {
    const argumentsDigest = sha256Hex(canonicalise(call.arguments));
    return (
      (this.sourceOptions.primary.kind === "jira"
        ? observeJiraChatMutation(
            this.sourceOptions.primary.options,
            call,
            identity,
            result,
            this.sourcePreparation?.sourceDigestFor(identity, argumentsDigest),
            this.humanInput?.revisionFor(identity, argumentsDigest),
          )
        : undefined) ?? observeMcpChatMutation(this.sourceOptions.mcp, call, identity, result)
    );
  }
}

function acceptedSources(
  deps: UiHandlerDeps,
  message: ChatMessage,
  correlationId: string,
  primaryKind: "jira" | "knowledge",
): {
  readonly primary: {
    readonly authority: {
      readonly ok: true;
      readonly envelope:
        | JiraChatTurnOptions["authority"]["envelope"]
        | KnowledgeChatTurnOptions["authority"]["envelope"];
      readonly reference: JiraChatTurnOptions["authority"]["reference"];
    };
  };
  readonly mcpAuthority: McpChatTurnOptions["authority"];
} {
  const turn = {
    chatId: message.chatId,
    userMessageId: message.id,
    startedAtMs: message.timestamp,
    nowMs: Date.now(),
    correlationId,
  };
  const jira =
    primaryKind === "knowledge"
      ? prepareAcceptedKnowledgeChatAuthority(deps, turn)
      : prepareAcceptedJiraChatAuthority(deps, turn);
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
    primary: { authority: { ok: true, envelope: jira.envelope, reference: jiraReference } },
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
  primaryKind: "jira" | "knowledge" = "jira",
): Promise<ChatToolTurnPort> {
  const correlation = correlationIdOrUnknown(correlationId);
  if (!chatModelSupportsTools(deps, modelId)) {
    const generation = deps.gatewayConfig?.generation();
    logConversationAdmission("observation-unavailable", correlation, generation, generation);
    throw new ConversationModelNotReadyError("tool-calling");
  }
  const jira = await (primaryKind === "knowledge"
    ? deps.knowledgeChatCatalog?.get()
    : deps.jiraChatCatalog?.get({
        knowledgeScoped: chatKnowledgeScopes(deps.store.findChatById(message.chatId)).length > 0,
      }));
  requireDispatch(jira !== undefined, "denied", "authority-invalid");
  const {
    primary: { authority },
    mcpAuthority,
  } = acceptedSources(deps, message, correlation, primaryKind);
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
    primary: acceptedPrimary(common, jira, authority),
    mcp: { ...common, authority: mcpAuthority, managed: mcp },
  });
}

function acceptedPrimary(
  common: Pick<KnowledgeChatTurnOptions, "deps" | "message" | "signal" | "correlationId">,
  managed: KnowledgeChatTurnOptions["managed"],
  authority: ReturnType<typeof acceptedSources>["primary"]["authority"],
): Primary {
  const envelope = authority.envelope;
  if (isKnowledgeChatAuthorityEnvelope(envelope))
    return {
      kind: "knowledge",
      options: { ...common, managed, authority: { ...authority, envelope } },
    };
  requireDispatch(isJiraEnvelope(envelope), "denied", "authority-invalid");
  return {
    kind: "jira",
    options: {
      ...common,
      managed,
      authority: { ...authority, envelope },
      openTrace: (context) =>
        openTraceSession(common.deps, {
          chatId: context.chatId,
          userMessageId: context.userMessageId,
          correlationId: context.correlationId,
        }),
    },
  };
}
