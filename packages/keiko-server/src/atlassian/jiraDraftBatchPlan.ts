import { JIRA_DRAFT_PAGE_ITEMS_MAX } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

// How many issues one model call can write. Keiko, not the model, sizes every page: from the
// selected model's output budget and the issue template first, then from what the previous pages
// actually cost. Reasoning models spend part of their output budget before the answer, so a page
// plans to use only a share of it.

/** The share of the output budget a page plans to fill; the rest absorbs reasoning and variance. */
const OUTPUT_SHARE = 0.55;
/** A drafted issue without template sections: key, summary and JSON framing. */
const ITEM_BASE_TOKENS = 160;
/** One required template section with a few sentences of text. */
const SECTION_TOKENS = 140;
/** One further required field value. */
const FIELD_TOKENS = 40;
/** Measured costs are padded so the next page is not planned at the edge of the budget. */
const MEASURED_MARGIN = 1.25;
const MIN_ITEM_TOKENS = 60;

export interface DraftBatchTemplateShape {
  readonly requiredSections: readonly string[];
  readonly requiredFields: readonly string[];
}

/** The planned output cost of one issue before any page has been measured. */
export function initialItemTokens(template: DraftBatchTemplateShape): number {
  return (
    ITEM_BASE_TOKENS +
    SECTION_TOKENS * Math.max(1, template.requiredSections.length) +
    FIELD_TOKENS * template.requiredFields.length
  );
}

/** How many issues fit one model call, between 1 and the staging page limit. */
export function draftPageSize(maxOutputTokens: number, itemTokens: number): number {
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) return 1;
  const planned = Math.floor((maxOutputTokens * OUTPUT_SHARE) / Math.max(1, itemTokens));
  return Math.min(JIRA_DRAFT_PAGE_ITEMS_MAX, Math.max(1, planned));
}

/** The cost per issue the next page plans with, after a page reported its real output. */
export function measuredItemTokens(
  previous: number,
  completionTokens: number | undefined,
  itemCount: number,
): number {
  if (completionTokens === undefined || !Number.isFinite(completionTokens) || itemCount <= 0)
    return previous;
  return Math.max(MIN_ITEM_TOKENS, Math.ceil((completionTokens / itemCount) * MEASURED_MARGIN));
}

/** A page that ran out of output plans its halves with at least twice the cost per issue. */
export function exhaustedItemTokens(previous: number): number {
  return Math.max(MIN_ITEM_TOKENS, previous * 2);
}

/** Halves of a page; the first half keeps the larger share. */
export function splitPage<T>(page: readonly T[]): readonly [readonly T[], readonly T[]] {
  const middle = Math.ceil(page.length / 2);
  return [page.slice(0, middle), page.slice(middle)];
}

// ─── Input window ────────────────────────────────────────────────────────────

/** A prompt plans to fill this share of the model's input budget; the rest absorbs estimate error. */
const INPUT_SHARE = 0.7;
/** Characters per token, low enough that German and code-like text are not underestimated. */
const CHARS_PER_TOKEN = 3;

export function estimatedTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

/**
 * How many leading items fit one prompt of `overheadChars` plus their own characters, when the
 * model's input budget is known; at least one, so an oversized item is still tried alone and the
 * overflow handling decides. Without a known budget every item fits.
 */
export function itemsWithinInput(
  maxInputTokens: number | undefined,
  overheadChars: number,
  itemChars: readonly number[],
): number {
  if (maxInputTokens === undefined || !Number.isFinite(maxInputTokens) || maxInputTokens <= 0)
    return itemChars.length;
  let remaining = Math.floor(maxInputTokens * INPUT_SHARE) - estimatedTokens(overheadChars);
  let count = 0;
  for (const chars of itemChars) {
    remaining -= estimatedTokens(chars);
    if (remaining < 0) break;
    count += 1;
  }
  return Math.max(1, count);
}
