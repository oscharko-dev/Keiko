import { splitOwnAssessment } from "@oscharko-dev/keiko-contracts/runtime/grounded-assessment";
import { markdownCodeRanges } from "@oscharko-dev/keiko-contracts/runtime/citation-markers";
import {
  bracketedRepositoryCitationCandidates,
  parseInlineCitations,
  reconcileInlineCitations,
  reconcileNumericCitations,
  type PackCitationIndex,
} from "./grounded-faithfulness.js";

const REPAIR_TEXT_MAX = 131_072;
const INSERTION_MAX = 32;
const MARKER_BODY_LENGTH_RE = /^.{1,512}$/su;
const PADDING_MAX = 16;

export function fitsCitationRepairTextLimit(text: string): boolean {
  return text.length <= REPAIR_TEXT_MAX;
}

interface MarkerInsertion {
  readonly start: number;
  readonly end: number;
}

export function buildCitationRepairPrompt(
  answerText: string,
  kind: "file" | "numeric" = "file",
): string {
  return [
    `Return only JSON: {"insertions":[{"after":"exact unique original prose","marker":"${kind === "file" ? "[path:line-range]" : "[n]"}"}]}.`,
    "Using only supplied excerpts, only insert supported markers; never rewrite the answer. At most 32 entries; after at most 512 characters, outside code, missing-evidence declarations and assessment. No explanations.",
    "Original answer:",
    answerText,
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function annotationEntries(text: string): readonly unknown[] | undefined {
  if (!fitsCitationRepairTextLimit(text)) return undefined;
  const json = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/u.exec(text)?.[1] ?? text;
  if (!json.startsWith("{")) return undefined;
  const value: unknown = JSON.parse(json);
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.insertions))
    return undefined;
  const entries: readonly unknown[] = value.insertions;
  return entries.length > 0 && entries.length <= INSERTION_MAX ? entries : undefined;
}

function annotation(
  entry: unknown,
): { readonly after: string; readonly marker: string } | undefined {
  if (!isRecord(entry) || Object.keys(entry).length !== 2) return undefined;
  const after = entry.after;
  const marker = entry.marker;
  if (typeof after !== "string" || typeof marker !== "string") return undefined;
  if (after.length === 0 || after.length > 512 || !MARKER_BODY_LENGTH_RE.test(marker.slice(1, -1)))
    return undefined;
  return { after, marker };
}

function annotatedAnswer(original: string, response: string): string | undefined {
  const entries = annotationEntries(response);
  if (entries === undefined) return undefined;
  const insertions = new Map<number, string>();
  for (const entry of entries) {
    const value = annotation(entry);
    if (value === undefined) return undefined;
    const start = original.indexOf(value.after);
    if (start < 0 || original.includes(value.after, start + 1)) return undefined;
    const offset = start + value.after.length;
    if (insertions.has(offset)) return undefined;
    insertions.set(offset, ` ${value.marker}`);
  }
  let answer = original;
  for (const [offset, marker] of [...insertions].sort((a, b) => b[0] - a[0])) {
    answer = answer.slice(0, offset) + marker + answer.slice(offset);
  }
  return answer;
}

/** Construct annotations locally, then retain every existing marker-only and sent-evidence guard. */
export function citationRepairContent(
  original: string,
  response: string,
  index: PackCitationIndex,
  numericMarkers?: ReadonlySet<number>,
): string | undefined {
  if (!fitsCitationRepairTextLimit(original) || !fitsCitationRepairTextLimit(response))
    return undefined;
  if (validateCitationRepair(original, response, index, numericMarkers)) return response;
  const candidate = annotatedAnswer(original, response.trim());
  return candidate !== undefined &&
    validateCitationRepair(original, candidate, index, numericMarkers)
    ? candidate
    : undefined;
}

function supportedBracket(
  token: string,
  index: PackCitationIndex,
  numericMarkers?: ReadonlySet<number>,
): boolean {
  if (numericMarkers !== undefined) {
    const numeric = reconcileNumericCitations(token, numericMarkers);
    if (numeric.citedMarkers.size > 0) return numeric.unsupportedMarkers.length === 0;
  }
  const parts = token.slice(1, -1).split(",");
  if (!parts.every((part) => parseInlineCitations(`[${part.trim()}]`).length === 1)) return false;
  const result = reconcileInlineCitations(token, index);
  return result.unsupported.length === 0 && result.citedScopePaths.size > 0;
}

