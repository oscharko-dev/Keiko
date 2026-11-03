import { isSecretShapedString } from "./isSecretShapedString";

export type ChatCreationModelChoice =
  { readonly kind: "automatic" } | { readonly kind: "explicit"; readonly modelId: string };

export function isPersistableChatCreationModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 2_048 &&
    !isSecretShapedString(value)
  );
}

/** Undefined is a legacy absence; null is an invalid new snapshot and must never elect a model. */
export function chatCreationModelChoiceOf(
  cfg: Readonly<Record<string, unknown>>,
): ChatCreationModelChoice | null | undefined {
  const kind = cfg["newChatModelSelection"];
  const modelId = cfg["newChatModelId"];
  if (kind === undefined && modelId === undefined) return undefined;
  if (kind === "automatic" && modelId === undefined) return { kind };
  if (kind === "explicit" && isPersistableChatCreationModelId(modelId)) return { kind, modelId };
  return null;
}

export function chatCreationModelConfig(
  choice: ChatCreationModelChoice | undefined,
): Readonly<Record<string, string>> {
  if (choice === undefined) return {};
  if (choice.kind === "automatic") return { newChatModelSelection: "automatic" };
  return { newChatModelSelection: "explicit", newChatModelId: choice.modelId };
}
