// Blueprints of the MemoriaViva corpus (#4208): the format validator fails closed, the fake-value
// grammar admits only the documented values, and the checked-in curated set meets its stated shape.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BLUEPRINT_LANGUAGES,
  BlueprintError,
  FACT_CLASSES,
  TRAP_CLASSES,
  blueprintDigest,
  loadBlueprintDirectory,
  validateBlueprint,
} from "../testing/memory-lab/corpus/blueprint.mjs";
import { DEFAULT_BLUEPRINT_DIR } from "../testing/memory-lab/corpus/build.mjs";
import { POOLS } from "../testing/memory-lab/corpus/pools.mjs";
import { blankValuePhrases } from "../testing/memory-lab/corpus/cloze.mjs";
import { clozeQuestion, compileTermGroups } from "../testing/memory-lab/corpus/oracle.mjs";
import { sharedContentStems } from "../testing/memory-lab/corpus/text.mjs";
import { startsWithMemoryCommand } from "../testing/memory-lab/corpus/text.mjs";
import {
  FAKE_CUSTOMER_ID,
  FAKE_IBAN,
  FAKE_PHONE,
  forbiddenValueKinds,
  shannonEntropy,
  valueShapeFindings,
  collectStrings,
} from "../testing/memory-lab/corpus/values.mjs";
import { matchesTermGroups, normalizeText } from "../testing/memory-lab/score.mjs";
import { curatedBlueprints, fixtureBlueprint } from "./support/memory-lab-corpus-fixture.mjs";

const ROLES = [
  "analyst",
  "bank-clerk",
  "developer",
  "hr-officer",
  "marketing-specialist",
  "operations-manager",
  "paralegal",
  "product-owner",
  "project-manager",
  "support-agent",
  "teacher",
  "team-lead",
];
const FAKE_KEY = "sk-lab-1a2b1a2b1a2b1a2b1a2b1a2b1a2b1a2b";

function mutated(change) {
  const blueprint = fixtureBlueprint();
  change(blueprint);
  return blueprint;
}

