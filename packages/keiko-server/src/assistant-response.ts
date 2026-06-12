import { ProviderError } from "@oscharko-dev/keiko-model-gateway";

const EMPTY_ASSISTANT_RESPONSE_STATUS = 200;
const LEGACY_EMPTY_ASSISTANT_PLACEHOLDER = "The model returned an empty response.";

export function isLegacyEmptyAssistantPlaceholder(message: {
  readonly role: string;
  readonly content: string;
}): boolean {
  return (
    message.role === "assistant" && message.content.trim() === LEGACY_EMPTY_ASSISTANT_PLACEHOLDER
  );
}

export function assertUsableAssistantContent(content: string, modelId: string): void {
  if (content.trim().length > 0) {
    return;
  }
  throw new ProviderError(
    `model '${modelId}' returned an empty assistant response`,
    EMPTY_ASSISTANT_RESPONSE_STATUS,
  );
}
