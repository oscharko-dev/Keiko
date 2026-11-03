// Focused scenarios of the MemoriaViva corpus (#4208). A person's whole conversation measures every
// class at once, so it can carry only one scenario class, and the report, which groups by scenario
// class, cannot give a class result a noise band from it. A focused scenario is the opposite: it takes
// ONE unit of a blueprint and builds a short conversation around it, carrying the class the report
// needs. Every unit is stated in each way it supports (plain, embedded, noisy and, where the blueprint
// holds a split form of the statement, split), and a build repeats it for every seed, so a handful of
// people yields enough scenarios per class and language.
//
//   unit                                   scenario class                  what it measures
//   fact                                   the fact's class                recall, also without word overlap
//   change                                 update                          the new value, the old one forbidden
//   change marked as a reversal            update and reversal             the same, for a flip of a two-way choice
//   change with a correction               edit-after-learn                the person corrects their earlier message
//   the same, after three questions        entrenchment                    the correction beats a fact that was supplied
//   forget                                 forget                          nothing of the fact survives
//   forget with its paraphrase             forget-paraphrase               the paraphrase is not learned again
//   trap                                   the trap's class                the forbidden content is not stored
//   fact taught inside a colleague's line  third-party                     the person's fact is true, the colleague's is not
//   relational question                    decision                        why a decision was taken
//
// A scenario id encodes where it comes from:
//   <blueprint>-<kind>-<unit>-<hardness>-s<seed>
// with kind one of fact, update, reversal, edit, entrench, forget, forget-paraphrase, trap, taught,
// relational, unit the fact key (trap: the trap's class and position; relational: its position),
// hardness one of the ways a unit is stated in and seed the number given to the build, so several
// seeds live in one directory. An id longer than the scenario format's 64 characters shortens its unit and appends four
// hex digits of it.
import { createHash } from "node:crypto";
import { matchesTermGroups } from "../score.mjs";
import { CorpusError } from "./errors.mjs";
import { generatorSettings, runGeneration, scenarioMeta } from "./generate.mjs";
import { HARDNESS_KINDS, UNSPLIT_KINDS } from "./plan.mjs";
import { deriveSeed } from "./random.mjs";

const ID_LENGTH = 64;
const TRAP_SCENARIO_CLASS = Object.freeze({
  credential: "credential",
  identifier: "identifier",
  "third-party": "third-party",
  hypothetical: "hypothetical",
  quote: "quote",
  question: "question",
  "assistant-claim": "assistant-claim",
  instruction: "instruction-smuggling",
});

const NONE = Object.freeze({ facts: [], changes: [], forgets: [], traps: [], relational: [] });

function factDescriptors(blueprint) {
  return blueprint.facts.map((fact) => ({
    kind: "fact",
    unit: fact.key,
    scenarioClass: fact.class,
    parts: { ...NONE, facts: [fact] },
    interest: "fact",
    probeGroups: ["facts", "controls"],
    paraphrase: true,
  }));
}

function changeDescriptors(blueprint) {
  const byKey = new Map(blueprint.facts.map((fact) => [fact.key, fact]));
  return blueprint.changes.flatMap((change) => {
    const base = {
      unit: change.key,
      parts: { ...NONE, facts: [byKey.get(change.key)], changes: [change] },
      interest: "change",
      probeGroups: ["facts"],
      paraphrase: true,
    };
    const update = { ...base, kind: "update", scenarioClass: "update" };
    return change.reversal === true
      ? [update, { ...base, kind: "reversal", scenarioClass: "reversal" }]
      : [update];
  });
}

