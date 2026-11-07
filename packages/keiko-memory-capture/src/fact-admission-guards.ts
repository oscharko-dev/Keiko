// Deterministic admission guards that read the person's own words and nothing else (ADR-0146 D4c):
// foreign-source markup (code, single quotes), first-person task requests and a first-person
// wrapper around another person's proposition. Each errs towards learning too little.

const FENCE_RE = /^[ \t]{0,3}(?:`{3,}|~{3,})/u;
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;
const SINGLE_QUOTES = new Set(["'", "‘", "’"]);

// Whether a position lies inside a Markdown fenced block (closed, or open to the end of the text)
// or an inline code span of its line.
export function isInsideCode(text: string, position: number): boolean {
  let offset = 0;
  let fenced = false;
  for (const line of text.split("\n")) {
    const lineEnd = offset + line.length;
    const opensOrCloses = FENCE_RE.test(line);
    if (position <= lineEnd) {
      if (fenced || opensOrCloses) return true;
      return isInsideInlineCode(line, position - offset);
    }
    if (opensOrCloses) fenced = !fenced;
    offset = lineEnd + 1;
  }
  return false;
}

// The end of the backtick run that starts at `from`.
function runEnd(line: string, from: number): number {
  let end = from;
  while (line.charAt(end) === "`") end += 1;
  return end;
}

// Where a backtick run of exactly `length` starts at or after `from`, or -1.
function closingRun(line: string, from: number, length: number): number {
  for (let at = line.indexOf("`", from); at !== -1; at = line.indexOf("`", runEnd(line, at))) {
    if (runEnd(line, at) - at === length) return at;
  }
  return -1;
}

// An inline code span opens and closes with backtick runs of the same length. One linear scan.
function isInsideInlineCode(line: string, at: number): boolean {
  for (let open = line.indexOf("`"); open !== -1 && open < at;) {
    const length = runEnd(line, open) - open;
    const close = closingRun(line, open + length, length);
    if (close === -1) return false;
    if (at < close + length) return at > open;
    open = line.indexOf("`", close + length);
  }
  return false;
}

function closesAt(text: string, at: number): boolean {
  if (!SINGLE_QUOTES.has(text.charAt(at))) return false;
  const before = text.charAt(at - 1);
  const afterIsWord = LETTER_OR_DIGIT_RE.test(text.charAt(at + 1));
  if (afterIsWord) return false;
  return LETTER_OR_DIGIT_RE.test(before) || (before !== "" && !/\s/u.test(before));
}

// Whether a quote opened here closes later on the same line. An elision ("die '90er", "'cause")
// opens nothing, so it cannot hide the rest of the turn.
function closesLaterOnLine(text: string, at: number): boolean {
  for (let next = at + 2; next < text.length && text.charAt(next) !== "\n"; next += 1) {
    if (closesAt(text, next)) return true;
  }
  return false;
}

// An apostrophe sits inside a word ("don't", "Anna's"); a quote opens after a non-letter before a
// letter when it closes later on its line, and closes after a non-space before a non-letter.
export function singleQuoteRole(text: string, at: number): "open" | "close" | null {
  if (!SINGLE_QUOTES.has(text.charAt(at))) return null;
  const beforeIsWord = LETTER_OR_DIGIT_RE.test(text.charAt(at - 1));
  const afterIsWord = LETTER_OR_DIGIT_RE.test(text.charAt(at + 1));
  if (!beforeIsWord && afterIsWord) return closesLaterOnLine(text, at) ? "open" : null;
  return closesAt(text, at) ? "close" : null;
}

const WANT_VERBS = String.raw`(?:i\s+(?:want|need|would\s+like)|i['’]d\s+like|ich\s+(?:möchte|moechte|will|brauche|benötige|wünsche|wuensche|bräuchte|hätte\s+gern(?:e)?))`;
const TASK_NOUNS =
  "summary|overview|list|table|example|explanation|translation|draft|answer|reply|email|e-mail|letter|script|function|snippet|outline|report|zusammenfassung|übersicht|uebersicht|liste|tabelle|beispiel|erklärung|erklaerung|übersetzung|uebersetzung|entwurf|antwort|mail|brief|skript|funktion|gliederung|bericht";