function repairInsertions(
  text: string,
  index: PackCitationIndex,
  numericMarkers?: ReadonlySet<number>,
): readonly MarkerInsertion[] {
  const code = markdownCodeRanges(text);
  const result: MarkerInsertion[] = [];
  for (const match of bracketedRepositoryCitationCandidates(text)) {
    const { start, end } = match;
    if (!MARKER_BODY_LENGTH_RE.test(match.text.slice(1, -1))) continue;
    if (code.some((range) => range.start <= start && range.end > start)) continue;
    if (text.charAt(end) === "(" || text.charAt(end) === "[") continue;
    const lineStart = text.lastIndexOf("\n", start) + 1;
    if (/^\s*Missing evidence:/iu.test(text.slice(lineStart, start))) continue;
    if (supportedBracket(match.text, index, numericMarkers)) result.push({ start, end });
    if (result.length > INSERTION_MAX) return [];
  }
  return result;
}

function paddingEnd(text: string, offset: number): number {
  let end = offset;
  while (end - offset < PADDING_MAX && /[ \t]/u.test(text.charAt(end))) end += 1;
  return end;
}

function splitsSubstantiveToken(text: string, offset: number): boolean {
  const word = /[\p{L}\p{M}\p{N}_$]/u;
  const separator = /[.,/:\\-]/u;
  const before = text.charAt(offset - 1);
  const after = text.charAt(offset);
  if (word.test(before) && word.test(after)) return true;
  if (word.test(before) && separator.test(after) && word.test(text.charAt(offset + 1))) return true;
  return separator.test(before) && word.test(text.charAt(offset - 2)) && word.test(after);
}

function unchangedWithInsertions(
  original: string,
  repaired: string,
  insertions: readonly MarkerInsertion[],
): boolean {
  const byStart = new Map(insertions.map((entry) => [entry.start, entry.end]));
  let left = 0;
  let right = 0;
  let inserted = 0;
  let paddingAllowed = false;
  while (right < repaired.length) {
    if (original.charAt(left) === repaired.charAt(right)) {
      if (!/[ \t]/u.test(repaired.charAt(right))) paddingAllowed = false;
      left += 1;
      right += 1;
      continue;
    }
    const padded = paddingEnd(repaired, right);
    const end = byStart.get(right) ?? byStart.get(padded);
    if (end !== undefined) {
      if (splitsSubstantiveToken(original, left)) return false;
      right = end;
      inserted += 1;
      paddingAllowed = true;
      continue;
    }
    if (paddingAllowed && padded > right) {
      right = padded;
      paddingAllowed = false;
      continue;
    }
    return false;
  }
  return left === original.length && inserted > 0;
}

export function validateCitationRepair(
  original: string,
  repaired: string,
  index: PackCitationIndex,
  numericMarkers?: ReadonlySet<number>,
): boolean {
  if (!fitsCitationRepairTextLimit(original) || !fitsCitationRepairTextLimit(repaired))
    return false;
  if (splitOwnAssessment(original).assessment !== splitOwnAssessment(repaired).assessment)
    return false;
  if (!hasSupportedRepairMarkers(repaired, index, numericMarkers)) return false;
  return unchangedWithInsertions(
    original,
    repaired,
    repairInsertions(repaired, index, numericMarkers),
  );
}

function hasSupportedRepairMarkers(
  repaired: string,
  index: PackCitationIndex,
  numericMarkers?: ReadonlySet<number>,
): boolean {
  const reconciliation = reconcileInlineCitations(repaired, index);
  if (reconciliation.unsupported.length > 0) return false;
  const numeric =
    numericMarkers === undefined ? undefined : reconcileNumericCitations(repaired, numericMarkers);
  if ((numeric?.unsupportedMarkers.length ?? 0) > 0) return false;
  return reconciliation.citedScopePaths.size > 0 || (numeric?.citedMarkers.size ?? 0) > 0;
}
