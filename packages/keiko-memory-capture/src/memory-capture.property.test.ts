// Properties every learning rule must keep for any input, drawn from seeded generators (#4212).
//
// The hand-written pins name the cases someone thought of; these properties name what must hold for
// all of them: what is learned comes from the person's own words, text from anyone else never
// becomes a fact, no rule throws or grows quadratically on hostile input, and a credential never
// becomes a memory. A failure prints the seed and a shrunk counterexample; see
// `tests/support/property-testing.ts` for replaying it.

import { describe, expect, it } from "vitest";

import type {
  MemoryId,
  MemoryProposalId,
  ProjectId,
  UserId,
} from "@oscharko-dev/keiko-contracts/memory";

import {
  arrayOf,
  checkProperty,
  createRandom,
  LINEAR_RATIO_MAX,
  measureScaling,
  oneOf,
  propertySettings,
  SCALING_FACTOR,
  scalingRatio,
  seedOf,
  shrinkArray,
  shrinkRecord,
  shrinkString,
  textOf,
  unicodeString,
  type Generator,
  type Random,
} from "../../../tests/support/property-testing.js";
import { MEMORY_BODY_MAX_CHARS_DEFAULT } from "./_constants.js";
import { memoryTextCaptureRejectionReason } from "./capture-safety.js";
import { extractCandidatesFromUserText } from "./capture.js";
import { admitProposedFact } from "./fact-admission.js";
import { factReplacedByStatement, statesChangedFact, statesSameFact } from "./fact-relation.js";
import {
  explicitStatementKind,
  isExplicitMemoryStatement,
  isForgettableStatement,
  isMemoryForgetReference,
} from "./intent-explicit.js";
import { extractSalientMemories } from "./salience.js";
import type {
  CaptureContext,
  SalienceDiagnostic,
  SalienceInput,
  SalienceOutcome,
} from "./types.js";

// ─── Statements the person might write ───────────────────────────────────────

const OWN_SENTENCES: Generator<string> = oneOf(
  (random) =>
    `${random.pick(["Ich", "ich", "Wir", "Ab jetzt", "Seit Montag"])} ${random.pick([
      "nutze",
      "arbeite mit",
      "bevorzuge",
      "mag",
      "schreibe",
      "plane mit",
    ])} ${random.pick(["Excel", "Numbers", "Tabellen", "kurze Antworten", "Python", "Listen"])}${random.pick(
      ["", " immer", " nicht", " gern", " für Berichte", " im Team", ", weil es schneller ist"],
    )}${random.pick([".", "!", "", ",", "?"])}`,
  (random) =>
    `${random.pick(["I", "We", "i"])} ${random.pick(["use", "prefer", "like", "work with", "decided to use"])} ${random.pick(
      ["Excel", "short answers", "Python", "bullet lists", "dark mode"],
    )}${random.pick(["", " every day", " for reports", " at work", " now"])}${random.pick([".", "!", "", ","])}`,
  (random) =>
    `${random.pick(["Anna sagt, ", "Man hat mir gesagt, ", "Mir wurde gesagt, ", '"', "Wenn ", "Vielleicht "])}${random.pick(
      ["ich nutze Excel", "ich mag Tabellen", "I use Python", "wir arbeiten mit Listen"],
    )}${random.pick([".", '"', ",", "?"])}`,
  (random) =>
    `${random.pick(["Sie", "Es", "They"])} ${random.pick(["beginnen immer mit einer Zusammenfassung", "sind kurz", "start with a summary"])}.`,
  unicodeString(24),
);

const USER_TEXT: Generator<string> = textOf(OWN_SENTENCES, 1, 5);
const EARLIER_TEXT: Generator<string> = oneOf(
  () => "",
  (random) =>
    random.pick(["Ich schreibe meine Berichte.", "My reports are long.", "Meine Notizen."]),
  USER_TEXT,
);

