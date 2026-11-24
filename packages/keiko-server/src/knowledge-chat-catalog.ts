import type { UiHandlerDeps } from "./deps.js";
import { createKnowledgeRequirementsProvider } from "./requirementsTool.js";
import { KNOWLEDGE_CHAT_TOOLS } from "./requirementsToolName.js";
import { jiraChatCatalogRoutes } from "./atlassian/jiraChatCatalogConsumer.js";
import {
  createLocalChatSourceCatalogRuntime,
  installLocalChatSourceCatalogRuntime,
  type LocalChatSourceCatalogRuntime,
} from "./local-chat-source-consumer.js";
import type { CatalogLifecycleLogPort } from "./tool-catalog/catalogToolLifecycle.js";

const PROFILE = { id: "knowledge-chat", version: 1 } as const;
export type KnowledgeChatCatalogRuntime = LocalChatSourceCatalogRuntime;
export function createKnowledgeChatCatalogRuntime(
  deps: UiHandlerDeps,
  log: CatalogLifecycleLogPort,
): KnowledgeChatCatalogRuntime {
  return createLocalChatSourceCatalogRuntime(
    {
      provider: createKnowledgeRequirementsProvider(deps),
      routes: jiraChatCatalogRoutes(KNOWLEDGE_CHAT_TOOLS),
      profile: PROFILE,
    },
    log,
  );
}
export function installKnowledgeChatCatalogRuntime(
  deps: UiHandlerDeps,
  log: CatalogLifecycleLogPort,
): UiHandlerDeps {
  const runtime = createKnowledgeChatCatalogRuntime(deps, log);
  return installLocalChatSourceCatalogRuntime(deps, "knowledgeChatCatalog", runtime);
}
