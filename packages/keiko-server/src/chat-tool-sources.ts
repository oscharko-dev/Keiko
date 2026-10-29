import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { createKeikoToolCatalog, compileToolProjection } from "@oscharko-dev/keiko-tool-catalog";
import {
  NATIVE_TOOL_CATALOG_RUNTIME,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ToolConsumerContext,
  ToolEffectGuard,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import type {
  ChatToolReadGrantView,
  ChatToolWriteApprovalView,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import type {
  CatalogConsumer,
  CatalogConsumerPort,
  CatalogHandlerContext,
  CatalogToolBinderInput,
  CatalogToolHandlerBinding,
} from "./tool-catalog/catalogToolPorts.js";
import type { ManagedProviderCatalog } from "./tool-catalog/managedProviderCatalog.js";
import { requireDispatch } from "./tool-catalog/catalogToolErrors.js";
import {
  createJiraChatCatalogAdmission,
  jiraChatCatalogConsumerPort,
  type JiraChatCatalogAction,
  type JiraChatCatalogConsumer,
  type JiraChatCatalogContext,
} from "./atlassian/jiraChatCatalogConsumer.js";
import { resolveCurrentJiraChatAuthority } from "./atlassian/jiraChatAuthority.js";
import { createMcpChatCatalogAdmission } from "./mcp/mcpChatCatalogAdmission.js";
import {
  mcpChatCatalogConsumerPort,
  type McpChatCatalogAction,
  type McpChatCatalogConsumer,
  type McpChatCatalogContext,
} from "./mcp/mcpChatCatalogConsumer.js";
import { resolveCurrentMcpChatAuthority } from "./mcp/mcpChatAuthority.js";
import type { McpChatCatalog } from "./mcp/mcpChatCatalogRuntime.js";

export interface ChatSourcesContext extends ToolConsumerContext {
  readonly jira: JiraChatCatalogContext;
  readonly mcp: McpChatCatalogContext;
}
type SourceAction = JiraChatCatalogAction | McpChatCatalogAction;
export interface ChatSourcesConsumer extends CatalogConsumer {
  readonly context: ChatSourcesContext;
  readonly action: SourceAction;
  readonly guard: ToolEffectGuard & {
    readonly write?: { readonly action: SourceAction; readonly beforeMutation: () => boolean };
  };
}
type SourcePorts = Pick<
  CatalogToolBinderInput<ChatSourcesConsumer>,
  "authorityPort" | "approvalPort"
>;
const DENIED = { ok: false, reason: "authority-invalid" } as const;

function captureSourceAction(value: CatalogJsonValue): SourceAction | undefined {
  return (
    jiraChatCatalogConsumerPort.captureApprovedAction(value) ??
    mcpChatCatalogConsumerPort.captureApprovedAction(value)
  );
}
export const chatSourcesConsumerPort: CatalogConsumerPort<ChatSourcesConsumer> = {
  scope: (context) => ({
    kind: "chat-tools",
    jira: jiraChatCatalogConsumerPort.scope(context.jira),
    mcp: mcpChatCatalogConsumerPort.scope(context.mcp),
  }),
  staleReason: "consumer-stale",
  requiredEffects: () => ["connector-access"],
  captureAction: (handler, value) => {
    const action = captureSourceAction(value);
    if (action === undefined) return undefined;
    const name = "tool" in action ? action.tool : action.name;
    return handler.binding?.catalogAction === name ? action : undefined;
  },
  captureApprovedAction: captureSourceAction,
};

function invocationFields(
  context: CatalogHandlerContext<ChatSourcesConsumer>,
): Pick<
  CatalogHandlerContext<ChatSourcesConsumer>,
  "invocationId" | "signal" | "beforeEffect" | "pageSequence" | "createCursor"
> {
  return {
    invocationId: context.invocationId,
    signal: context.signal,
    beforeEffect: context.beforeEffect,
    pageSequence: context.pageSequence,
    createCursor: context.createCursor,
  };
}
function jiraGuard(guard: ChatSourcesConsumer["guard"]): JiraChatCatalogConsumer["guard"] {
  const write = guard.write;
  if (write === undefined) return { check: guard.check };
  requireDispatch("tool" in write.action, "denied", "authority-invalid");
  return {
    check: guard.check,
    write: { action: write.action, beforeMutation: write.beforeMutation },
  };
}
function mcpGuard(guard: ChatSourcesConsumer["guard"]): McpChatCatalogConsumer["guard"] {
  const write = guard.write;
  if (write === undefined) return { check: guard.check };
  requireDispatch(!("tool" in write.action), "denied", "authority-invalid");
  return {
    check: guard.check,
    write: { action: write.action, beforeMutation: write.beforeMutation },
  };
}
function jiraBinding(
  binding: CatalogToolHandlerBinding<JiraChatCatalogConsumer>,
): CatalogToolHandlerBinding<ChatSourcesConsumer> {
  return {
    ...binding,
    execute: (args, context) =>
      binding.execute(args, {
        ...context.jira,
        ...invocationFields(context),
        mutationGuard: jiraGuard(context.mutationGuard),
      }),
  };
}
function mcpBinding(
  binding: CatalogToolHandlerBinding<McpChatCatalogConsumer>,
): CatalogToolHandlerBinding<ChatSourcesConsumer> {
  return {
    ...binding,
    execute: (args, context) =>
      binding.execute(args, {
        ...context.mcp,
        ...invocationFields(context),
        mutationGuard: mcpGuard(context.mutationGuard),
      }),
  };
}

/** Recompile one projection; the application-owned SDK hosts and provider bindings remain owners. */
export function combineChatCatalogs(
  jira: ManagedProviderCatalog<JiraChatCatalogConsumer>,
  mcp: McpChatCatalog,
): ManagedProviderCatalog<ChatSourcesConsumer> {
  const profile = { id: "chat-tools", version: 1 };
  const entries = [jira.projection, mcp.projection].flatMap((projection) =>
    projection.tools.map(({ alias, ...descriptor }) => ({ alias, descriptor })),
  );
  const catalog = createKeikoToolCatalog(
    [
      {
        profile,
        adapterDialect: { id: "gateway-json-schema", version: 1 },
        adapterRuntime: NATIVE_TOOL_CATALOG_RUNTIME,
        entries,
      },
    ],
    [],
    { referenceTimeMs: Date.now() },
  );
  return {
    catalog,
    projection: compileToolProjection(catalog, profile),
    handlerBindings: [
      ...jira.handlerBindings.map(jiraBinding),
      ...mcp.handlerBindings.map(mcpBinding),
    ],
    close: () => Promise.resolve(),
  };
}

export function chatSourcesAuthorityDigest(
  context: Pick<ChatSourcesContext, "jira" | "mcp">,
): string {
  return sha256Hex(canonicalise([context.jira.authorityReference, context.mcp.authorityReference]));
}
export function currentChatSources(deps: UiHandlerDeps, context: ChatSourcesContext): boolean {
  const now = new Date().toISOString();
  return (
    !context.signal.aborted &&
    resolveCurrentJiraChatAuthority(
      deps,
      context.jira.chatId,
      context.jira.authorityReference,
      now,
      context.correlationId,
    ).ok &&
    resolveCurrentMcpChatAuthority(
      deps,
      context.mcp.chatId,
      context.mcp.authorityReference,
      now,
      context.correlationId,
    ).ok
  );
}
interface AdmissionOptions {
  readonly deps: UiHandlerDeps;
  readonly context: () => ChatSourcesContext;
  readonly tools: McpChatCatalog["tools"];
  readonly requestReadConsent: (grant: ChatToolReadGrantView, signal: AbortSignal) => Promise<void>;
  readonly requestWriteConsent: (
    approval: ChatToolWriteApprovalView,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly reviewableWrite: (action: SourceAction) => boolean;
}
function jointGuard(
  guard: ChatSourcesConsumer["guard"],
  current: () => boolean,
): ChatSourcesConsumer["guard"] {
  const check = (): boolean => current() && guard.check();
  const write = guard.write;
  return write === undefined
    ? { check }
    : {
        check,
        write: {
          action: write.action,
          beforeMutation: () => check() && write.beforeMutation() && check(),
        },
      };
}

function sourceAdmissions(options: AdmissionOptions): {
  readonly jira: ReturnType<typeof createJiraChatCatalogAdmission>;
  readonly mcp: ReturnType<typeof createMcpChatCatalogAdmission>;
} {
  const jira = createJiraChatCatalogAdmission({
    ...options,
    now: Date.now,
    context: () => ({ ...options.context().jira, signal: options.context().signal }),
  });
  const mcp = createMcpChatCatalogAdmission({
    ...options,
    now: Date.now,
    context: () => ({ ...options.context().mcp, signal: options.context().signal }),
  });
  return { jira, mcp };
}

/** A private source map delegates admission while the binder and harness account once per call. */
export function createChatSourcesAdmission(options: AdmissionOptions): SourcePorts {
  const { jira, mcp } = sourceAdmissions(options);
  const current = (capability: string | undefined): boolean =>
    capability === options.context().authority &&
    currentChatSources(options.deps, options.context());
  const ports: SourcePorts = {
    authorityPort: {
      preview: (capability, action) => {
        if (!current(capability)) return DENIED;
        return "tool" in action
          ? jira.authorityPort.preview(options.context().jira.authority, action)
          : mcp.authorityPort.preview(options.context().mcp.authority, action);
      },
      admit: (capability, action) => {
        if (!current(capability)) return DENIED;
        const admission =
          "tool" in action
            ? jira.authorityPort.admit(options.context().jira.authority, action)
            : mcp.authorityPort.admit(options.context().mcp.authority, action);
        return admission.ok
          ? {
              ok: true,
              mutationGuard: jointGuard(admission.mutationGuard, () => current(capability)),
            }
          : admission;
      },
    },
    approvalPort: {
      available: (action, context) =>
        current(context.authority) &&
        ("tool" in action
          ? jira.approvalPort.available(action, context.jira)
          : mcp.approvalPort.available(action, context.mcp)),
      request: async (action, context) => {
        if (context.signal.aborted || !current(context.authority)) return undefined;
        return "tool" in action
          ? jira.approvalPort.request(action, { ...context.jira, signal: context.signal })
          : mcp.approvalPort.request(action, { ...context.mcp, signal: context.signal });
      },
    },
  };
  return ports;
}