// Words that never occur in USER_TEXT: whatever is built from them was not said by the person.
const FOREIGN_WORDS = ["Quokka", "Teleskop", "Zebrafink", "Mandarinen", "Kalenderblatt", "Oboe"];
const FOREIGN_TEXT: Generator<string> = textOf(
  (random) =>
    `${random.pick(["Ich", "Du", "Wir", "I"])} ${random.pick(FOREIGN_WORDS)} ${random.pick(FOREIGN_WORDS)}`,
  1,
  4,
);

// ─── Model replies ───────────────────────────────────────────────────────────

interface ProposedItem {
  readonly body: string;
  readonly evidence: string;
  readonly about: string;
  readonly type: string;
  readonly relation: string;
  readonly related: number | null;
}

// A run of whole words out of `text`, the way a model copies a span.
function copiedSpan(random: Random, text: string): string {
  const words = text.split(/(?<=\s)/u);
  const start = random.integer(0, Math.max(0, words.length - 1));
  const end = random.integer(start + 1, Math.max(start + 1, words.length));
  return words.slice(start, end).join("").trim();
}

function item(random: Random, evidence: string): ProposedItem {
  return {
    body: random.pick([
      evidence,
      evidence,
      evidence,
      `Die Person ${evidence}`,
      `Meine Berichte ${evidence}`,
      `Sie ${evidence}`,
    ]),
    evidence,
    about: random.pick(["self", "self", "self", "self", "team", "other"]),
    type: random.pick(["preference", "fact", "decision", "workflow", "goal"]),
    relation: random.pick(["new", "new", "same", "update", "contradiction"]),
    // The number of a shown known fact, as the prompt asks; a turn holds at most three.
    related: random.chance(0.4) ? random.integer(1, 3) : null,
  };
}

const reply = (items: readonly ProposedItem[]): string => JSON.stringify({ items });

// ─── Learning harness ────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 10, 6);

function context(): CaptureContext {
  return {
    userId: "u-1" as UserId,
    projectId: "p-1" as ProjectId,
    nowMs: NOW,
    newMemoryId: (): MemoryId => "ignored" as MemoryId,
    newProposalId: (): MemoryProposalId => "ignored" as MemoryProposalId,
  };
}

interface Learned {
  readonly outcomes: readonly SalienceOutcome[];
  readonly diagnostics: readonly SalienceDiagnostic[];
}

