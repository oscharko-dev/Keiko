export type RequiredConversationCapability = "conversation" | "tool-calling";
export type ToolCallingReadinessReason =
  "unsupported" | "unverified" | "stale" | "configuration-changed";
export const TOOL_CALLING_REQUIRED_MESSAGE =
  "The selected model cannot use the connected tools. Choose a model with tool calling.";
export const TOOL_CALLING_VERIFICATION_REQUIRED_MESSAGE =
  "The selected model needs a current tool-calling readiness check. Open Settings > Models and run the readiness check.";
export const CONVERSATION_REQUIRED_MESSAGE =
  "The selected model failed its live readiness check. Open Settings > Models and run the readiness check to see the provider status.";

export class ConversationModelNotReadyError extends Error {
  public constructor(
    public readonly requiredCapability: RequiredConversationCapability = "conversation",
    public readonly reason: ToolCallingReadinessReason | undefined = requiredCapability ===
    "tool-calling"
      ? "unsupported"
      : undefined,
  ) {
    const readinessMessage =
      requiredCapability === "tool-calling"
        ? TOOL_CALLING_VERIFICATION_REQUIRED_MESSAGE
        : CONVERSATION_REQUIRED_MESSAGE;
    super(
      requiredCapability === "tool-calling" && reason === "unsupported"
        ? TOOL_CALLING_REQUIRED_MESSAGE
        : readinessMessage,
    );
    this.name = "ConversationModelNotReadyError";
  }
}
