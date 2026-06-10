// Issue #148 — client-side document text extraction into bounded conversation context.
//
// The Conversation Center attaches text documents but, before this module, never extracted
// their text — the model received an empty documentContext and replied "I'm unable to view the
// attached document." This extractor pre-extracts the text on the client and bounds it to the
// SAME UTF-8 byte budgets the server enforces (chat-handlers.ts / conversation-validation.ts),
// so the client preflight equals the server trust boundary.
//
// Security (AC #4 of #147): displayName and all surfaced strings are basename-only — an absolute
// filesystem path NEVER crosses this wire nor reaches the UI. No new runtime dependencies.

import type { ConversationDocumentContextWire } from "@/lib/types";

// Mirror the server constants EXACTLY. A divergence here would let the client ship context the
// server silently drops (or vice versa), so these are intentionally duplicated, not approximated.
export const MAX_DOCUMENT_CONTEXT_TEXT_BYTES = 65_536; // per entry, UTF-8 bytes
export const MAX_AGGREGATE_DOCUMENT_BYTES = 262_144; // across all entries, UTF-8 bytes
export const MAX_DOCUMENT_CONTEXT_ENTRIES = 16;
export const DOCUMENT_TRUNCATION_MARKER = "\n…[truncated]";

// Only text-decodable formats are extracted client-side. Binary documents (PDF) flow through the
// metadata-only attachments path — running file.text() on a PDF would yield garbage, so we skip
// them rather than ship corrupt context. Mirrors the document MIME allowlist in AttachmentStrip.
const TEXT_EXTRACTABLE_PREFIXES = ["text/"] as const;
const TEXT_EXTRACTABLE_EXACT = new Set([
  "application/json",
  "application/x-yaml",
  "application/yaml",
]);

export function isTextExtractableMime(mimeType: string): boolean {
  if (TEXT_EXTRACTABLE_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) return true;
  return TEXT_EXTRACTABLE_EXACT.has(mimeType);
}

export interface PendingDocument {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly file: File;
}

export interface DocumentExtractionResult {
  readonly entries: readonly ConversationDocumentContextWire[];
  readonly failures: readonly string[];
}

const encoder = new TextEncoder();

function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

// Returns the longest prefix of `text` whose UTF-8 byte length is <= budget, never splitting a
// Unicode code point. Iterating code points (the string iterator yields whole code points, not
// UTF-16 units) guarantees we stop on a character boundary so the result re-encodes cleanly.
function truncateToUtf8Budget(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (utf8ByteLength(text) <= budget) return text;
  let used = 0;
  let result = "";
  for (const codePoint of text) {
    const next = used + utf8ByteLength(codePoint);
    if (next > budget) break;
    used = next;
    result += codePoint;
  }
  return result;
}

// file.name is already a basename in the browser, but webkitRelativePath or a synthesised File can
// carry separators. Strip everything up to the last "/" or "\" so no path fragment is surfaced.
function basename(name: string): string {
  const lastSlash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  return lastSlash >= 0 ? name.slice(lastSlash + 1) : name;
}

// All three message builders run BEFORE the actual send, so they speak in the future tense
// (audit C317 — the old copy claimed "the other attachments were still sent" even for a single
// attachment and before any send happened). displayName is always basename-only (AC #4 #147).
function failureMessage(displayName: string): string {
  return `Couldn't read "${displayName}" — it will be skipped. Your message will be sent without it.`;
}

const AGGREGATE_LIMIT_LABEL = `${String(MAX_AGGREGATE_DOCUMENT_BYTES / 1024)} KB`;

// Audit C075 — a document dropped because earlier files exhausted the aggregate byte budget used
// to vanish silently; the model then replied "I can't see the document" with zero user feedback.
function budgetSkipMessage(displayName: string): string {
  return `"${displayName}" won't be sent — the ${AGGREGATE_LIMIT_LABEL} attachment limit was already used by earlier files.`;
}

