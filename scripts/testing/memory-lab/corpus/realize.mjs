// Turns a conversation plan into text (#4208). Every fact, change, restatement, paraphrase and trap
// sentence comes from the blueprint and is inserted verbatim; a writer supplies only the filler and the
// words around it. Everything a writer returns is checked before it is used: it must be text, it must
// state none of the blueprint's facts, hold no value-shaped string and start no memory command, and a
// paragraph must carry the fact marker exactly once. A writer that fails is asked again a few times and
// then the build stops with a CorpusError, so a conversation never silently loses a fact.
import { normalizeText } from "../score.mjs";
import { CorpusError } from "./errors.mjs";
import { LEARNER_TYPE, changeText, compileTermGroups, factText, statementText } from "./oracle.mjs";
import { mapSequential } from "./sequence.mjs";
import { startsWithMemoryCommand } from "./text.mjs";
import { forbiddenValueKinds } from "./values.mjs";
import { FACT_MARKER } from "./writer-port.mjs";

const MAX_WRITER_ATTEMPTS = 4;
const MAX_TEXT_CHARS = 1200;
const FILLER_BLOCK = 10;
const FORGET_COMMANDS = Object.freeze({ de: "Vergiss das.", en: "Forget that." });

/** The command that forgets the fact restated just before it. */
export function forgetCommand(language) {
  return FORGET_COMMANDS[language];
}

/** A predicate over text: true when a writer's sentence may appear in the corpus. */
export function createCleanTester(oracle) {
  const matchers = [
    ...oracle.truth,
    ...oracle.superseded,
    ...oracle.forgotten,
    ...oracle.forbidden,
  ].map((entry) => compileTermGroups(entry.terms));
  return (text) => {
    if (text.includes("[[") || text.includes("]]")) return false;
    if (forbiddenValueKinds(text).length > 0 || startsWithMemoryCommand(text)) return false;
    const haystack = normalizeText(text);
    return !matchers.some((matches) => matches(haystack));
  };
}

function checkedText(value, isClean, what) {
  if (typeof value !== "string") return { problem: `${what} is not text` };
  const text = value.replace(/\s+/gu, " ").trim();
  if (text.length === 0) return { problem: `${what} is empty` };
  if (text.length > MAX_TEXT_CHARS)
    return { problem: `${what} is longer than ${String(MAX_TEXT_CHARS)}` };
  if (!isClean(text)) return { problem: `${what} states a fact, a value or a memory command` };
  return { text };
}

function checkSingle(value, isClean, what) {
  const result = checkedText(value, isClean, what);
  return result.problem === undefined ? { value: result.text } : result;
}

function checkParagraph(value, isClean) {
  if (typeof value !== "string") return { problem: "the paragraph is not text" };
  const markers = value.split(FACT_MARKER).length - 1;
  if (markers !== 1)
    return { problem: `the paragraph holds the fact marker ${String(markers)} times, not once` };
  const around = checkedText(value.replace(FACT_MARKER, " "), isClean, "the paragraph");
  if (around.problem !== undefined) return around;
  if (around.text.length < 20) return { problem: "the paragraph holds no text around the marker" };
  return { value: value.replace(/\s+/gu, " ").trim() };
}

function checkExchanges(value, count, isClean) {
  if (!Array.isArray(value) || value.length !== count)
    return { problem: `expected ${String(count)} exchanges` };
  const exchanges = [];
  for (const item of value) {
    const user = checkedText(item?.user, isClean, "an exchange's user text");
    const assistant = checkedText(item?.assistant, isClean, "an exchange's assistant text");
    const problem = user.problem ?? assistant.problem;
    if (problem !== undefined) return { problem };
    exchanges.push({ user: user.text, assistant: assistant.text });
  }
  return { value: exchanges };
}

// A bounded retry as a recursion, so that no `await` sits inside a loop.
async function requestChecked(call, check, attempt = 1) {
  const result = check(await call());
  if (result.problem === undefined) return result.value;
  if (attempt >= MAX_WRITER_ATTEMPTS)
    throw new CorpusError(`the writer's text was rejected: ${result.problem}`);
  return requestChecked(call, check, attempt + 1);
}

/** The checked access to a writer: every method returns validated text or throws CorpusError. */
export function createContext({ blueprint, writer, random, isClean }) {
  const base = {
    language: blueprint.language,
    role: blueprint.role,
    styleNotes: blueprint.styleNotes,
    random,
    isClean,
  };
  return {
    blueprint,
    exchanges: (count) =>
      requestChecked(
        () => writer.exchanges({ ...base, count }),
        (value) => checkExchanges(value, count, isClean),
      ),
    paragraph: (hardness) =>
      requestChecked(
        () => writer.paragraph({ ...base, hardness }),
        (value) => checkParagraph(value, isClean),
      ),
    sentence: (kind) =>
      requestChecked(
        () => writer.sentence({ ...base, kind }),
        (value) => checkSingle(value, isClean, `the ${kind} sentence`),
      ),
  };
}

async function surround(context, text, hardness) {
  if (hardness === "plain" || hardness === "split") return text;
  const paragraph = await context.paragraph(hardness);
  return paragraph.replace(FACT_MARKER, () => text);
}

