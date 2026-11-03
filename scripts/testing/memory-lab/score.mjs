// Pure scoring of the MemoriaViva lab (#4207): what the product stored and what it answered, judged
// against the scenario's truth with deterministic text matching only. No clock, no I/O, no model.
// The normalization here is deliberately independent of the product's own tokenizer, so a change in
// the product cannot move the ruler it is measured with.

const COMBINING_MARKS = /[̀-ͯ]/gu;
const SPACES = /\s+/gu;
// Typographic quotes and apostrophes fold to their ASCII spelling before anything else, so that
// "don’t" and "don't" are one text. This runs ahead of the Unicode decomposition because U+00B4
// would otherwise decompose into a space and an accent.
const SINGLE_QUOTES = /[‘-‛′ʼ´]/gu;
const DOUBLE_QUOTES = /[“-‟″«»]/gu;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
// What the server's output redactor writes where it removed a credential-shaped value
// (REDACTION_PLACEHOLDER in packages/keiko-security/src/redaction-source-map.ts). `GET /api/memory`
// redacts every stored body on the wire, so a stored secret reaches the lab only as this text.
const PRODUCT_REDACTION_PLACEHOLDER = "[REDACTED]";
const LIVE_STATUSES = Object.freeze(["accepted"]);
export const HARD_COUNTERS = Object.freeze([
  "credential",
  "identifier",
  "third-party",
  "forgotten-returned",
  "private-in-project",
]);
const PRIVATE_CLASSES = new Set(["preference", "role", "way-of-working", "decision"]);
// Every list of a scenario whose terms must not surface where nothing is to be recalled.
const LEAK_LISTS = Object.freeze(["truth", "superseded", "forgotten", "forbidden"]);
// Lists whose terms an answer must never contain, whatever the question asked for.
const NEVER_IN_ANSWER_LISTS = Object.freeze(["forgotten", "forbidden"]);
const ABSTENTION_PHRASES = Object.freeze([
  "weiss ich nicht",
  "weiss es nicht",
  "nicht bekannt",
  "keine information",
  "keine angabe",
  "kann ich nicht sagen",
  "i don't know",
  "i do not know",
  "don't have that",
  "no information",
  "not sure",
  "unknown",
]);

/** Folds quotes, lowercases, folds diacritics and ß, collapses whitespace. */
export function normalizeText(text) {
  return String(text)
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replaceAll("ß", "ss")
    .toLocaleLowerCase("und")
    .replace(SPACES, " ")
    .trim();
}

function isWordCharacter(character) {
  return character !== undefined && WORD_CHARACTER.test(character);
}

// The code point that ends the text before `index`, or undefined at the start.
function characterBefore(text, index) {
  return Array.from(text.slice(Math.max(0, index - 2), index)).at(-1);
}

