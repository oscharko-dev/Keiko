import type { EditorAgentGovernedAuthorityReference } from "@oscharko-dev/keiko-contracts";
import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ToolConsumerActionIdentity,
  ToolConsumerContext,
  ToolEffectGuard,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import type { McpToolRisk } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type {
  CatalogConsumer,
  CatalogConsumerPort,
  CatalogHandlerResult,
} from "../tool-catalog/catalogToolPorts.js";
import type { ManagedCatalogRoute } from "../tool-catalog/managedProviderCatalog.js";
import { requireDispatch } from "../tool-catalog/catalogToolErrors.js";

export interface McpChatCatalogContext extends ToolConsumerContext {
  readonly chatId: string;
  readonly userMessageId: string;
  readonly configurationDigest: string;
  readonly authorityReference: EditorAgentGovernedAuthorityReference;
}
export interface McpChatCatalogTool {
  readonly name: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly risk: McpToolRisk;
}
export interface McpChatCatalogAction extends ToolConsumerActionIdentity, McpChatCatalogTool {
  readonly argumentsDigest: string;
}
export interface McpChatCatalogConsumer extends CatalogConsumer {
  readonly context: McpChatCatalogContext;
  readonly action: McpChatCatalogAction;
  readonly guard: ToolEffectGuard & {
    readonly write?: {
      readonly action: McpChatCatalogAction;
      readonly beforeMutation: () => boolean;
    };
  };
}

function captureAction(value: CatalogJsonValue): McpChatCatalogAction | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const action = value as CatalogJsonObject;
  if (
    Object.keys(action).sort().join() !==
      "actionId,argumentsDigest,idempotencyKey,name,risk,serverName,toolName" ||
    ![
      action.actionId,
      action.idempotencyKey,
      action.name,
      action.serverName,
      action.toolName,
    ].every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 128) ||
    (action.risk !== "read" && action.risk !== "write") ||
    typeof action.argumentsDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(action.argumentsDigest)
  )
    return undefined;
  return action as unknown as McpChatCatalogAction;
}

export const mcpChatCatalogConsumerPort: CatalogConsumerPort<McpChatCatalogConsumer> = {
  scope: (context) => ({
    kind: "configured-mcp-chat",
    chatId: context.chatId,
    configurationDigest: context.configurationDigest,
    authorityRunId: context.authorityReference.runId,
    authorityDigest: context.authorityReference.envelopeDigest,
  }),
  staleReason: "consumer-stale",
  requiredEffects: () => ["connector-access"],
  captureAction: (handler, value) => {
    const action = captureAction(value);
    return handler.binding?.catalogAction === action?.name ? action : undefined;
  },
  captureApprovedAction: captureAction,
};

export function mcpChatCatalogRoutes(
  tools: readonly McpChatCatalogTool[],
): readonly ManagedCatalogRoute<McpChatCatalogConsumer>[] {
  return tools.map((tool) => ({
    name: tool.name,
    alias: tool.name,
    catalogAction: tool.name,
    previewAction: (identity): McpChatCatalogAction => ({
      actionId: identity.actionId,
      idempotencyKey: identity.idempotencyKey,
      name: tool.name,
      serverName: tool.serverName,
      toolName: tool.toolName,
      risk: tool.risk,
      argumentsDigest: sha256Hex(canonicalise({})),
    }),
    actionFor: (args, identity): McpChatCatalogAction => ({
      actionId: identity.actionId,
      idempotencyKey: identity.idempotencyKey,
      name: tool.name,
      serverName: tool.serverName,
      toolName: tool.toolName,
      risk: tool.risk,
      argumentsDigest: sha256Hex(canonicalise(args)),
    }),
    resultFor: (data, context): CatalogHandlerResult => {
      requireDispatch(context.beforeEffect(), "denied", "effect-denied");
      return { data, page: { truncated: false, reason: "none", cursor: null }, resultCount: 1 };
    },
  }));
}
