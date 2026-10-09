import type {
  GroundedAnswerEvidenceDeclaration,
  GroundedInsufficiencyDeclaration,
  GroundedPromptContextWire,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { InsufficiencyDeclarationResult } from "./grounded-faithfulness.js";

export interface GroundedAnswerUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface GroundedAnswerResult extends GroundedAnswerEvidenceDeclaration {
  /** Internal verified inventory; never projected as a wire field or included in logs. */
  readonly evidenceScopeIndex?:
    ReadonlyMap<string, GroundedInsufficiencyDeclaration["state"]> | undefined;
  readonly insufficiencyObservation?:
    Omit<InsufficiencyDeclarationResult, "declarations"> | undefined;
  readonly content: string;
  readonly usage: GroundedAnswerUsage;
  // GEN-AI-GATEWAY-001 (RB-4): the provider finishReason for the completion. When "length" the
  // answer was truncated and must be surfaced (incomplete-answer marker) rather than consumed as a
  // complete grounded answer. Optional/absent on deterministic test answerers and legacy payloads.
  readonly finishReason?: string | undefined;
  // The share the sent prompt took, for the context meter (grounded-prompt-context.ts). Counts only.
  readonly promptContext?: GroundedPromptContextWire | undefined;
}

export type GroundedAnswerPayload = string | GroundedAnswerResult;

const SAFE_GROUNDED_FALLBACK =
  "I could not produce a clean grounded answer from the retrieved repository evidence.";

const ORCHESTRATION_PREFIX_RE =
  /^(searching for\b|search query\b|we need to call search\b|let'?s search\b|calling search\b|tool call\b|plan\b:|system prompt\b:|developer prompt\b:|internal planning\b:|internal reasoning\b:|hidden instruction\b:)/i;

const PROMPT_DISCLOSURE_RE =
  /^(system prompt\b:|developer prompt\b:|internal planning\b:|internal reasoning\b:|hidden instruction\b:)/i;

const ARGUMENT_LINE_RE =
  /^(?:[{[]|["']?(?:path|query|max_results|maxResults|tool|arguments|scope|search)["']?\s*:)/i;

function isFiniteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOrchestrationLine(line: string): boolean {
  return ORCHESTRATION_PREFIX_RE.test(line);
}

function isArgumentLine(line: string): boolean {
  if (ARGUMENT_LINE_RE.test(line)) {
    return true;
  }
  return line === "}" || line === "]" || line === "}," || line === "],";
}

function shouldStripLeadingLine(trimmed: string, stripping: boolean): boolean {
  if (trimmed.length === 0) {
    return true;
  }
  if (!stripping) {
    return isOrchestrationLine(trimmed);
  }
  return (
    isOrchestrationLine(trimmed) ||
    isArgumentLine(trimmed) ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[")
  );
}

function leadingContentIndex(lines: readonly string[]): number {
  let index = 0;
  let stripping = false;
  while (index < lines.length) {
    const trimmed = lines[index]?.trim() ?? "";
    const shouldStrip = shouldStripLeadingLine(trimmed, stripping);
    if (!shouldStrip) {
      return index;
    }
    stripping ||= isOrchestrationLine(trimmed);
    index += 1;
  }
  return index;
}

export function sanitizeGroundedAnswerContent(content: string): string {
  const lines = content.split("\n");
  const index = leadingContentIndex(lines);
  const sanitized = lines
    .slice(index)
    .filter((line) => !PROMPT_DISCLOSURE_RE.test(line.trim()))
    .join("\n")
    .trim();
  return sanitized.length > 0 ? sanitized : SAFE_GROUNDED_FALLBACK;
}

export function normalizeGroundedAnswerPayload(
  payload: GroundedAnswerPayload,
): GroundedAnswerResult {
  if (typeof payload === "string") {
    return {
      content: sanitizeGroundedAnswerContent(payload.trim()),
      usage: { promptTokens: 0, completionTokens: 0 },
    };
  }
  return {
    content: sanitizeGroundedAnswerContent(payload.content.trim()),
    usage: {
      promptTokens: isFiniteCount(payload.usage.promptTokens) ? payload.usage.promptTokens : 0,
      completionTokens: isFiniteCount(payload.usage.completionTokens)
        ? payload.usage.completionTokens
        : 0,
    },
    ...(payload.finishReason === undefined ? {} : { finishReason: payload.finishReason }),
    ...(payload.promptContext === undefined ? {} : { promptContext: payload.promptContext }),
    ...normalizedEvidenceDeclaration(payload),
  };
}

function normalizedEvidenceDeclaration(
  payload: GroundedAnswerResult,
): Pick<
  GroundedAnswerResult,
  | "answerKind"
  | "citationBehaviour"
  | "insufficiencyDeclarations"
  | "evidenceScopeIndex"
  | "insufficiencyObservation"
> {
  return {
    ...(payload.answerKind === undefined ? {} : { answerKind: payload.answerKind }),
    ...(payload.citationBehaviour === undefined
      ? {}
      : { citationBehaviour: payload.citationBehaviour }),
    ...(payload.insufficiencyDeclarations === undefined
      ? {}
      : { insufficiencyDeclarations: payload.insufficiencyDeclarations }),
    ...(payload.evidenceScopeIndex === undefined
      ? {}
      : { evidenceScopeIndex: payload.evidenceScopeIndex }),
    ...(payload.insufficiencyObservation === undefined
      ? {}
      : { insufficiencyObservation: payload.insufficiencyObservation }),
  };
}

/** True when the payload string produced only the safe fallback (no clean grounded answer). */
export function isSafeGroundedFallback(content: string): boolean {
  return content === SAFE_GROUNDED_FALLBACK;
}
