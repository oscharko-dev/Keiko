import {
  isChatJiraPodId,
  type Chat,
  type ChatJiraPodBinding,
  type UpdateChatPatch,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  isCodingWorkbenchMode,
  type CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import type { UpdateChatOptions } from "./types.js";
import { invalidRequest } from "./errors.js";

interface JiraChatState {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly mode: CodingWorkbenchMode;
  readonly binding?: ChatJiraPodBinding | undefined;
}

const EMPTY: JiraChatState = { schemaVersion: 1, generation: 0, mode: "governed-assist" };
const STATE_KEYS = new Set(["schemaVersion", "generation", "mode", "binding"]);
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

function validState(value: unknown): value is JiraChatState {
  if (!record(value) || !Object.keys(value).every((key) => STATE_KEYS.has(key))) return false;
  if (
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 0 ||
    !isCodingWorkbenchMode(value.mode)
  )
    return false;
  return value.binding === undefined || validBinding(value.binding, Number(value.generation));
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
  return value;
}

export function jiraChatFields(
  state: JiraChatState,
): Pick<Chat, "toolMode" | "jiraBindingGeneration" | "jiraPodBinding"> {
  return {
    toolMode: state.mode,
    jiraBindingGeneration: state.generation,
    jiraPodBinding: state.binding,
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
  return patch.toolMode ?? existing.toolMode ?? "governed-assist";
}

export function updatedJiraChatState(
  existing: Chat,
  patch: UpdateChatPatch,
  options: UpdateChatOptions | undefined,
  now: number,
): JiraChatState | undefined {
  if (patch.jiraPodId === undefined && patch.toolMode === undefined) return undefined;
  const mode = nextMode(existing, patch);
  const binding = selectedBinding(existing, patch, options, now);
  const changed =
    binding !== existing.jiraPodBinding || mode !== (existing.toolMode ?? "governed-assist");
  const generation = (existing.jiraBindingGeneration ?? 0) + Number(changed);
  if (!Number.isSafeInteger(generation))
    throw invalidRequest("Chat binding generation is exhausted.");
  return {
    schemaVersion: 1,
    generation,
    mode,
    ...(binding === undefined ? {} : { binding: { ...binding, bindingGeneration: generation } }),
  };
}
