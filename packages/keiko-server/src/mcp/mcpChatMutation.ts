import type { McpChatToolAuthoritySubject } from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
import type { EditorAgentGovernedAuthorityReference } from "@oscharko-dev/keiko-contracts";
import type { ChatMessage } from "../store/index.js";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { CatalogHandlerContext } from "../tool-catalog/catalogToolPorts.js";
import { requireDispatch } from "../tool-catalog/catalogToolErrors.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import type {
  ChatToolMutationStore,
  McpChatToolMutationIntent,
} from "../store/chatToolMutationTypes.js";
import { observedChatToolMutationOutcome } from "../store/chatToolMutationState.js";
import { resolveCurrentMcpChatAuthority, type McpChatAuthorityDeps } from "./mcpChatAuthority.js";
import { mcpChatWriteAction } from "./mcpChatCatalogAdmission.js";
import type { McpChatDeclaration } from "./mcpChatDescriptors.js";
import type { McpChatCatalogAction, McpChatCatalogConsumer } from "./mcpChatCatalogConsumer.js";

type Context = CatalogHandlerContext<McpChatCatalogConsumer>;
function intentFor(
  deps: McpChatAuthorityDeps,
  declaration: McpChatDeclaration,
  args: CatalogJsonObject,
  context: Context,
): McpChatToolMutationIntent {
  const current = resolveCurrentMcpChatAuthority(
    deps,
    context.chatId,
    context.authorityReference,
    new Date().toISOString(),
    context.correlationId,
  );
  const message = deps.store.findMessageById(context.userMessageId);
  const action = context.mutationGuard.write?.action;
  requireDispatch(
    current.ok &&
      message?.canonicalTurnRef !== undefined &&
      action !== undefined &&
      message.chatId === context.chatId &&
      action.name === declaration.name &&
      action.serverName === declaration.serverName &&
      action.toolName === declaration.toolName &&
      action.argumentsDigest === sha256Hex(canonicalise(args)),
    "denied",
    "authority-invalid",
  );
  return createMcpChatMutationIntent(
    message,
    current.envelope.subject,
    context.authorityReference,
    action,
    context.correlationId,
  );
}
export function createMcpChatMutationIntent(
  message: ChatMessage,
  subject: McpChatToolAuthoritySubject,
  authority: EditorAgentGovernedAuthorityReference,
  action: McpChatCatalogAction,
  correlationId: string,
): McpChatToolMutationIntent {
  requireDispatch(
    message.canonicalTurnRef !== undefined && message.chatId === subject.chatId,
    "denied",
    "authority-invalid",
  );
  const identity = mcpChatWriteAction(action);
  return {
    sourceKind: "configured-mcp",
    invocationId: identity.invocationId,
    chatId: message.chatId,
    userMessageId: message.id,
    turnRef: message.canonicalTurnRef,
    actorId: subject.actorDigest,
    podId: null,
    bindingGeneration: null,
    credentialGeneration: null,
    configurationDigest: subject.configurationDigest,
    serverName: action.serverName,
    toolName: action.toolName,
    authorityDigest: authority.envelopeDigest,
    actionDigest: identity.actionDigest,
    operation: identity.operation,
    correlationId,
  };
}

function denied(
  outcome: ChatToolExchange["mutationOutcome"],
  replayed = false,
): ManagedMcpToolResult {
  return {
    data: {
      outcome: outcome ?? "unknown",
      replayed,
      message:
        "The recorded mutation outcome is authoritative. An uncertain remote effect may have occurred; do not repeat it.",
    },
    isError: true,
  };
}
function reportFailure(correlationId: string, error: unknown): void {
  emitServerDiagnostic(
    undefined,
    serverDiagnosticFromError({
      correlationId,
      operation: "mcp.mutation-execution-failed",
      source: "mcp-chat-mutation",
      error,
      redact: () => "server-operation-failed",
    }),
  );
}
async function dispatch(
  journal: ChatToolMutationStore,
  intent: McpChatToolMutationIntent,
  context: Context,
  execute: () => Promise<CatalogJsonObject>,
): Promise<ManagedMcpToolResult> {
  if (
    !journal.beginDispatch(
      intent.invocationId,
      () => context.beforeEffect() && context.mutationGuard.write?.beforeMutation() === true,
    )
  ) {
    journal.settle(intent.invocationId, "rejected");
    return denied("rejected");
  }
  try {
    const data = await execute();
    const success = data.isError !== true;
    journal.acknowledgeMcp(intent.invocationId, success);
    journal.settle(intent.invocationId, success ? "succeeded" : "unknown");
    return { data, ...(success ? {} : { isError: true }) };
  } catch (error) {
    reportFailure(context.correlationId, error);
    const record = journal.find(intent.invocationId);
    const outcome =
      record === undefined ? "unknown" : (observedChatToolMutationOutcome(record) ?? "unknown");
    if (record !== undefined) journal.settle(intent.invocationId, outcome);
    return denied(outcome);
  }
}
/** The existing SQLite journal commits before tools/call; a protocol error never proves no effect. */
export async function executeMcpChatMutation(
  deps: McpChatAuthorityDeps,
  declaration: McpChatDeclaration,
  args: CatalogJsonObject,
  context: Context,
  execute: () => Promise<CatalogJsonObject>,
): Promise<ManagedMcpToolResult> {
  try {
    const journal = deps.store.chatToolMutations;
    requireDispatch(journal !== undefined && context.beforeEffect(), "denied", "authority-invalid");
    const intent = intentFor(deps, declaration, args, context);
    const prepared = journal.prepare(intent);
    if (prepared.kind === "blocked") return denied("not-dispatched");
    if (prepared.kind === "replayed")
      return denied(observedChatToolMutationOutcome(prepared.record), true);
    return await dispatch(journal, intent, context, execute);
  } catch (error) {
    reportFailure(context.correlationId, error);
    return denied("unknown");
  }
}
