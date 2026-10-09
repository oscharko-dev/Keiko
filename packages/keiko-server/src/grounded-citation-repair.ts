import { markdownCodeRanges } from "@oscharko-dev/keiko-contracts/runtime/citation-markers";
import {
  parseInlineCitations,
  reconcileInlineCitations,
  reconcileNumericCitations,
  type PackCitationIndex,
} from "./grounded-faithfulness.js";

const REPAIR_TEXT_MAX = 131_072;
const INSERTION_MAX = 32;
const PADDING_MAX = 16;
interface MarkerInsertion {
  readonly start: number;
  readonly end: number;
}

export function buildCitationRepairPrompt(
  answerText: string,
  kind: "file" | "numeric" = "file",
): string {
  return [
    `Return the original answer verbatim; only insert supported ${kind === "file" ? "[path:line-range]" : "[n]"} citation markers.`,
    "Use only the supplied repository excerpts. Preserve every claim, code block and existing bracket.",
    "Do not add explanations, tools, missing-evidence declarations or unsupported locations.",
    "Original answer:",
    answerText,
  ].join("\n");
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
  for (const match of text.matchAll(/\[[^\]\r\n]{1,512}\]/gu)) {
    const end = match.index + match[0].length;
    if (code.some((range) => range.start <= match.index && range.end > match.index)) continue;
    if (text.charAt(end) === "(" || text.charAt(end) === "[") continue;
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    if (/^\s*Missing evidence:/iu.test(text.slice(lineStart, match.index))) continue;
    if (supportedBracket(match[0], index, numericMarkers)) result.push({ start: match.index, end });
    if (result.length > INSERTION_MAX) return [];
  }
  return result;
}

function paddingEnd(text: string, offset: number): number {
  let end = offset;
  while (end - offset < PADDING_MAX && /[ \t]/u.test(text.charAt(end))) end += 1;
  return end;
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
  if (original.length > REPAIR_TEXT_MAX || repaired.length > REPAIR_TEXT_MAX) return false;
  const reconciliation = reconcileInlineCitations(repaired, index);
  if (reconciliation.unsupported.length > 0) return false;
  const numeric =
    numericMarkers === undefined ? undefined : reconcileNumericCitations(repaired, numericMarkers);
  if ((numeric?.unsupportedMarkers.length ?? 0) > 0) return false;
  if (reconciliation.citedScopePaths.size === 0 && (numeric?.citedMarkers.size ?? 0) === 0)
    return false;
  return unchangedWithInsertions(
    original,
    repaired,
    repairInsertions(repaired, index, numericMarkers),
  );
}
