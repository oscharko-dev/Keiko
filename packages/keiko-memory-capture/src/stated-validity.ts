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
  mrz: 2,
  mär: 2,
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
  sept: 8,
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

const UNTIL_PHRASES = [
  String.raw`bis(?:\s+(?:ende|zum\s+ende))?`,
  String.raw`until(?:\s+the\s+end\s+of)?`,
  "till",
  "through",
];
const NAMED_MONTH = Object.keys(MONTHS).join("|");
// A dot after a shortened month stays inside the date only when an explicit year follows it.
const MONTH_ABBREVIATION = "jan|feb|mär|mrz|mar|apr|jun|jul|aug|sept?|okt|oct|nov|dez|dec";
const MONTH_WITH_OPTIONAL_DOT = String.raw`(?:(?:${MONTH_ABBREVIATION})\.(?=[ \t]+\d{4}\b)|(?:${NAMED_MONTH})(?!\p{L}))`;
const MONTH_END = String.raw`(?<!\p{L})(?:${UNTIL_PHRASES.join("|")})[ \t]+(${MONTH_WITH_OPTIONAL_DOT})(?:[ \t]+(\d{4})\b)?`;
const END_OF_MONTH_RE = new RegExp(MONTH_END, "iu");
const GERMAN_DATE_RE = /(?:^|[^\p{L}])bis(?:\s+zum)?\s+(\d{1,2})\.(\d{1,2})\.(\d{4})?(?!\d)/iu;
const ISO_DATE_RE = /(?:^|[^\p{L}])(?:bis|until|till|through)\s+(\d{4})-(\d{2})-(\d{2})(?!\d)/iu;
const GERMAN_NAMED_DAY = String.raw`\bbis(?:[ \t]+zum)?[ \t]+(\d{1,2})\.[ \t]+(${MONTH_WITH_OPTIONAL_DOT})(?:[ \t]+(\d{4})\b)?`;
const GERMAN_NAMED_DAY_RE = new RegExp(GERMAN_NAMED_DAY, "iu");
// In English the day follows the abbreviated month. Its dot is internal only when the day follows.
const ENGLISH_DAY_MONTH = String.raw`(?:${MONTH_ABBREVIATION})\.|(?:${NAMED_MONTH})`;
const ENGLISH_NAMED_DAY = String.raw`\b(?:until|till|through)[ \t]+(${ENGLISH_DAY_MONTH})[ \t]+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?[ \t]+(\d{4})\b)?`;
const ENGLISH_NAMED_DAY_RE = new RegExp(ENGLISH_NAMED_DAY, "iu");
const STATED_NAMED_DATES_RE = new RegExp(
  `${GERMAN_NAMED_DAY}|${ENGLISH_NAMED_DAY}|${MONTH_END}`,
  "giu",
);
const REASON_RE = /(?:^|[^\p{L}])(?:weil|denn|da|because|since)\s+([^.!?…\n]{3,300})/iu;

// A stated day ends at midnight where the person lives. Keiko runs on their own machine, so its local
// time zone is theirs; a UTC day would end hours early west of UTC and run into the next day east.
function endOfDay(year: number, month: number, day: number): number | null {
  const end = new Date(year, month, day, 23, 59, 59, 999);
  return end.getMonth() === month && end.getDate() === day ? end.getTime() : null;
}

function endOfMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0, 23, 59, 59, 999).getTime();
}

function monthEnd(sentence: string, nowMs: number): number | null {
  const match = END_OF_MONTH_RE.exec(sentence);
  const month = namedMonthIndex(match?.[1]);
  if (month === undefined) return null;
  if (match?.[2] !== undefined) return endOfMonth(Number(match[2]), month);
  const thisYear = new Date(nowMs).getFullYear();
  const end = endOfMonth(thisYear, month);
  return end > nowMs ? end : endOfMonth(thisYear + 1, month);
}

// The longest gap between two leap days is eight years around a non-leap century.
function calendarDayEnd(
  day: number,
  month: number,
  year: string | undefined,
  nowMs: number,
): number | null {
  if (year !== undefined) return endOfDay(Number(year), month, day);
  const firstYear = new Date(nowMs).getFullYear();
  for (let candidateYear = firstYear; candidateYear <= firstYear + 8; candidateYear++) {
    const end = endOfDay(candidateYear, month, day);
    if (end !== null && end > nowMs) return end;
  }
  return null;
}

// Sentence splitting and admission share the punctuation that belongs to a stated calendar date.
export function statedDateDots(text: string): ReadonlySet<number> {
  const dots = new Set<number>();
  for (const match of text.matchAll(STATED_NAMED_DATES_RE)) {
    for (const dot of match[0].matchAll(/\./gu)) dots.add(match.index + dot.index);
  }
  return dots;
}

function namedMonthIndex(word: string | undefined): number | undefined {
  const key = word?.replace(/\.$/u, "").toLocaleLowerCase("und") ?? "";
  return Object.hasOwn(MONTHS, key) ? MONTHS[key] : undefined;
}

export function statedDateEnd(sentence: string, nowMs: number): number | null {
  const iso = ISO_DATE_RE.exec(sentence);
  if (iso !== null) return endOfDay(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const numeric = GERMAN_DATE_RE.exec(sentence);
  if (numeric !== null)
    return calendarDayEnd(Number(numeric[1]), Number(numeric[2]) - 1, numeric[3], nowMs);
  const german = GERMAN_NAMED_DAY_RE.exec(sentence);
  const named = german ?? ENGLISH_NAMED_DAY_RE.exec(sentence);
  if (named === null) return monthEnd(sentence, nowMs);
  const month = namedMonthIndex(named[german === null ? 1 : 2]);
  const day = Number(named[german === null ? 2 : 1]);
  return month === undefined ? null : calendarDayEnd(day, month, named[3], nowMs);
}

// The end a sentence states for its fact, as epoch ms, or null when it states none in the future.
export function statedValidUntil(sentence: string, nowMs: number): number | null {
  const end = statedDateEnd(sentence, nowMs);
  return end !== null && end > nowMs ? end : null;
}

export function statedReason(sentence: string): string | null {
  return REASON_RE.exec(sentence)?.[1]?.trim() ?? null;
}
