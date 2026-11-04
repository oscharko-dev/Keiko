// The scripted writer of the corpus generator (#4208): deterministic template sentences combined by
// slots from pools.mjs. It is the floor of the corpus, used by tests and offline builds. For the same
// random source it returns the same text, so a corpus built with it can be rebuilt and compared by
// digest. Its text is regular by construction, which the variety figures report honestly; model-written
// text (writer-model.mjs) is what gives the real corpus its spread.
import { CorpusError } from "./errors.mjs";
import { POOLS } from "./pools.mjs";
import { FACT_MARKER } from "./writer-port.mjs";

const MAX_ATTEMPTS = 60;

function fill(template, values) {
  return template.replaceAll("{obj}", values.obj ?? "").replaceAll("{when}", values.when ?? "");
}

function poolsOf(language) {
  const pools = POOLS[language];
  if (pools === undefined) throw new CorpusError(`the scripted writer has no pool for ${language}`);
  return pools;
}

function objectsOf(pools, role) {
  return [...pools.objects.generic, ...(pools.objects[role] ?? [])];
}

// Builds candidates until one passes `isClean`; a pool that cannot produce one is a defect.
function firstClean(build, texts, isClean, what) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const candidate = build();
    if (texts(candidate).every((text) => isClean(text))) return candidate;
  }
  throw new CorpusError(
    `the scripted writer found no clean ${what} in ${String(MAX_ATTEMPTS)} tries`,
  );
}

function buildExchange(pools, objects, random) {
  const obj = random.pick(objects);
  const when = random.pick(pools.whens);
  const opener = random.chance(0.15) ? `${random.pick(pools.chatter)} ` : "";
  const closer = random.chance(0.55) ? ` ${random.pick(pools.closers)}` : "";
  const followUp = random.chance(0.45) ? ` ${random.pick(pools.followUps)}` : "";
  return {
    user: `${opener}${fill(random.pick(pools.requests), { obj, when })}${closer}`,
    assistant: `${fill(random.pick(pools.answers), { obj })}${followUp}`,
  };
}

function scriptedExchanges({ language, role, count, random, isClean }) {
  const pools = poolsOf(language);
  const objects = objectsOf(pools, role);
  return Array.from({ length: count }, () =>
    firstClean(
      () => buildExchange(pools, objects, random),
      (exchange) => [exchange.user, exchange.assistant],
      isClean,
      "exchange",
    ),
  );
}

function taskSentence(pools, objects, random) {
  return random.chance(0.4)
    ? fill(random.pick(pools.objectTasks), { obj: random.pick(objects) })
    : random.pick(pools.tasks);
}

// Distinct sentences from one producer; a producer with fewer variants simply returns fewer.
function distinct(count, produce) {
  const sentences = new Set();
  for (let attempt = 0; attempt < MAX_ATTEMPTS && sentences.size < count; attempt += 1)
    sentences.add(produce());
  return [...sentences];
}

function embeddedSentences(pools, objects, random) {
  const count = random.int(2, 4);
  return { before: distinct(count, () => taskSentence(pools, objects, random)), after: [] };
}

function noisySentences(pools, objects, random) {
  const before = distinct(random.int(1, 2), () => random.pick(pools.chatter));
  const after = distinct(random.int(1, 2), () =>
    random.chance(0.5) ? random.pick(pools.chatter) : taskSentence(pools, objects, random),
  );
  return { before, after };
}

function assembleParagraph(parts, hardness, random) {
  if (hardness === "noisy") return [...parts.before, FACT_MARKER, ...parts.after].join(" ");
  const at = random.int(0, parts.before.length);
  const sentences = [...parts.before.slice(0, at), FACT_MARKER, ...parts.before.slice(at)];
  return sentences.join(" ");
}

function scriptedParagraph({ language, role, hardness, random, isClean }) {
  const pools = poolsOf(language);
  const objects = objectsOf(pools, role);
  const parts = firstClean(
    () =>
      hardness === "noisy"
        ? noisySentences(pools, objects, random)
        : embeddedSentences(pools, objects, random),
    (candidate) => [...candidate.before, ...candidate.after],
    isClean,
    "paragraph",
  );
  return assembleParagraph(parts, hardness, random);
}

function scriptedSentence({ language, kind, random, isClean }) {
  const pools = poolsOf(language);
  const pool = { ack: pools.acks, "lead-answer": pools.leadAnswers }[kind];
  if (pool === undefined) throw new CorpusError(`the scripted writer cannot write ${kind}`);
  return firstClean(
    () => random.pick(pool),
    (sentence) => [sentence],
    isClean,
    kind,
  );
}

// The port is asynchronous, so a failure of the synchronous template code must surface as a
// rejection, which an async function guarantees.
function asynchronously(produce) {
  return async (request) => produce(request);
}

/** A fresh scripted writer; it holds no state, so one instance can serve any number of builds. */
export function createScriptedWriter() {
  return {
    id: "scripted",
    exchanges: asynchronously(scriptedExchanges),
    paragraph: asynchronously(scriptedParagraph),
    sentence: asynchronously(scriptedSentence),
  };
}
