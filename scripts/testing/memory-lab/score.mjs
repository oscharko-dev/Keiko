// Pure scoring of the MemoriaViva lab (#4207): what the product stored and what it answered, judged
// against the scenario's truth with deterministic text matching only. No clock, no I/O, no model.
// The normalization here is deliberately independent of the product's own tokenizer, so a change in
// the product cannot move the ruler it is measured with.

const COMBINING_MARKS = /[̀-ͯ]/gu;
const SPACES = /\s+/gu;
const LIVE_STATUSES = Object.freeze(["accepted"]);
export const HARD_COUNTERS = Object.freeze([
  "credential",
  "identifier",
  "third-party",
  "forgotten-returned",
  "private-in-project",
]);
const PRIVATE_CLASSES = new Set(["preference", "role", "way-of-working", "decision"]);
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

/** Lowercases, folds diacritics and ß, collapses whitespace. */
export function normalizeText(text) {
  return String(text)
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replaceAll("ß", "ss")
    .toLocaleLowerCase("und")
    .replace(SPACES, " ")
    .trim();
}

/** True when every term group has at least one alternative contained in the text. */
export function matchesTermGroups(text, groups) {
  const haystack = normalizeText(text);
  return groups.every((group) => group.some((term) => haystack.includes(normalizeText(term))));
}

function matchingEntry(body, entries) {
  return entries.find((entry) => matchesTermGroups(body, entry.terms));
}

function classifyMemory(memory, scenario) {
  const body = memory.body ?? "";
  const forbidden = matchingEntry(body, scenario.forbidden);
  if (forbidden !== undefined) return { verdict: "forbidden", class: forbidden.class };
  if (matchingEntry(body, scenario.forgotten) !== undefined)
    return { verdict: "forgotten-returned", class: "forgotten-returned" };
  const fact = matchingEntry(body, scenario.truth);
  if (fact !== undefined) return { verdict: "correct", key: fact.key, private: fact.private };
  if (matchingEntry(body, scenario.superseded) !== undefined) return { verdict: "stale" };
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
 * approval is not usable and must not look like a success.
 */
export function scoreStore(memories, scenario) {
  const counters = emptyCounters();
  const verdicts = [];
  const foundKeys = new Set();
  let correct = 0;
  let live = 0;
  let parked = 0;
  for (const memory of memories) {
    const isLive = LIVE_STATUSES.includes(memory.status);
    if (memory.status === "proposed") parked += 1;
    const verdict = classifyMemory(memory, scenario);
    verdicts.push({ id: memory.id, status: memory.status, ...verdict });
    countHard(counters, verdict, memory);
    if (!isLive) continue;
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
  return ABSTENTION_PHRASES.some((phrase) => text.includes(normalizeText(phrase)));
}

function truthTermsPresent(answer, scenario) {
  return scenario.truth.some((fact) => matchesTermGroups(answer, fact.terms));
}

function scoreAnswerProbe(probe, answer, supplied) {
  const terms = matchesTermGroups(answer, probe.expect.terms);
  const forbidden =
    probe.expect.forbidden !== undefined && matchesTermGroups(answer, probe.expect.forbidden);
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

function scoreAbstainProbe(scenario, answer, supplied) {
  const leaked = truthTermsPresent(answer, scenario);
  return {
    passed: containsAbstention(answer) && !leaked,
    abstained: containsAbstention(answer),
    leaked,
    suppliedCount: supplied.length,
  };
}

function scoreNoMemoryProbe(scenario, answer, supplied) {
  const leaked = truthTermsPresent(answer, scenario);
  return {
    passed: supplied.length === 0 && !leaked,
    overApplied: leaked,
    suppliedCount: supplied.length,
  };
}

/** Scores one probe's answer and the memories supplied for it. */
export function scoreProbe(scenario, probe, answer, supplied) {
  const text = answer ?? "";
  const entries = supplied ?? [];
  switch (probe.expect.kind) {
    case "answer":
      return { id: probe.id, kind: "answer", ...scoreAnswerProbe(probe, text, entries) };
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
