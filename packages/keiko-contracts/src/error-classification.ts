// The only error classes a client note may name (review on PR #3452): the JavaScript built-ins, the
// errors the browser platform raises, the classes Keiko's own browser code throws, and the `typeof`
// of a thrown non-Error. A name is text the error chose, so any other name travels as "Error": a
// hostile or accidental name can never carry content into the activity log.
export const CLIENT_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AbortError",
  "ChunkLoadError",
  "DataCloneError",
  "InvalidStateError",
  "NetworkError",
  "NotAllowedError",
  "NotFoundError",
  "NotReadableError",
  "NotSupportedError",
  "OverconstrainedError",
  "QuotaExceededError",
  "SecurityError",
  "TimeoutError",
  "ChunkLoadError",
  "ApiError",
  "ChatLookupFailure",
  "DebugRequestError",
  "DictationRecorderError",
  "EditorModelOwnershipError",
  "OverlappingPatchEditError",
  "PollAbortError",
  "RelationshipApiError",
  "StreamingUnavailableError",
  "TaskWorkspaceProvisionError",
  "TaskWorkspaceRepairOperatorRequiredError",
  "TaskWorkspaceRestoreVerificationError",
  "VoiceControlError",
  "VoiceLiveDictationControlError",
  "VoiceRtcError",
  "WorkspaceShortcutConflictError",
  "WorkspaceShortcutReservedError",
  "bigint",
  "boolean",
  "function",
  "number",
  "object",
  "string",
  "symbol",
  "undefined",
]);

/**
 * An error's class for a client note: its name when the closed vocabulary holds it, "Error" for
 * any other Error, and `typeof` for a thrown non-Error. Never the message, never the stack.
 */
export function clientErrorClass(error: unknown): string {
  if (
    error instanceof Error ||
    (typeof DOMException !== "undefined" && error instanceof DOMException)
  ) {
    const name = error.name;
    return CLIENT_ERROR_CLASSES.has(name) ? name : "Error";
  }
  return typeof error;
}