// A statement told over two turns: the blueprint's lead names the subject and the next turn holds
// the rule alone, so a learner that reads one turn at a time can only store the rule without its
// subject. `spec.learner` is the verbatim rule; any correction in front of it is not extracted.
async function splitStatement(context, spec) {
  if (spec.split === undefined)
    throw new CorpusError(`the ${spec.kind} of ${spec.key ?? "a trap"} has no split form`);
  const opening = {
    user: spec.split.lead,
    assistant: await context.sentence("lead-answer"),
  };
  const rule = { user: spec.text, assistant: await context.sentence("ack"), learner: spec.learner };
  return [
    { turn: opening, designated: { kind: "lead", key: spec.key, text: spec.split.lead } },
    { turn: rule, designated: { kind: spec.kind, key: spec.key, text: spec.text } },
  ];
}

// One statement of the blueprint: the verbatim text, the way it is stated, what a correct learner
// extracts from it and what the validator must find in it afterwards.
async function statement(context, spec) {
  if (spec.hardness === "split") return splitStatement(context, spec);
  const user = await surround(context, spec.text, spec.hardness);
  const assistant = await context.sentence("ack");
  const learner = spec.learner ?? [];
  const turn = { user, assistant, ...(learner.length > 0 ? { learner } : {}) };
  return [{ turn, designated: { kind: spec.kind, key: spec.key, text: spec.text } }];
}

function learnerItem(fact, body) {
  return [{ body, type: LEARNER_TYPE[fact.class] }];
}

function realizeFact(unit, context) {
  const split = unit.hardness === "split";
  const text = statementText(unit.fact, split && unit.fact.split !== undefined);
  return statement(context, {
    kind: "fact",
    key: unit.fact.key,
    text,
    hardness: unit.hardness,
    split: unit.fact.split,
    learner: learnerItem(unit.fact, text),
  });
}

// The learner extracts the new statement only (its rule, when it is told over two turns): a
// correction in front of it is the person's way of saying that the earlier message was wrong, and it
// may name the old value.
function realizeChange(unit, context) {
  const split = unit.hardness === "split" && unit.change.split !== undefined;
  return statement(context, {
    kind: "change",
    key: unit.change.key,
    text: changeText(unit.change, unit.edit, split),
    hardness: unit.hardness,
    split: unit.change.split,
    learner: learnerItem(unit.fact, split ? unit.change.split.rule : unit.change.seed),
  });
}

// A question that makes the product supply the fact; there is nothing in it to learn.
async function realizeAsk(unit, context) {
  const turn = { user: unit.text, assistant: await context.sentence("ack") };
  return [{ turn, designated: { kind: "ask", key: unit.fact.key, text: unit.text } }];
}

async function realizeForget(unit, context) {
  const restated = factText(unit.fact);
  const first = { user: restated, assistant: await context.sentence("ack") };
  const command = forgetCommand(context.blueprint.language);
  const second = { user: command, assistant: await context.sentence("ack") };
  return [
    { turn: first, designated: { kind: "restate", key: unit.fact.key, text: restated } },
    { turn: second, designated: { kind: "forget", key: unit.fact.key, text: command } },
  ];
}

// What a correct learner extracts from the paraphrase of a forgotten fact is the paraphrase itself:
// the product must refuse to learn it again, which only a learner item can put to the test.
function realizeParaphrase(unit, context) {
  return statement(context, {
    kind: "paraphrase",
    key: unit.fact.key,
    text: unit.forget.paraphrase,
    hardness: unit.hardness,
    learner: learnerItem(unit.fact, unit.forget.paraphrase),
  });
}

function realizeTrap(unit, context) {
  const taught = unit.fact;
  return statement(context, {
    kind: taught === undefined ? "trap" : "taught",
    key: taught?.key,
    text: unit.trap.text,
    hardness: unit.hardness,
    learner: taught === undefined ? [] : learnerItem(taught, factText(taught)),
  });
}

const REALIZERS = Object.freeze({
  fact: realizeFact,
  change: realizeChange,
  ask: realizeAsk,
  forget: realizeForget,
  paraphrase: realizeParaphrase,
  trap: realizeTrap,
});

function chunks(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );
}

/**
 * Realizes a plan: filler in blocks of ten exchanges, then every unit in conversation order.
 * Returns the turns and the designated sentences (kind, key, verbatim text, turn index).
 */
export async function realizePlan(plan, context) {
  const fillerTurns = plan.slots.flatMap((slot, index) => (slot === undefined ? [index] : []));
  const filler = (
    await mapSequential(chunks(fillerTurns, FILLER_BLOCK), (part) => context.exchanges(part.length))
  ).flat();
  const ordered = plan.units.toSorted(
    (left, right) => plan.starts.get(left.id) - plan.starts.get(right.id),
  );
  const parts = new Map(
    await mapSequential(ordered, async (unit) => [
      unit.id,
      await REALIZERS[unit.kind](unit, context),
    ]),
  );
  const turns = [];
  const designated = [];
  let fillerAt = 0;
  for (const [index, slot] of plan.slots.entries()) {
    if (slot === undefined) {
      turns.push(filler[fillerAt]);
      fillerAt += 1;
      continue;
    }
    const entry = parts.get(slot.unit.id)[slot.part];
    turns.push(entry.turn);
    if (entry.designated !== undefined) designated.push({ ...entry.designated, turn: index });
  }
  return { turns, designated };
}
