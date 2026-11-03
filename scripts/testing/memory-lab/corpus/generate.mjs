// The generator of the MemoriaViva corpus (#4208): a blueprint becomes a scenario of a stated size.
//
// The truth comes first. The blueprint fixes the facts, the changes, the forgets and the traps before
// any text exists; the generator plans which turn carries which part, lets a writer produce only the
// filler and the words around the facts, inserts every fact sentence verbatim, derives the probes from
// the facts and then proves from the finished scenario that every fact survived. A conversation that
// lost one is rejected with a CorpusError, never scored. The result is a scenario of format version 1,
// validated by the same code as the hand-written ones.
import { validateScenario } from "../scenario.mjs";
import { blueprintDigest, validateBlueprint } from "./blueprint.mjs";
import { deriveOracle } from "./oracle.mjs";
import { HARDNESS_KINDS, buildUnits, hardnessCounts, placeUnits } from "./plan.mjs";
import { deriveProbes } from "./probes.mjs";
import { createRandom } from "./random.mjs";
import { createCleanTester, createContext, realizePlan } from "./realize.mjs";
import { verifyScenario } from "./verify.mjs";

export { CorpusError } from "./errors.mjs";

const SCENARIO_SCHEMA_VERSION = 1;
const MIN_SIZE = 10;
// A person's conversation is a multi-turn scenario; the per-class results come from the probes.
const PERSON_CLASS = "multi-turn";
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._:@/-]{0,79}$/u;

/** The generator label recorded in every scenario; plain characters only, at most 80. */
export function checkGeneratorLabel(label) {
  if (typeof label !== "string" || !LABEL.test(label))
    throw new RangeError("the generator label must be 1 to 80 plain characters");
  return label;
}

/**
 * The validated settings of one generation: `size` (messages, user and assistant both counted),
 * `seed` (the integer that makes a scenario reproducible), `writer` (the writer port), the recorded
 * `generatorLabel` (defaults to the writer's id) and the optional `baseSeed` the caller derived the
 * seed from, which a focused scenario carries in its id.
 */
export function generatorSettings(options) {
  const { size, seed, writer, generatorLabel, baseSeed } = options ?? {};
  if (!Number.isSafeInteger(size) || size < MIN_SIZE)
    throw new RangeError(`size must be an integer of at least ${String(MIN_SIZE)} messages`);
  if (!Number.isSafeInteger(seed) || seed < 0) throw new RangeError("seed must be an integer >= 0");
  const complete = ["exchanges", "paragraph", "sentence"].every(
    (method) => typeof writer?.[method] === "function",
  );
  if (!complete || typeof writer.id !== "string")
    throw new TypeError("writer needs an id and the methods exchanges, paragraph and sentence");
  return {
    size,
    seed,
    baseSeed: baseSeed ?? seed,
    writer,
    label: checkGeneratorLabel(generatorLabel ?? writer.id),
  };
}

function describeScenario(blueprint, settings, turnCount, counts) {
  const mix = HARDNESS_KINDS.map((kind) => `${kind}=${String(counts[kind])}`).join(" ");
  return [
    `Synthetic person ${blueprint.id} (${blueprint.role}, ${blueprint.language}).`,
    `Generator ${settings.label}; seed ${String(settings.seed)};`,
    `${String(turnCount * 2)} messages in ${String(turnCount)} turns; hardness ${mix}.`,
  ].join(" ");
}

// What differs between a person's whole conversation and a focused scenario: which units exist and
// how they are stated, which probes are asked, and the scenario's id, class, difficulty and text.
function personShape(blueprint, settings) {
  return {
    unitOptions: {},
    probeGroups: undefined,
    paraphrase: true,
    header: ({ turns, counts }) => ({
      id: `${blueprint.id}-m${String(settings.size)}`,
      class: PERSON_CLASS,
      difficulty: HARDNESS_KINDS.findLast((kind) => counts[kind] > 0) ?? "plain",
      description: describeScenario(blueprint, settings, turns.length, counts),
    }),
  };
}

function assembleScenario({ blueprint, header, oracle, turns, probes }) {
  const optional = (name, list) => (list.length > 0 ? { [name]: list } : {});
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    ...header,
    language: blueprint.language,
    truth: oracle.truth,
    ...optional("superseded", oracle.superseded),
    ...optional("forgotten", oracle.forgotten),
    ...optional("forbidden", oracle.forbidden),
    turns,
    probes,
  };
}

/**
 * Body-free metadata of a generated scenario for the manifest; `hardness` counts the units that
 * state a fact or its change, unless the caller passes the counts it wants reported.
 */
export function scenarioMeta({ blueprint, scenario, settings, plan, counts }) {
  return {
    scenarioId: scenario.id,
    blueprintId: blueprint.id,
    blueprintDigest: blueprintDigest(blueprint),
    language: blueprint.language,
    role: blueprint.role,
    size: settings.size,
    messages: scenario.turns.length * 2,
    turns: scenario.turns.length,
    seed: settings.seed,
    baseSeed: settings.baseSeed,
    generator: settings.label,
    writer: settings.writer.id,
    hardness: counts,
    fillerTurns: plan.slots.filter((slot) => slot === undefined).length,
    learnerTurns: scenario.turns.filter((turn) => turn.learner !== undefined).length,
    probes: scenario.probes.length,
  };
}

/**
 * The pipeline both modes share, over a blueprint that is already validated (or a part of one):
 * plan, write, assemble, then prove from the finished scenario that every fact survived.
 */
export async function runGeneration(blueprint, settings, shape) {
  const oracle = deriveOracle(blueprint);
  const random = createRandom(settings.seed);
  const units = buildUnits(blueprint, random, shape.unitOptions);
  const plan = { units, ...placeUnits(units, Math.round(settings.size / 2), random) };
  const isClean = createCleanTester(oracle);
  const context = createContext({ blueprint, writer: settings.writer, random, isClean });
  const { turns, designated } = await realizePlan(plan, context);
  const counts = hardnessCounts(units);
  const probes = deriveProbes(blueprint, random, shape.probeGroups);
  const header = shape.header({ turns, counts });
  const scenario = validateScenario(assembleScenario({ blueprint, header, oracle, turns, probes }));
  verifyScenario({
    blueprint,
    scenario,
    designated,
    size: settings.size,
    isClean,
    paraphrase: shape.paraphrase,
    edit: shape.unitOptions.edit === true,
    asks: shape.unitOptions.asks === true,
  });
  return { scenario, designated, plan, counts };
}

/**
 * Generates one scenario from a blueprint. `options`: `size` (messages, user and assistant both
 * counted), `seed` (integer; the same inputs give the same scenario), `writer` (the writer port),
 * `generatorLabel` (recorded in the description; defaults to the writer's id). Returns the scenario,
 * the designated sentences (kind, key, verbatim text and turn) and body-free metadata for the manifest.
 */
export async function generateScenario(blueprint, options) {
  const settings = generatorSettings(options);
  const checked = validateBlueprint(blueprint);
  const { scenario, designated, plan, counts } = await runGeneration(
    checked,
    settings,
    personShape(checked, settings),
  );
  const meta = scenarioMeta({ blueprint: checked, scenario, settings, plan, counts });
  return { scenario, designated, meta };
}
