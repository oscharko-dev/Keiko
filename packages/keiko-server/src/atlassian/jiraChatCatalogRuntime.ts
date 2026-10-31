import { randomUUID } from "node:crypto";
import {
  createJiraReportStore,
  type AtlassianHttpBodyPort,
  type JiraManagedConnection,
  type JiraManagedMutationExecutor,
  type JiraReportStore,
  type JiraReportToolDeps,
} from "@oscharko-dev/keiko-connectors";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { UiHandlerDeps } from "../deps.js";
import type { CatalogHandlerContext } from "../tool-catalog/catalogToolPorts.js";
import type { CatalogLifecycleLogPort } from "../tool-catalog/catalogToolLifecycle.js";
import { CatalogDispatchFault, requireDispatch } from "../tool-catalog/catalogToolErrors.js";
import {
  createManagedProviderCatalog,
  type ManagedProviderCatalog,
} from "../tool-catalog/managedProviderCatalog.js";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";
import { resolveCurrentJiraChatAuthority } from "./jiraChatAuthority.js";
import {
  jiraChatCatalogRoutes,
  JIRA_CHAT_TOOLS,
  type JiraChatCatalogConsumer,
} from "./jiraChatCatalogConsumer.js";
import { executeJiraChatMutation } from "./jiraChatMutation.js";
import { executeJiraChatDraft } from "./jiraChatDraft.js";
import type { AtlassianHttpLifecycleOptions } from "./httpRequestLifecycle.js";
import { createJiraChatMutationIntent } from "./jiraChatMutationIntent.js";
import { jiraIssueTemplateSource } from "./jiraTemplateLog.js";
import { recordJiraReportActivity } from "./jiraReportActivity.js";

type ChatCatalog = ManagedProviderCatalog<JiraChatCatalogConsumer>;
type CatalogInitialization =
  | { readonly ok: true; readonly value: ChatCatalog }
  | { readonly ok: false; readonly error: unknown };
type MutationExecutor = JiraManagedMutationExecutor<CatalogHandlerContext<JiraChatCatalogConsumer>>;
type ApprovalRegistry = NonNullable<UiHandlerDeps["atlassianActionApprovalRegistry"]>;
export interface JiraChatCatalogRuntime {
  readonly get: () => Promise<ChatCatalog>;
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

function mutationExecutor(deps: UiHandlerDeps): MutationExecutor {
  return (operation, args, context, execute) => {
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
    if (operation !== "jira.draft") return executeJiraChatMutation({ ...shared, execute });
    return executeJiraChatDraft({
      ...shared,
      arguments: args,
      deselected: approvedDeselection(deps, current.envelope.subject, context, intent),
      context,
      connection: jiraChatDraftConnection(deps, current.credential),
    });
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
function approvedDeselection(
  deps: UiHandlerDeps,
  subject: Parameters<ApprovalRegistry["findChatWriteApproval"]>[0],
  context: CatalogHandlerContext<JiraChatCatalogConsumer>,
  intent: { readonly invocationId: string; readonly actionDigest: string },
): readonly string[] {
  const approval = deps.atlassianActionApprovalRegistry?.findChatWriteApproval(
    subject,
    context.authorityReference,
    intent.invocationId,
    context.correlationId,
  )?.approval;
  return approval?.kind === "jira-chat-write" && approval.actionDigest === intent.actionDigest
    ? (approval.excludedItemRefs ?? [])
    : [];
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
    activity: (activity, context): void => {
      recordJiraReportActivity(deps.activityLog, context.correlationId, activity);
    },
  };
}

function initializeCatalog(
  deps: UiHandlerDeps,
  log: CatalogLifecycleLogPort,
  store: JiraReportStore,
): Promise<ChatCatalog> {
  return createManagedProviderCatalog<JiraChatCatalogConsumer>({
    providers: [
      createJiraProviderForCatalog(
        (context) => connection(deps, context),
        JIRA_CHAT_TOOLS,
        mutationExecutor(deps),
        reportTool(deps, store),
      ),
    ],
    routes: jiraChatCatalogRoutes(),
    profile: { id: "jira-chat", version: 1 },
    log,
    correlationId: randomUUID(),
    now: Date.now,
  });
}

/** One lazy SDK host per application graph; neither Pods nor turns own protocol transports. */
export function createJiraChatCatalogRuntime(
  deps: UiHandlerDeps,
  log: CatalogLifecycleLogPort,
  store: JiraReportStore = createJiraReportStore(),
): JiraChatCatalogRuntime {
  let catalog: Promise<CatalogInitialization> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  const requireOpen = (): void => {
    if (closed) throw new CatalogDispatchFault("failed", "handler-unavailable");
  };
  const initialize = (): Promise<CatalogInitialization> => {
    const pending: Promise<CatalogInitialization> = initializeCatalog(deps, log, store).then(
      (value) => ({ ok: true, value }),
      (error: unknown) => {
        // The managed initializer logs and disposes this failed host. Preserve the error for
        // its waiting callers, but never let that attempt poison a later initialization.
        if (catalog === pending) catalog = undefined;
        return { ok: false, error };
      },
    );
    return pending;
  };
  return {
    get: async (): Promise<ChatCatalog> => {
      requireOpen();
      catalog ??= initialize();
      const admitted = await catalog;
      if (!admitted.ok) throw admitted.error;
      requireOpen();
      return admitted.value;
    },
    close: (): Promise<void> => {
      closed = true;
      closing ??=
        catalog === undefined
          ? Promise.resolve()
          : catalog.then((admitted) => (admitted.ok ? admitted.value.close() : undefined));
      return closing;
    },
  };
}

export function installJiraChatCatalogRuntime(
  deps: UiHandlerDeps,
  log: CatalogLifecycleLogPort,
): UiHandlerDeps {
  const store = createJiraReportStore();
  const runtime = createJiraChatCatalogRuntime(deps, log, store);
  const previousDispose = deps.dispose;
  return Object.assign(deps, {
    jiraChatCatalog: runtime,
    jiraReportStore: store,
    dispose: async (): Promise<void> => {
      try {
        await runtime.close();
      } finally {
        await previousDispose?.();
      }
    },
  });
}
