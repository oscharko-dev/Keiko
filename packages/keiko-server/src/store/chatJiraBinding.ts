import {
  isChatJiraPodId,
  type Chat,
  type ChatJiraPodBinding,
  type UpdateChatPatch,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  CHAT_TOOL_DEFAULT_MODE,
  isCodingWorkbenchMode,
  type CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { isMcpServerName, MCP_SERVER_MAX } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import type { UpdateChatOptions } from "./types.js";
import { invalidRequest } from "./errors.js";

interface JiraChatState {
  readonly schemaVersion: 2;
  readonly generation: number;
  readonly mode: CodingWorkbenchMode;
  readonly binding?: ChatJiraPodBinding | undefined;
  readonly jiraAdministrationEnabled?: boolean;
  /** MCP servers the Chat offers its model; absent keeps every enabled server. */
  readonly mcpServers?: readonly string[] | undefined;
}

const EMPTY: JiraChatState = { schemaVersion: 2, generation: 0, mode: CHAT_TOOL_DEFAULT_MODE };
const STATE_KEYS = new Set([
  "schemaVersion",
  "generation",
  "mode",
  "binding",
  "mcpServers",
  "jiraAdministrationEnabled",
]);
const BINDING_KEYS = new Set([
  "podId",
  "bindingGeneration",
  "authenticationGeneration",
  "connectedAtMs",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validBinding(value: unknown, generation: number): value is ChatJiraPodBinding {
  if (!record(value) || !Object.keys(value).every((key) => BINDING_KEYS.has(key))) return false;
  return (
    isChatJiraPodId(value.podId) &&
    positiveGeneration(value.bindingGeneration) &&
    value.bindingGeneration === generation &&
    positiveGeneration(value.authenticationGeneration) &&
    Number.isSafeInteger(value.connectedAtMs) &&
    Number(value.connectedAtMs) >= 0
  );
}

type StoredJiraChatState = Omit<JiraChatState, "schemaVersion"> & {
  readonly schemaVersion: 1 | 2;
};

function validState(value: unknown): value is StoredJiraChatState {
  if (!record(value) || !Object.keys(value).every((key) => STATE_KEYS.has(key))) return false;
  if (
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 0 ||
    !isCodingWorkbenchMode(value.mode)
  )
    return false;
  return (
    validMcpSelection(value.mcpServers) &&
    validAdministrationState(value) &&
    (value.binding === undefined || validBinding(value.binding, Number(value.generation)))
  );
}

function validAdministrationState(value: Record<string, unknown>): boolean {
  const selected = value.jiraAdministrationEnabled;
  if (selected === undefined) return true;
  // Schema 1 predates the selection and can never carry an explicit administration grant.
  return value.schemaVersion === 2 && typeof selected === "boolean" &&
    (selected === false || value.binding !== undefined);
}

function validMcpSelection(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= MCP_SERVER_MAX &&
      value.every(isMcpServerName) &&
      new Set(value).size === value.length)
  );
}

/** Corrupt persisted generations must never collapse to a fresh, reusable authority identity. */
export function decodeJiraChatState(json: string | null): JiraChatState {
  if (json === null) return EMPTY;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new TypeError("Stored Jira Chat state is invalid.");
  }
  if (!validState(value)) throw new TypeError("Stored Jira Chat state is invalid.");
  return value.schemaVersion === 2 ? { ...value, schemaVersion: 2 } : migratedState(value);
}

/**
 * Version 1 wrote Ask for approval both when a person selected it and as the default of a Chat that
 * only connected a tool source (a Pod binding patch stored `governed-assist` beside the binding), so
 * the two rows are byte-identical. The stored mode is the person's selection and is kept until they
 * change it; only a Chat without any row resolves the Full access default. Widening an Ask row would
 * silently remove the per-action write approval a person may have chosen.
 */
function migratedState(value: StoredJiraChatState): JiraChatState {
  return { ...value, schemaVersion: 2 };
}

export function jiraChatFields(
  state: JiraChatState,
): Pick<
  Chat,
  "toolMode" | "jiraBindingGeneration" | "jiraPodBinding" | "mcpServers" | "jiraAdministrationEnabled"
> {
  return {
    toolMode: state.mode,
    jiraBindingGeneration: state.generation,
    jiraPodBinding: state.binding,
    jiraAdministrationEnabled: state.jiraAdministrationEnabled === true,
    ...(state.mcpServers === undefined ? {} : { mcpServers: state.mcpServers }),
  };
}

function selectedBinding(
  existing: Chat,
  patch: UpdateChatPatch,
  options: UpdateChatOptions | undefined,
  now: number,
): ChatJiraPodBinding | undefined {
  if (patch.jiraPodId === undefined) return existing.jiraPodBinding;
  if (patch.jiraPodId === null) return undefined;
  const target = verifiedTarget(patch.jiraPodId, options);
  const current = existing.jiraPodBinding;
  if (
    current?.podId === target.podId &&
    current.authenticationGeneration === target.authenticationGeneration
  )
    return current;
  return { ...target, bindingGeneration: 1, connectedAtMs: now };
}

