// Quality Intelligence handoff route error shapes (Epic #270, Issue #281).
//
// Safe error JSON for the Conversation Center → QI workflow handoff route. Error bodies
// NEVER carry credentials, raw payloads, chat content, envelope ids, header values, or
// anything that could be mistaken for a secret. Every error message is a fixed string
// keyed by a stable code. Mirrors the existing connector error envelope shape so the
// dispatcher serialises it identically (`{ error: { code, message } }`).
//
// Note: kept separate from `connectorErrors.ts` to keep route-group code paths cleanly
// addressable for review and to avoid widening that file's error-code union with handoff
// concerns. Test parity with the connector error tests is enforced in `__tests__/`.

export type QiHandoffErrorCode =
  | "QI_HANDOFF_BAD_REQUEST"
  | "QI_HANDOFF_UNKNOWN_CHAT_MESSAGE"
  | "QI_HANDOFF_FORBIDDEN_PAYLOAD"
  | "QI_HANDOFF_INTERNAL";

export interface QiHandoffErrorBody {
  readonly error: { readonly code: QiHandoffErrorCode; readonly message: string };
}

const SAFE_MESSAGES: Readonly<Record<QiHandoffErrorCode, string>> = {
  QI_HANDOFF_BAD_REQUEST: "The request body is not a valid Quality Intelligence handoff envelope.",
  QI_HANDOFF_UNKNOWN_CHAT_MESSAGE:
    "The referenced Conversation Center chat message could not be located.",
  QI_HANDOFF_FORBIDDEN_PAYLOAD:
    "The handoff envelope contained a forbidden field. Handoff envelopes may not carry chat content, credentials, headers, or URLs.",
  QI_HANDOFF_INTERNAL: "The Quality Intelligence handoff route could not service the request.",
};

export const qiHandoffErrorBody = (code: QiHandoffErrorCode): QiHandoffErrorBody => ({
  error: { code, message: SAFE_MESSAGES[code] },
});
