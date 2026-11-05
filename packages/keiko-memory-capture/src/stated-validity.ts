// What a sentence says about a fact beyond the fact: a stated end and the reason of a decision.
// Parsed deterministically from the person's own words, never from the model.

const MONTHS: Readonly<Record<string, number>> = {
  januar: 0,
  january: 0,
  jan: 0,
  februar: 1,
  february: 1,
  feb: 1,
  märz: 2,
  maerz: 2,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  mai: 4,
  may: 4,
  juni: 5,
  june: 5,
  jun: 5,
  juli: 6,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  oktober: 9,
  october: 9,
  okt: 9,
  oct: 9,
  november: 10,
  nov: 10,
  dezember: 11,
  december: 11,
  dez: 11,
  dec: 11,
};

const END_OF_MONTH_RE =
  /(?:^|[^\p{L}])(?:bis(?:\s+(?:ende|zum\s+ende))?|until(?:\s+the\s+end\s+of)?|till|through)\s+(\p{L}+)(?:\s+(\d{4}))?(?![\p{L}])/iu;
const GERMAN_DATE_RE = /(?:^|[^\p{L}])bis(?:\s+zum)?\s+(\d{1,2})\.(\d{1,2})\.(\d{4})?(?!\d)/iu;
const ISO_DATE_RE = /(?:^|[^\p{L}])(?:bis|until|till|through)\s+(\d{4})-(\d{2})-(\d{2})(?!\d)/iu;
const REASON_RE = /(?:^|[^\p{L}])(?:weil|denn|da|because|since)\s+([^.!?…\n]{3,300})/iu;

function endOfDay(year: number, month: number, day: number): number | null {
  const end = Date.UTC(year, month, day, 23, 59, 59, 999);
  const check = new Date(end);
  return check.getUTCMonth() === month && check.getUTCDate() === day ? end : null;
}

function endOfMonth(year: number, month: number): number {
  return Date.UTC(year, month + 1, 0, 23, 59, 59, 999);
}

function monthEnd(sentence: string, nowMs: number): number | null {
  const match = END_OF_MONTH_RE.exec(sentence);
  const month = match?.[1] === undefined ? undefined : MONTHS[match[1].toLocaleLowerCase("und")];
  if (month === undefined) return null;
  if (match?.[2] !== undefined) return endOfMonth(Number(match[2]), month);
  const thisYear = new Date(nowMs).getUTCFullYear();
  const end = endOfMonth(thisYear, month);
  return end > nowMs ? end : endOfMonth(thisYear + 1, month);
}

function germanDateEnd(sentence: string, nowMs: number): number | null {
  const match = GERMAN_DATE_RE.exec(sentence);
  if (match === null) return null;
  const month = Number(match[2]) - 1;
  const day = Number(match[1]);
  if (match[3] !== undefined) return endOfDay(Number(match[3]), month, day);
  const thisYear = new Date(nowMs).getUTCFullYear();
  const end = endOfDay(thisYear, month, day);
  if (end === null) return null;
  return end > nowMs ? end : endOfDay(thisYear + 1, month, day);
}

function isoDateEnd(sentence: string): number | null {
  const match = ISO_DATE_RE.exec(sentence);
  if (match === null) return null;
  return endOfDay(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

// The end a sentence states for its fact, as epoch ms, or null when it states none in the future.
export function statedValidUntil(sentence: string, nowMs: number): number | null {
  const end = isoDateEnd(sentence) ?? germanDateEnd(sentence, nowMs) ?? monthEnd(sentence, nowMs);
  return end !== null && end > nowMs ? end : null;
}

// Whether the sentence names an end that has passed, with its year: "bis Dezember 2019". A date
// without a year means its next occurrence, so it never counts as passed.
export function statedEndPassed(sentence: string, nowMs: number): boolean {
  const year = /\b\d{4}\b/u.test(sentence);
  if (!year) return false;
  const end = isoDateEnd(sentence) ?? germanDateEnd(sentence, nowMs) ?? monthEnd(sentence, nowMs);
  return end !== null && end <= nowMs;
}

export function statedReason(sentence: string): string | null {
  return REASON_RE.exec(sentence)?.[1]?.trim() ?? null;
}