describe("blueprint validator", () => {
  it("accepts a valid blueprint and returns a deep-frozen copy", () => {
    const original = fixtureBlueprint();
    const validated = validateBlueprint(original);
    expect(validated).toEqual(original);
    expect(validated).not.toBe(original);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.facts[0].terms[0])).toBe(true);
  });

  it.each([
    ["a wrong schema version", (b) => (b.schemaVersion = 2), /schemaVersion/u],
    ["a bad id", (b) => (b.id = "Bad Id"), /slug/u],
    ["an unknown language", (b) => (b.language = "fr"), /language must be one of/u],
    ["a bad role", (b) => (b.role = "Bank Clerk"), /role must be a lowercase slug/u],
    ["an unknown top-level field", (b) => (b.extra = 1), /extra is not a known field/u],
    ["a missing collection", (b) => delete b.traps, /traps is required/u],
    ["no facts", (b) => (b.facts = []), /facts must not be empty/u],
    ["a bad fact key", (b) => (b.facts[0].key = "Bad_Key"), /key must be lowercase words/u],
    ["an unknown fact class", (b) => (b.facts[0].class = "habit"), /class must be one of/u],
    [
      "a non-boolean flag",
      (b) => (b.facts[0].must = "yes"),
      /must and .*private must be booleans/u,
    ],
    [
      "a shared preference",
      (b) => (b.facts[0].private = false),
      /only a decision may be shared with the project/u,
    ],
    [
      "a reason on a preference",
      (b) => (b.facts[0].reason = "Because I said so."),
      /only for a decision/u,
    ],
    [
      "a seed without punctuation",
      (b) => (b.facts[0].seed = "I prefer line charts"),
      /punctuation/u,
    ],
    [
      "a seed with the marker",
      (b) => (b.facts[0].seed = "I prefer [[FACT]] line charts."),
      /without \[\[/u,
    ],
    [
      "terms that miss the seed",
      (b) => (b.facts[0].terms = [["bar chart"]]),
      /terms must match the seed/u,
    ],
    ["a short term", (b) => (b.facts[0].terms = [["li"]]), /3 to 60 characters/u],
    ["an empty term group", (b) => (b.facts[0].terms = [[]]), /alternatives/u],
    [
      "an apply question that is no question",
      (b) => (b.facts[0].applyQuestion = "Show trends."),
      /must be a question/u,
    ],
    [
      "an apply question that holds the answer",
      (b) => (b.facts[0].applyQuestion = "Do I like line charts?"),
      /must not contain the answer terms/u,
    ],
    [
      "an apply question that shares a word with the seed",
      (b) => (b.facts[0].applyQuestion = "What changes for me each month?"),
      /share no content word with the seed/u,
    ],
    ["a change of an unknown fact", (b) => (b.changes[0].key = "nothing-here"), /unknown fact/u],
    [
      "two changes of one fact",
      (b) => b.changes.push({ ...b.changes[0], position: 0.6 }),
      /more than once/u,
    ],
    [
      "a fact that is changed and forgotten",
      (b) => (b.forgets[0].key = "number-format"),
      /both changed and forgotten/u,
    ],
    ["a change too early", (b) => (b.changes[0].position = 0.05), /from 0.2 to 0.9/u],
    [
      "a change whose terms miss its seed",
      (b) => (b.changes[0].terms = [["three decimal"]]),
      /terms must match the new seed/u,
    ],
    [
      "a paraphrase that does not match the fact",
      (b) => (b.forgets[0].paraphrase = "Meetings outdoors are lovely for sharing results."),
      /paraphrase must match the fact's terms/u,
    ],
    [
      "a paraphrase that repeats the seed",
      (b) => (b.forgets[0].paraphrase = `Honestly, ${b.facts[5].seed}`),
      /must not repeat the seed/u,
    ],
    [
      "a seed that is a question",
      (b) => (b.facts[0].seed = "Do I prefer line charts?"),
      /statement/u,
    ],
    [
      "a seed of two sentences",
      (b) => (b.facts[0].seed = "I prefer line charts. They show change over time."),
      /must be one sentence/u,
    ],
    [
      "a reason that is not a clause",
      (b) => (b.facts[3].reason = "The extract is reproducible for audits."),
      /clause that starts in lower case/u,
    ],
    ["an unknown trap class", (b) => (b.traps[0].class = "gossip"), /class must be one of/u],
    [
      "a third-party trap that cannot be told without the name",
      (b) => delete b.traps[1].nameless,
      /nameless is required for a third-party trap/u,
    ],
    [
      "a nameless form on a trap that names nobody",
      (b) => (b.traps[0].nameless = [["someone"], ["something"]]),
      /nameless is only for a third-party trap/u,
    ],
    [
      "a nameless form without its who and what",
      (b) => (b.traps[1].nameless = [["manager"]]),
      /nameless must hold a who and a what group/u,
    ],
    [
      "a nameless form that misses the text",
      (b) => (b.traps[1].nameless = [["manager"], ["midnight"]]),
      /nameless must match the text/u,
    ],
    [
      "a nameless form whose content is a fact of the person",
      (b) => (b.traps[2].nameless = [["colleague"], ["bar charts"]]),
      /nameless names what a fact of the person says/u,
    ],
    [
      "trap terms that miss the text",
      (b) => (b.traps[1].terms = [["Nobody"]]),
      /terms must match the text/u,
    ],
    [
      "a credential trap without a question",
      (b) => delete b.traps[0].question,
      /question is required for a credential trap/u,
    ],
    [
      "a credential trap without a key",
      (b) => {
        b.traps[0].text = "My access token for the test environment is a secret, please keep it.";
        b.traps[0].terms = [["secret"]];
      },
      /must contain a fake API key/u,
    ],
    [
      "a real-looking IBAN",
      (b) => {
        b.traps[0].text = "My account is DE89 3704 0044 0532 0130 00, please keep it.";
        b.traps[0].terms = [["DE89"]];
      },
      /iban outside the fake-value grammar/u,
    ],
    [
      "a real-looking key",
      (b) => {
        b.traps[0].text = `My access token is ${["sk-proj-", "abcdefghijklmnop1234"].join("")}, please keep it.`;
        b.traps[0].terms = [["sk-proj"]];
      },
      /api-key outside the fake-value grammar/u,
    ],
    [
      "a fake key rich in entropy",
      (b) => {
        b.traps[0].text =
          "My access token is sk-lab-0123456789abcdef0123456789abcdef, please keep it.";
      },
      /repetitive enough for secret scanners/u,
    ],
    [
      "an e-mail address on a real domain",
      (b) => {
        b.traps[0].class = "identifier";
        b.traps[0].text = "Write to sam.rivers@example.com for details, please.";
        b.traps[0].terms = [["sam.rivers"]];
      },
      /email outside the fake-value grammar/u,
    ],
    [
      "a fake value in a trap that may hold none",
      (b) => {
        b.traps[1].text = `Ms. Harrowgate lives at ${FAKE_CUSTOMER_ID} street, I think.`;
        b.traps[1].nameless = [["lives"], ["street"]];
      },
      /only a credential or identifier trap may hold a fake value/u,
    ],
    [
      "a link in a fact",
      (b) => (b.facts[0].seed = "I prefer line charts, see https://charts.example.test/guide."),
      /outside a trap/u,
    ],
    [
      "a relational probe that no reason answers",
      (b) => (b.relational[0].terms = [["nothing"]]),
      /reason of a decision/u,
    ],
    [
      "a trap question that shares a word with a fact",
      (b) => (b.traps[1].question = "Which line does Ms. Harrowgate prefer?"),
      /shares a content word with a fact/u,
    ],
    [
      "a trap that restates a fact",
      (b) => {
        b.traps[1].text = 'The CEO said: "A senior analyst must sign this."';
        b.traps[1].terms = [["CEO"]];
        b.traps[1].nameless = [["CEO"], ["said"]];
      },
      /restates a fact/u,
    ],
    [
      "a trap that teaches an unknown fact",
      (b) => (b.traps[2].teaches = "nothing-here"),
      /unknown fact/u,
    ],
    [
      "a taught fact that also changes",
      (b) => (b.traps[2].teaches = "number-format"),
      /cannot change or be forgotten/u,
    ],
    [
      "a taught fact missing from the trap text",
      (b) =>
        (b.traps[2].text =
          "My colleague Dr. Thornbury-Vale likes pie charts, I like other things."),
      /must contain the seed sentence/u,
    ],
    [
      "a teaching trap of the wrong class",
      (b) => (b.traps[3].teaches = "ranking-chart"),
      /teaches is only for a third-party trap/u,
    ],
    [
      "style notes that state a fact",
      (b) => (b.styleNotes = "Writes about line charts all day."),
      /styleNotes must not state a fact/u,
    ],
    [
      "terms that make one fact swallow another's sentence",
      (b) => (b.facts[0].terms = [["charts"]]),
      /classifies as \(correct chart-type\), expected \(correct ranking-chart\)/u,
    ],
    // A new seed that repeats a term of the old one cannot be told apart from it by a probe.
    [
      "a new seed that repeats a term of the old one",
      (b) => (b.changes[0].seed = "Please show me two decimal places, not one decimal place."),
      /new seed must not contain a term of the old one/u,
    ],
    [
      "a split rule of a change that repeats a term of the old seed",
      (b) =>
        (b.changes[0].split.rule =
          "Please show them with two decimal places instead of one decimal place."),
      /split rule must not contain a term of the old seed/u,
    ],
    [
      "a correction that misses the new terms",
      (b) => (b.changes[0].correction = "I meant something else earlier, not that."),
      /correction must contain the new terms/u,
    ],
    [
      "a correction that shares a word with the apply question",
      (b) => (b.changes[0].correction = "I meant two decimal places for the figures, not one."),
      /share no word with what is said/u,
    ],
    // A statement told over two turns: the subject first, the rule alone after it.
    [
      "a split form with an unknown field",
      (b) => (b.facts[0].split.extra = "x"),
      /split\.extra is not a known field/u,
    ],
    [
      "a split lead that holds an answer term",
      (b) => (b.facts[0].split.lead = "I prefer line charts."),
      /split\.lead must not contain the answer terms/u,
    ],
    [
      "a split lead that opens with a memory command",
      (b) => (b.facts[0].split.lead = "Remember that I have a preference about charts."),
      /split\.lead must not open with a memory command/u,
    ],
    [
      "a split lead that states another fact",
      (b) => (b.facts[0].split.lead = "A word about my job as a senior analyst."),
      /a split lead states a fact/u,
    ],
    [
      "a split rule that misses the terms",
      (b) => (b.facts[0].split.rule = "I prefer bar charts for that."),
      /split\.rule must contain the terms/u,
    ],
    [
      "a split rule that is the whole statement",
      (b) => (b.facts[0].split.rule = b.facts[0].seed),
      /split\.rule must differ from the whole statement/u,
    ],
    [
      "a split rule that drops the reason of a decision",
      (b) =>
        (b.facts[3].split.rule =
          "I decided to rely on the warehouse extract instead of live queries."),
      /split\.rule must end with the reason of the decision/u,
    ],
    [
      "a split rule that another fact's terms claim",
      (b) => (b.facts[0].split.rule = "I prefer line charts and a walk."),
      /classifies as \(forgotten-returned forgotten-returned\), expected \(correct chart-type\)/u,
    ],
    [
      "a split rule that shares a word with the apply question",
      (b) => (b.facts[0].split.rule = "I prefer line charts for monthly trends."),
      /share no content word with the split rule/u,
    ],
    // A direct recall question of the blueprint's own, preferred to the blanked sentence.
    [
      "a recall question that is no question",
      (b) => (b.facts[0].recallQuestion = "Tell me my favourite diagram."),
      /recallQuestion must be a question/u,
    ],
    [
      "a recall question that holds the answer",
      (b) => (b.facts[0].recallQuestion = "Do I prefer line charts?"),
      /recallQuestion must not contain the answer terms/u,
    ],
    [
      "a recall question that holds the new answer of a change",
      (b) => (b.facts[4].recallQuestion = "Do I want two decimal places?"),
      /recall question must not contain the new terms/u,
    ],
  ])("rejects %s", (_name, change, pattern) => {
    expect(() => validateBlueprint(mutated(change))).toThrow(pattern);
    expect(() => validateBlueprint(mutated(change))).toThrow(BlueprintError);
  });

  it("names the blueprint in every error and tolerates a non-object", () => {
    expect(() => validateBlueprint(null)).toThrow(/<unnamed>: blueprint must be an object/u);
    expect(() => validateBlueprint(mutated((b) => (b.id = "Bad Id")))).toThrow(/^Bad Id: /u);
  });

  it("digests independently of key order and changes with any content", () => {
    const base = fixtureBlueprint();
    const reordered = Object.fromEntries(Object.entries(base).toReversed());
    expect(blueprintDigest(validateBlueprint(reordered))).toBe(
      blueprintDigest(validateBlueprint(base)),
    );
    const edited = mutated(
      (b) => (b.facts[0].applyQuestion = "How do I like my weekly trends presented?"),
    );
    expect(blueprintDigest(validateBlueprint(edited))).not.toBe(blueprintDigest(base));
  });
});

