// The plan of a generated conversation (#4208): which turn carries which part of the blueprint,
// before any text exists. The plan is pure: the same blueprint, turn count and random source give the
// same plan. Facts and traps are placed by the seeded random source; changes and forgets sit at the
// position the blueprint names; a fact that later changes or is forgotten is always placed before
// that event; a `split` fact takes two consecutive turns (the subject and the rule), a forget takes
// two (the restatement and the command), and the paraphrase of a forgotten fact comes later. An
// entrenchment scenario adds the questions that make the product supply a fact over and over before
// it is corrected, laid out at fixed places so that all of them fall between the fact and the
// correction.
import { CorpusError } from "./errors.mjs";
import { opensWithMemoryCommand } from "./text.mjs";

/** The ways a fact is stated: bare, inside a paragraph, across two turns, or among small talk. */
export const HARDNESS_KINDS = Object.freeze(["plain", "embedded", "split", "noisy"]);
/**
 * The ways left for a unit that cannot be told over two turns: a statement whose blueprint holds no
 * split form, and a trap or a paraphrase, which is one sentence by nature.
 */
export const UNSPLIT_KINDS = Object.freeze(["plain", "embedded", "noisy"]);
const PARAPHRASE_GAP = 0.12;
const PARAPHRASE_SPREAD = 0.18;
const PARAPHRASE_LIMIT = 0.97;

/** How many questions of the person make the product supply a fact before it is corrected. */
export const ASK_COUNT = 3;
const ASK_ANCHORS = Object.freeze([0.42, 0.56, 0.7]);
const CORRECTION_ANCHOR = 0.82;
// A question opens with a neutral lead and then asks the fact's apply question, which shares no word
// with the fact, so it surfaces the memory without stating anything the memory could hold.
const ASK_LEADS = Object.freeze({
  de: [
    "Kurze Frage:",
    "Noch etwas zu meiner Arbeit:",
    "Damit ich nichts durcheinanderbringe:",
    "Bevor ich weitermache:",
    "Nur zur Orientierung:",
    "Ich brauche gleich eine Auskunft von dir:",
  ],
  en: [
    "Quick question:",
    "One more thing about my work:",
    "So that I do not mix anything up:",
    "Before I carry on:",
    "Just to get my bearings:",
    "I need a quick answer from you:",
  ],
});

function factUnits(blueprint, entrenched) {
  const taught = new Set(blueprint.traps.map((trap) => trap.teaches));
  // The fact comes before the first question of an entrenchment scenario, not just before its change.
  const changed = (change) => (entrenched ? `ask:${change.key}:0` : `change:${change.key}`);
  const events = new Map([
    ...blueprint.changes.map((change) => [change.key, changed(change)]),
    ...blueprint.forgets.map((forget) => [forget.key, `forget:${forget.key}`]),
  ]);
  return blueprint.facts
    .filter((fact) => !taught.has(fact.key))
    .map((fact) => ({
      id: `fact:${fact.key}`,
      kind: "fact",
      fact,
      mustPrecede: events.get(fact.key),
    }));
}

function changeUnits(blueprint, byKey, options) {
  return blueprint.changes.map((change) => ({
    id: `change:${change.key}`,
    kind: "change",
    fact: byKey.get(change.key),
    change,
    anchor: options.asks === true ? CORRECTION_ANCHOR : change.position,
    edit: options.edit === true,
  }));
}

// The questions between a fact and its correction, each a plain turn of its own.
function askUnits(blueprint, byKey, random) {
  const leads = ASK_LEADS[blueprint.language];
  return blueprint.changes.flatMap((change) => {
    const fact = byKey.get(change.key);
    return random
      .shuffle(leads)
      .slice(0, ASK_COUNT)
      .map((lead, index) => ({
        id: `ask:${change.key}:${String(index)}`,
        kind: "ask",
        fact,
        text: `${lead} ${fact.applyQuestion}`,
        anchor: ASK_ANCHORS[index],
        hardness: "plain",
        length: 1,
      }));
  });
}

function forgetUnits(blueprint, byKey, random, withParaphrase) {
  return blueprint.forgets.flatMap((forget) => {
    const fact = byKey.get(forget.key);
    const command = {
      id: `forget:${forget.key}`,
      kind: "forget",
      fact,
      forget,
      anchor: forget.position,
      length: 2,
      hardness: "plain",
    };
    if (!withParaphrase) return [command];
    const later = forget.position + PARAPHRASE_GAP + random.next() * PARAPHRASE_SPREAD;
    const paraphrase = {
      id: `paraphrase:${forget.key}`,
      kind: "paraphrase",
      fact,
      forget,
      anchor: Math.min(PARAPHRASE_LIMIT, later),
      mustFollow: command.id,
    };
    return [command, paraphrase];
  });
}

function trapUnits(blueprint, byKey, bareCommands) {
  return blueprint.traps.map((trap, index) => ({
    id: `trap:${String(index)}`,
    kind: "trap",
    trap,
    fact: trap.teaches === undefined ? undefined : byKey.get(trap.teaches),
    // A command only acts at the start of a turn, so a trap that is one stays bare.
    hardness: bareCommands && opensWithMemoryCommand(trap.text) ? "plain" : undefined,
  }));
}

// Cycling a shuffled list guarantees that every kind appears as soon as there are enough units.
function cycle(units, kinds, random) {
  return new Map(
    random.shuffle(units).map((unit, index) => [unit.id, kinds[index % kinds.length]]),
  );
}

