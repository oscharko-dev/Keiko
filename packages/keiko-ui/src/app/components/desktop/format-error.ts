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
  // RB-6 / ADR-0173 D5 — the request correlation id, when the underlying failure carried one, so
  // the notice can offer a copyable support id (same i18n "{feature}.supportId" pattern proven at
  // VoiceDictation.tsx, WorkspaceTrustSurfaces.tsx, RepositoryFolderSwitcher.tsx).
  readonly correlationId: string | undefined;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[\w.~+/=-]{12,}(?![\w.~+/=-])/gi,
  /\bgho_\w{12,}\b/g,
  /\bghp_\w{12,}\b/g,
];

function sanitizeMessage(message: string): string {
  let out = message;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  out = out.replace(/\bBearer\s+\[REDACTED\]/gi, "[REDACTED]");
  return out;
}

function isSpaceChar(ch: string): boolean {
  return ch !== "" && /\s/u.test(ch);
}

function isCodeBodyChar(ch: string): boolean {
  return /[A-Z0-9_/-]/u.test(ch);
}

interface TrailingCode {
  readonly prefixEnd: number;
  readonly code: string;
}

// Manual scan replacing the former `/\s+\(([A-Z][A-Z0-9_/-]{2,})\)\s*$/` (SonarCloud S8786): that
// pattern's leading `\s+` is unanchored, so a message with no trailing " (CODE)" at all (e.g. one
// long whitespace-only string) forces the engine to retry the full backtrack at every start
// position, giving O(n²) work. Scanning back from the end char-by-char can't backtrack and is O(n).
function extractTrailingCode(message: string): TrailingCode | undefined {
  let end = message.length;
  while (end > 0 && isSpaceChar(message[end - 1] ?? "")) end--;
  if (end === 0 || message[end - 1] !== ")") return undefined;
  const closeParen = end - 1;

  let runStart = closeParen;
  while (runStart > 0 && isCodeBodyChar(message[runStart - 1] ?? "")) runStart--;
  const code = message.slice(runStart, closeParen);
  if (code.length < 3 || !/^[A-Z]$/u.test(code[0] ?? "")) return undefined;

  const openParen = runStart - 1;
  if (openParen < 0 || message[openParen] !== "(") return undefined;

  let wsStart = openParen;
  while (wsStart > 0 && isSpaceChar(message[wsStart - 1] ?? "")) wsStart--;
  if (wsStart === openParen) return undefined;

  return { prefixEnd: wsStart, code };
}

function parseFormattedMessage(message: string): {
  readonly message: string;
  readonly code: string | undefined;
} {
  const trailing = extractTrailingCode(message);
  if (trailing === undefined) return { message, code: undefined };
  return { message: message.slice(0, trailing.prefixEnd).trim(), code: trailing.code };
}

// RB-6 / ADR-0173 D5 — a correlation id survives the formatUserError -> setError(string) ->
// toUserErrorNotice round trip (the architecture every desktop chat error surface already uses)
// as a dedicated trailing segment, kept structurally separate from the "(CODE)" convention above
// rather than sharing its charset: a correlation id's alphabet ([A-Za-z0-9._-]) includes lowercase
// letters `isCodeBodyChar` does not accept, so folding the two together would silently truncate the
// id. Peeled off with plain string search (no regex — nothing here risks S8786's catastrophic
// backtracking, but this stays consistent with the manual-scan style above).
const SUPPORT_ID_PREFIX = "[correlationId:";
const SUPPORT_ID_SUFFIX = "]";

function appendSupportId(base: string, correlationId: string | undefined): string {
  if (correlationId === undefined) return base;
  return `${base} ${SUPPORT_ID_PREFIX}${correlationId}${SUPPORT_ID_SUFFIX}`;
}

function extractTrailingSupportId(message: string): {
  readonly message: string;
  readonly correlationId: string | undefined;
} {
  if (!message.endsWith(SUPPORT_ID_SUFFIX)) return { message, correlationId: undefined };
  const openIndex = message.lastIndexOf(SUPPORT_ID_PREFIX);
  if (openIndex === -1) return { message, correlationId: undefined };
  const correlationId = message.slice(openIndex + SUPPORT_ID_PREFIX.length, -1);
  if (correlationId.length === 0) return { message, correlationId: undefined };
  return { message: message.slice(0, openIndex).trimEnd(), correlationId };
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

function friendlyMessageForCode(
  message: string,
  code: string | undefined,
  fallback: string,
): string {
  if (code === "GATEWAY_TIMEOUT" && (message.length === 0 || message === code)) {
    return "The model gateway timed out before the model returned a response.";
  }
  return message.length > 0 ? message : fallback;
}

function titleForError(message: string, code: string | undefined): string {
  if (isClarificationNeeded(code)) {
    return "Keiko braucht mehr Kontext";
  }
  if (isTooBroadRepositoryQuestion(message, code)) {
    return "Narrow the connected-source question";
  }
  if (code === "GATEWAY_TIMEOUT") return "Model gateway timed out";
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
  if (code === "GATEWAY_TIMEOUT") {
    return "Retry. If it repeats, use a smaller prompt or another model, then check gateway URL, proxy, and deployment in Settings.";
  }
  if (code === "PAYLOAD_TOO_LARGE") {
    return "Reduce the selected scope or remove large attachments before retrying.";
  }
  return undefined;
}

export function formatUserError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const message = friendlyMessageForCode(
      sanitizeMessage(error.message.trim()),
      error.code,
      fallback,
    );
    return appendSupportId(`${message} (${error.code})`, error.correlationId);
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return sanitizeMessage(error.message.trim());
  }
  return fallback;
}

// S3358 — a caught value may be a plain string, an Error, or anything else (unknown throw).
function rawErrorMessage(error: unknown): string {
  if (typeof error === "string") return error.trim();
  if (error instanceof Error) return error.message.trim();
  return "";
}

export function toUserErrorNotice(error: unknown, fallback: string): UserErrorNotice {
  if (error instanceof ApiError) {
    const message = friendlyMessageForCode(
      sanitizeMessage(error.message.trim()),
      error.code,
      fallback,
    );
    return {
      title: titleForError(message, error.code),
      message,
      code: error.code,
      remediation: remediationForError(message, error.code),
      correlationId: error.correlationId,
    };
  }
  const rawMessage = rawErrorMessage(error);
  const withoutSupportId = extractTrailingSupportId(sanitizeMessage(rawMessage || fallback));
  const formatted = parseFormattedMessage(withoutSupportId.message);
  return {
    title: titleForError(formatted.message, formatted.code),
    message: formatted.message,
    code: formatted.code,
    remediation: remediationForError(formatted.message, formatted.code),
    correlationId: withoutSupportId.correlationId,
  };
}