function verifiedTarget(
  podId: string,
  options: UpdateChatOptions | undefined,
): NonNullable<UpdateChatOptions["verifiedJiraPod"]> {
  const target = options?.verifiedJiraPod;
  if (
    !isChatJiraPodId(podId) ||
    target?.podId !== podId ||
    !positiveGeneration(target.authenticationGeneration)
  ) {
    throw invalidRequest("A current verified Jira Pod is required.");
  }
  return { podId: target.podId, authenticationGeneration: target.authenticationGeneration };
}

function nextMode(existing: Chat, patch: UpdateChatPatch): CodingWorkbenchMode {
  if (patch.toolMode !== undefined && !isCodingWorkbenchMode(patch.toolMode))
    throw invalidRequest("Invalid Chat tool mode.");
  return patch.toolMode ?? existing.toolMode ?? CHAT_TOOL_DEFAULT_MODE;
}

function patchesJiraChatState(patch: UpdateChatPatch): boolean {
  return (
    patch.jiraPodId !== undefined ||
    patch.toolMode !== undefined ||
    patch.mcpServers !== undefined ||
    patch.jiraAdministrationEnabled !== undefined
  );
}

function nextAdministrationSelection(
  existing: Chat,
  patch: UpdateChatPatch,
  binding: ChatJiraPodBinding | undefined,
  options: UpdateChatOptions | undefined,
): boolean {
  const requested = patch.jiraAdministrationEnabled;
  if (requested !== undefined && typeof requested !== "boolean")
    throw invalidRequest("Invalid Jira administration selection.");
  if (requested === true) {
    if (binding === undefined || binding !== existing.jiraPodBinding)
      throw invalidRequest("Select the current Jira Pod before enabling administration.");
    const verified = verifiedTarget(binding.podId, options);
    if (verified.authenticationGeneration !== binding.authenticationGeneration)
      throw invalidRequest("The Jira Pod credential generation has changed.");
  }
  if (binding === undefined || binding !== existing.jiraPodBinding) return false;
  return requested ?? (existing.jiraAdministrationEnabled === true);
}

export function updatedJiraChatState(
  existing: Chat,
  patch: UpdateChatPatch,
  options: UpdateChatOptions | undefined,
  now: number,
): JiraChatState | undefined {
  if (!patchesJiraChatState(patch)) return undefined;
  const mode = nextMode(existing, patch);
  const binding = selectedBinding(existing, patch, options, now);
  const jiraAdministrationEnabled = nextAdministrationSelection(existing, patch, binding, options);
  const mcpServers = nextMcpServers(existing, patch);
  const changed =
    binding !== existing.jiraPodBinding ||
    jiraAdministrationEnabled !== (existing.jiraAdministrationEnabled === true) ||
    mode !== (existing.toolMode ?? CHAT_TOOL_DEFAULT_MODE) ||
    !sameMcpSelection(mcpServers, existing.mcpServers);
  const generation = (existing.jiraBindingGeneration ?? 0) + Number(changed);
  if (!Number.isSafeInteger(generation))
    throw invalidRequest("Chat binding generation is exhausted.");
  return {
    schemaVersion: 2,
    generation,
    mode,
    jiraAdministrationEnabled,
    ...(binding === undefined ? {} : { binding: { ...binding, bindingGeneration: generation } }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
  };
}

function nextMcpServers(existing: Chat, patch: UpdateChatPatch): readonly string[] | undefined {
  if (patch.mcpServers === undefined) return existing.mcpServers;
  if (patch.mcpServers === null) return undefined;
  if (!validMcpSelection(patch.mcpServers)) throw invalidRequest("Invalid MCP server selection.");
  return [...patch.mcpServers].sort(compareStrings);
}

function sameMcpSelection(
  next: readonly string[] | undefined,
  previous: readonly string[] | undefined,
): boolean {
  if (next === undefined || previous === undefined) return next === previous;
  return next.length === previous.length && next.every((name, index) => previous[index] === name);
}

/** A revoked credential keeps its visible association; removal disconnects it. */
export function invalidatedJiraChatState(
  existing: Chat,
  podId: string,
  authenticationGeneration: number | null,
): JiraChatState | undefined {
  assertJiraPodInvalidation(podId, authenticationGeneration);
  const binding = existing.jiraPodBinding;
  if (binding?.podId !== podId) return undefined;
  if (
    authenticationGeneration !== null &&
    authenticationGeneration <= binding.authenticationGeneration
  )
    return undefined;
  const generation = (existing.jiraBindingGeneration ?? 0) + 1;
  if (!Number.isSafeInteger(generation))
    throw invalidRequest("Chat binding generation is exhausted.");
  return {
    schemaVersion: 2,
    generation,
    mode: existing.toolMode ?? CHAT_TOOL_DEFAULT_MODE,
    jiraAdministrationEnabled: false,
    ...(existing.mcpServers === undefined ? {} : { mcpServers: existing.mcpServers }),
    ...(authenticationGeneration === null
      ? {}
      : {
          binding: { ...binding, authenticationGeneration, bindingGeneration: generation },
        }),
  };
}

export function assertJiraPodInvalidation(podId: string, generation: number | null): void {
  if (!isChatJiraPodId(podId) || (generation !== null && !positiveGeneration(generation)))
    throw invalidRequest("Invalid Jira Pod lifecycle state.");
}
