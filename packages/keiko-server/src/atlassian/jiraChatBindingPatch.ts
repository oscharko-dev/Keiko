import { isChatJiraPodId } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  isCodingWorkbenchMode,
  type CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { isMcpServerName, MCP_SERVER_MAX } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import {
  invalidRequest,
  type UpdateChatOptions,
  type UpdateChatPatch,
  type Chat,
} from "../store/index.js";
import { findOwnedJiraPod, isReadyJiraPod, type JiraPodAccessDeps } from "./jiraPodAccess.js";
import { logChatScopeUpdate } from "../chat-scope-update-log.js";

function requestedPod(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (!isChatJiraPodId(value)) throw invalidRequest("The Jira Pod identifier is invalid.");
  return value;
}

function requestedMode(value: unknown): CodingWorkbenchMode | undefined {
  if (value === undefined) return undefined;
  if (!isCodingWorkbenchMode(value)) throw invalidRequest("The chat tool mode is invalid.");
  return value;
}

function requestedAdministration(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean")
    throw invalidRequest("The Jira administration selection is invalid.");
  return value;
}

function requestedMcpServers(value: unknown): readonly string[] | null | undefined {
  if (value === undefined || value === null) return value;
  if (
    !Array.isArray(value) ||
    value.length > MCP_SERVER_MAX ||
    !value.every(isMcpServerName) ||
    new Set(value).size !== value.length
  )
    throw invalidRequest("The MCP server selection is invalid.");
  return value;
}

function parseJiraChatPatchFields(
  body: Record<string, unknown>,
  expectedIdentity: string | undefined,
): Partial<UpdateChatPatch> {
  if (Object.hasOwn(body, "jiraPodBinding") || Object.hasOwn(body, "jiraBindingGeneration"))
    throw invalidRequest("Jira binding generations are server-owned.");
  const podId = requestedPod(body.jiraPodId);
  const mode = requestedMode(body.toolMode);
  const mcpServers = requestedMcpServers(body.mcpServers);
  const jiraAdministrationEnabled = requestedAdministration(body.jiraAdministrationEnabled);
  if (
    podId === undefined && mode === undefined && mcpServers === undefined &&
    jiraAdministrationEnabled === undefined
  ) return {};
  if (expectedIdentity === undefined)
    throw invalidRequest("A current chat scope identity is required.");
  return {
    ...(podId === undefined ? {} : { jiraPodId: podId }),
    ...(mode === undefined ? {} : { toolMode: mode }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
    ...(jiraAdministrationEnabled === undefined ? {} : { jiraAdministrationEnabled }),
  };
}

export function jiraChatPatchFields(
  body: Record<string, unknown>,
  expectedIdentity: string | undefined,
  onDenied: () => void,
): Partial<UpdateChatPatch> {
  try {
    return parseJiraChatPatchFields(body, expectedIdentity);
  } catch (error) {
    onDenied();
    throw error;
  }
}

export function jiraChatUpdateOptions(
  deps: JiraPodAccessDeps,
  patch: UpdateChatPatch,
  chat: Chat,
  correlationId: string | undefined,
): Pick<UpdateChatOptions, "verifiedJiraPod"> {
  const podId = patch.jiraPodId ??
    (patch.jiraAdministrationEnabled === true ? chat.jiraPodBinding?.podId : undefined);
  if (podId === undefined) {
    if (patch.jiraAdministrationEnabled === true) {
      logChatScopeUpdate("denied", chat, chat, patch, correlationId);
      throw invalidRequest("Select a ready Jira Pod before enabling administration.");
    }
    return {};
  }
  const credential = findOwnedJiraPod(deps, podId);
  if (credential === undefined || !isReadyJiraPod(credential)) {
    logChatScopeUpdate("denied", chat, chat, patch, correlationId);
    throw invalidRequest("The Jira Pod is unavailable or requires verification.");
  }
  return {
    verifiedJiraPod: { podId, authenticationGeneration: credential.generation },
  };
}