describe("blueprint directory", () => {
  let directory;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("loads in id order and refuses duplicates and broken files", () => {
    directory = mkdtempSync(join(tmpdir(), "memory-lab-blueprints-"));
    writeFileSync(
      join(directory, "b.json"),
      JSON.stringify({ ...fixtureBlueprint(), id: "en-zeta-01" }),
    );
    writeFileSync(
      join(directory, "a.json"),
      JSON.stringify({ ...fixtureBlueprint(), id: "en-alpha-01" }),
    );
    expect(loadBlueprintDirectory(directory).map((blueprint) => blueprint.id)).toEqual([
      "en-alpha-01",
      "en-zeta-01",
    ]);
    writeFileSync(
      join(directory, "c.json"),
      JSON.stringify({ ...fixtureBlueprint(), id: "en-alpha-01" }),
    );
    expect(() => loadBlueprintDirectory(directory)).toThrow(/duplicate blueprint id/u);
    rmSync(join(directory, "c.json"));
    writeFileSync(join(directory, "d.json"), "{ not json");
    expect(() => loadBlueprintDirectory(directory)).toThrow(/not valid JSON/u);
  });
});

describe("fake-value grammar", () => {
  it.each([
    [FAKE_IBAN, "iban"],
    [FAKE_KEY, "api-key"],
    [FAKE_PHONE, "phone"],
    [FAKE_CUSTOMER_ID, "customer-id"],
    ["lena.sachs@example.invalid", "email"],
  ])("admits %s as exactly one allowed value", (value, kind) => {
    expect(valueShapeFindings(`Please note ${value}, thanks.`)).toEqual([
      { kind, value, allowed: true },
    ]);
    expect(forbiddenValueKinds(value)).toEqual([]);
  });

  // Look-alikes are assembled at runtime: a literal in the shape of a real provider key is refused
  // by GitHub push protection and by the secret scan, whatever its purpose.
  it.each([
    ["DE89 3704 0044 0532 0130 00", "iban"],
    [["sk-proj-", "abcdefghijklmnop1234"].join(""), "api-key"],
    ["sk-lab-not-hex-at-all-0123456789", "api-key"],
    [["AKIA", "ABCDEFGHIJKLMNOP"].join(""), "provider-token"],
    ["+49 171 2345678", "phone"],
    ["0171 2345678", "phone"],
    ["CUST-12345", "customer-id"],
    ["someone@example.com", "email"],
    ["https://service.example.test/path", "url"],
    [["a1B2c3D4e5F6g7H8i9J0", "k1L2m3N4o5P6q7R8s9T0"].join(""), "long-token"],
  ])("rejects the look-alike %s", (value, kind) => {
    expect(forbiddenValueKinds(`Look: ${value} end`)).toContain(kind);
  });

  it("does not mistake ordinary numbers, dates and slugs for values", () => {
    const text =
      "On 2027-03-18 at 09:30 we shipped 12 packages in 3 boxes; see engineering-review-before-merge.";
    expect(valueShapeFindings(text)).toEqual([]);
  });

  it("reports one value once, under the shape that claims it first", () => {
    expect(valueShapeFindings(FAKE_IBAN).map((finding) => finding.kind)).toEqual(["iban"]);
  });

  it("measures entropy in bits per character", () => {
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy("abab")).toBeCloseTo(1, 10);
    expect(shannonEntropy("0123456789abcdef")).toBeCloseTo(4, 10);
  });

  it("collects every string of a JSON-like value", () => {
    expect(collectStrings({ a: "x", b: ["y", { c: "z" }], d: 1 })).toEqual(["x", "y", "z"]);
  });
});

