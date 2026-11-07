import { createManagedChatCatalogRuntime } from "../tool-catalog/managedChatCatalogRuntime.js";
import { randomUUID } from "node:crypto";
import {
  createJiraDraftStore,
  createJiraReportStore,
  parseRequirementIds,
  type AtlassianHttpBodyPort,
  type JiraDraftStore,
  type JiraDraftToolDeps,
  type JiraManagedConnection,
  type JiraManagedMutationExecutor,
  type JiraReportStore,
  type JiraReportToolDeps,
  type JiraTraceOutcome,
  type JiraTraceRequest,
  type StagedJiraDraftItem,
} from "@oscharko-dev/keiko-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpProvider,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { ToolDefinition } from "@oscharko-dev/keiko-contracts";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { UiHandlerDeps } from "../deps.js";
import type { CatalogHandlerContext } from "../tool-catalog/catalogToolPorts.js";
import type { CatalogLifecycleLogPort } from "../tool-catalog/catalogToolLifecycle.js";
import { requireDispatch } from "../tool-catalog/catalogToolErrors.js";
import {
  createManagedProviderCatalog,
  managedCatalogToolDefinitions,
  type ManagedProviderCatalog,
} from "../tool-catalog/managedProviderCatalog.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";
import { JIRA_MANAGED_ACTION_TYPES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { decideAtlassianEnvelopeAction } from "./actionPolicy.js";
import { resolveCurrentJiraChatAuthority } from "./jiraChatAuthority.js";
import {
  jiraChatCatalogRoutes,
  JIRA_CHAT_TOOLS,
  type JiraChatCatalogConsumer,
} from "./jiraChatCatalogConsumer.js";
import { executeJiraChatMutation } from "./jiraChatMutation.js";
import { executeJiraChatDraft, jiraDraftRequirementRefusal } from "./jiraChatDraft.js";
import {
  chatReportRequirementIds,
  createKnowledgeRequirementsProvider,
} from "../requirementsTool.js";
import {
  logTrace,
  newTally,
  openTraceSession,
  tallyOutcome,
  tallyRefusal,
  traceOutcomeData,
  traceRefusalData,
  type TraceTurn,
} from "../requirement-trace.js";
import type { AtlassianHttpLifecycleOptions } from "./httpRequestLifecycle.js";
import { recordJiraCitationMarkers, resolveJiraCitationMarkers } from "./jiraCitationMarkers.js";
import { createJiraChatMutationIntent } from "./jiraChatMutationIntent.js";
import { jiraIssueTemplateSource, recordJiraTemplateMetadata } from "./jiraTemplateLog.js";
import { recordJiraReportActivity } from "./jiraReportActivity.js";
import { recordJiraDraftActivity } from "./jiraDraftActivity.js";
import { createJiraDraftBatchExecutor } from "./jiraDraftBatchTool.js";
import { draftRefusalData, readableChatDraft } from "./jiraChatDraftArguments.js";
import {
  attachmentReviewFor,
  jiraChatAttachmentSource,
  type JiraChatAttachmentReview,
} from "./jiraChatAttachment.js";

type ChatCatalog = ManagedProviderCatalog<JiraChatCatalogConsumer>;
type MutationExecutor = JiraManagedMutationExecutor<CatalogHandlerContext<JiraChatCatalogConsumer>>;
type ApprovalRegistry = NonNullable<UiHandlerDeps["atlassianActionApprovalRegistry"]>;
const JIRA_CHAT_PROFILE = { id: "jira-chat", version: 1 } as const;
/**
 * What a turn can use. The Jira batch drafts from the Chat's Knowledge requirements, so a Chat
 * without Knowledge scopes does not offer it: its schema is not spent on turns that cannot call it.
 */
export interface JiraChatToolScope {
  readonly knowledgeScoped: boolean;
}
const JIRA_DRAFT_BATCH_TOOL = "jira.draft-batch";
const JIRA_DRAFT_BATCH_ALIAS = JIRA_DRAFT_BATCH_TOOL.replace(/[.-]/gu, "_");

export interface JiraChatCatalogRuntime {
  readonly get: (scope?: JiraChatToolScope) => Promise<ChatCatalog>;
  /**
   * The tool definitions a Chat advertises with a bound Jira Pod. Static, so it is derived once
   * from the providers the catalog hosts without admitting a host or touching a connection.
   */
  readonly toolDefinitions: (scope?: JiraChatToolScope) => readonly ToolDefinition[];
  readonly close: () => Promise<void>;
}

function turnMessage(
  deps: UiHandlerDeps,
  context: CatalogHandlerContext<JiraChatCatalogConsumer>,
): ReturnType<UiHandlerDeps["store"]["findMessageById"]> {
  return context.userMessageId === undefined
    ? undefined
    : deps.store.findMessageById(context.userMessageId);
}

type CurrentAuthority = Extract<ReturnType<typeof resolveCurrentJiraChatAuthority>, { ok: true }>;
type MutationIntent = ReturnType<typeof createJiraChatMutationIntent>;
type SharedMutation = Omit<Parameters<typeof executeJiraChatMutation>[0], "execute">;

interface PreparedMutation {
  readonly current: CurrentAuthority;
  readonly intent: MutationIntent;
  readonly shared: SharedMutation;
}

/** Authority, the bound write action and the journaled intent; every refusal precedes any effect. */
function prepareMutation(
  deps: UiHandlerDeps,
  operation: string,
  args: CatalogJsonObject,
  context: CatalogHandlerContext<JiraChatCatalogConsumer>,
): PreparedMutation {
  const current = resolveCurrentJiraChatAuthority(
    deps,
    context.chatId,
    context.authorityReference,
    new Date().toISOString(),
    context.correlationId,
  );
  const credentials = deps.atlassianConnectorCredentials;
  const write = context.mutationGuard.write;
  const message = turnMessage(deps, context);
  requireDispatch(
    current.ok && credentials !== undefined && write !== undefined && message !== undefined,
    "denied",
    "authority-invalid",
  );
  requireDispatch(
    write.action.tool === operation &&
      write.action.argumentsDigest === sha256Hex(canonicalise(args)),
    "invalid",
    "invalid-arguments",
  );
  const intent = createJiraChatMutationIntent(
    message,
    current.envelope.subject,
    context.authorityReference,
    write.action,
    context.correlationId,
  );
  const shared = {
    journal: deps.store.chatToolMutations,
    intent,
    httpPortFactory: (lifecycle: AtlassianHttpLifecycleOptions): AtlassianHttpBodyPort =>
      credentials.httpBodyPortFactory(current.credential, context.correlationId, lifecycle),
    beforeEffect: context.beforeEffect,
    beforeMutation: write.beforeMutation,
  };
  return { current, intent, shared };
}

/**
 * The drafts already advised about in a turn, oldest first; bounded like a cache. A draft is its
 * items: correcting them and sending them again is that same choice, a draft of other items is not.
 */
const ADVISED_DRAFTS_MAX = 256;
export function untracedAdvisory(
  deps: Pick<UiHandlerDeps, "activityLog">,
  advised: Set<string>,
  context: {
    readonly chatId: string;
    readonly userMessageId?: string | undefined;
    readonly correlationId: string;
  },
): (refs: readonly string[]) => boolean {
  return (refs): boolean => {
    const turn = `${context.chatId}\u0000${context.userMessageId ?? context.correlationId}`;
    const key = `${turn}\u0000${JSON.stringify([...refs].sort((a, b) => a.localeCompare(b)))}`;
    if (advised.has(key)) return false;
    advised.add(key);
    if (advised.size > ADVISED_DRAFTS_MAX) advised.delete(advised.values().next().value ?? key);
    recordJiraDraftActivity(deps.activityLog, context.correlationId, {
      phase: "refused",
      refusal: "requirements-untraced",
      newDraft: false,
      pageItemCount: 0,
      itemCount: refs.length,
      pageCount: 0,
      byteCount: 0,
      unresolvedRefCount: 0,
      violationCount: 0,
      durationMs: 0,
    });
    return true;
  };
}

function mutationExecutor(deps: UiHandlerDeps): MutationExecutor {
  const advised = new Set<string>();
  return (operation, args, context, execute) => {
    const { current, intent, shared } = prepareMutation(deps, operation, args, context);
    const turn = {
      chatId: context.chatId,
      userMessageId: context.userMessageId,
      correlationId: context.correlationId,
    };
    if (operation === "jira.draft") {
      // The draft runs on exactly the item list the approval covered: a draft that changed or
      // vanished since is refused here, before any item is journaled.
      const draft = readableChatDraft(deps.jiraDraftStore, context.chatId, args);
      if (!draft.ok) return Promise.resolve({ data: draftRefusalData(draft), isError: true });
      const approval = draftApproval(deps, current.envelope.subject, context, intent);
      return executeJiraChatDraft({
        ...shared,
        arguments: draft.arguments,
        deselected: approval?.excludedItemRefs ?? [],
        context,
        retainProgress: (snapshot): void => {
          context.retainDraftProgress?.(intent.invocationId, context.invocationId, snapshot);
        },
        connection: jiraChatDraftConnection(deps, current.credential),
        openTrace: () => openTraceSession(deps, turn),
        // A draft a human reviewed runs as approved; the advisory guides an unreviewed one only.
        ...(approval === undefined
          ? {
              adviseUntraced: untracedAdvisory(deps, advised, context),
            }
          : {}),
        activity: (activity): void => {
          recordJiraDraftActivity(deps.activityLog, context.correlationId, activity);
        },
      });
    }
    return executeTracedMutation(deps, turn, operation, args, (trace) =>
      executeJiraChatMutation({
        ...shared,
        execute: (http) => execute(http, trace),
      }),
    );
  };
}

/** The explicit requirement references of a create or edit, validated before anything is sent. */
export async function executeTracedMutation(
  deps: UiHandlerDeps,
  turn: TraceTurn,
  operation: string,
  args: CatalogJsonObject,
  run: (trace: JiraTraceRequest | undefined) => Promise<ManagedMcpToolResult>,
): Promise<ManagedMcpToolResult> {
  const references = parseRequirementIds(args.requirementIds);
  if (references === undefined) return malformedReferences();
  if (references === null || (operation !== "jira.create" && operation !== "jira.edit"))
    return run(undefined);
  const session = openTraceSession(deps, turn);
  const tally = newTally();
  const logged = operation === "jira.create" ? "create" : "edit";
  try {
    const resolution = session.resolve(references);
    if (!resolution.ok) {
      tallyRefusal(tally, resolution);
      logTrace(turn.correlationId, logged, tally);
      return { data: { outcome: "rejected", ...traceRefusalData(resolution) }, isError: true };
    }
    let traced: JiraTraceOutcome | undefined;
    const result = await run({
      ...resolution.trace,
      report: (outcome) => {
        traced = outcome;
      },
    });
    tallyOutcome(tally, traced);
    logTrace(turn.correlationId, logged, tally);
    const data = traceOutcomeData(traced);
    return data === undefined ? result : { ...result, data: { ...result.data, trace: data } };
  } finally {
    session.close();
  }
}

function malformedReferences(): ManagedMcpToolResult {
  return {
    data: { outcome: "rejected", reason: "field-validation", requirementRefusal: "references" },
    isError: true,
  };
}

/**
 * Only the routing a draft needs; credentials stay with the custody-owned HTTP port. The template
 * source is part of it: a draft item is a journaled create and passes the same write gate as
 * `jira.create`, so a connection without the source would let a violating item through.
 */
export function jiraChatDraftConnection(
  deps: Pick<UiHandlerDeps, "store">,
  credential: Pick<JiraManagedConnection, "baseUrl" | "deployment">,
): Omit<JiraManagedConnection, "http"> {
  return {
    baseUrl: credential.baseUrl,
    deployment: credential.deployment,
    issueTemplates: jiraIssueTemplateSource(deps.store),
  };
}

/** The items the human left out when approving this draft; none without an approval. */
/** The human's approval of exactly this draft action, or undefined when none reviewed it. */
function draftApproval(
  deps: UiHandlerDeps,
  subject: Parameters<ApprovalRegistry["findChatWriteApproval"]>[0],
  context: CatalogHandlerContext<JiraChatCatalogConsumer>,
  intent: { readonly invocationId: string; readonly actionDigest: string },
): { readonly excludedItemRefs?: readonly string[] | undefined } | undefined {
  const approval = deps.atlassianActionApprovalRegistry?.findChatWriteApproval(
    subject,
    context.authorityReference,
    intent.invocationId,
    context.correlationId,
  )?.approval;
  return approval?.kind === "jira-chat-write" && approval.actionDigest === intent.actionDigest
    ? approval
    : undefined;
}

/**
 * Whether this attachment needed a human review under the current policy and, if it did, the file
 * the approval covers. Where review is required and no approval is found (an expired record), the
 * answer is "required, nothing reviewed", which the source refuses.
 */
function attachmentReview(
  deps: UiHandlerDeps,
  envelope: Extract<ReturnType<typeof resolveCurrentJiraChatAuthority>, { ok: true }>["envelope"],
  context: CatalogHandlerContext<JiraChatCatalogConsumer>,
): JiraChatAttachmentReview {
  const policy = decideAtlassianEnvelopeAction(JIRA_MANAGED_ACTION_TYPES["jira.attach"], envelope);
  const actionId = context.mutationGuard.write?.action.actionId;
  const approval =
    actionId === undefined
      ? undefined
      : deps.atlassianActionApprovalRegistry?.findChatWriteApproval(
          envelope.subject,
          context.authorityReference,
          actionId,
          context.correlationId,
        )?.approval;
  return attachmentReviewFor(policy.kind, approval);
}

function connection(
  deps: UiHandlerDeps,
  context: CatalogHandlerContext<JiraChatCatalogConsumer>,
): JiraManagedConnection {
  const current = resolveCurrentJiraChatAuthority(
    deps,
    context.chatId,
    context.authorityReference,
    new Date().toISOString(),
    context.correlationId,
  );
  const credentials = deps.atlassianConnectorCredentials;
  requireDispatch(current.ok && credentials !== undefined, "denied", "authority-invalid");
  return {
    baseUrl: current.credential.baseUrl,
    deployment: current.credential.deployment,
    identity: `${current.credential.authRef}:${String(current.credential.generation)}`,
    http: credentials.httpBodyPortFactory(current.credential, context.correlationId, {
      beforeDispatch: () => context.beforeEffect(),
    }),
    issueTemplates: jiraIssueTemplateSource(deps.store),
    attachmentSource: jiraChatAttachmentSource(deps, {
      chatId: context.chatId,
      correlationId: context.correlationId,
      review: () => attachmentReview(deps, current.envelope, context),
    }),
    templateMetadataActivity: (activity): void => {
      recordJiraTemplateMetadata(deps.activityLog, context.correlationId, activity);
    },
  };
}

/** A report belongs to the Chat that started it; the export route checks the same binding. */
function reportTool(
  deps: UiHandlerDeps,
  store: JiraReportStore,
): JiraReportToolDeps<CatalogHandlerContext<JiraChatCatalogConsumer>> {
  return {
    store,
    owner: (context) => context.chatId,
    checker: deps.jiraReportChecker,
    requirements: (context) => chatReportRequirementIds(deps, context),
    activity: (activity, context): void => {
      recordJiraReportActivity(deps.activityLog, context.correlationId, activity);
    },
  };
}

/** A staged draft belongs to the Chat that started it; approval and the run check the same binding. */
export function draftTool(
  deps: UiHandlerDeps,
  store: JiraDraftStore,
): JiraDraftToolDeps<CatalogHandlerContext<JiraChatCatalogConsumer>> {
  return {
    store,
    owner: (context) => context.chatId,
    checkRequirements: (items, context): ReturnType<typeof jiraDraftRequirementRefusal> => {
      context.signal.throwIfAborted();
      requireDispatch(context.beforeEffect(), "denied", "effect-denied");
      const refusal = jiraDraftRequirementRefusal(
        items,
        () =>
          openTraceSession(deps, {
            chatId: context.chatId,
            userMessageId: context.userMessageId,
            correlationId: context.correlationId,
          }),
        context.correlationId,
      );
      if (refusal === undefined) return undefined;
      const data = { ...refusal.data };
      delete data.items;
      return { ...refusal, data };
    },
    projectItems: (items, context): readonly StagedJiraDraftItem[] =>
      projectStagedCitationMarkers(deps, items, context),
    activity: (activity, context): void => {
      recordJiraDraftActivity(deps.activityLog, context.correlationId, activity);
    },
  };
}

/**
 * A staged page names the sources of its `[n]` markers before the draft digest is minted, so the
 * preview, the approval, the replay and Jira all hold the same text (F7). It covers the pages the
 * model stages and the pages a draft batch stages alike.
 */
function projectStagedCitationMarkers(
  deps: UiHandlerDeps,
  items: readonly StagedJiraDraftItem[],
  context: CatalogHandlerContext<JiraChatCatalogConsumer>,
): readonly StagedJiraDraftItem[] {
  const labels = context.citationSources?.();
  if (labels === undefined || labels.size === 0) return items;
  const rewrite = resolveJiraCitationMarkers({ items }, labels);
  recordJiraCitationMarkers(deps.activityLog, context.correlationId, {
    callCount: 1,
    labelCount: labels.size,
    resolvedCount: rewrite.resolvedCount,
    unresolvedCount: rewrite.unresolvedCount,
    markdownDescriptionCount: rewrite.markdownDescriptionCount,
  });
  return rewrite.resolvedCount === 0
    ? items
    : (rewrite.arguments.items as readonly StagedJiraDraftItem[]);
}

function chatCatalogProviders(
  deps: UiHandlerDeps,
  store: JiraReportStore,
  draftStore: JiraDraftStore,
): readonly ManagedMcpProvider<CatalogHandlerContext<JiraChatCatalogConsumer>>[] {
  const draft = draftTool(deps, draftStore);
  return [
    createJiraProviderForCatalog(
      (context) => connection(deps, context),
      JIRA_CHAT_TOOLS,
      mutationExecutor(deps),
      reportTool(deps, store),
      draft,
      createJiraDraftBatchExecutor(deps, draft),
    ),
    createKnowledgeRequirementsProvider(deps, store),
  ];
}

function initializeCatalog(
  deps: UiHandlerDeps,
  log: CatalogLifecycleLogPort,
  store: JiraReportStore,
  draftStore: JiraDraftStore,
): Promise<ChatCatalog> {
  return createManagedProviderCatalog<JiraChatCatalogConsumer>({
    providers: chatCatalogProviders(deps, store, draftStore),
    routes: jiraChatCatalogRoutes(),
    profile: JIRA_CHAT_PROFILE,
    log,
    correlationId: randomUUID(),
    now: Date.now,
  });
}

// Static: the providers declare the same tools whatever the connection, so one derivation serves.
function staticToolDefinitions(
  deps: UiHandlerDeps,
  store: JiraReportStore,
  draftStore: JiraDraftStore,
): () => readonly ToolDefinition[] {
  let definitions: readonly ToolDefinition[] | undefined;
  return () => {
    definitions ??= managedCatalogToolDefinitions(
      jiraChatCatalogRoutes(),
      chatCatalogProviders(deps, store, draftStore).flatMap((provider) => provider.tools()),
      JIRA_CHAT_PROFILE,
      Date.now(),
    );
    return definitions;
  };
}

/** One lazy SDK host per application graph; neither Pods nor turns own protocol transports. */
export function createJiraChatCatalogRuntime(
  deps: UiHandlerDeps,
  log: CatalogLifecycleLogPort,
  store: JiraReportStore = createJiraReportStore(),
  draftStore: JiraDraftStore = createJiraDraftStore(),
): JiraChatCatalogRuntime {
  const base = createManagedChatCatalogRuntime(staticToolDefinitions(deps, store, draftStore), () =>
    initializeCatalog(deps, log, store, draftStore),
  );
  let withoutBatch: { readonly of: ChatCatalog; readonly value: ChatCatalog } | undefined;
  const offered = (scope: JiraChatToolScope | undefined): boolean => scope?.knowledgeScoped ?? true;
  return {
    ...base,
    toolDefinitions: (scope): readonly ToolDefinition[] =>
      offered(scope)
        ? base.toolDefinitions()
        : base.toolDefinitions().filter((tool) => tool.name !== JIRA_DRAFT_BATCH_ALIAS),
    get: async (scope): Promise<ChatCatalog> => {
      const full = await base.get();
      if (offered(scope) || full.omitting === undefined) return full;
      if (withoutBatch?.of !== full)
        withoutBatch = { of: full, value: full.omitting([JIRA_DRAFT_BATCH_TOOL]) };
      return withoutBatch.value;
    },
  };
}

export function installJiraChatCatalogRuntime(
  deps: UiHandlerDeps,
  log: CatalogLifecycleLogPort,
): UiHandlerDeps {
  const store = createJiraReportStore();
  const draftStore = createJiraDraftStore();
  const runtime = createJiraChatCatalogRuntime(deps, log, store, draftStore);
  const previousDispose = deps.dispose;
  return Object.assign(deps, {
    jiraChatCatalog: runtime,
    jiraReportStore: store,
    jiraDraftStore: draftStore,
    dispose: async (): Promise<void> => {
      try {
        await runtime.close();
      } finally {
        await previousDispose?.();
      }
    },
  });
}
