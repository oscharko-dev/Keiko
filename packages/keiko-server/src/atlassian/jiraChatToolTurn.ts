import { createJiraChatHumanInput } from "./jiraChatHumanInput.js";
import { createJiraPrivateLifetime } from "./httpPrivateIdentity.js";
import { chatKnowledgeScopes } from "../requirement-inventory.js";
import { admitChatToolModelCall } from "../chat-tool-approvals.js";
import { jiraTurnGuidance } from "./jiraOpenDraft.js";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ChatMessage } from "../store/index.js";
import {
  JIRA_MUTATION_OPERATIONS,
  isJiraAvatarUploadOperation,
  type JiraAttachmentPreview,
  type JiraMutationOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  connectionFingerprint,
  isJiraDraftItem,
  parseJiraAttachmentArguments,
  parseJiraDraft,
  type StagedJiraDraft,
  type StagedJiraDraftItem,
} from "@oscharko-dev/keiko-connectors";
import { JIRA_DRAFT_PAGE_ITEMS_MAX } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { chatDraftArguments } from "./jiraChatDraftArguments.js";
import type { HeldJiraDraft } from "./jiraApprovalExpiry.js";
import { recordJiraDraftActivity } from "./jiraDraftActivity.js";
import {
  jiraChatAttachmentLimit,
  previewJiraChatAttachment,
  previewJiraEmailTemplatePack,
  previewJiraAvatarImage,
  type JiraChatAttachmentDeps,
} from "./jiraChatAttachment.js";
import type { UiHandlerDeps } from "../deps.js";
import { correlationIdOrUnknown } from "../correlation.js";
import { requireDispatch } from "../tool-catalog/catalogToolErrors.js";
import {
  mintAcceptedJiraChatAuthority,
  reserveCurrentJiraChatAuthority,
  resolveCurrentJiraChatAuthority,
  type JiraChatAuthorityDeps,
} from "./jiraChatAuthority.js";
import {
  createJiraChatCatalogAdmission,
  createJiraChatCatalogConsumerPort,
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
import { jiraMutationToolId } from "./jiraMutationToolId.js";
import type { TraceSession } from "../requirement-trace.js";
import {
  createJiraChatSourcePreparation,
  type JiraChatSourcePreparation,
} from "./jiraChatRequirementBinding.js";
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

/** Exported for its focused regression test: the first advice is new, an identical one repeats. */
export function draftUntracedAdvice(
  deps: JiraChatTurnOptions["deps"],
  openTrace: JiraChatTurnOptions["openTrace"],
): JiraChatTemplatePreflightPorts["untracedAdvice"] {
  if (openTrace === undefined) return undefined;
  const advised = new Set<string>();
  return (draftArguments, context) => {
    const advise = untracedAdvisory(deps, advised, context);
    let repeated = true;
    const data = jiraDraftUntracedAdvice(
      draftArguments,
      () => openTrace(context),
      (refs) => {
        repeated = !advise(refs);
      },
    );
    return data === undefined ? undefined : { data, repeated };
  };
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
  Pick<
    JiraChatAdmissionOptions,
    "preflightWrite" | "attachmentPreview" | "draftItemRefs" | "holdDraft"
  >
> &
  Pick<JiraChatAdmissionOptions, "sourcePreparation">;
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

const sameItems = (left: unknown, right: unknown): boolean =>
  sha256Hex(canonicalise(left)) === sha256Hex(canonicalise(right));

/**
 * The draft this write sends stays the Chat's open draft while its approval is pending (#4354 AC4):
 * a staged draft already is one, and inline items are kept in the existing draft store, once. If
 * the approval then expires, the model resubmits the draft by reference instead of drafting anew.
 */
function holdOpenDraft(
  options: JiraChatTurnOptions,
  access: JiraChatTurnReviewAccess,
  action: JiraChatCatalogAction,
  context: JiraChatCatalogContext,
): HeldJiraDraft | undefined {
  const store = options.deps.jiraDraftStore;
  const args = proposedWriteArguments(access, action);
  if (action.tool !== "jira.draft" || store === undefined || args === undefined) return undefined;
  const resolved = chatDraftArguments(store, context.chatId, args);
  if (!resolved.ok) return undefined;
  if (resolved.staged)
    return typeof args.draftId === "string"
      ? heldOf(store.peek(args.draftId, context.chatId))
      : undefined;
  return holdInlineItems(options, store, resolved.arguments.items, context);
}

/** Whether these are well-formed draft items by the check the staging tool applies to a page. */
function isStagedItems(items: unknown): items is readonly StagedJiraDraftItem[] {
  return Array.isArray(items) && items.length > 0 && items.every(isJiraDraftItem);
}

function holdInlineItems(
  options: JiraChatTurnOptions,
  store: NonNullable<UiHandlerDeps["jiraDraftStore"]>,
  items: unknown,
  context: JiraChatCatalogContext,
): HeldJiraDraft | undefined {
  if (!isStagedItems(items)) return undefined;
  const open = store.latest(context.chatId);
  if (open !== undefined && sameItems(open.items, items)) return heldOf(open);
  const current = resolveCurrentJiraChatAuthority(
    options.deps,
    context.chatId,
    context.authorityReference,
    new Date().toISOString(),
    context.correlationId,
  );
  if (!current.ok) return undefined;
  const { credential } = current;
  const fingerprint = connectionFingerprint({
    baseUrl: credential.baseUrl,
    identity: `${credential.authRef}:${String(credential.generation)}`,
  });
  let draft: StagedJiraDraft | undefined;
  for (let start = 0; start < items.length; start += JIRA_DRAFT_PAGE_ITEMS_MAX) {
    const page = items.slice(start, start + JIRA_DRAFT_PAGE_ITEMS_MAX);
    const appended = store.append(context.chatId, draft?.id, fingerprint, page);
    if (!appended.ok) return undefined;
    draft = appended.draft;
  }
  if (draft === undefined) return undefined;
  recordJiraDraftActivity(options.deps.activityLog, context.correlationId, {
    phase: "held",
    newDraft: true,
    pageItemCount: 0,
    itemCount: draft.items.length,
    pageCount: draft.pageCount,
    byteCount: draft.bytes,
    unresolvedRefCount: 0,
    violationCount: 0,
    durationMs: 0,
  });
  return heldOf(draft);
}

function heldOf(
  draft:
    | { readonly id: string; readonly digest: string; readonly items: readonly unknown[] }
    | undefined,
): HeldJiraDraft | undefined {
  return draft === undefined
    ? undefined
    : { id: draft.id, digest: draft.digest, itemCount: draft.items.length };
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
    holdDraft: (action, context) => holdOpenDraft(options, access, action, context),
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
  if (action.tool === "jira.upload-email-template-pack")
    return reviewedEmailTemplate(options, access, action, args);
  if (isJiraAvatarUploadOperation(action.tool))
    return reviewedAvatar(options, access, action, args);
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

function emailTemplatePath(args: CatalogJsonObject): string | undefined {
  const source: unknown = args.source;
  if (source === null || typeof source !== "object" || Array.isArray(source)) return undefined;
  if (!("kind" in source) || source.kind !== "connected-file" || !("path" in source))
    return undefined;
  return typeof source.path === "string" ? source.path : undefined;
}
type ConnectedFilePreview = (
  deps: JiraChatTurnOptions["deps"],
  chatId: string,
  path: string,
  correlationId: string,
  signal: AbortSignal | undefined,
) => Promise<JiraAttachmentPreview | undefined>;

async function reviewedConnectedFile(
  preview: ConnectedFilePreview,
  options: JiraChatTurnOptions,
  access: JiraChatTurnReviewAccess,
  action: JiraChatCatalogAction,
  args: CatalogJsonObject | undefined,
): Promise<JiraAttachmentPreview | undefined> {
  if (args === undefined || !access.reviewableWrite(action) || !access.readAllowed(action))
    return undefined;
  const path = emailTemplatePath(args);
  if (path === undefined) return undefined;
  const result = await preview(
    options.deps,
    options.message.chatId,
    path,
    options.correlationId,
    options.signal,
  );
  return access.readAllowed(action) ? result : undefined;
}

const reviewedAvatar = (
  options: JiraChatTurnOptions,
  access: JiraChatTurnReviewAccess,
  action: JiraChatCatalogAction,
  args: CatalogJsonObject | undefined,
): Promise<JiraAttachmentPreview | undefined> =>
  reviewedConnectedFile(previewJiraAvatarImage, options, access, action, args);

const reviewedEmailTemplate = (
  options: JiraChatTurnOptions,
  access: JiraChatTurnReviewAccess,
  action: JiraChatCatalogAction,
  args: CatalogJsonObject | undefined,
): Promise<JiraAttachmentPreview | undefined> =>
  reviewedConnectedFile(previewJiraEmailTemplatePack, options, access, action, args);

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

export function jiraSourcePreparationForTurn(
  options: JiraChatTurnOptions,
  context: JiraChatCatalogContext,
): JiraChatSourcePreparation {
  return createJiraChatSourcePreparation({
    chatId: options.message.chatId,
    correlationId: context.correlationId,
    draftStore: options.deps.jiraDraftStore,
    openTrace: () =>
      options.openTrace?.(context) ?? {
        resolve: () => ({ ok: false, reason: "unavailable", problems: [] }),
        unitCount: () => 0,
        close: () => undefined,
      },
    admitted: () =>
      !context.signal.aborted &&
      resolveCurrentJiraChatAuthority(
        options.deps,
        context.chatId,
        context.authorityReference,
        new Date().toISOString(),
        context.correlationId,
      ).ok,
  });
}

type JiraTurnBind = ChatToolTurnOptions<JiraChatCatalogContext>["bind"];
type JiraConsentPorts = Pick<
  JiraChatAdmissionOptions,
  "requestReadConsent" | "requestWriteConsent" | "reviewableWrite" | "draftItemRefs"
>;

function jiraCatalogBinder(
  options: JiraChatTurnOptions,
  sourcePreparation: JiraChatSourcePreparation,
  consumerPort: ReturnType<typeof createJiraChatCatalogConsumerPort>,
  consent: () => JiraConsentPorts,
  access: Omit<JiraChatTurnReviewAccess, "readAllowed">,
): (selected: ManagedProviderCatalog<JiraChatCatalogConsumer>) => JiraTurnBind {
  return (selected): JiraTurnBind =>
    (current, budgetPort, invocationRegistry) =>
      bindChatToolCatalog<JiraChatCatalogConsumer>({
        deps: options.deps,
        managed: selected,
        context: current,
        budgetPort,
        invocationRegistry,
        consumerPort,
        admission: createJiraChatCatalogAdmission({
          deps: options.deps,
          context: () => current,
          now: Date.now,
          ...consent(),
          sourcePreparation,
          ...createJiraChatTurnReviewPorts(options, {
            ...access,
            readAllowed: () => !current.signal.aborted,
          }),
        }),
      });
}

function jiraInvocationPorts(
  source: JiraChatSourcePreparation,
  humanInput: ReturnType<typeof createJiraChatHumanInput>,
  lifetime: ReturnType<typeof createJiraPrivateLifetime>,
): Pick<
  ChatToolTurnOptions<JiraChatCatalogContext>,
  "prepareInvocation" | "finalizeInvocation" | "finalizeTurn"
> {
  return {
    prepareInvocation: async (
      call,
      actionId,
      ports,
    ): Promise<{ readonly sourceDigest?: string } | undefined> => {
      const prepared = await source.prepareInvocation(call, actionId);
      await humanInput.prepare(call, actionId, ports);
      return prepared;
    },
    finalizeInvocation: (actionId): void => {
      humanInput.finalize(actionId);
    },
    finalizeTurn: async (): Promise<void> => {
      humanInput.finish();
      await lifetime.finish();
    },
  };
}

interface JiraTurnPreparation {
  readonly context: JiraChatCatalogContext;
  readonly humanInput: ReturnType<typeof createJiraChatHumanInput>;
  readonly privateLifetime: ReturnType<typeof createJiraPrivateLifetime>;
  readonly sourcePreparation: JiraChatSourcePreparation;
  readonly consumerPort: ReturnType<typeof createJiraChatCatalogConsumerPort>;
}
/** Internal composition shared with the model-free native qualifier; authority stays turn-owned. */
export function prepareJiraTurn(options: JiraChatTurnOptions): JiraTurnPreparation {
  const base = jiraTurnContext(options);
  const humanInput = createJiraChatHumanInput(options, base);
  const privateLifetime = createJiraPrivateLifetime(base.signal, options.correlationId);
  const context: JiraChatCatalogContext = {
    ...base,
    privateLifetime,
    humanInputFor: (operation, digest) => humanInput.selectionFor(operation, digest),
    activeHumanInput: () => humanInput.currentSelection(),
  };
  const sourcePreparation = jiraSourcePreparationForTurn(options, context);
  const consumerPort = createJiraChatCatalogConsumerPort(
    sourcePreparation.sourceDigestFor,
    (actionId, digest) => humanInput.revisionFor(actionId, digest),
  );
  return { context, humanInput, privateLifetime, sourcePreparation, consumerPort };
}

function jiraSelectionPorts(
  options: JiraChatTurnOptions,
  bind: (selected: ManagedProviderCatalog<JiraChatCatalogConsumer>) => JiraTurnBind,
): Pick<ChatToolTurnOptions<JiraChatCatalogContext>, "guidance" | "selectTools"> {
  const { deps, message, correlationId } = options;
  return {
    guidance: jiraTurnGuidance(
      deps.jiraDraftStore,
      message.chatId,
      deps.activityLog,
      correlationId,
    ),
    selectTools: async (
      identities,
    ): ReturnType<NonNullable<ChatToolTurnOptions<JiraChatCatalogContext>["selectTools"]>> => {
      requireDispatch(deps.jiraChatCatalog !== undefined, "failed", "handler-unavailable");
      const selected = await deps.jiraChatCatalog.select(identities, {
        knowledgeScoped: chatKnowledgeScopes(deps.store.findChatById(message.chatId)).length > 0,
      });
      return { managed: selected, bind: bind(selected), close: selected.close };
    },
  };
}

export class JiraChatToolTurn extends ChatToolTurn<JiraChatCatalogContext> {
  private readonly sourcePreparation: JiraChatSourcePreparation;
  private readonly humanInput: ReturnType<typeof createJiraChatHumanInput>;
  public constructor(private readonly jiraOptions: JiraChatTurnOptions) {
    const { authority, deps, managed, correlationId, message } = jiraOptions;
    const { context, humanInput, privateLifetime, sourcePreparation, consumerPort } =
      prepareJiraTurn(jiraOptions);
    const bind = jiraCatalogBinder(
      jiraOptions,
      sourcePreparation,
      consumerPort,
      () => this.consentPorts(),
      {
        writeExchange: (actionId) => this.writeExchange(actionId),
        reviewableWrite: (action) => this.reviewableWrite(action),
      },
    );
    super({
      deps,
      message,
      managed,
      context,
      correlationId,
      budget: authority.envelope.budget,
      ...jiraSelectionPorts(jiraOptions, bind),
      bind: bind(managed),
      ...jiraInvocationPorts(sourcePreparation, humanInput, privateLifetime),
    });
    this.sourcePreparation = sourcePreparation;
    this.humanInput = humanInput;
  }
  protected override admitAuthorityModelCall(): boolean {
    return admitChatToolModelCall(this.jiraOptions, reserveCurrentJiraChatAuthority);
  }

  protected override observedMutation(
    call: NormalizedResponse["toolCalls"][number],
    identity: string,
    result: ToolResultEnvelope,
  ): JiraMutationOutcome | undefined {
    return observeJiraChatMutation(
      this.jiraOptions,
      call,
      identity,
      result,
      this.sourcePreparation.sourceDigestFor(identity, sha256Hex(canonicalise(call.arguments))),
      this.humanInput.revisionFor(identity, sha256Hex(canonicalise(call.arguments))),
    );
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

function mutationOperationForResult(
  result: ToolResultEnvelope,
): (typeof JIRA_MUTATION_OPERATIONS)[number] | undefined {
  const canonicalId: string | undefined = result.toolRef?.canonicalId;
  return JIRA_MUTATION_OPERATIONS.find((value) => canonicalId === jiraMutationToolId(value));
}

export function observeJiraChatMutation(
  options: JiraChatTurnOptions,
  call: NormalizedResponse["toolCalls"][number],
  identity: string,
  result: ToolResultEnvelope,
  sourceDigest?: string,
  humanInputRevision?: string,
): JiraMutationOutcome | undefined {
  const operation = mutationOperationForResult(result);
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
      ...(sourceDigest === undefined ? {} : { sourceDigest }),
      ...(humanInputRevision === undefined ? {} : { humanInputRevision }),
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
  const managed = await catalog.get({
    knowledgeScoped: chatKnowledgeScopes(deps.store.findChatById(message.chatId)).length > 0,
  });
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
