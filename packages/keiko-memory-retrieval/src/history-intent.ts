// Whether a question asks what held before (#4223). A corrected fact keeps its superseded values as
// history, but an answer about the present must not see them: a model given the old value next to
// the new one can answer with the old one (lab 2026-11-11, update-lists-de). So the values a recalled
// memory replaced reach the answer only when the question itself points into the past. The cue words
// are a closed German and English vocabulary of time before now; a question without one gets the
// current value alone, which is what it gets without history at all.

const PAST_CUES: readonly string[] = [
  // German
  "früher(?:e[nmrs]?)?",
  "frueher(?:e[nmrs]?)?",
  String.raw`vorher(?:ig\p{L}*)?`,
  "zuvor",
  "davor",
  "damals",
  "ehemals",
  String.raw`ehemalig\p{L}*`,
  String.raw`ursprünglich\p{L}*`,
  String.raw`urspruenglich\p{L}*`,
  String.raw`vorig\p{L}*`,
  "bevor",
  "anfangs",
  "zuerst",
  "zwischendurch",
  "dazwischen",
  String.raw`am\s+anfang`,
  String.raw`vor\s+(?:meiner|meinem|meinen|deiner|deinem|der|dem|den|unserer|unserem)`,
  "alte[nrs]?",
  // English
  "before",
  "previously",
  "previous",
  "earlier",
  "formerly",
  "former",
  "originally",
  "prior",
  "old",
  String.raw`(?:used|did\s+\p{L}+\s+use)\s+to`,
  String.raw`in\s+the\s+past`,
  String.raw`back\s+then`,
  String.raw`at\s+first`,
  String.raw`in\s+between`,
  String.raw`(?:at|in)\s+the\s+(?:very\s+)?beginning`,
];

const PAST_CUE_RE = new RegExp(String.raw`(?<!\p{L})(?:${PAST_CUES.join("|")})(?!\p{L})`, "iu");

/** True when the question points to a time before now, so earlier values of a fact may answer it. */
export function asksAboutEarlierValues(queryText: string | undefined): boolean {
  // NFC, so a decomposed umlaut ("fru\u0308her") reads like the composed one.
  return queryText !== undefined && PAST_CUE_RE.test(queryText.normalize("NFC"));
}