// A change whose blueprint holds a correction is also told as the person correcting an earlier
// message of theirs: directly after it was learned (edit-after-learn), or after three questions that
// made the product supply the fact again and again (entrenchment). Both expect the new terms and
// forbid the old, as an update does; without a correction the change has neither scenario.
function correctionDescriptors(blueprint) {
  const byKey = new Map(blueprint.facts.map((fact) => [fact.key, fact]));
  return blueprint.changes
    .filter((change) => change.correction !== undefined)
    .flatMap((change) => {
      const base = {
        unit: change.key,
        parts: { ...NONE, facts: [byKey.get(change.key)], changes: [change] },
        interest: "change",
        probeGroups: ["facts"],
        paraphrase: true,
        edit: true,
      };
      return [
        { ...base, kind: "edit", scenarioClass: "edit-after-learn" },
        { ...base, kind: "entrench", scenarioClass: "entrenchment", asks: true },
      ];
    });
}

function forgetDescriptors(blueprint) {
  const byKey = new Map(blueprint.facts.map((fact) => [fact.key, fact]));
  return blueprint.forgets.flatMap((forget) => {
    const base = {
      unit: forget.key,
      parts: { ...NONE, facts: [byKey.get(forget.key)], forgets: [forget] },
      probeGroups: ["forgets"],
    };
    return [
      { ...base, kind: "forget", scenarioClass: "forget", interest: "fact", paraphrase: false },
      {
        ...base,
        kind: "forget-paraphrase",
        scenarioClass: "forget-paraphrase",
        interest: "paraphrase",
        paraphrase: true,
      },
    ];
  });
}

// A trap without a question cannot be probed, so it has no focused scenario.
function trapDescriptors(blueprint) {
  const byKey = new Map(blueprint.facts.map((fact) => [fact.key, fact]));
  return blueprint.traps.flatMap((trap, index) => {
    if (trap.question === undefined) return [];
    const taught = trap.teaches === undefined ? undefined : byKey.get(trap.teaches);
    if (taught !== undefined)
      return [
        {
          kind: "taught",
          unit: taught.key,
          scenarioClass: "third-party",
          parts: { ...NONE, facts: [taught], traps: [trap] },
          interest: "trap",
          probeGroups: ["facts", "traps"],
          paraphrase: true,
        },
      ];
    return [
      {
        kind: "trap",
        unit: `${trap.class}-${String(index + 1)}`,
        scenarioClass: TRAP_SCENARIO_CLASS[trap.class],
        parts: { ...NONE, traps: [trap] },
        interest: "trap",
        probeGroups: ["traps"],
        paraphrase: true,
      },
    ];
  });
}

function relationalDescriptors(blueprint) {
  return blueprint.relational.map((entry, index) => {
    const decision = blueprint.facts.find(
      (fact) => fact.reason !== undefined && matchesTermGroups(fact.reason, entry.terms),
    );
    return {
      kind: "relational",
      unit: String(index + 1),
      scenarioClass: "decision",
      parts: { ...NONE, facts: [decision], relational: [entry] },
      interest: "fact",
      probeGroups: ["relational"],
      paraphrase: true,
    };
  });
}

/**
 * The ways a focused unit is stated: the four hardness kinds when the statement it is about has a
 * split form in the blueprint, the other three otherwise. A trap and a paraphrase are one sentence,
 * so they are never told over two turns.
 */
export function focusedHardnessKinds(descriptor) {
  const owner = {
    fact: descriptor.parts.facts[0],
    change: descriptor.parts.changes[0],
  }[descriptor.interest];
  return owner?.split === undefined ? UNSPLIT_KINDS : HARDNESS_KINDS;
}

/** Every focused unit of a validated blueprint, in a fixed order. */
export function focusedUnits(blueprint) {
  return [
    ...factDescriptors(blueprint),
    ...changeDescriptors(blueprint),
    ...correctionDescriptors(blueprint),
    ...forgetDescriptors(blueprint),
    ...trapDescriptors(blueprint),
    ...relationalDescriptors(blueprint),
  ];
}

function withoutTrailingHyphens(text) {
  let end = text.length;
  while (end > 0 && text.charAt(end - 1) === "-") end -= 1;
  return text.slice(0, end);
}

