import { reserveChatToolPrompt } from "../chat-tool-approvals.js";
import { JIRA_TOOL_GUIDANCE } from "./jiraToolGuidance.js";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ChatMessage } from "../store/index.js";
import {
  JIRA_MUTATION_OPERATIONS,
  type JiraAttachmentPreview,
  type JiraMutationOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { parseJiraAttachmentArguments, parseJiraDraft } from "@oscharko-dev/keiko-connectors";
import { chatDraftArguments } from "./jiraChatDraftArguments.js";
import {
  jiraChatAttachmentLimit,
  previewJiraChatAttachment,
  type JiraChatAttachmentDeps,
} from "./jiraChatAttachment.js";
import type { UiHandlerDeps } from "../deps.js";
import { correlationIdOrUnknown } from "../correlation.js";
import { requireDispatch } from "../tool-catalog/catalogToolErrors.js";
import {
  mintAcceptedJiraChatAuthority,
  reserveCurrentJiraChatAuthority,
  type JiraChatAuthorityDeps,
} from "./jiraChatAuthority.js";
import {
  createJiraChatCatalogAdmission,
  jiraChatCatalogConsumerPort,
  type JiraChatAdmissionOptions,
  type JiraChatCatalogAction,
  type JiraChatCatalogConsumer,
  type JiraChatCatalogContext,
} from "./jiraChatCatalogConsumer.js";
import type { ManagedProviderCatalog } from "../tool-catalog/managedProviderCatalog.js";
import { createJiraChatMutationIntent } from "./jiraChatMutationIntent.js";
import {
  createJiraChatTemplatePreflight,
  type JiraChatTemplatePreflightPorts,
} from "./jiraChatTemplatePreflight.js";
import { jiraChatMutationOutcome } from "./jiraChatMutationOutcome.js";
import { jiraOperationForTool, isCurrentJiraOperationBinding } from "./jiraManagedProvider.js";
import {
  jiraDraftUntracedAdvice,
  observedJiraDraftOutcome,
  jiraDraftRequirementRefusal,
} from "./jiraChatDraft.js";
import { untracedAdvisory } from "./jiraChatCatalogRuntime.js";
import type { TraceSession } from "../requirement-trace.js";
import type {
  CatalogJsonObject,
  ToolResultEnvelope,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  ChatToolTurn,
  bindChatToolCatalog,
  mintAndBoundChatTurn,
  type ChatToolTurnOptions,
} from "../chat-tool-turn.js";
export { chatModelSupportsTools as jiraChatModelSupportsTools } from "../chat-tool-turn.js";
type TurnDeps = JiraChatAuthorityDeps &
  JiraChatAttachmentDeps &
  Pick<
    UiHandlerDeps,
    | "jiraChatCatalog"
    | "gatewayConfig"
    | "atlassianActionApprovalRegistry"
    | "diagnostics"
    | "atlassianConnectorCredentials"
    | "jiraDraftStore"
    | "activityLog"
  >;
type Accepted = Extract<ReturnType<typeof mintAcceptedJiraChatAuthority>, { ok: true }>;
export interface JiraChatTurnOptions {
  readonly deps: TurnDeps;
  readonly message: ChatMessage;
  readonly authority: Accepted;
  readonly managed: ManagedProviderCatalog<JiraChatCatalogConsumer>;
  readonly signal: AbortSignal;
  readonly correlationId: string;
  /** Opens the requirements of the Chat's Pods; without it a draft is never advised about them. */
  readonly openTrace?: ((context: JiraChatCatalogContext) => TraceSession) | undefined;
}

function draftUntracedAdvice(
  deps: JiraChatTurnOptions["deps"],
  openTrace: JiraChatTurnOptions["openTrace"],
): JiraChatTemplatePreflightPorts["untracedAdvice"] {
  if (openTrace === undefined) return undefined;
  const advised = new Set<string>();
  return (draftArguments, context) =>
    jiraDraftUntracedAdvice(
      draftArguments,
      () => openTrace(context),
      untracedAdvisory(deps, advised, context),
    );
}

function draftRequirementsCheck(
  openTrace: JiraChatTurnOptions["openTrace"],
): JiraChatTemplatePreflightPorts["draftRequirements"] {
  return (args, context): ReturnType<typeof jiraDraftRequirementRefusal> => {
    const items = parseJiraDraft(args)?.items;
    if (items === undefined) return undefined;
    return jiraDraftRequirementRefusal(
      items,
      openTrace === undefined ? undefined : (): TraceSession => openTrace(context),
      context.correlationId,
    );
  };
}

type ReviewAction = Pick<JiraChatCatalogAction, "actionId" | "argumentsDigest">;
export type JiraChatTurnReviewPorts = Required<
  Pick<JiraChatAdmissionOptions, "preflightWrite" | "attachmentPreview" | "draftItemRefs">
>;
interface JiraChatTurnReviewAccess {
  readonly writeExchange: (actionId: string) => ChatToolExchange | undefined;
  readonly reviewableWrite: (action: ReviewAction) => boolean;
  readonly readAllowed: (action: JiraChatCatalogAction) => boolean;
}

/** The model's proposed write, only while it matches the persisted approval digest. */
function proposedWriteArguments(
  access: JiraChatTurnReviewAccess,
  action: ReviewAction,
): CatalogJsonObject | undefined {
  const exchange = access.writeExchange(action.actionId);
  const args: unknown = exchange?.call.arguments;
  return exchange !== undefined &&
    typeof args === "object" &&
    args !== null &&
    !Array.isArray(args) &&
    sha256Hex(canonicalise(args)) === action.argumentsDigest
    ? (args as CatalogJsonObject)
    : undefined;
}

/** The same Jira review owners serve a Jira-only turn and a turn with other connected sources. */
export function createJiraChatTurnReviewPorts(
  options: JiraChatTurnOptions,
  access: JiraChatTurnReviewAccess,
): JiraChatTurnReviewPorts {
  return {
    preflightWrite: createJiraChatTemplatePreflight({
      deps: options.deps,
      writeArguments: (action) => proposedWriteArguments(access, action),
      readAllowed: access.readAllowed,
      draftRequirements: draftRequirementsCheck(options.openTrace),
      untracedAdvice: draftUntracedAdvice(options.deps, options.openTrace),
    }),
    attachmentPreview: (action) => reviewedAttachment(options, access, action),
    draftItemRefs: (action): readonly string[] | undefined => {
      const args = proposedWriteArguments(access, action);
      if (args === undefined || !access.reviewableWrite(action)) return undefined;
      const draft = chatDraftArguments(options.deps.jiraDraftStore, options.message.chatId, args);
      return draft.ok ? parseJiraDraft(draft.arguments)?.items.map((item) => item.ref) : undefined;
    },
  };
}

/** The file the model proposes to attach, read now for the human's review (#4176). */
async function reviewedAttachment(
  options: JiraChatTurnOptions,
  access: JiraChatTurnReviewAccess,
  action: JiraChatCatalogAction,
): Promise<JiraAttachmentPreview | undefined> {
  const { deps, message, correlationId, authority, signal } = options;
  const args = proposedWriteArguments(access, action);
  const parsed =
    args !== undefined && access.reviewableWrite(action)
      ? parseJiraAttachmentArguments(args)
      : undefined;
  if (parsed === undefined || !access.readAllowed(action)) return undefined;
  // The instance's own limit bounds the review exactly as it bounds the send.
  const maxBytes = await jiraChatAttachmentLimit(deps, {
    chatId: message.chatId,
    authorityReference: authority.reference,
    signal,
    correlationId,
    readAllowed: () => access.readAllowed(action),
  });
  if (!access.readAllowed(action)) return undefined;
  const preview = await previewJiraChatAttachment(
    deps,
    message.chatId,
    parsed,
    correlationId,
    maxBytes,
  );
  return access.readAllowed(action) ? preview : undefined;
}

function jiraTurnContext(options: JiraChatTurnOptions): JiraChatCatalogContext {
  const { authority, correlationId, message, signal } = options;
  return {
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
}

export class JiraChatToolTurn extends ChatToolTurn<JiraChatCatalogContext> {
  public constructor(private readonly jiraOptions: JiraChatTurnOptions) {
    const { authority, deps, managed, correlationId, message } = jiraOptions;
    const context = jiraTurnContext(jiraOptions);
    const bind =
      (
        selected: ManagedProviderCatalog<JiraChatCatalogConsumer>,
      ): ChatToolTurnOptions<JiraChatCatalogContext>["bind"] =>
      (current, budgetPort, invocationRegistry) =>
        bindChatToolCatalog<JiraChatCatalogConsumer>({
          deps,
          managed: selected,
          context: current,
          budgetPort,
          invocationRegistry,
          consumerPort: jiraChatCatalogConsumerPort,
          admission: createJiraChatCatalogAdmission({
            deps,
            context: () => current,
            now: Date.now,
            ...this.consentPorts(),
            ...createJiraChatTurnReviewPorts(jiraOptions, {
              writeExchange: (actionId) => this.writeExchange(actionId),
              reviewableWrite: (action) => this.reviewableWrite(action),
              readAllowed: () => !current.signal.aborted,
            }),
          }),
        });
    super({
      deps,
      message,
      managed,
      context,
      correlationId,
      budget: authority.envelope.budget,
      guidance: JIRA_TOOL_GUIDANCE,
      bind: bind(managed),
      selectTools: async (identities) => {
        requireDispatch(deps.jiraChatCatalog !== undefined, "failed", "handler-unavailable");
        const selected = await deps.jiraChatCatalog.select(identities);
        return { managed: selected, bind: bind(selected), close: selected.close };
      },
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

function currentMutationContract(
  operation: string,
  result: ToolResultEnvelope,
): ReturnType<typeof jiraOperationForTool> {
  const contract = jiraOperationForTool(operation);
  const data = result.data;
  const binding =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as CatalogJsonObject).operationBinding
      : undefined;
  if (
    contract === undefined ||
    result.toolRef?.contractVersion !== contract.declaration.descriptor.toolRef.contractVersion ||
    (result.data !== null && !isCurrentJiraOperationBinding(operation, binding))
  )
    return undefined;
  return contract;
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
  const contract = currentMutationContract(operation, result);
  if (contract === undefined) return undefined;
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
      operationBinding: contract.binding,
    },
    correlationId,
  );
  if (operation === "jira.draft") {
    // A draft is never dispatched itself; its items' journal records are its outcome (#4178).
    const draft = chatDraftArguments(deps.jiraDraftStore, message.chatId, call.arguments);
    const observed = draft.ok
      ? observedJiraDraftOutcome(deps.store.chatToolMutations, expected, draft.arguments)
      : undefined;
    return observed ?? (result.effectStarted ? undefined : "not-dispatched");
  }
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
  openTrace?: JiraChatTurnOptions["openTrace"],
): Promise<JiraChatToolTurn | undefined> {
  if (deps.store.findChatById(message.chatId)?.jiraPodBinding === undefined) return undefined;
  const catalog = deps.jiraChatCatalog;
  requireDispatch(catalog !== undefined, "denied", "authority-invalid");
  const managed = await catalog.get();
  const correlation = correlationIdOrUnknown(correlationId);
  const bound = mintAndBoundChatTurn<JiraChatTurnOptions["authority"]>(
    deps,
    modelId,
    message,
    correlation,
    (turn) => mintAcceptedJiraChatAuthority(deps, turn),
    [signal],
  );
  return new JiraChatToolTurn({
    deps,
    message,
    ...bound,
    managed,
    correlationId: correlation,
    openTrace,
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