const REQUEST_RES: readonly RegExp[] = [
  // "I want you to use Python", "Ich möchte, dass du Python nutzt": addressed at the model.
  new RegExp(String.raw`(?:^|[^\p{L}])${WANT_VERBS}\s+(?:you|u)\s+to(?![\p{L}\p{N}])`, "iu"),
  new RegExp(
    String.raw`(?:^|[^\p{L}])${WANT_VERBS}\s*,?\s+dass\s+(?:du|ihr|sie)(?![\p{L}\p{N}])`,
    "iu",
  ),
  // "I need a summary", "Ich hätte gern eine kurze Übersicht": a piece of work for this task. A
  // thing the person needs in their life ("Ich brauche eine Brille", "I want a dog") stays a fact.
  new RegExp(
    String.raw`(?:^|[^\p{L}])${WANT_VERBS}\s+(?:an?|the|ein|eine|einen|einem|einer|die|den|das)\s+(?:\p{L}+\s+)?(?:${TASK_NOUNS})(?![\p{L}\p{N}])`,
    "iu",
  ),
  new RegExp(
    String.raw`(?:^|[^\p{L}])${WANT_VERBS}\s+(?:some\s+|etwas\s+)?(?:help|hilfe|unterstützung|support|tipps?|tips?)(?![\p{L}\p{N}])`,
    "iu",
  ),
];

export function isFirstPersonTaskRequest(evidence: string): boolean {
  return REQUEST_RES.some((pattern) => pattern.test(evidence));
}

const OWN_SUBJECT = String.raw`(?:ich|i|wir|we|mein\p{L}*|my|unser\p{L}*|our)`;
const MENTAL_VERBS = String.raw`weiß|weiss|glaube|denke|meine|vermute|habe\s+gehört|know|think|believe|heard|guess|suppose`;
const WRAPPER = String.raw`(?:(?:ich|i)\s+(?:${MENTAL_VERBS})|i['’]m\s+(?:sure|aware)|i\s+am\s+(?:sure|aware)|ich\s+bin\s+(?:mir\s+)?sicher)`;
// "I know that Anna has cancer": the wrapper is the person's, the proposition is not.
const WRAPPED_PROPOSITION_RE = new RegExp(
  String.raw`(?:^|[^\p{L}])${WRAPPER}\s*,?\s+(?:dass|that)\s+(?!${OWN_SUBJECT}(?![\p{L}\p{N}]))\p{L}`,
  "iu",
);
const PROPOSITION_VERBS =
  "has|have|had|is|was|lives|works|gets|hat|hatte|ist|war|wohnt|lebt|arbeitet|bekommt|kriegt";
// The same without "that": "I know Anna has cancer". A named subject followed by its verb is another
// person's proposition; "I know Rust" names no proposition at all. The wrapper is matched without
// case, the named subject by its capital.
// The person's own subject as it starts a clause, in a pattern that keeps letter case.
const OWN_SUBJECT_BY_CAPITAL = String.raw`(?:[Ii]ch|I|[Ww]ir|[Ww]e|[Mm]ein\p{L}*|[Mm]y|[Uu]nser\p{L}*|[Oo]ur)`;
const BARE_WRAPPER_RE = new RegExp(String.raw`(?:^|[^\p{L}])${WRAPPER}\s*,?\s+`, "giu");
const NAMED_PROPOSITION_RE = new RegExp(
  String.raw`^(?!${OWN_SUBJECT_BY_CAPITAL}(?![\p{L}\p{N}]))\p{Lu}\p{L}*\s+(?:${PROPOSITION_VERBS})(?![\p{L}\p{N}])`,
  "u",
);

function wrapsNamedProposition(evidence: string): boolean {
  return [...evidence.matchAll(BARE_WRAPPER_RE)].some((match) =>
    NAMED_PROPOSITION_RE.test(evidence.slice(match.index + match[0].length)),
  );
}

const LIFE_VERBS =
  "wohnt|lebt|arbeitet|schläft|übernachtet|studiert|lives|works|stays|sleeps|studies";
const OWN_PRONOUN_RE = /(?:^|[^\p{L}])(?:ich|i|mir|mich|me|wir|we|uns|us)(?![\p{L}\p{N}])/iu;
const POSSESSIVE_RE = /(?:^|[^\p{L}])(?:mein\p{L}*|my|unser\p{L}*|our)(?![\p{L}\p{N}])/iu;
// "Anna wohnt in meiner Wohnung": another person's life, named only through the person's thing.
const OTHER_LIFE_RE = new RegExp(
  String.raw`^\p{Lu}\p{L}*\s+(?:${LIFE_VERBS})(?![\p{L}\p{N}])`,
  "u",
);

// "Anna wohnt bei mir": the person is named only as the place of another person's life.
const WITH_ME_RE = /(?:^|[^\p{L}])(?:bei\s+(?:mir|uns)|with\s+(?:me|us))(?![\p{L}\p{N}])/giu;

export function isOtherPersonsProposition(evidence: string): boolean {
  if (WRAPPED_PROPOSITION_RE.test(evidence) || wrapsNamedProposition(evidence)) return true;
  if (!OTHER_LIFE_RE.test(evidence.trimStart())) return false;
  const withoutPlace = evidence.replace(WITH_ME_RE, " ");
  const namesOnlyPlace = withoutPlace !== evidence || POSSESSIVE_RE.test(evidence);
  return namesOnlyPlace && !OWN_PRONOUN_RE.test(withoutPlace);
}
