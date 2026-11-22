import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@oscharko-dev/keiko-contracts";
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
  createManagedProviderCatalog,
  managedCatalogToolDefinitions,
  type ManagedCatalogRoute,
} from "./tool-catalog/managedProviderCatalog.js";
import {
  createManagedChatCatalogRuntime,
  type ManagedChatCatalogRuntime,
} from "./tool-catalog/managedChatCatalogRuntime.js";
import type { CatalogLifecycleLogPort } from "./tool-catalog/catalogToolLifecycle.js";

const PROFILE = { id: "connected-folder-chat", version: 1 } as const;
export type ConnectedFolderChatCatalogRuntime = ManagedChatCatalogRuntime<JiraChatCatalogConsumer>;

/** A result that names a continuation, or says more matches exist, carries less than exists. */
function namesMore(data: CatalogJsonObject): boolean {
  const { coverage } = data;
  const cut = isJsonObject(coverage) && coverage.truncated === true;
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
      return namesMore(data)
        ? { ...result, page: { truncated: true, reason: "result-cap", cursor: null } }
        : result;
    },
  }));
}

export function createConnectedFolderChatCatalogRuntime(
  deps: Pick<UiHandlerDeps, "diagnostics">,
  log: CatalogLifecycleLogPort,
): ConnectedFolderChatCatalogRuntime {
  const provider = createConnectedFolderProvider(deps);
  const routes = connectedFolderCatalogRoutes();
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

export function installConnectedFolderChatCatalogRuntime(
  deps: UiHandlerDeps,
  log: CatalogLifecycleLogPort,
): UiHandlerDeps {
  const runtime = createConnectedFolderChatCatalogRuntime(deps, log);
  const previousDispose = deps.dispose;
  return Object.assign(deps, {
    connectedFolderChatCatalog: runtime,
    dispose: async (): Promise<void> => {
      try {
        await runtime.close();
      } finally {
        await previousDispose?.();
      }
    },
  });
}
