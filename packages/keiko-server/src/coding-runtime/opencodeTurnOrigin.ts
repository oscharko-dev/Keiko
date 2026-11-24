// The origin Keiko stamps on a runtime user message it dispatched itself (#4491). The prompt body
// stores it as message metadata, so every later reader (the undo boundary, the transcript
// projection) reads the same closed word from the message and never infers it from the text.

/** The prompt metadata key that marks a turn Keiko started to continue the human's request. */
export const OPENCODE_TURN_ORIGIN_METADATA = "keikoTurnOriginV1";

/** The continuations Keiko dispatches on its own; each continues the person's accepted request. */
export const KEIKO_CONTINUATION_ORIGINS = [
  "verification-continuation",
  "delivery-continuation",
] as const;

export type KeikoContinuationOrigin = (typeof KEIKO_CONTINUATION_ORIGINS)[number];

/** The closed origin a runtime message's metadata names; anything else is the person's own message. */
export function keikoContinuationOrigin(metadata: unknown): KeikoContinuationOrigin | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const value = (metadata as Readonly<Record<string, unknown>>)[OPENCODE_TURN_ORIGIN_METADATA];
  return KEIKO_CONTINUATION_ORIGINS.find((origin) => origin === value);
}
