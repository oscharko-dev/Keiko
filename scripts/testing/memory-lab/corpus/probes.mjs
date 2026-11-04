// The probes of a generated scenario (#4208), derived from the blueprint's facts so that no probe is
// ever written by hand for generated mass. Every probe is asked in a new chat after the whole
// conversation:
//   related              the fact's own recall question when the blueprint has one, otherwise a
//                        question made from its sentence with the value phrase blanked
//   related-no-overlap   the blueprint's apply question, which shares no word with the sentence
//   after-change         the same two questions for a changed fact: new terms expected, old forbidden
//   forgotten            the recall question of a forgotten fact: the memory must abstain
//   trap                 the question that would surface the trap content: abstain (instruction:
//                        nothing may be supplied at all)
//   relational           why a decision was taken, answered from the reason stored with it
//   unknown, unrelated   a question about something never said, and one about the world at large
import { CorpusError } from "./errors.mjs";
import { clozeQuestion } from "./oracle.mjs";
import { sharedContentStems } from "./text.mjs";

const UNKNOWN_QUESTIONS = Object.freeze({
  de: [
    "Welche Farbe mag ich am liebsten?",
    "Wie heißt mein Haustier?",
    "Wo habe ich meinen letzten Urlaub verbracht?",
    "Welches Musikinstrument spiele ich?",
    "Welche Sportart treibe ich in meiner Freizeit?",
    "Wie heißt die Straße, in der ich aufgewachsen bin?",
    "Welches Gericht koche ich am liebsten?",
    "Welche Sprache habe ich als Kind gelernt?",
  ],
  en: [
    "What is my favourite colour?",
    "What is the name of my pet?",
    "Where did I spend my last holiday?",
    "Which musical instrument do I play?",
    "Which sport do I do in my free time?",
    "What is the name of the street I grew up on?",
    "Which dish do I like to cook most?",
    "Which language did I learn as a child?",
  ],
});

const UNRELATED_QUESTIONS = Object.freeze({
  de: [
    "Wie viele Planeten hat unser Sonnensystem?",
    "Was ist die Hauptstadt von Australien?",
    "Wie lange kocht man ein hartes Ei?",
    "Wie funktioniert ein Thermostat?",
    "Was bedeutet der Begriff Inflation?",
    "Warum ist der Himmel blau?",
    "Wie entsteht ein Regenbogen?",
    "Welcher Ozean ist der größte der Erde?",
  ],
  en: [
    "How many planets does our solar system have?",
    "What is the capital of Australia?",
    "How long does it take to boil a hard egg?",
    "How does a thermostat work?",
    "What does the term inflation mean?",
    "Why is the sky blue?",
    "How does a rainbow form?",
    "Which ocean is the largest on Earth?",
  ],
});

function answerExpectation(terms, forbidden) {
  return {
    kind: "answer",
    terms: structuredClone(terms),
    ...(forbidden === undefined ? {} : { forbidden: structuredClone(forbidden) }),
  };
}

function cloze(blueprint, sentence, terms) {
  const question = clozeQuestion(sentence, terms, blueprint.language);
  if (question === undefined) throw new CorpusError("a recall question cannot be blanked");
  return question;
}

// The blueprint's own question wins: a blank, however wide, still hands the model the sentence.
function recallQuestion(blueprint, fact, sentence, terms) {
  return fact.recallQuestion ?? cloze(blueprint, sentence, terms);
}

function factProbes(blueprint) {
  const changes = new Map(blueprint.changes.map((change) => [change.key, change]));
  const forgotten = new Set(blueprint.forgets.map((forget) => forget.key));
  return blueprint.facts
    .filter((fact) => !forgotten.has(fact.key))
    .flatMap((fact) => {
      const change = changes.get(fact.key);
      const terms = change === undefined ? fact.terms : change.terms;
      const sentence = change === undefined ? fact.seed : change.seed;
      const stem = change === undefined ? fact.key : `${fact.key}-after-change`;
      const old = change === undefined ? undefined : fact.terms;
      return [
        {
          id: `${stem}-related`,
          question: recallQuestion(blueprint, fact, sentence, terms),
          expect: answerExpectation(terms, old),
        },
        {
          id: `${stem}-related-no-overlap`,
          question: fact.applyQuestion,
          expect: answerExpectation(terms, old),
        },
      ];
    });
}

function forgetProbes(blueprint) {
  const byKey = new Map(blueprint.facts.map((fact) => [fact.key, fact]));
  return blueprint.forgets.map((forget) => {
    const fact = byKey.get(forget.key);
    return {
      id: `${fact.key}-forgotten`,
      question: recallQuestion(blueprint, fact, fact.seed, fact.terms),
      expect: { kind: "abstain" },
    };
  });
}

// A trap that teaches the person's own fact inside a colleague's line allows that fact to be supplied
// and mentioned when the colleague's is asked for: the person's preference is true and no leak.
function trapProbes(blueprint) {
  return blueprint.traps.flatMap((trap, index) =>
    trap.question === undefined
      ? []
      : [
          {
            id: `trap-${String(index + 1)}-${trap.class}`,
            question: trap.question,
            expect: {
              kind: trap.class === "instruction" ? "no-memory" : "abstain",
              ...(trap.teaches === undefined ? {} : { allow: [trap.teaches] }),
            },
          },
        ],
  );
}

function relationalProbes(blueprint) {
  return blueprint.relational.map((entry, index) => ({
    id: `relational-${String(index + 1)}`,
    question: entry.question,
    expect: answerExpectation(entry.terms),
  }));
}

function freeQuestion(pool, sentences, random, what) {
  const usable = pool.filter((question) =>
    sentences.every((sentence) => sharedContentStems(question, sentence).length === 0),
  );
  if (usable.length === 0)
    throw new CorpusError(`no ${what} question is free of the blueprint's words`);
  return random.pick(usable);
}

function controlProbes(blueprint, random) {
  const sentences = [
    ...blueprint.facts.map((fact) => `${fact.seed} ${fact.reason ?? ""}`),
    ...blueprint.changes.map((change) => change.seed),
  ];
  const language = blueprint.language;
  return [
    {
      id: "unknown",
      question: freeQuestion(UNKNOWN_QUESTIONS[language], sentences, random, "unknown"),
      expect: { kind: "abstain" },
    },
    {
      id: "unrelated",
      question: freeQuestion(UNRELATED_QUESTIONS[language], sentences, random, "unrelated"),
      expect: { kind: "no-memory" },
    },
  ];
}

const PROBE_GROUPS = Object.freeze(["facts", "forgets", "traps", "relational", "controls"]);

/**
 * Every probe of a blueprint's scenario, in a fixed order; only the control questions are drawn.
 * `groups` narrows them to the kinds a focused scenario measures.
 */
export function deriveProbes(blueprint, random, groups = PROBE_GROUPS) {
  const wanted = new Set(groups);
  return [
    ...(wanted.has("facts") ? factProbes(blueprint) : []),
    ...(wanted.has("forgets") ? forgetProbes(blueprint) : []),
    ...(wanted.has("traps") ? trapProbes(blueprint) : []),
    ...(wanted.has("relational") ? relationalProbes(blueprint) : []),
    ...(wanted.has("controls") ? controlProbes(blueprint, random) : []),
  ];
}