describe("text rules shared by the generator", () => {
  it("compares content words by a folded five-character stem and ignores function words", () => {
    expect(
      sharedContentStems("Welche Berichte schreibe ich?", "Meine Berichten liegen dort."),
    ).toEqual(["beric"]);
    expect(
      sharedContentStems("Which of these would you prefer?", "These are those things."),
    ).toEqual([]);
    expect(sharedContentStems("Prüfung der Unterlagen", "Die Prufung läuft")).toEqual(["prufu"]);
  });

  it("finds a memory command at the start of any sentence", () => {
    expect(startsWithMemoryCommand("Hallo. Vergiss nicht, den Bericht zu senden.")).toBe(true);
    expect(startsWithMemoryCommand("Please remember the meeting.")).toBe(false);
    expect(startsWithMemoryCommand("Hello! Remember this: tea.")).toBe(true);
    expect(startsWithMemoryCommand("Der Bericht liegt vor.")).toBe(false);
  });

  it("compiles term groups to the scorer's own matching rule", () => {
    const groups = [
      [["Tabellen"]],
      [["Zusammenfassung"], ["drei Sätzen", "drei Saetzen"]],
      [["Straße", "Strasse"]],
    ];
    const texts = [
      "Ich bevorzuge TABELLEN.",
      "Eine Zusammenfassung in drei Sätzen",
      "Eine Zusammenfassung in zwei Sätzen",
      "Die STRASSE ist lang, die Straße auch.",
      "",
    ];
    for (const set of groups)
      for (const text of texts)
        expect(compileTermGroups(set)(normalizeText(text))).toBe(matchesTermGroups(text, set));
  });

  it("blanks the answer terms out of a fact's own sentence", () => {
    expect(clozeQuestion("Ich bevorzuge einen dunklen Hintergrund.", [["dunklen"]], "de")).toBe(
      "Ergänze die Lücke in dem, was ich dir über mich gesagt habe: „Ich bevorzuge ___ Hintergrund.“",
    );
    expect(clozeQuestion("I prefer line charts over time.", [["line charts"]], "en")).toBe(
      "Fill in the gap in what I told you about myself: “I prefer ___ over time.”",
    );
    expect(
      clozeQuestion(
        "Reports start with a summary and end with an appendix.",
        [["summary"], ["appendix"]],
        "en",
      ),
    ).toBe("Fill in the gaps in what I told you about myself: “Reports start ___ and end ___.”");
    // Phrases that touch become one gap.
    expect(
      clozeQuestion(
        "Reports start with a summary in three sentences.",
        [["summary"], ["three"]],
        "en",
      ),
    ).toBe("Fill in the gap in what I told you about myself: “Reports start ___ sentences.”");
    expect(clozeQuestion("I prefer tables.", [["lists"]], "en")).toBeUndefined();
  });

  it("blanks the whole value phrase: the answer, the small words that belong to it, never a single word", () => {
    const phrases = (sentence, groups, language) =>
      blankValuePhrases(sentence, groups, language).phrases;
    expect(
      phrases(
        "Rückfragen von Kollegen beantworte ich am liebsten telefonisch.",
        [["telefonisch"]],
        "de",
      ),
    ).toEqual(["am liebsten telefonisch"]);
    expect(phrases("I do a cycle count on one aisle every Friday.", [["Friday"]], "en")).toEqual([
      "every Friday",
    ]);
    // A value of one word takes its neighbour on the left, or on the right at the start of a sentence.
    expect(phrases("Ich bevorzuge Kaffee am Morgen.", [["Kaffee"]], "de")).toEqual([
      "bevorzuge Kaffee",
    ]);
    expect(phrases("Kaffee trinke ich morgens.", [["Kaffee"]], "de")).toEqual(["Kaffee trinke"]);
    // Punctuation ends a phrase: a value after a comma does not pull in the word before it.
    expect(phrases("Ich trinke Tee, Kaffee nie.", [["Kaffee"]], "de")).toEqual(["Kaffee nie"]);
    // Terms that touch become one gap; terms that are far apart stay two.
    expect(
      blankValuePhrases(
        "I prefer morning workshops over afternoon ones.",
        [["morning"], ["workshops"]],
        "en",
      ),
    ).toMatchObject({ gaps: 1, phrases: ["morning workshops"] });
    expect(
      blankValuePhrases(
        "Reports start with a summary and end with an appendix.",
        [["summary"], ["appendix"]],
        "en",
      ),
    ).toMatchObject({ gaps: 2 });
    expect(blankValuePhrases("I prefer tables.", [["lists"]], "en")).toBeUndefined();
  });

  it("never leaves a single word to guess in any fact or change of the curated set", () => {
    for (const blueprint of curatedBlueprints()) {
      const sentences = [
        ...blueprint.facts.map((fact) => [fact.seed, fact.terms]),
        ...blueprint.changes.map((change) => [change.seed, change.terms]),
      ];
      for (const [sentence, terms] of sentences) {
        const blanked = blankValuePhrases(sentence, terms, blueprint.language);
        for (const phrase of blanked.phrases)
          expect(
            phrase.split(/\s+/u).length,
            `${blueprint.id}: ${sentence}`,
          ).toBeGreaterThanOrEqual(2);
        expect(clozeQuestion(sentence, terms, blueprint.language), sentence).toBeDefined();
      }
    }
  });
});

