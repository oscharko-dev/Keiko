// Conversation budget estimator (Issue #151 / Epic #142).
//
// Pure, deterministic helper that estimates how much of a chat model's context
// window is consumed by a conversation turn. The UI uses this for the
// pre-send pressure indicator (AC#1) and the "clear history" affordance
// (AC#4). The breakdown carries connected-context byte counts so they can
// be disclosed and removable from the next call (AC#5).
//
// Engineering note (from the issue): token counting is APPROXIMATE here.
// We use bytes/4 as a rough proxy. UI copy and tests MUST state this
// precisely — do not present byte estimates as exact tokens.

export interface ConversationBudgetMessage {
  readonly role: string;
  readonly content: string;
}

export interface ConversationBudgetDocumentContext {
  readonly extractedBytes: number;
}

export interface ConversationBudgetInputs {
  readonly modelContextWindow: number;
  readonly modelMaxOutputTokens: number;
  readonly userDraftText: string;
  readonly conversationHistory: readonly ConversationBudgetMessage[];
  readonly documentContext?: readonly ConversationBudgetDocumentContext[] | undefined;
  readonly repoContextPackBytes?: number | undefined;
  readonly knowledgeCapsuleBytes?: number | undefined;
  readonly memoryContextBytes?: number | undefined;
}

export type ConversationBudgetPressure = "low" | "moderate" | "high" | "exceeded";

export interface ConversationBudgetBreakdown {
  readonly draftBytes: number;
  readonly historyBytes: number;
  readonly documentBytes: number;
  readonly repoContextBytes: number;
  readonly knowledgeBytes: number;
  readonly memoryBytes: number;
}

export interface ConversationBudgetEstimate {
  readonly approximateBytes: number;
  readonly approximateTokens: number;
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: number;
  readonly availableInputTokens: number;
  readonly pressure: ConversationBudgetPressure;
  readonly breakdown: ConversationBudgetBreakdown;
}

// Average ASCII byte ≈ 4 chars per token in mainstream BPE tokenizers. This
// is an over-simplification; we surface it as APPROXIMATE everywhere.
const APPROX_BYTES_PER_TOKEN = 4;

// Pressure thresholds, applied against the fraction of availableInputTokens
// the approximate token count consumes.
const PRESSURE_LOW = 0.5;
const PRESSURE_MODERATE = 0.75;
const PRESSURE_HIGH = 0.95;

function coerceNonNegativeInt(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  return Math.floor(value);
}

function utf8ByteLength(text: string): number {
  // Browsers and Node both expose TextEncoder. Falls back to char length
  // when (in some legacy harness) it is absent — acceptable since the
  // result is documented approximate.
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length;
  }
  return text.length;
}

function sumHistoryBytes(history: readonly ConversationBudgetMessage[]): number {
  let total = 0;
  for (const message of history) {
    total += utf8ByteLength(message.role);
    total += utf8ByteLength(message.content);
  }
  return total;
}

function sumDocumentBytes(
  documents: readonly ConversationBudgetDocumentContext[] | undefined,
): number {
  if (documents === undefined) return 0;
  let total = 0;
  for (const document of documents) {
    total += coerceNonNegativeInt(document.extractedBytes);
  }
  return total;
}

function classifyPressure(
  tokens: number,
  availableInputTokens: number,
): ConversationBudgetPressure {
  if (availableInputTokens <= 0) return "exceeded";
  const ratio = tokens / availableInputTokens;
  if (ratio > PRESSURE_HIGH) return "exceeded";
  if (ratio > PRESSURE_MODERATE) return "high";
  if (ratio > PRESSURE_LOW) return "moderate";
  return "low";
}

export function estimateConversationBudget(
  input: ConversationBudgetInputs,
): ConversationBudgetEstimate {
  const contextWindowTokens = coerceNonNegativeInt(input.modelContextWindow);
  const reservedOutputTokens = coerceNonNegativeInt(input.modelMaxOutputTokens);
  const availableInputTokens = Math.max(0, contextWindowTokens - reservedOutputTokens);

  const draftBytes = utf8ByteLength(input.userDraftText);
  const historyBytes = sumHistoryBytes(input.conversationHistory);
  const documentBytes = sumDocumentBytes(input.documentContext);
  const repoContextBytes = coerceNonNegativeInt(input.repoContextPackBytes);
  const knowledgeBytes = coerceNonNegativeInt(input.knowledgeCapsuleBytes);
  const memoryBytes = coerceNonNegativeInt(input.memoryContextBytes);

  const breakdown: ConversationBudgetBreakdown = {
    draftBytes,
    historyBytes,
    documentBytes,
    repoContextBytes,
    knowledgeBytes,
    memoryBytes,
  };

  const approximateBytes =
    draftBytes + historyBytes + documentBytes + repoContextBytes + knowledgeBytes + memoryBytes;
  const approximateTokens = Math.ceil(approximateBytes / APPROX_BYTES_PER_TOKEN);
  const pressure = classifyPressure(approximateTokens, availableInputTokens);

  return {
    approximateBytes,
    approximateTokens,
    contextWindowTokens,
    reservedOutputTokens,
    availableInputTokens,
    pressure,
    breakdown,
  };
}
