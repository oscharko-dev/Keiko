import { isChatJiraPodId } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  isCodingWorkbenchMode,
  type CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import type { UiHandlerDeps } from "../deps.js";
import {
  invalidRequest,
  type UpdateChatOptions,
  type UpdateChatPatch,
  type Chat,
} from "../store/index.js";
import { findOwnedJiraPod, isReadyJiraPod } from "./jiraPodAccess.js";
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

function parseJiraChatPatchFields(
  body: Record<string, unknown>,
  expectedIdentity: string | undefined,
): Partial<UpdateChatPatch> {
  if (Object.hasOwn(body, "jiraPodBinding") || Object.hasOwn(body, "jiraBindingGeneration"))
    throw invalidRequest("Jira binding generations are server-owned.");
  const podId = requestedPod(body.jiraPodId);
  const mode = requestedMode(body.toolMode);
  if (podId === undefined && mode === undefined) return {};
  if (expectedIdentity === undefined)
    throw invalidRequest("A current chat scope identity is required.");
  return {
    ...(podId === undefined ? {} : { jiraPodId: podId }),
    ...(mode === undefined ? {} : { toolMode: mode }),
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
  deps: UiHandlerDeps,
  patch: UpdateChatPatch,
  chat: Chat,
  correlationId: string | undefined,
): Pick<UpdateChatOptions, "verifiedJiraPod"> {
  if (patch.jiraPodId === undefined || patch.jiraPodId === null) return {};
  const credential = findOwnedJiraPod(deps, patch.jiraPodId);
  if (credential === undefined || !isReadyJiraPod(credential)) {
    logChatScopeUpdate("denied", chat, chat, patch, correlationId);
    throw invalidRequest("The Jira Pod is unavailable or requires verification.");
  }
  return {
    verifiedJiraPod: { podId: patch.jiraPodId, authenticationGeneration: credential.generation },
  };
}