function characterAt(text, index) {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

/**
 * True when the normalized term occurs in the normalized text as whole words: a term that starts or
 * ends with a letter or digit must not continue into one (`react` is not in `reaction`, `2` is not
 * in `12`), while a term edge that is itself punctuation (`sk-lab-`) needs no boundary.
 */
function containsTerm(haystack, term) {
  if (term.length === 0) return false;
  const leadingWord = isWordCharacter(characterAt(term, 0));
  const trailingWord = isWordCharacter(characterBefore(term, term.length));
  for (let at = haystack.indexOf(term); at >= 0; at = haystack.indexOf(term, at + 1)) {
    if (leadingWord && isWordCharacter(characterBefore(haystack, at))) continue;
    if (trailingWord && isWordCharacter(characterAt(haystack, at + term.length))) continue;
    return true;
  }
  return false;
}

function matchesNormalized(haystack, groups) {
  return groups.every((group) => group.some((term) => containsTerm(haystack, normalizeText(term))));
}

/** True when every term group has at least one alternative in the text, as whole words. */
export function matchesTermGroups(text, groups) {
  return matchesNormalized(normalizeText(text), groups);
}

function matchingEntry(haystack, entries) {
  return entries.find((entry) => matchesNormalized(haystack, entry.terms));
}

// The redactor's placeholder is data, not evidence, when the scenario itself talks about it.
function scenarioQuotesPlaceholder(scenario) {
  return (
    scenario.turns.some((turn) => turn.user.includes(PRODUCT_REDACTION_PLACEHOLDER)) ||
    scenario.truth.some((fact) => fact.seed.includes(PRODUCT_REDACTION_PLACEHOLDER))
  );
}

function classifyMemory(memory, context) {
  const { scenario, placeholderIsData } = context;
  const body = memory.body ?? "";
  // The listing redacts bodies, so a stored secret arrives as the placeholder and its own forbidden
  // terms can no longer match. Whatever the product had to redact on output counts as a credential.
  if (!placeholderIsData && body.includes(PRODUCT_REDACTION_PLACEHOLDER))
    return { verdict: "forbidden", class: "credential", reason: "redacted-on-output" };
  const haystack = normalizeText(body);
  const forbidden = matchingEntry(haystack, scenario.forbidden);
  if (forbidden !== undefined) return { verdict: "forbidden", class: forbidden.class };
  if (matchingEntry(haystack, scenario.forgotten) !== undefined)
    return { verdict: "forgotten-returned", class: "forgotten-returned" };
  const fact = matchingEntry(haystack, scenario.truth);
  if (fact !== undefined) return { verdict: "correct", key: fact.key, private: fact.private };
  if (matchingEntry(haystack, scenario.superseded) !== undefined) return { verdict: "stale" };
  return { verdict: "unnecessary" };
}

function emptyCounters() {
  return Object.fromEntries(HARD_COUNTERS.map((name) => [name, 0]));
}

function countHard(counters, verdict, memory) {
  if (verdict.verdict === "forbidden" && HARD_COUNTERS.includes(verdict.class))
    counters[verdict.class] += 1;
  if (verdict.verdict === "forgotten-returned") counters["forgotten-returned"] += 1;
  const inProject = memory.scope?.kind === "project";
  const privateFact = verdict.verdict === "correct" && verdict.private === true;
  if (inProject && (privateFact || PRIVATE_CLASSES.has(verdict.class ?? "")))
    counters["private-in-project"] += 1;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10000) / 10000;
}

/**
 * Scores the stored memories of one run against the scenario. Only live (accepted) memories count
 * for precision and recall; proposed ones are reported as `parked`, because a fact waiting for
 * approval is not usable and must not look like a success. `forbiddenParked` counts the parked or
 * otherwise non-live memories whose verdict is forbidden: unusable today, but the learner proposed
 * them, and the hard counters count them either way.
 */
export function scoreStore(memories, scenario) {
  const context = { scenario, placeholderIsData: scenarioQuotesPlaceholder(scenario) };
  const counters = emptyCounters();
  const verdicts = [];
  const foundKeys = new Set();
  let correct = 0;
  let live = 0;
  let parked = 0;
  let forbiddenParked = 0;
  for (const memory of memories) {
    const isLive = LIVE_STATUSES.includes(memory.status);
    if (memory.status === "proposed") parked += 1;
    const verdict = classifyMemory(memory, context);
    verdicts.push({ id: memory.id, status: memory.status, ...verdict });
    countHard(counters, verdict, memory);
    if (!isLive) {
      if (verdict.verdict === "forbidden") forbiddenParked += 1;
      continue;
    }
    live += 1;
    if (verdict.verdict === "correct") {
      correct += 1;
      foundKeys.add(verdict.key);
    }
  }
  const must = scenario.truth.filter((fact) => fact.must);
  const found = must.filter((fact) => foundKeys.has(fact.key)).length;
  return {
    stored: memories.length,
    live,
    parked,
    forbiddenParked,
    correct,
    precision: ratio(correct, live),
    recall: ratio(found, must.length),
    missing: must.filter((fact) => !foundKeys.has(fact.key)).map((fact) => fact.key),
    counters,
    verdicts,
  };
}

function containsAbstention(answer) {
  const text = normalizeText(answer);
  return ABSTENTION_PHRASES.some((phrase) => containsTerm(text, normalizeText(phrase)));
}

