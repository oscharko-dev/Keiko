import { randomUUID } from "node:crypto";
import { chatCapabilityMatches } from "./chat-tool-authority.js";
import type {
  CodingWorkbenchRuntimeDelegationUsage,
  EditorAgentGovernedAuthorityReference,
  ToolDefinition,
} from "@oscharko-dev/keiko-contracts";
import type { CatalogVersionRef } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpProvider } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { ToolAuthorityAvailability } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import type {
  CatalogConsumerPort,
  CatalogHandlerContext,
  CatalogToolBinderInput,
} from "./tool-catalog/catalogToolPorts.js";
import type { CatalogLifecycleLogPort } from "./tool-catalog/catalogToolLifecycle.js";
import {
  createManagedChatCatalogRuntime,
  type ManagedChatCatalogRuntime,
} from "./tool-catalog/managedChatCatalogRuntime.js";
import {
  createManagedProviderCatalog,
  managedCatalogToolDefinitions,
  type ManagedCatalogRoute,
} from "./tool-catalog/managedProviderCatalog.js";
import type { UiHandlerDeps } from "./deps.js";
import {
  jiraChatCatalogConsumerPort,
  type JiraChatCatalogConsumer,
  type JiraChatCatalogContext,
  type JiraChatCatalogAction,
} from "./atlassian/jiraChatCatalogConsumer.js";
import { createChatToolAuthorityPort, reserveChatToolInvocation } from "./chat-tool-approvals.js";
import { recordChatAuthorityResult } from "./editor/chatAuthorityActivity.js";
import type { LocalChatSourceAuthorityDeps } from "./local-chat-source-authority.js";

// The catalog side of a local Chat source (Knowledge Pods, a connected folder): the same
// action/binder contract as the existing local reads, each source with its own authority owner.
// Read-only: there is no consent grant and the approval port is unavailable.

/** The authority owner of one local source: its read tools and its current-authority checks. */
export interface LocalChatSourceOwner {
  readonly reads: ReadonlySet<string>;
  readonly resolve: (
    deps: LocalChatSourceAuthorityDeps,
    chatId: string,
    reference: EditorAgentGovernedAuthorityReference,
    nowIso: string,
    correlationId: string,
  ) =>
    | { readonly ok: true; readonly envelope: { readonly expiresAt: string } }
    | { readonly ok: false };
  readonly reserve: (
    deps: LocalChatSourceAuthorityDeps,
    chatId: string,
    reference: EditorAgentGovernedAuthorityReference,
    usage: CodingWorkbenchRuntimeDelegationUsage,
    nowIso: string,
    correlationId: string,
  ) => { readonly ok: boolean };
}

export interface LocalChatSourceAdmissionOptions {
  readonly deps: LocalChatSourceAuthorityDeps;
  readonly context: () => JiraChatCatalogContext;
  readonly now: () => number;
}

type AdmissionPorts = Pick<
  CatalogToolBinderInput<JiraChatCatalogConsumer>,
  "authorityPort" | "approvalPort"
>;
interface OwnedAdmission extends LocalChatSourceAdmissionOptions {
  readonly owner: LocalChatSourceOwner;
}

export function localChatSourceConsumerPort(
  kind: string,
): CatalogConsumerPort<JiraChatCatalogConsumer> {
  return {
    ...jiraChatCatalogConsumerPort,
    scope: (context) => ({ ...jiraChatCatalogConsumerPort.scope(context), kind }),
  };
}

function preview(
  options: OwnedAdmission,
  capability: string | undefined,
  action: JiraChatCatalogAction,
): ToolAuthorityAvailability {
  const context = options.context();
  const current = options.owner.resolve(
    options.deps,
    context.chatId,
    context.authorityReference,
    new Date(options.now()).toISOString(),
    context.correlationId,
  );
  const allowed =
    current.ok &&
    options.owner.reads.has(action.tool) &&
    chatCapabilityMatches(context, capability) &&
    current.envelope.expiresAt === context.authorityExpiresAt;
  recordChatAuthorityResult(
    "catalog-read",
    allowed ? { ok: true } : { ok: false, reason: "invalid" },
    { chatId: context.chatId },
    context.correlationId,
  );
  return allowed ? { ok: true } : { ok: false, reason: "authority-invalid" };
}

export function createLocalChatSourceAdmission(
  options: LocalChatSourceAdmissionOptions,
  owner: LocalChatSourceOwner,
): AdmissionPorts {
  return {
    authorityPort: createChatToolAuthorityPort<JiraChatCatalogConsumer, OwnedAdmission>(
      { ...options, owner },
      {
        preview,
        reviewable: (current, action) => current.owner.reads.has(action.tool),
        reserve: (current) => reserveChatToolInvocation(current, current.owner.reserve),
        guard: (current, capability, action) => ({
          check: () => preview(current, capability, action).ok,
        }),
      },
    ),
    approvalPort: { available: () => false, request: () => Promise.resolve(undefined) },
  };
}

export type LocalChatSourceCatalogRuntime = ManagedChatCatalogRuntime<JiraChatCatalogConsumer>;

/** The single read provider of one local source, its server-owned routes and its profile. */
export interface LocalChatSourceCatalog {
  readonly provider: ManagedMcpProvider<CatalogHandlerContext<JiraChatCatalogConsumer>>;
  readonly routes: readonly ManagedCatalogRoute<JiraChatCatalogConsumer>[];
  readonly profile: CatalogVersionRef;
}

/** One lazy catalog host per local source; its tool definitions are compiled once. */
export function createLocalChatSourceCatalogRuntime(
  source: LocalChatSourceCatalog,
  log: CatalogLifecycleLogPort,
): LocalChatSourceCatalogRuntime {
  const { provider, routes, profile } = source;
  let definitions: readonly ToolDefinition[] | undefined;
  return createManagedChatCatalogRuntime(
    () =>
      (definitions ??= managedCatalogToolDefinitions(
        routes,
        provider.tools(),
        profile,
        Date.now(),
      )),
    () =>
      createManagedProviderCatalog<JiraChatCatalogConsumer>({
        providers: [provider],
        routes,
        profile,
        log,
        correlationId: randomUUID(),
        now: Date.now,
      }),
  );
}

/** Puts the runtime on the application graph; it closes before the disposers installed earlier. */
export function installLocalChatSourceCatalogRuntime(
  deps: UiHandlerDeps,
  key: "knowledgeChatCatalog" | "connectedFolderChatCatalog",
  runtime: LocalChatSourceCatalogRuntime,
): UiHandlerDeps {
  const previousDispose = deps.dispose;
  return Object.assign(deps, {
    [key]: runtime,
    dispose: async (): Promise<void> => {
      try {
        await runtime.close();
      } finally {
        await previousDispose?.();
      }
    },
  });
}
