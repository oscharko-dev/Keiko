// The one statement of when a conversation is compacted automatically. The send path
// (chat-prompt-budget.ts `selectGatewayPromptAssembly`) and the context meter (chat-context-status.ts,
// chat-context-breakdown.ts) both read these values, so the meter can never promise a threshold the
// send path does not apply (PR #3678 review).

/** Automatic compaction starts once a prompt reaches this share of its input budget. */
export const AUTOMATIC_COMPACTION_THRESHOLD = 0.9;

/** Automatic compaction targets this share of the input budget. */
export const AUTOMATIC_COMPACTION_TARGET = 0.7;
