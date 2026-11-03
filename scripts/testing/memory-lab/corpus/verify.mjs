// Validation of a generated scenario against its blueprint (#4208). Generation promises that every
// truth fact survived; this module proves it from the finished scenario alone, independently of how it
// was built, so a faulty plan, writer or edit cannot slip a conversation that lost a fact into the
// corpus: a scenario that fails any check is rejected with a CorpusError and never scored.
import { HARD_COUNTERS, scoreStore } from "../score.mjs";
import { CorpusError } from "./errors.mjs";
import { changeText, factText } from "./oracle.mjs";
import { ASK_COUNT } from "./plan.mjs";
import { forgetCommand } from "./realize.mjs";
import { collectStrings, valueShapeFindings } from "./values.mjs";

const SIZE_TOLERANCE = 0.05;

function reject(message) {
  throw new CorpusError(message);
}

// The sentences that may state a fact or a change: the whole statement or, told over two turns, the
// rule of its split form.
function factTexts(fact) {
  return fact.split === undefined ? [factText(fact)] : [factText(fact), fact.split.rule];
}

function changeTexts(change, edit) {
  const whole = changeText(change, edit);
  return change.split === undefined ? [whole] : [whole, changeText(change, edit, true)];
}

// Everything the blueprint says verbatim, each with the turn kind that must carry it and the texts
// it may carry it in.
function expectedSentences(blueprint, { paraphrase: withParaphrase, edit }) {
  const taught = new Set(blueprint.traps.map((trap) => trap.teaches));
  const byKey = new Map(blueprint.facts.map((fact) => [fact.key, fact]));
  return [
    ...blueprint.facts
      .filter((fact) => !taught.has(fact.key))
      .map((fact) => ({ kind: "fact", key: fact.key, texts: factTexts(fact) })),
    ...blueprint.changes.map((change) => ({
      kind: "change",
      key: change.key,
      texts: changeTexts(change, edit),
    })),
    ...blueprint.forgets.flatMap((forget) => [
      { kind: "restate", key: forget.key, texts: [factText(byKey.get(forget.key))] },
      { kind: "forget", key: forget.key, texts: [forgetCommand(blueprint.language)] },
      ...(withParaphrase
        ? [{ kind: "paraphrase", key: forget.key, texts: [forget.paraphrase] }]
        : []),
    ]),
    ...blueprint.traps.map((trap) => ({
      kind: trap.teaches === undefined ? "trap" : "taught",
      key: trap.teaches,
      texts: [trap.text],
    })),
  ];
}

function checkSize(scenario, size) {
  const messages = scenario.turns.length * 2;
  if (Math.abs(messages - size) > Math.max(2, size * SIZE_TOLERANCE))
    reject(`the scenario has ${String(messages)} messages, not about ${String(size)}`);
}

function checkSurvival(blueprint, scenario, designated, mode) {
  for (const entry of designated) {
    const user = scenario.turns[entry.turn]?.user;
    if (typeof user !== "string" || !user.includes(entry.text))
      reject(
        `the ${entry.kind} sentence of ${entry.key ?? "a trap"} is not verbatim in turn ${String(entry.turn)}`,
      );
  }
  for (const expected of expectedSentences(blueprint, mode)) {
    const found = designated.some(
      (entry) =>
        entry.kind === expected.kind &&
        entry.key === expected.key &&
        expected.texts.includes(entry.text),
    );
    if (!found)
      reject(`the conversation lost the ${expected.kind} sentence of ${expected.key ?? "a trap"}`);
  }
}

function turnOf(designated, kind, key) {
  return designated.find((entry) => entry.kind === kind && entry.key === key)?.turn;
}

function checkOrder(blueprint, designated, { paraphrase: withParaphrase }) {
  for (const change of blueprint.changes)
    if (turnOf(designated, "fact", change.key) >= turnOf(designated, "change", change.key))
      reject(`the change of ${change.key} comes before the fact it changes`);
  for (const { key } of blueprint.forgets) {
    const chain = withParaphrase
      ? ["fact", "restate", "forget", "paraphrase"]
      : ["fact", "restate", "forget"];
    const order = chain.map((kind) => turnOf(designated, kind, key));
    if (
      order.some((turn) => turn === undefined) ||
      order.some((turn, i) => i > 0 && turn <= order[i - 1])
    )
      reject(`the forget sequence of ${key} is out of order or incomplete`);
  }
}

// The questions of an entrenchment scenario: ASK_COUNT per change, each ending with the fact's apply
// question and stating nothing, strictly between the fact and its correction.
function checkAsks(blueprint, designated, isClean) {
  const byKey = new Map(blueprint.facts.map((fact) => [fact.key, fact]));
  for (const change of blueprint.changes) {
    const asks = designated.filter((entry) => entry.kind === "ask" && entry.key === change.key);
    const question = byKey.get(change.key).applyQuestion;
    if (
      asks.length !== ASK_COUNT ||
      asks.some((ask) => !ask.text.endsWith(question) || !isClean(ask.text))
    )
      reject(`the questions about ${change.key} are not ${String(ASK_COUNT)} clean questions`);
    const turns = [
      turnOf(designated, "fact", change.key),
      ...asks.map((ask) => ask.turn),
      turnOf(designated, "change", change.key),
    ];
    if (turns.some((turn, i) => turn === undefined || (i > 0 && turn <= turns[i - 1])))
      reject(`the questions about ${change.key} are not between the fact and its correction`);
  }
}

function ownerOf(blueprint, entry) {
  if (entry.kind === "fact") return blueprint.facts.find((fact) => fact.key === entry.key);
  if (entry.kind === "change") return blueprint.changes.find((change) => change.key === entry.key);
  return undefined;
}

