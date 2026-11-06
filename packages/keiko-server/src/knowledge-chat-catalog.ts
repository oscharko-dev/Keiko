import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import { createKnowledgeRequirementsProvider } from "./requirementsTool.js";
import { KNOWLEDGE_CHAT_TOOLS } from "./requirementsToolName.js";
import {
  jiraChatCatalogRoutes,
  type JiraChatCatalogConsumer,
} from "./atlassian/jiraChatCatalogConsumer.js";
import {
  createManagedProviderCatalog,
  managedCatalogToolDefinitions,
} from "./tool-catalog/managedProviderCatalog.js";
import {
  createManagedChatCatalogRuntime,
  type ManagedChatCatalogRuntime,
} from "./tool-catalog/managedChatCatalogRuntime.js";
import type { CatalogLifecycleLogPort } from "./tool-catalog/catalogToolLifecycle.js";

const PROFILE = { id: "knowledge-chat", version: 1 } as const;
export type KnowledgeChatCatalogRuntime = ManagedChatCatalogRuntime<JiraChatCatalogConsumer>;
export function createKnowledgeChatCatalogRuntime(
  deps: UiHandlerDeps,
  log: CatalogLifecycleLogPort,
): KnowledgeChatCatalogRuntime {
  const provider = createKnowledgeRequirementsProvider(deps);
  const routes = jiraChatCatalogRoutes(KNOWLEDGE_CHAT_TOOLS);
  let definitions: readonly ToolDefinition[] | undefined;
  return createManagedChatCatalogRuntime(
    () =>
      (definitions ??= managedCatalogToolDefinitions(
        routes,
        provider.tools(),
        PROFILE,
        Date.now(),
      )),
    () =>
      createManagedProviderCatalog<JiraChatCatalogConsumer>({
        providers: [provider],
        routes,
        profile: PROFILE,
        log,
        correlationId: randomUUID(),
        now: Date.now,
      }),
  );
}
export function installKnowledgeChatCatalogRuntime(
  deps: UiHandlerDeps,
  log: CatalogLifecycleLogPort,
): UiHandlerDeps {
  const runtime = createKnowledgeChatCatalogRuntime(deps, log);
  const previousDispose = deps.dispose;
  return Object.assign(deps, {
    knowledgeChatCatalog: runtime,
    dispose: async (): Promise<void> => {
      try {
        await runtime.close();
      } finally {
        await previousDispose?.();
      }
    },
  });
}
