export type RequiredConversationCapability = "conversation" | "tool-calling";
export const TOOL_CALLING_REQUIRED_MESSAGE =
  "The selected model cannot use the connected tools. Choose a model with tool calling.";
export const CONVERSATION_REQUIRED_MESSAGE =
  "The selected model failed its live readiness check. Open Settings > Models and run the readiness check to see the provider status.";

export class ConversationModelNotReadyError extends Error {
  public constructor(
    public readonly requiredCapability: RequiredConversationCapability = "conversation",
  ) {
    super(
      requiredCapability === "tool-calling"
        ? TOOL_CALLING_REQUIRED_MESSAGE
        : CONVERSATION_REQUIRED_MESSAGE,
    );
    this.name = "ConversationModelNotReadyError";
  }
}
