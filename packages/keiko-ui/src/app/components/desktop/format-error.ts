// Shared error formatting for desktop chat surfaces (uiux-fix F041, C171).
// Previously five sites (useChatSession, ChatWindow grounding select,
// ConnectedScopePill, ConnectorScopePill, ScopeConnectButton) each rendered
// `${error.code}: ${error.message}` into role="alert" regions, so users saw raw
// machine strings like "GATEWAY_UPSTREAM_FAILURE: connect ECONNREFUSED …" with
// the code as the leading content. The human message now comes first; the
// technical code is appended in parentheses so support and audit can still
// identify the failure (same pattern as local-knowledge/format-error and
// memoriaviva/components/format-error).

import { ApiError } from "@/lib/api";

export interface UserErrorNotice {
  readonly title: string;
  readonly message: string;
  readonly code: string | undefined;
  readonly remediation: string | undefined;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\bgho_[A-Za-z0-9_]{12,}\b/g,
  /\bghp_[A-Za-z0-9_]{12,}\b/g,
];

const TRAILING_CODE_PATTERN = /\s+\(([A-Z][A-Z0-9_/-]{2,})\)\s*$/;

function sanitizeMessage(message: string): string {
  let out = message;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  out = out.replace(/\bBearer\s+\[REDACTED\]/gi, "[REDACTED]");
  return out;
}

function parseFormattedMessage(message: string): { readonly message: string; readonly code: string | undefined } {
  const match = TRAILING_CODE_PATTERN.exec(message);
  if (match === null) return { message, code: undefined };
  return { message: message.slice(0, match.index).trim(), code: match[1] };
}

function isTooBroadRepositoryQuestion(message: string, code: string | undefined): boolean {
  return (
    code === "BAD_REQUEST" &&
    message.toLowerCase().includes("too broad") &&
    message.toLowerCase().includes("connected")
  );
}

function isClarificationNeeded(code: string | undefined): boolean {
  return code === "CLARIFICATION_NEEDED";
}

function titleForError(message: string, code: string | undefined): string {
  if (isClarificationNeeded(code)) {
    return "Keiko braucht mehr Kontext";
  }
  if (isTooBroadRepositoryQuestion(message, code)) {
    return "Narrow the connected-source question";
  }
  if (code === "PAYLOAD_TOO_LARGE") return "Request is too large";
  if (code === "NO_MODEL") return "No model is available";
  if (code !== undefined) return "Request failed";
  return "Something went wrong";
}

function remediationForError(message: string, code: string | undefined): string | undefined {
  if (isClarificationNeeded(code)) {
    return "Nenne eine konkrete Datei, einen Identifier, eine Fehlermeldung oder eine exakte Phrase.";
  }
  if (isTooBroadRepositoryQuestion(message, code)) {
    return "Ask about a specific file, folder, symbol, identifier, or exact phrase. For broad questions over large project folders, narrow the Files scope first.";
  }
  if (code === "PAYLOAD_TOO_LARGE") {
    return "Reduce the selected scope or remove large attachments before retrying.";
  }
  return undefined;
}

export function formatUserError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const message = sanitizeMessage(error.message.trim());
    if (message.length > 0) return `${message} (${error.code})`;
    return `${fallback} (${error.code})`;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return sanitizeMessage(error.message.trim());
  }
  return fallback;
}

export function toUserErrorNotice(error: unknown, fallback: string): UserErrorNotice {
  if (error instanceof ApiError) {
    const message = sanitizeMessage(error.message.trim()) || fallback;
    return {
      title: titleForError(message, error.code),
      message,
      code: error.code,
      remediation: remediationForError(message, error.code),
    };
  }
  const rawMessage =
    typeof error === "string"
      ? error.trim()
      : error instanceof Error
        ? error.message.trim()
        : "";
  const formatted = parseFormattedMessage(sanitizeMessage(rawMessage || fallback));
  return {
    title: titleForError(formatted.message, formatted.code),
    message: formatted.message,
    code: formatted.code,
    remediation: remediationForError(formatted.message, formatted.code),
  };
}