/** The id of a focused scenario; see the grammar at the top of this file. */
export function focusedScenarioId({ blueprintId, kind, unit, hardness, seed }) {
  const head = `${blueprintId}-${kind}-`;
  const tail = `-${hardness}-s${String(seed)}`;
  const room = ID_LENGTH - head.length - tail.length;
  if (unit.length <= room) return `${head}${unit}${tail}`;
  if (room < 8)
    throw new CorpusError(`the blueprint id ${blueprintId} leaves no room for a scenario id`);
  const digest = createHash("sha256").update(unit).digest("hex").slice(0, 4);
  return `${head}${withoutTrailingHyphens(unit.slice(0, room - 5))}-${digest}${tail}`;
}

/**
 * Throws a CorpusError when this blueprint's focused ids could not be made for these seeds, so that a
 * build stops before it generates anything instead of after thousands of scenarios. The longest id
 * is a forget-paraphrase scenario stated in the longest hardness kind under the largest seed, and a
 * unit as long as the format allows forces the shortening that needs room for the blueprint id.
 */
export function checkFocusedIdRoom(blueprintId, seeds) {
  focusedScenarioId({
    blueprintId,
    kind: "forget-paraphrase",
    unit: "x".repeat(ID_LENGTH),
    hardness: HARDNESS_KINDS.toSorted((left, right) => right.length - left.length)[0],
    seed: Math.max(...seeds),
  });
}

function describeFocused(blueprint, descriptor, hardness, settings, turnCount) {
  return [
    `Focused ${descriptor.scenarioClass} scenario of ${blueprint.id} (${blueprint.role}, ${blueprint.language}):`,
    `${descriptor.kind} ${descriptor.unit}, stated ${hardness}.`,
    `Generator ${settings.label}; seed ${String(settings.baseSeed)};`,
    `${String(turnCount * 2)} messages in ${String(turnCount)} turns.`,
  ].join(" ");
}

function interestCounts(hardness) {
  return Object.fromEntries(HARDNESS_KINDS.map((kind) => [kind, kind === hardness ? 1 : 0]));
}

/**
 * Generates the focused scenario of one unit, stated in one hardness kind. `options`: `size`,
 * `seed` (the number the build was given; it is derived together with the unit, the hardness and the
 * size, so every combination writes different filler), `writer` and `generatorLabel`, as for a
 * person's conversation. The blueprint must be validated. Returns the scenario, the designated
 * sentences and body-free metadata, with the unit in `meta.focus`.
 */
export async function generateFocusedScenario(blueprint, descriptor, hardness, options) {
  if (!focusedHardnessKinds(descriptor).includes(hardness))
    throw new CorpusError(`${descriptor.kind} ${descriptor.unit} cannot be stated ${hardness}`);
  const derived = deriveSeed(
    options.seed,
    blueprint.id,
    descriptor.kind,
    descriptor.unit,
    hardness,
    options.size,
  );
  const settings = generatorSettings({ ...options, seed: derived, baseSeed: options.seed });
  const id = focusedScenarioId({
    blueprintId: blueprint.id,
    kind: descriptor.kind,
    unit: descriptor.unit,
    hardness,
    seed: options.seed,
  });
  const part = { ...blueprint, ...descriptor.parts };
  const { scenario, designated, plan } = await runGeneration(part, settings, {
    unitOptions: {
      hardnessOf: (unit) => (unit.kind === descriptor.interest ? hardness : "plain"),
      paraphrase: descriptor.paraphrase,
      edit: descriptor.edit === true,
      asks: descriptor.asks === true,
    },
    probeGroups: descriptor.probeGroups,
    paraphrase: descriptor.paraphrase,
    header: ({ turns }) => ({
      id,
      class: descriptor.scenarioClass,
      difficulty: hardness,
      description: describeFocused(blueprint, descriptor, hardness, settings, turns.length),
    }),
  });
  const meta = scenarioMeta({
    blueprint,
    scenario,
    settings,
    plan,
    counts: interestCounts(hardness),
  });
  const focus = { kind: descriptor.kind, unit: descriptor.unit, hardness };
  return { scenario, designated, meta: { ...meta, focus } };
}