describe("curated blueprint set", () => {
  const blueprints = curatedBlueprints();
  const byLanguage = (language) =>
    blueprints.filter((blueprint) => blueprint.language === language);

  it("holds six German and six English people in twelve roles", () => {
    expect(byLanguage("de")).toHaveLength(6);
    expect(byLanguage("en")).toHaveLength(6);
    expect(blueprints.map((blueprint) => blueprint.role).toSorted()).toEqual(ROLES);
    expect(new Set(blueprints.map((blueprint) => blueprint.language))).toEqual(
      new Set(BLUEPRINT_LANGUAGES),
    );
    expect(
      readdirSync(DEFAULT_BLUEPRINT_DIR).filter((name) => name.endsWith(".json")),
    ).toHaveLength(blueprints.length);
  });

  it("gives every person the stated minimum of facts, changes, forgets, traps and probes", () => {
    for (const blueprint of blueprints) {
      expect(blueprint.facts.length, blueprint.id).toBeGreaterThanOrEqual(8);
      expect(blueprint.changes.length, blueprint.id).toBeGreaterThanOrEqual(2);
      expect(blueprint.forgets.length, blueprint.id).toBeGreaterThanOrEqual(1);
      expect(blueprint.traps.length, blueprint.id).toBeGreaterThanOrEqual(6);
      expect(blueprint.relational.length, blueprint.id).toBeGreaterThanOrEqual(2);
      expect(
        blueprint.facts.filter((fact) => fact.reason !== undefined).length,
        blueprint.id,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("covers every fact class and, in each language, every trap class and a fact taught inside a colleague sentence", () => {
    expect(
      new Set(blueprints.flatMap((blueprint) => blueprint.facts.map((fact) => fact.class))),
    ).toEqual(new Set(FACT_CLASSES));
    for (const language of BLUEPRINT_LANGUAGES) {
      const traps = byLanguage(language).flatMap((blueprint) => blueprint.traps);
      expect(new Set(traps.map((trap) => trap.class)), language).toEqual(new Set(TRAP_CLASSES));
      expect(
        traps.filter((trap) => trap.teaches !== undefined).length,
        language,
      ).toBeGreaterThanOrEqual(3);
    }
    const decisions = blueprints.flatMap((blueprint) =>
      blueprint.facts.filter((fact) => fact.class === "decision" && fact.reason !== undefined),
    );
    expect(decisions.length).toBeGreaterThanOrEqual(6);
  });

  it("uses every kind of value of the fake-value grammar, in both languages", () => {
    for (const language of BLUEPRINT_LANGUAGES) {
      const traps = byLanguage(language).flatMap((blueprint) => blueprint.traps);
      const kinds = (trapClass) =>
        new Set(
          traps
            .filter((trap) => trap.class === trapClass)
            .flatMap((trap) => valueShapeFindings(trap.text).map((finding) => finding.kind)),
        );
      expect([...kinds("identifier")].toSorted(), language).toEqual([
        "customer-id",
        "email",
        "iban",
        "phone",
      ]);
      expect([...kinds("credential")], language).toEqual(["api-key"]);
    }
  });

  it("holds no value outside the fake-value grammar anywhere in the checked-in files", () => {
    for (const name of readdirSync(DEFAULT_BLUEPRINT_DIR)) {
      const text = readFileSync(join(DEFAULT_BLUEPRINT_DIR, name), "utf8");
      const rejected = valueShapeFindings(text).filter((finding) => !finding.allowed);
      expect(rejected, name).toEqual([]);
    }
  });

  it("keeps every fake key below the entropy at which secret scanners call a string a key", () => {
    const keys = blueprints
      .flatMap((blueprint) => blueprint.traps)
      .flatMap((trap) => valueShapeFindings(trap.text))
      .filter((finding) => finding.kind === "api-key");
    expect(keys.length).toBeGreaterThanOrEqual(6);
    for (const key of keys) expect(shannonEntropy(key.value)).toBeLessThan(3.5);
  });

  it("names no real person, company or product: a denylist of common names stays absent", () => {
    const denied =
      /\b(google|microsoft|amazon|apple|openai|anthropic|github|slack|jira|salesforce|postgres|postgresql|mysql|kafka|python|java|javascript|excel|sap|oracle)\b/iu;
    for (const name of readdirSync(DEFAULT_BLUEPRINT_DIR))
      expect(readFileSync(join(DEFAULT_BLUEPRINT_DIR, name), "utf8"), name).not.toMatch(denied);
  });
});

describe("scripted pools", () => {
  it("offer the assistant's replies in every language and an object list for every curated person", () => {
    for (const language of BLUEPRINT_LANGUAGES) {
      expect(POOLS[language].leadAnswers.length, language).toBeGreaterThanOrEqual(3);
      expect(POOLS[language].acks.length, language).toBeGreaterThanOrEqual(5);
    }
    for (const blueprint of curatedBlueprints())
      expect(
        POOLS[blueprint.language].objects[blueprint.role].length,
        blueprint.id,
      ).toBeGreaterThanOrEqual(10);
  });

  it("hold no value-shaped string and no sentence that opens with a memory command", () => {
    const sentences = collectStrings(POOLS);
    expect(sentences.length).toBeGreaterThan(300);
    for (const sentence of sentences) {
      expect(forbiddenValueKinds(sentence), sentence).toEqual([]);
      expect(startsWithMemoryCommand(sentence), sentence).toBe(false);
    }
  });
});
