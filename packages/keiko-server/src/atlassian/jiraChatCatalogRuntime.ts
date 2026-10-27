import { randomUUID } from "node:crypto";
import type {
  JiraManagedConnection,
  JiraManagedMutationExecutor,
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
import { createJiraChatMutationIntent } from "./jiraChatMutationIntent.js";

type ChatCatalog = ManagedProviderCatalog<JiraChatCatalogConsumer>;
type MutationExecutor = JiraManagedMutationExecutor<CatalogHandlerContext<JiraChatCatalogConsumer>>;
export interface JiraChatCatalogRuntime {
  readonly get: () => Promise<ChatCatalog>;
  readonly close: () => Promise<void>;
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
    const message =
      context.userMessageId === undefined
        ? undefined
        : deps.store.findMessageById(context.userMessageId);
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
    return executeJiraChatMutation({
      journal: deps.store.chatToolMutations,
      intent: createJiraChatMutationIntent(
        message,
        current.envelope.subject,
        context.authorityReference,
        write.action,
        context.correlationId,
      ),
      httpPortFactory: (lifecycle) =>
        credentials.httpBodyPortFactory(current.credential, context.correlationId, lifecycle),
      beforeEffect: context.beforeEffect,
      beforeMutation: write.beforeMutation,
      execute,
    });
  };
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
    http: credentials.httpBodyPortFactory(current.credential, context.correlationId, {
      beforeDispatch: () => context.beforeEffect(),
    }),
  };
}

/** One lazy SDK host per application graph; neither Pods nor turns own protocol transports. */
export function createJiraChatCatalogRuntime(
  deps: UiHandlerDeps,
  log: CatalogLifecycleLogPort,
): JiraChatCatalogRuntime {
  let catalog: Promise<ChatCatalog> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  const requireOpen = (): void => {
    if (closed) throw new CatalogDispatchFault("failed", "handler-unavailable");
  };
  return {
    get: async (): Promise<ChatCatalog> => {
      requireOpen();
      catalog ??= createManagedProviderCatalog<JiraChatCatalogConsumer>({
        providers: [
          createJiraProviderForCatalog(
            (context) => connection(deps, context),
            JIRA_CHAT_TOOLS,
            mutationExecutor(deps),
          ),
        ],
        routes: jiraChatCatalogRoutes(),
        profile: { id: "jira-chat", version: 1 },
        log,
        correlationId: randomUUID(),
        now: Date.now,
      });
      const admitted = await catalog;
      requireOpen();
      return admitted;
    },
    close: (): Promise<void> => {
      closed = true;
      closing ??=
        catalog === undefined ? Promise.resolve() : catalog.then((value) => value.close());
      return closing;
    },
  };
}

export function installJiraChatCatalogRuntime(
  deps: UiHandlerDeps,
  log: CatalogLifecycleLogPort,
): UiHandlerDeps {
  const runtime = createJiraChatCatalogRuntime(deps, log);
  return {
    ...deps,
    jiraChatCatalog: runtime,
    dispose: async (): Promise<void> => {
      try {
        await runtime.close();
      } finally {
        await deps.dispose?.();
      }
    },
  };
}
