import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { UiHandlerDeps } from "./deps.js";
import { createConnectedFolderProvider } from "./connectedFolderTool.js";
import { CONNECTED_FOLDER_CHAT_TOOLS } from "./connectedFolderToolName.js";
import {
  jiraChatCatalogRoutes,
  type JiraChatCatalogConsumer,
} from "./atlassian/jiraChatCatalogConsumer.js";
import {
  createLocalChatSourceCatalogRuntime,
  installLocalChatSourceCatalogRuntime,
  type LocalChatSourceCatalogRuntime,
} from "./local-chat-source-consumer.js";
import type { ManagedCatalogRoute } from "./tool-catalog/managedProviderCatalog.js";
import type { CatalogLifecycleLogPort } from "./tool-catalog/catalogToolLifecycle.js";

const PROFILE = { id: "connected-folder-chat", version: 1 } as const;
export type ConnectedFolderChatCatalogRuntime = LocalChatSourceCatalogRuntime;

/**
 * A result that names a continuation, says more matches exist, or says an entry could not be
 * listed carries less than exists.
 */
export function connectedFolderResultNamesMore(data: CatalogJsonObject): boolean {
  const { coverage } = data;
  const cut =
    isJsonObject(coverage) && (coverage.truncated === true || coverage.coverageIncomplete === true);
  return cut || data.nextAfter !== undefined || data.nextStartLine !== undefined;
}
function isJsonObject(value: CatalogJsonValue | undefined): value is CatalogJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The shared local-read routes; a result that names more is recorded as a truncated page. */
function connectedFolderCatalogRoutes(): readonly ManagedCatalogRoute<JiraChatCatalogConsumer>[] {
  return jiraChatCatalogRoutes(CONNECTED_FOLDER_CHAT_TOOLS).map((route) => ({
    ...route,
    resultFor: (data, context): ReturnType<typeof route.resultFor> => {
      const result = route.resultFor(data, context);
      return connectedFolderResultNamesMore(data)
        ? { ...result, page: { truncated: true, reason: "result-cap", cursor: null } }
        : result;
    },
  }));
}

export function createConnectedFolderChatCatalogRuntime(
  deps: Pick<UiHandlerDeps, "diagnostics">,
  log: CatalogLifecycleLogPort,
): ConnectedFolderChatCatalogRuntime {
  return createLocalChatSourceCatalogRuntime(
    {
      provider: createConnectedFolderProvider(deps),
      routes: connectedFolderCatalogRoutes(),
      profile: PROFILE,
    },
    log,
  );
}

export function installConnectedFolderChatCatalogRuntime(
  deps: UiHandlerDeps,
  log: CatalogLifecycleLogPort,
): UiHandlerDeps {
  const runtime = createConnectedFolderChatCatalogRuntime(deps, log);
  return installLocalChatSourceCatalogRuntime(deps, "connectedFolderChatCatalog", runtime);
}