// Audit C075 — same silence for documents beyond the 16-entry cap.
function countSkipMessage(displayName: string): string {
  return `"${displayName}" won't be sent — only the first ${String(MAX_DOCUMENT_CONTEXT_ENTRIES)} documents are included.`;
}

interface ExtractionState {
  readonly entries: ConversationDocumentContextWire[];
  remainingAggregate: number;
}

function buildEntry(
  doc: PendingDocument,
  text: string,
  perEntryBudget: number,
): {
  readonly entry: ConversationDocumentContextWire;
  readonly consumed: number;
} {
  const truncated = utf8ByteLength(text) > perEntryBudget;
  const boundedText = truncated ? truncateToUtf8Budget(text, perEntryBudget) : text;
  const extractedBytes = utf8ByteLength(boundedText);
  const markerBytes = truncated ? utf8ByteLength(DOCUMENT_TRUNCATION_MARKER) : 0;
  const entry: ConversationDocumentContextWire = {
    id: doc.id,
    displayName: basename(doc.name),
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    extractedBytes,
    truncated,
    truncationMarker: truncated ? DOCUMENT_TRUNCATION_MARKER : undefined,
    text: boundedText,
  };
  return { entry, consumed: extractedBytes + markerBytes };
}

async function readDocumentInto(
  state: ExtractionState,
  doc: PendingDocument,
): Promise<string | undefined> {
  // Audit C075 — every complete drop must surface a message; only genuinely empty files stay
  // silent (nothing was lost). The returned failure flows into the same setError pipeline as
  // read failures (useChatSession.buildDocumentContext).
  if (state.remainingAggregate <= 0) return budgetSkipMessage(basename(doc.name));
  let raw: string;
  try {
    raw = await doc.file.text();
  } catch {
    // Never throw — surface a fixed, path-safe failure so the send proceeds without this doc.
    return failureMessage(basename(doc.name));
  }
  // The per-entry budget is the smaller of the fixed cap and what the aggregate has left, minus
  // the marker cost so a truncated entry's text + marker still fits the remaining aggregate.
  const aggregateRoom = state.remainingAggregate - utf8ByteLength(DOCUMENT_TRUNCATION_MARKER);
  const perEntryBudget = Math.min(MAX_DOCUMENT_CONTEXT_TEXT_BYTES, Math.max(aggregateRoom, 0));
  if (perEntryBudget <= 0) return budgetSkipMessage(basename(doc.name));
  const { entry, consumed } = buildEntry(doc, raw, perEntryBudget);
  if (entry.text.length === 0) {
    return raw.length === 0 ? undefined : budgetSkipMessage(basename(doc.name));
  }
  state.entries.push(entry);
  state.remainingAggregate -= consumed;
  return undefined;
}

// Extracts text from the text-decodable documents in array order, enforcing per-entry and
// aggregate UTF-8 byte budgets and a 16-entry cap. Deterministic: earlier documents win the
// aggregate budget; later ones are truncated or dropped. Never throws.
export async function extractDocumentContext(
  documents: readonly PendingDocument[],
): Promise<DocumentExtractionResult> {
  const extractable = documents.filter((doc) => isTextExtractableMime(doc.mimeType));
  const included = extractable.slice(0, MAX_DOCUMENT_CONTEXT_ENTRIES);
  const state: ExtractionState = { entries: [], remainingAggregate: MAX_AGGREGATE_DOCUMENT_BYTES };
  const failures: string[] = [];
  for (const doc of included) {
    const failure = await readDocumentInto(state, doc);
    if (failure !== undefined) failures.push(failure);
  }
  // Audit C075 — documents beyond the 16-entry cap were sliced away without any hint. Binary
  // documents (PDF) are intentionally NOT reported: their metadata-only path is by design.
  for (const doc of extractable.slice(MAX_DOCUMENT_CONTEXT_ENTRIES)) {
    failures.push(countSkipMessage(basename(doc.name)));
  }
  return { entries: state.entries, failures };
}