// True for a fact or a change whose blueprint holds the split form of its statement.
function canSplit(unit) {
  if (unit.kind === "fact") return unit.fact.split !== undefined;
  if (unit.kind === "change") return unit.change.split !== undefined;
  return false;
}

function withHardness(units, random) {
  const statements = units.filter((unit) => unit.kind === "fact" || unit.kind === "change");
  const surrounded = units.filter(
    (unit) => (unit.kind === "trap" || unit.kind === "paraphrase") && unit.hardness === undefined,
  );
  const hardness = new Map([
    ...cycle(
      statements.filter((unit) => canSplit(unit)),
      HARDNESS_KINDS,
      random,
    ),
    ...cycle(
      statements.filter((unit) => !canSplit(unit)),
      UNSPLIT_KINDS,
      random,
    ),
    ...cycle(surrounded, UNSPLIT_KINDS, random),
  ]);
  return units.map((unit) => {
    const kind = unit.hardness ?? hardness.get(unit.id);
    return { ...unit, hardness: kind, length: unit.length ?? (kind === "split" ? 2 : 1) };
  });
}

// Hardness given by the caller instead of drawn: the units of a focused scenario are stated in the
// one way the scenario is about, and everything around them plainly.
function givenHardness(units, hardnessOf) {
  return units.map((unit) => {
    const kind = unit.hardness ?? hardnessOf(unit);
    if (kind === "split" && !canSplit(unit))
      throw new CorpusError(`${unit.id} has no split form to be told over two turns`);
    return { ...unit, hardness: kind, length: unit.length ?? (kind === "split" ? 2 : 1) };
  });
}

/**
 * Every unit of the conversation, with its hardness and the number of consecutive turns it takes.
 * `options.hardnessOf(unit)` replaces the drawn hardness (and lets a memory command be stated in any
 * way); `options.paraphrase: false` leaves the paraphrase of a forgotten fact out; `options.edit`
 * makes each change a correction of the earlier message; `options.asks` adds the questions that make
 * the product supply each changed fact before its correction.
 */
export function buildUnits(blueprint, random, options = {}) {
  const byKey = new Map(blueprint.facts.map((fact) => [fact.key, fact]));
  const drawn = options.hardnessOf === undefined;
  const entrenched = options.asks === true;
  const units = [
    ...factUnits(blueprint, entrenched),
    ...changeUnits(blueprint, byKey, options),
    ...(entrenched ? askUnits(blueprint, byKey, random) : []),
    ...forgetUnits(blueprint, byKey, random, options.paraphrase !== false),
    ...trapUnits(blueprint, byKey, drawn),
  ];
  return drawn ? withHardness(units, random) : givenHardness(units, options.hardnessOf);
}

function isFree(slots, start, length) {
  for (let offset = 0; offset < length; offset += 1)
    if (slots[start + offset] !== undefined) return false;
  return true;
}

// The free run of `length` turns closest to `target`, searched outwards, inside [lo, hi].
function nearestFree(slots, target, length, lo, hi) {
  const last = hi - length + 1;
  if (last < lo) return undefined;
  const centre = Math.min(Math.max(target, lo), last);
  for (let distance = 0; distance <= last - lo; distance += 1) {
    for (const start of distance === 0 ? [centre] : [centre + distance, centre - distance])
      if (start >= lo && start <= last && isFree(slots, start, length)) return start;
  }
  return undefined;
}

/** The refusal of a turn count that cannot hold every part; the generator grows the conversation on it. */
export class TooShortError extends CorpusError {}

function tooShort(turnCount) {
  return new TooShortError(
    `${String(turnCount)} turns are too few to place every part of the blueprint`,
  );
}

/**
 * Places the units on `turnCount` turns. Returns `slots` (a turn index to `{ unit, part }`, undefined
 * for a filler turn) and `starts` (a unit id to its first turn). The first turn is always filler.
 */
export function placeUnits(units, turnCount, random) {
  const slots = Array.from({ length: turnCount });
  const starts = new Map();
  const last = turnCount - 1;
  const place = (unit, target, lo, hi) => {
    const start = nearestFree(slots, target, unit.length, lo, hi);
    if (start === undefined) throw tooShort(turnCount);
    for (let part = 0; part < unit.length; part += 1) slots[start + part] = { unit, part };
    starts.set(unit.id, start);
  };
  const anchored = units
    .filter((unit) => unit.anchor !== undefined && unit.mustFollow === undefined)
    .toSorted((left, right) => left.anchor - right.anchor);
  for (const unit of anchored) place(unit, Math.floor(unit.anchor * turnCount), 1, last);
  for (const unit of units.filter((entry) => entry.mustFollow !== undefined))
    place(unit, Math.floor(unit.anchor * turnCount), starts.get(unit.mustFollow) + 2, last);
  for (const unit of units.filter((entry) => entry.mustPrecede !== undefined)) {
    const limit = starts.get(unit.mustPrecede) - 1;
    place(unit, random.int(1, Math.max(1, limit - unit.length + 1)), 1, limit);
  }
  const free = units.filter((unit) => unit.anchor === undefined && unit.mustPrecede === undefined);
  for (const unit of random.shuffle(free))
    place(unit, random.int(1, Math.max(1, last - unit.length + 1)), 1, last);
  return { slots, starts };
}

/** Counts of the four hardness kinds over the units that state a fact or its change. */
export function hardnessCounts(units) {
  const counts = Object.fromEntries(HARDNESS_KINDS.map((kind) => [kind, 0]));
  for (const unit of units)
    if (unit.kind === "fact" || unit.kind === "change") counts[unit.hardness] += 1;
  return counts;
}