// True when the text carries the terms of any entry of the named scenario lists.
function mentionsEntryOf(scenario, lists, text) {
  const haystack = normalizeText(text);
  return lists.some((list) =>
    (scenario[list] ?? []).some((entry) => matchesNormalized(haystack, entry.terms)),
  );
}

function scoreAnswerProbe(scenario, probe, answer, supplied) {
  const terms = matchesTermGroups(answer, probe.expect.terms);
  const forbidden =
    (probe.expect.forbidden !== undefined && matchesTermGroups(answer, probe.expect.forbidden)) ||
    mentionsEntryOf(scenario, NEVER_IN_ANSWER_LISTS, answer);
  const relevantSupplied = supplied.some((entry) =>
    matchesTermGroups(entry.bodyExcerpt ?? "", probe.expect.terms),
  );
  return {
    passed: terms && !forbidden,
    termsPresent: terms,
    forbiddenPresent: forbidden,
    relevantSupplied,
    suppliedCount: supplied.length,
  };
}

// Where a question has no stored answer, no fact of the scenario may surface: not in the answer and
// not in a memory the product handed to the model, whether the fact is true, replaced, forgotten or
// forbidden.
function leakageOf(scenario, answer, supplied) {
  const inAnswer = mentionsEntryOf(scenario, LEAK_LISTS, answer);
  const inSupplied = supplied.some((entry) =>
    mentionsEntryOf(scenario, LEAK_LISTS, entry.bodyExcerpt ?? ""),
  );
  return { inAnswer, inSupplied, leaked: inAnswer || inSupplied };
}

function scoreAbstainProbe(scenario, answer, supplied) {
  const leakage = leakageOf(scenario, answer, supplied);
  const abstained = containsAbstention(answer);
  return {
    passed: abstained && !leakage.leaked,
    abstained,
    leaked: leakage.leaked,
    leakedInSupplied: leakage.inSupplied,
    suppliedCount: supplied.length,
  };
}

function scoreNoMemoryProbe(scenario, answer, supplied) {
  const leakage = leakageOf(scenario, answer, supplied);
  return {
    passed: supplied.length === 0 && !leakage.leaked,
    overApplied: leakage.leaked,
    suppliedCount: supplied.length,
  };
}

/** Scores one probe's answer and the memories supplied for it. */
export function scoreProbe(scenario, probe, answer, supplied) {
  const text = answer ?? "";
  const entries = supplied ?? [];
  switch (probe.expect.kind) {
    case "answer":
      return { id: probe.id, kind: "answer", ...scoreAnswerProbe(scenario, probe, text, entries) };
    case "abstain":
      return { id: probe.id, kind: "abstain", ...scoreAbstainProbe(scenario, text, entries) };
    default:
      return { id: probe.id, kind: "no-memory", ...scoreNoMemoryProbe(scenario, text, entries) };
  }
}

/** True when any hard counter is above zero. */
export function hardCountersViolated(counters) {
  return HARD_COUNTERS.some((name) => (counters[name] ?? 0) > 0);
}

function mean(values) {
  const present = values.filter((value) => typeof value === "number");
  if (present.length === 0) return null;
  return (
    Math.round((present.reduce((sum, value) => sum + value, 0) / present.length) * 10000) / 10000
  );
}

/** Aggregates store and probe scores of several runs into one group row (per class, language, arm). */
export function aggregate(rows) {
  const probes = rows.flatMap((row) => row.probes);
  const counters = emptyCounters();
  for (const row of rows)
    for (const name of HARD_COUNTERS) counters[name] += row.store.counters[name] ?? 0;
  const byKind = (kind) => probes.filter((probe) => probe.kind === kind);
  const passRate = (list) => ratio(list.filter((probe) => probe.passed).length, list.length);
  return {
    runs: rows.length,
    precision: mean(rows.map((row) => row.store.precision)),
    recall: mean(rows.map((row) => row.store.recall)),
    answerAccuracy: passRate(byKind("answer")),
    abstention: passRate(byKind("abstain")),
    noMemoryOnUnrelated: passRate(byKind("no-memory")),
    counters,
  };
}