async function learn(input: Omit<SalienceInput, "context">, modelReply: string): Promise<Learned> {
  const diagnostics: SalienceDiagnostic[] = [];
  let next = 0;
  const outcomes = await extractSalientMemories(
    { ...input, context: context() },
    {
      callModel: () => Promise.resolve(modelReply),
      callModelMessages: () => Promise.resolve(modelReply),
      now: () => NOW,
      newMemoryId: () => `m-${String(next++)}` as MemoryId,
      newProposalId: () => `p-${String(next++)}` as MemoryProposalId,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
  );
  return { outcomes, diagnostics };
}

const knownFacts = (bodies: readonly string[]): SalienceInput["knownFacts"] =>
  bodies.map((body, index) => ({ id: `k-${String(index)}`, body }));

// ─── Origin of a learned body ────────────────────────────────────────────────

// Every property below states its run count once, so its coverage floors follow a widened or
// narrowed run (KEIKO_PROPERTY_RUNS) instead of failing a short replay for being short.
const PROPERTY_TIMEOUT_MS = 120_000;
// Each relation to a known fact must be reached at least this often in the reference 800 runs; the
// generators reached the rarest one 19 times there.
const RELATION_REACH_FLOOR = 5;

function runsOf(name: string, runs: number): number {
  return propertySettings({ name, runs }).runs;
}

// A floor met at the reference run count, scaled to the runs actually made.
function scaledFloor(floor: number, referenceRuns: number, runs: number): number {
  return Math.min(floor, Math.floor((floor * runs) / referenceRuns));
}

const WORD_RE = /[\p{L}\p{M}\p{N}]+/gu;

// Compares case-insensitively the way Unicode does: "ﬁ" capitalises to "FI", which must still count
// as the person's word. Upper- then lower-casing both sides folds such characters alike.
function wordsOf(text: string): Set<string> {
  const folded = text.toUpperCase().toLowerCase();
  return new Set(Array.from(folded.matchAll(WORD_RE), ([word]) => word));
}

// A learned body may capitalise a clause that opened mid-sentence ("… und ich nutze Excel" → "Ich
// nutze Excel") or name the person's own thing from their previous message ("Sie beginnen …" →
// "Meine Berichte beginnen …"); it may not bring in a word the person wrote in neither message.
// The evidence span, by contrast, must stand in this message as written.
function expectOwnWords(outcome: SalienceOutcome, userText: string, earlier: string): void {
  if (outcome.kind !== "candidate") return;
  const { body, provenance } = outcome.proposal;
  expect(userText.includes(provenance.evidenceSpan ?? ""), "evidence span is the person's").toBe(
    true,
  );
  const said = new Set([...wordsOf(userText), ...wordsOf(earlier)]);
  const brought = [...wordsOf(body)].filter((word) => !said.has(word));
  expect(brought, `learned body ${JSON.stringify(body)} is the person's words`).toEqual([]);
}

interface Turn {
  readonly userText: string;
  readonly previousUserText: string;
  readonly known: readonly string[];
  readonly items: readonly ProposedItem[];
}

const shrinkTurn = shrinkRecord<Turn>({
  userText: shrinkString,
  previousUserText: shrinkString,
  known: (known) => shrinkArray(known),
  items: (items) => shrinkArray(items),
});

// What a model copies: mostly a whole sentence of the person's or its words without the final mark,
// sometimes a run of words cut anywhere, sometimes words nobody in the conversation wrote.
function proposedEvidence(random: Random, sentences: readonly string[], userText: string): string {
  const roll = random.next();
  if (roll < 0.5)
    return random
      .pick(sentences)
      .replace(/[.!?,]+$/u, "")
      .trim();
  if (roll < 0.9) return copiedSpan(random, userText);
  return FOREIGN_TEXT(random);
}

const OWN_TURN: Generator<Turn> = (random) => {
  const sentences = arrayOf(OWN_SENTENCES, 1, 5)(random);
  const userText = sentences.join(random.pick([" ", "\n", " "]));
  return {
    userText,
    previousUserText: EARLIER_TEXT(random),
    known: arrayOf(OWN_SENTENCES, 0, 3)(random),
    items: arrayOf((r) => item(r, proposedEvidence(r, sentences, userText)), 1, 4)(random),
  };
};

// A message that repeats, negates or states a change of a known fact, placed first so a model's
// numbered relation can name it. Random sentences alone reach these rules by chance only.
const RELATION_VERBS = ["nutze", "bevorzuge", "mag"] as const;
const RELATION_VALUES = ["Excel", "Numbers", "Tabellen", "Listen"] as const;

const RELATION_TURN: Generator<Turn> = (random) => {
  const verb = random.pick(RELATION_VERBS);
  const [old, current] = [random.pick(RELATION_VALUES), random.pick(RELATION_VALUES)];
  const context = random.pick(["", " für Berichte", " im Team"]);
  const fact = `Ich ${verb} ${old}${context}`;
  const said = random.pick([
    fact,
    `${fact} nicht`,
    `Ab jetzt ${verb} ich ${current}${context}`,
    `Ich ${verb} ${current}${context}`,
  ]);
  return {
    userText: `${said}.`,
    previousUserText: EARLIER_TEXT(random),
    known: [fact, ...arrayOf(OWN_SENTENCES, 0, 2)(random)],
    items: [item(random, said)],
  };
};

interface ForeignTurn extends Turn {
  readonly assistantText: string;
  // The earlier sentence this message repeats with one letter changed.
  readonly said: string;
}

// Shrinking the person's texts could turn a foreign span into their own words and the failure into
// a different one; only what the model and the assistant contributed is shrunk.
const shrinkForeignTurn = shrinkRecord<ForeignTurn>({
  assistantText: shrinkString,
  items: (items) => shrinkArray(items),
});

type ForeignSource = "near-miss" | "assistant" | "earlier";

function foreignSourceOf(turn: ForeignTurn, evidence: string): ForeignSource {
  if (evidence === turn.said.replace(/[.!?,]+$/u, "").trim()) return "near-miss";
  return turn.assistantText.includes(evidence) ? "assistant" : "earlier";
}

// The same sentence with one character changed: a span copied from the earlier message is then
// one letter away from anything in this one.
function nearMiss(random: Random, sentence: string): string {
  const points = Array.from(sentence);
  const at = random.integer(0, Math.max(0, points.length - 1));
  points[at] = points[at] === "q" ? "z" : "q";
  return points.join("");
}

const FOREIGN_TURN: Generator<ForeignTurn> = (random) => {
  const said = OWN_SENTENCES(random);
  const assistantText = FOREIGN_TEXT(random);
  const previousUserText = `${FOREIGN_TEXT(random)} ${said} ${EARLIER_TEXT(random)}`;
  const userText = `${USER_TEXT(random)} ${nearMiss(random, said)}`;
  const source = (r: Random): string => {
    if (r.chance(0.3)) return said.replace(/[.!?,]+$/u, "").trim();
    return copiedSpan(r, r.chance(0.5) ? assistantText : previousUserText);
  };
  return {
    userText,
    previousUserText,
    assistantText,
    said,
    known: [],
    items: arrayOf((r) => item(r, source(r)), 1, 4)(random),
  };
};

function inputOf(turn: Turn, assistantText?: string): Omit<SalienceInput, "context"> {
  return {
    userText: turn.userText,
    previousUserText: turn.previousUserText,
    knownFacts: knownFacts(turn.known),
    ...(assistantText === undefined ? {} : { assistantText }),
  };
}

// Counts learned outcomes and every drop reason, so a weak generator shows where it stops.
function countReach(reach: Map<string, number>, { outcomes, diagnostics }: Learned): void {
  const add = (key: string, count: number): void => {
    reach.set(key, (reach.get(key) ?? 0) + count);
  };
  for (const outcome of outcomes) add(outcome.kind, 1);
  for (const diagnostic of diagnostics) {
    if (diagnostic.kind === "dropped-model-items") add(diagnostic.reason, diagnostic.count);
  }
}

// How learned facts stood to the known ones: a repeat confirms, a change supersedes either because
// the model named the known fact or because the comparison found it without a label.
type RelationReach = "confirmation" | "labelled-supersede" | "deterministic-supersede";

function countRelationReach(reach: Map<RelationReach, number>, { outcomes }: Learned): void {
  const add = (key: RelationReach): void => {
    reach.set(key, (reach.get(key) ?? 0) + 1);
  };
  for (const outcome of outcomes) {
    if (outcome.kind === "confirmation") add("confirmation");
    else if (outcome.relation.kind !== "supersede") continue;
    else add(outcome.relationLabel === "new" ? "deterministic-supersede" : "labelled-supersede");
  }
}

describe("memory capture properties", () => {
  it("learns only the person's own words", { timeout: PROPERTY_TIMEOUT_MS }, async () => {
    const reach = new Map<string, number>();
    const relations = new Map<RelationReach, number>();
    const runs = runsOf("origin", 800);
    await checkProperty({
      name: "origin",
      runs,
      generate: oneOf(OWN_TURN, OWN_TURN, RELATION_TURN),
      shrink: shrinkTurn,
      property: async (turn) => {
        const learned = await learn(inputOf(turn), reply(turn.items));
        const userText = turn.userText.normalize("NFC");
        for (const outcome of learned.outcomes)
          expectOwnWords(outcome, userText, turn.previousUserText.normalize("NFC"));
        countReach(reach, learned);
        countRelationReach(relations, learned);
      },
    });
    // The generator must reach admission, or the property above held vacuously.
    const summary = JSON.stringify(Object.fromEntries(reach));
    expect(reach.get("candidate") ?? 0, summary).toBeGreaterThanOrEqual(scaledFloor(80, 800, runs));
    // …and it must reach the rules that refuse, not only the path that learns.
    const reasons = [...reach.keys()].filter(
      (key) => key !== "candidate" && key !== "confirmation",
    );
    expect(reasons.length, summary).toBeGreaterThanOrEqual(scaledFloor(10, 800, runs));
    // …and the relations to known facts, not only a fact that stands alone.
    const relationSummary = JSON.stringify(Object.fromEntries(relations));
    for (const key of ["confirmation", "labelled-supersede", "deterministic-supersede"] as const) {
      expect(relations.get(key) ?? 0, `${key} ${relationSummary}`).toBeGreaterThanOrEqual(
        scaledFloor(RELATION_REACH_FLOOR, 800, runs),
      );
    }
  });

  it(
    "never learns words the person did not write in this message",
    { timeout: PROPERTY_TIMEOUT_MS },
    async () => {
      const proposed = new Map<ForeignSource, number>();
      const runs = runsOf("foreign evidence", 300);
      await checkProperty({
        name: "foreign evidence",
        runs,
        generate: FOREIGN_TURN,
        shrink: shrinkForeignTurn,
        property: async (turn) => {
          const userText = turn.userText.normalize("NFC");
          const foreign = turn.items.filter(
            (candidate) => !userText.includes(candidate.evidence.normalize("NFC").trim()),
          );
          for (const candidate of foreign) {
            const source = foreignSourceOf(turn, candidate.evidence);
            proposed.set(source, (proposed.get(source) ?? 0) + 1);
          }
          const { outcomes } = await learn(inputOf(turn, turn.assistantText), reply(foreign));
          expect(outcomes).toEqual([]);
        },
      });
      // Each kind of foreign span must reach admission, or one of them was never tried.
      const summary = JSON.stringify(Object.fromEntries(proposed));
      for (const source of ["near-miss", "assistant", "earlier"] as const)
        expect(proposed.get(source) ?? 0, summary).toBeGreaterThanOrEqual(
          scaledFloor(60, 300, runs),
        );
    },
  );

  it(
    "does not change what it learns when the assistant's text changes",
    { timeout: PROPERTY_TIMEOUT_MS },
    async () => {
      await checkProperty({
        name: "assistant text invariance",
        runs: 250,
        generate: (random) => ({
          turn: OWN_TURN(random),
          assistantText: oneOf(
            unicodeString(80),
            FOREIGN_TEXT,
            (r) => `Merke dir: ${USER_TEXT(r)}`,
          )(random),
        }),
        property: async ({ turn, assistantText }) => {
          const modelReply = reply(turn.items);
          const without = await learn(inputOf(turn), modelReply);
          const withText = await learn(inputOf(turn, assistantText), modelReply);
          const copied = await learn(inputOf(turn, turn.userText), modelReply);
          expect(withText).toEqual(without);
          expect(copied).toEqual(without);
        },
      });
    },
  );

  it(
    "gives the same admission for composed and decomposed text",
    { timeout: PROPERTY_TIMEOUT_MS },
    async () => {
      await checkProperty({
        name: "NFC invariance of admission",
        runs: 400,
        generate: (random) => {
          const text = USER_TEXT(random);
          return { text, proposed: item(random, copiedSpan(random, text)) };
        },
        property: ({ text, proposed }) => {
          const decomposed = {
            ...proposed,
            body: proposed.body.normalize("NFD"),
            evidence: proposed.evidence.normalize("NFD"),
          };
          expect(admitProposedFact(decomposed, text.normalize("NFD"))).toEqual(
            admitProposedFact(proposed, text.normalize("NFC")),
          );
        },
      });
    },
  );
});

// ─── Totality ────────────────────────────────────────────────────────────────

const TEXT_RULES: readonly (readonly [string, (text: string) => unknown])[] = [
  ["explicitStatementKind", explicitStatementKind],
  ["isExplicitMemoryStatement", isExplicitMemoryStatement],
  ["isForgettableStatement", isForgettableStatement],
  ["isMemoryForgetReference", isMemoryForgetReference],
  ["memoryTextCaptureRejectionReason", (text): unknown => memoryTextCaptureRejectionReason(text)],
  [
    "extractCandidatesFromUserText",
    (text): unknown => extractCandidatesFromUserText(text, context()),
  ],
  ["statesSameFact", (text): unknown => statesSameFact(text, `${text} nicht`)],
  ["statesChangedFact", (text): unknown => statesChangedFact("Ich nutze Excel.", text)],
  [
    "factReplacedByStatement",
    (text): unknown => factReplacedByStatement(text, knownFacts(["Ich nutze Excel.", text])),
  ],
  [
    "admitProposedFact",
    (text): unknown =>
      admitProposedFact(
        { body: text, evidence: Array.from(text).slice(0, 40).join(""), about: "self" },
        text,
      ),
  ],
];

// With the u flag a surrogate class matches only a half character, never a whole pair.
const LONE_SURROGATE_RE = /[\ud800-\udfff]/u;

function loneSurrogateIn(value: unknown): boolean {
  if (typeof value === "string") return LONE_SURROGATE_RE.test(value);
  if (Array.isArray(value)) return value.some((item) => loneSurrogateIn(item));
  if (typeof value === "object" && value !== null)
    return Object.values(value).some((item) => loneSurrogateIn(item));
  return false;
}

describe("totality", () => {
  it.each(TEXT_RULES)(
    "%s answers every text the same way twice, without throwing",
    { timeout: PROPERTY_TIMEOUT_MS },
    async (_, rule) => {
      await checkProperty({
        name: `totality ${_}`,
        runs: 300,
        generate: oneOf(
          unicodeString(200),
          USER_TEXT,
          (r) => `Merke dir: ${USER_TEXT(r)}`,
          (r) => `Vergiss ${USER_TEXT(r)}`,
        ),
        shrink: shrinkString,
        property: (text) => {
          const first = rule(text);
          expect(rule(text)).toEqual(first);
          if (!loneSurrogateIn(text))
            expect(loneSurrogateIn(first), "no half character is invented").toBe(false);
        },
      });
    },
  );

  it("survives any model reply without throwing", { timeout: PROPERTY_TIMEOUT_MS }, async () => {
    await checkProperty({
      name: "totality salience",
      runs: 300,
      generate: (random) => ({
        userText: oneOf(USER_TEXT, unicodeString(120))(random),
        modelReply: oneOf(unicodeString(200), (r) =>
          reply(arrayOf((x) => item(x, unicodeString(60)(x)), 0, 5)(r)),
        )(random),
      }),
      property: async ({ userText, modelReply }) => {
        const first = await learn({ userText, knownFacts: [] }, modelReply);
        expect(await learn({ userText, knownFacts: [] }, modelReply)).toEqual(first);
      },
    });
  });
});

// ─── Linear time ─────────────────────────────────────────────────────────────

type Shape = (size: number) => string;

const repeated =
  (lead: string, piece: string, tail = ""): Shape =>
  (size) =>
    `${lead}${piece.repeat(Math.ceil(size / piece.length))}${tail}`;

// Every shape that once made a rule quadratic: runs glued to a trigger, with and without spaces.
const NAMED_SHAPES: readonly (readonly [string, Shape])[] = [
  ["marks glued after a comma", repeated("Vergiss den Bericht, ", ",")],
  ["marks glued to a continuation", repeated("Vergiss den Bericht, nimm", ",", " den Entwurf")],
  ["glued single-letter periods", repeated("Vergiss den Bericht", "x.")],
  ["glued number periods", repeated("Merke dir, dass ", "1.")],
  ["glued abbreviations", repeated("Merke dir, dass ", "z.B.")],
  ["spaced periods", repeated("Vergiss ", "x. ")],
  ["repeated subjects", repeated("", "ich ", "mag Tabellen.")],
  ["spaces before a reason", repeated("Ich nutze Excel", " ", ", weil Anna es will.")],
  ["update without a target", repeated("update memory about ", "a ")],
  ["correction without a verb", repeated("that's wrong, ", "a ")],
  ["dotted words", repeated("Merke dir ", "a.")],
  ["open quotes", repeated("Ich sage ", '"a ')],
  ["glued auxiliaries", repeated("So—", "wurde")],
  ["credential lookalikes", repeated("Bearer ", "password= ")],
];

// Random runs of the pieces those shapes are made of, behind the words that start each rule's scan:
// a quadratic path nobody has named yet is found the same way the named ones were.
const LEADS = [
  "Vergiss den Bericht",
  "Vergiss den Bericht, ",
  "Merke dir, dass ",
  "Ich ",
  "Anna sagt, ",
];
const PIECES = [
  ",",
  ".",
  "x.",
  "1.",
  "z.B.",
  " ",
  "nimm",
  "dass ",
  "ich ",
  '"',
  "—",
  "-",
  "İ",
  "ſ",
  "\u0345",
];

const RANDOM_SHAPES: readonly (readonly [string, Shape])[] = Array.from(
  { length: 8 },
  (_, index) => {
    const random = createRandom(seedOf(`hostile shape ${String(index)}`));
    const lead = random.pick(LEADS);
    const piece = arrayOf((r) => r.pick(PIECES), 1, 3)(random).join("");
    return [`random run ${JSON.stringify(lead + piece)}`, repeated(lead, piece)] as const;
  },
);

// A hang fails at once, whatever the ratio says.
const HANG_GUARD_MS = 5_000;

// Two ranges, each timed at one size and four times it. The first stays, with its lead and tail,
// under the memory body limit at which several rules stop reading, so a quadratic path behind
// that limit still shows; the second finds one in a rule without a limit. Both stay below V8's
// large-object threshold (128 KiB, two-byte text included), above which an allocation costs
// disproportionately more and a linear copy would look quadratic.
const SIZES = [Math.floor(MEMORY_BODY_MAX_CHARS_DEFAULT / SCALING_FACTOR) - 128, 8_000] as const;

const MINIMUM_MS = 10;

// A rule still faster than MINIMUM_MS over the harness's largest repetition count spends a few
// nanoseconds a call: it does not read its input, so its ratio means nothing, and its large run
// must merely stay that fast as well.
function expectLinear(name: string, build: Shape, rule: (text: string) => unknown): void {
  for (const size of SIZES) {
    const scaling = measureScaling({
      build,
      run: rule,
      size,
      maximumSize: size,
      minimumMs: MINIMUM_MS,
    });
    const detail = `${name}: ${JSON.stringify(scaling)}`;
    expect(scaling.largeMs, detail).toBeLessThan(HANG_GUARD_MS);
    if (scaling.measurable) expect(scalingRatio(scaling), detail).toBeLessThan(LINEAR_RATIO_MAX);
    else expect(scaling.largeMs, detail).toBeLessThan(MINIMUM_MS * LINEAR_RATIO_MAX);
  }
}

describe("linear time", () => {
  it.each([...NAMED_SHAPES, ...RANDOM_SHAPES])(
    "%s",
    { timeout: PROPERTY_TIMEOUT_MS },
    (_, build) => {
      for (const [name, rule] of TEXT_RULES) expectLinear(name, build, rule);
    },
  );
});

// ─── Credentials never become memories ───────────────────────────────────────

// Public, documented credential formats, built here rather than read from the package's patterns.
const CREDENTIALS: readonly Generator<string>[] = [
  (r): string => `sk-${alnum(r, 32)}`,
  (r): string => `AKIA${upperAlnum(r, 16)}`,
  (r): string => `${r.pick(["ghp", "gho", "ghs", "ghu", "ghr"])}_${alnum(r, 36)}`,
  (r): string => `xoxb-${digits(r, 12)}-${alnum(r, 24)}`,
  (r): string => `eyJ${alnum(r, 20)}.eyJ${alnum(r, 30)}.${alnum(r, 43)}`,
  (): string => "-----BEGIN PRIVATE KEY-----",
  (r): string => `Bearer ${alnum(r, 40)}`,
  (r): string => `https://user${digits(r, 3)}:${alnum(r, 12)}@example.com/repo`,
  (r): string =>
    `${r.pick(["password", "Passwort", "secret", "api_key", "token"])}=${alnum(r, 14)}`,
  (r): string => `mein Passwort ist ${alnum(r, 12)}`,
];

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ALNUM_CHARACTERS = Array.from(ALNUM);
const alnum = (r: Random, length: number): string =>
  Array.from({ length }, () => r.pick(ALNUM_CHARACTERS)).join("");
const upperAlnum = (r: Random, length: number): string => alnum(r, length).toUpperCase();
const digits = (r: Random, length: number): string =>
  Array.from({ length }, () => String(r.integer(0, 9))).join("");

interface CredentialText {
  readonly text: string;
  readonly secret: string;
}

// Shrinks the words around the credential and keeps the credential whole, still set apart by the
// space around it: glued to a word, it would be a different text and a different failure.
function* shrinkCredentialText({ text, secret }: CredentialText): Iterable<CredentialText> {
  const at = text.indexOf(secret);
  const before = text.slice(0, at).trimEnd();
  const after = text.slice(at + secret.length).trimStart();
  const join = (head: string, tail: string): string =>
    [head, secret, tail].filter((part) => part !== "").join(" ");
  for (const smaller of shrinkString(before)) yield { secret, text: join(smaller, after) };
  for (const smaller of shrinkString(after)) yield { secret, text: join(before, smaller) };
}

describe("credentials", () => {
  it(
    "rejects any text that carries a credential, wherever it stands",
    { timeout: PROPERTY_TIMEOUT_MS },
    async () => {
      await checkProperty({
        name: "credential rejection",
        runs: 500,
        generate: (random) => {
          const secret = random.pick(CREDENTIALS)(random);
          const after = random.chance(0.5) ? USER_TEXT(random) : "";
          return { secret, text: `${USER_TEXT(random)} ${secret} ${after}`.trim() };
        },
        shrink: shrinkCredentialText,
        property: ({ text, secret }) => {
          expect(memoryTextCaptureRejectionReason(text)).not.toBeNull();
          // "Merke dir: A. B" stores only its first sentence, so the credential may stand outside
          // what is stored; it must never stand inside anything that is.
          const outcomes = extractCandidatesFromUserText(`Merke dir: ${text}`, context());
          expect(JSON.stringify(outcomes)).not.toContain(secret);
        },
      });
    },
  );

  it(
    "never learns a credential the model copied from the person's message",
    { timeout: PROPERTY_TIMEOUT_MS },
    async () => {
      await checkProperty({
        name: "credential learning",
        runs: 300,
        generate: (random) => {
          const secret = random.pick(CREDENTIALS)(random);
          const userText = `Ich nutze ${secret} für alles.`;
          return {
            userText,
            secret,
            items: [item(random, random.chance(0.5) ? userText : `Ich nutze ${secret}`)],
          };
        },
        property: async ({ userText, secret, items }) => {
          const { outcomes, diagnostics } = await learn({ userText, knownFacts: [] }, reply(items));
          // Neither the body nor its evidence span nor a diagnostic may carry it.
          expect(JSON.stringify({ outcomes, diagnostics })).not.toContain(secret);
        },
      });
    },
  );
});