// The text of a statement told over two turns, as its turn holds it.
function splitText(entry, owner, edit) {
  return entry.kind === "fact" ? owner.split.rule : changeText(owner, edit, true);
}

// The statements of a scenario that are told over two turns: the designated rule sentences.
function splitStatements(blueprint, designated, edit) {
  return designated.flatMap((entry) => {
    const owner = ownerOf(blueprint, entry);
    const told = owner?.split !== undefined && entry.text === splitText(entry, owner, edit);
    return told ? [{ entry, owner }] : [];
  });
}

// A rule follows its lead directly, and its learner extracts the rule alone: the verbatim second
// sentence, without its subject and without any correction in front of it.
function checkSplitStatement(scenario, designated, { entry, owner }) {
  const lead = designated.find((other) => other.kind === "lead" && other.turn === entry.turn - 1);
  if (lead?.key !== entry.key || lead.text !== owner.split.lead)
    reject(`the rule of ${entry.key} does not follow its lead`);
  const items = scenario.turns[entry.turn]?.learner ?? [];
  if (items.length !== 1 || items[0].body !== owner.split.rule)
    reject(
      `the learner of the split ${entry.kind} of ${entry.key} does not extract its rule alone`,
    );
}

// A statement told over two turns follows its lead, and a lead is always followed by its statement.
function checkLeads(blueprint, scenario, designated, { edit }) {
  for (const split of splitStatements(blueprint, designated, edit))
    checkSplitStatement(scenario, designated, split);
  for (const lead of designated.filter((entry) => entry.kind === "lead")) {
    const next = designated.find((entry) => entry.turn === lead.turn + 1);
    if (next?.key !== lead.key) reject(`the lead of ${lead.key} is not followed by its rule`);
  }
}

// What a correct learner extracts from the paraphrase of a forgotten fact is the paraphrase itself,
// or the product's refusal to learn it again would never be tried.
function checkParaphrases(scenario, designated) {
  for (const entry of designated.filter((other) => other.kind === "paraphrase")) {
    const items = scenario.turns[entry.turn]?.learner ?? [];
    if (!items.some((item) => item.body === entry.text))
      reject(`the paraphrase of ${entry.key} carries no learner item`);
  }
}

function acceptedBodies(blueprint, fact) {
  const owner =
    blueprint.changes.find((change) => change.key === fact.key) ??
    blueprint.facts.find((candidate) => candidate.key === fact.key);
  return owner?.split === undefined ? [fact.seed] : [fact.seed, owner.split.rule];
}

function checkLearner(blueprint, scenario, designated) {
  const taught = new Set(designated.filter((entry) => entry.kind === "taught").map((e) => e.turn));
  for (const [index, turn] of scenario.turns.entries()) {
    if (taught.has(index)) continue;
    for (const item of turn.learner ?? [])
      if (!turn.user.includes(item.body))
        reject(`a learner item of turn ${String(index)} is not in the turn`);
  }
  for (const fact of scenario.truth) {
    const bodies = acceptedBodies(blueprint, fact);
    const learnt = scenario.turns.some((turn) =>
      (turn.learner ?? []).some((item) => bodies.includes(item.body)),
    );
    if (!learnt) reject(`no turn teaches the truth fact ${fact.key} to a correct learner`);
  }
}

function checkLeaks(scenario, designated, isClean) {
  const byTurn = new Map(designated.map((entry) => [entry.turn, entry.text]));
  for (const [index, turn] of scenario.turns.entries()) {
    const owned = byTurn.get(index);
    const rest = owned === undefined ? turn.user : turn.user.replace(owned, " ");
    if (!isClean(rest) || !isClean(turn.assistant))
      reject(
        `turn ${String(index)} states a fact, a value or a memory command outside its sentence`,
      );
  }
}

function checkValues(scenario) {
  for (const text of collectStrings(scenario))
    if (valueShapeFindings(text).some((finding) => !finding.allowed))
      reject("the scenario holds a value outside the fake-value grammar");
}

// A perfect memory, built from the truth list, must score perfectly with the scorer's own code.
function checkPerfectStore(scenario) {
  const memories = scenario.truth.map((fact, index) => ({
    id: `perfect-${String(index)}`,
    status: "accepted",
    body: fact.seed,
    scope: { kind: "user" },
  }));
  const store = scoreStore(memories, scenario);
  const clean = HARD_COUNTERS.every((name) => store.counters[name] === 0);
  const imperfect = store.precision !== null && store.precision !== 1;
  if (!clean || store.missing.length > 0 || imperfect)
    reject("a perfect memory does not score perfectly against the scenario's own oracle");
}

/**
 * Validates a generated scenario; throws CorpusError on the first defect. `paraphrase: false` is for
 * a focused scenario that forgets a fact without restating it later in other words, `edit: true` for
 * one whose changes are corrections of the earlier message and `asks: true` for one that asks about
 * each changed fact before it is corrected.
 */
export function verifyScenario({
  blueprint,
  scenario,
  designated,
  size,
  isClean,
  paraphrase = true,
  edit = false,
  asks = false,
}) {
  const mode = { paraphrase, edit };
  checkSize(scenario, size);
  checkSurvival(blueprint, scenario, designated, mode);
  checkOrder(blueprint, designated, mode);
  if (asks) checkAsks(blueprint, designated, isClean);
  checkLearner(blueprint, scenario, designated);
  checkLeads(blueprint, scenario, designated, mode);
  if (paraphrase) checkParaphrases(scenario, designated);
  checkLeaks(scenario, designated, isClean);
  checkValues(scenario);
  checkPerfectStore(scenario);
}
