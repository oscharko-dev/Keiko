// Hermetic tests of the anchor converter (#4208): WildChat and OASST2 rows and LongMemEval instances
// become scenario v1 files the lab loads as they are. Every conversation below is invented; the
// assistant texts carry a marker so a leak into a scenario or a manifest is detectable.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../testing/coding-workbench-lab/lab-common.mjs";
import {
  CONVERSION_LIMITS,
  convertLongMemEval,
  convertOasstTree,
  convertWildChat,
  groupOasstMessages,
} from "../testing/memory-lab/anchor/converters.mjs";
import {
  convertAnchorSets,
  main,
  normalizeConvertOptions,
} from "../testing/memory-lab/anchor/convert.mjs";
import { ANCHOR_SETS } from "../testing/memory-lab/anchor/sets.mjs";
import {
  loadScenarioDirectory,
  scenarioSetManifest,
  validateScenario,
} from "../testing/memory-lab/scenario.mjs";

const ASSISTANT_MARKER = "ASSISTANT-TEXT-must-not-be-kept";
// A credential-shaped placeholder, assembled at run time so no literal in this file has the shape of
// a key (the repository's secret scan runs the default rule set over it).
const KEY_SHAPE = ["sk", "-", "AbCdEfGhIjKlMnOpQrStUvWx"].join("");

function wildChatEntry(hash, userTexts, overrides = {}) {
  const conversation = userTexts.flatMap((text, index) => [
    { role: "user", content: text, language: "German", turn_identifier: 2 * index },
    {
      role: "assistant",
      content: `${ASSISTANT_MARKER}-${hash}-${String(index)}`,
      language: "German",
      turn_identifier: 2 * index + 1,
    },
  ]);
  return {
    row_idx: 0,
    row: { conversation_hash: hash, language: "German", conversation, ...overrides },
    truncated_cells: [],
  };
}

function oasstMessage(id, parent, role, text, extra = {}) {
  return {
    row_idx: 0,
    row: {
      message_id: id,
      parent_id: parent,
      message_tree_id: "tree-1",
      role,
      text,
      lang: "de",
      created_date: "2023-01-01T00:00:00Z",
      rank: null,
      deleted: false,
      review_result: true,
      ...extra,
    },
    truncated_cells: [],
  };
}

function userTurns(scenario) {
  return scenario.turns.map((turn) => turn.user);
}

function captureError(action) {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected the action to throw");
}

describe("memory lab anchor converters", () => {
  describe("WildChat", () => {
    const set = ANCHOR_SETS["wildchat-de"];

    it("keeps the user turns, drops the assistant text and adds the unrelated probe", () => {
      const { scenario, redactions } = convertWildChat(
        wildChatEntry("conv-1", ["Ich mag Tabellen.", "Und kurze Antworten."]),
        set,
      );
      expect(validateScenario(scenario)).toBeTruthy();
      expect(scenario).toMatchObject({
        schemaVersion: 1,
        language: "de",
        class: "anchor-real",
        difficulty: "noisy",
        truth: [],
        probes: [
          { id: "unrelated", question: "Was ist Apache Kafka?", expect: { kind: "no-memory" } },
        ],
      });
      expect(scenario.id).toMatch(/^wildchat-de-[0-9a-f]{12}$/u);
      expect(userTurns(scenario)).toEqual(["Ich mag Tabellen.", "Und kurze Antworten."]);
      expect(JSON.stringify(scenario)).not.toContain(ASSISTANT_MARKER);
      expect(Object.values(redactions)).toEqual([0, 0, 0, 0, 0, 0]);
    });

    it("asks the English unrelated question for an English set", () => {
      const english = ANCHOR_SETS["wildchat-en"];
      const { scenario } = convertWildChat(wildChatEntry("conv-en", ["One.", "Two."]), english);
      expect(scenario.id).toMatch(/^wildchat-en-/u);
      expect(scenario.language).toBe("en");
      expect(scenario.probes[0].question).toBe("What is Apache Kafka?");
    });

    it("derives a stable id from the conversation hash alone", () => {
      const first = convertWildChat(wildChatEntry("same", ["a b", "c d"]), set);
      const second = convertWildChat(wildChatEntry("same", ["x y", "z w"]), set);
      const other = convertWildChat(wildChatEntry("other", ["a b", "c d"]), set);
      expect(second.scenario.id).toBe(first.scenario.id);
      expect(other.scenario.id).not.toBe(first.scenario.id);
    });

    it("redacts credential-shaped text in the turns and counts it", () => {
      const { scenario, redactions } = convertWildChat(
        wildChatEntry("secrets", [
          "Mail an erika@example.com und DE89 3704 0044 0532 0130 00",
          `Key ${KEY_SHAPE} und +49 170 1234567`,
        ]),
        set,
      );
      const text = userTurns(scenario).join("\n");
      expect(text).not.toMatch(/erika@|DE89|sk-Ab|170 1234567/u);
      expect(text).toContain("[redacted]");
      expect(redactions).toMatchObject({ email: 1, iban: 1, token: 1, phone: 1 });
    });

    it.each([
      ["one user turn", ["nur eine Frage"], "fewUserTurns"],
      ["only blank turns besides one", ["", "   ", "eine"], "fewUserTurns"],
      [
        "a turn over the length limit",
        ["x".repeat(CONVERSION_LIMITS.maxTurnChars + 1), "zwei"],
        "turnTooLong",
      ],
      [
        "more user turns than the limit",
        Array.from({ length: CONVERSION_LIMITS.maxUserTurns + 1 }, (_u, i) => `turn ${String(i)}`),
        "tooManyUserTurns",
      ],
    ])("skips a conversation with %s", (_name, texts, reason) => {
      expect(convertWildChat(wildChatEntry("skip", texts), set)).toEqual({ skip: reason });
    });

    it("accepts the boundaries: 4000 characters and 40 user turns", () => {
      const long = convertWildChat(
        wildChatEntry("long", ["x".repeat(CONVERSION_LIMITS.maxTurnChars), "zwei"]),
        set,
      );
      expect(long.scenario.turns[0].user).toHaveLength(CONVERSION_LIMITS.maxTurnChars);
      const many = convertWildChat(
        wildChatEntry(
          "many",
          Array.from({ length: CONVERSION_LIMITS.maxUserTurns }, (_u, i) => `turn ${String(i)}`),
        ),
        set,
      );
      expect(many.scenario.turns).toHaveLength(CONVERSION_LIMITS.maxUserTurns);
    });

    it("drops blank user turns before counting", () => {
      const { scenario } = convertWildChat(
        wildChatEntry("blank", ["", "Hallo", "  ", "Welt"]),
        set,
      );
      expect(userTurns(scenario)).toEqual(["Hallo", "Welt"]);
    });

    it("skips a truncated or malformed row by name", () => {
      const truncated = wildChatEntry("t", ["a", "b"]);
      truncated.truncated_cells = ["conversation"];
      expect(convertWildChat(truncated, set)).toEqual({ skip: "truncated" });
      expect(
        convertWildChat(wildChatEntry("m", ["a", "b"], { conversation: "text" }), set),
      ).toEqual({
        skip: "malformed",
      });
      expect(convertWildChat({ row: {} }, set)).toEqual({ skip: "malformed" });
      expect(convertWildChat(undefined, set)).toEqual({ skip: "malformed" });
    });

    it("tolerates a truncated cell that is not the conversation", () => {
      const entry = wildChatEntry("other-cell", ["a", "b"]);
      entry.truncated_cells = ["openai_moderation"];
      expect(convertWildChat(entry, set).scenario).toBeDefined();
    });

    it("falls back to the turns when a row carries no conversation hash", () => {
      const withoutHash = wildChatEntry("x", ["erste Frage", "zweite Frage"]);
      delete withoutHash.row.conversation_hash;
      const { scenario } = convertWildChat(withoutHash, set);
      expect(scenario.id).toMatch(/^wildchat-de-[0-9a-f]{12}$/u);
    });
  });

  describe("OASST2", () => {
    const set = ANCHOR_SETS["oasst2-de"];

    function tree() {
      // Deliberately shuffled: the chosen thread must not depend on row order.
      return [
        oasstMessage("p4", "a3", "prompter", "Danke, ich bevorzuge die Bahn."),
        oasstMessage("a3", "p1", "assistant", "Antwort drei"),
        oasstMessage("p1", "a2", "prompter", "Und wie viel kostet das?", {
          created_date: "2023-01-01T00:00:00Z",
        }),
        oasstMessage("a1", "r", "assistant", "Antwort B", { rank: 1 }),
        oasstMessage("r", null, "prompter", "Wie plane ich eine Reise?"),
        oasstMessage("p2", "a2", "prompter", "Eine spätere Folge", {
          created_date: "2023-02-01T00:00:00Z",
        }),
        oasstMessage("a2", "r", "assistant", "Antwort A", { rank: 0 }),
        oasstMessage("p3", "a1", "prompter", "Folge zur schlechteren Antwort"),
        oasstMessage("a0", "r", "assistant", "gelöscht", { rank: 0, deleted: true }),
        oasstMessage("a9", "r", "assistant", "durchgefallen", { rank: 0, review_result: false }),
      ].map((entry) => entry.row);
    }

    it("follows the best-ranked child at every level and keeps the prompter texts", () => {
      const { scenario, redactions } = convertOasstTree("tree-1", tree(), set);
      expect(userTurns(scenario)).toEqual([
        "Wie plane ich eine Reise?",
        "Und wie viel kostet das?",
        "Danke, ich bevorzuge die Bahn.",
      ]);
      expect(scenario).toMatchObject({
        language: "de",
        class: "anchor-real",
        difficulty: "noisy",
        truth: [],
      });
      expect(scenario.id).toMatch(/^oasst2-de-[0-9a-f]{12}$/u);
      expect(JSON.stringify(scenario)).not.toMatch(/Antwort|gelöscht|durchgefallen/u);
      expect(validateScenario(scenario)).toBeTruthy();
      expect(redactions.email).toBe(0);
    });

    it("chooses the same thread whatever the row order", () => {
      const forward = convertOasstTree("tree-1", tree(), set);
      const backward = convertOasstTree("tree-1", tree().toReversed(), set);
      expect(backward.scenario).toEqual(forward.scenario);
    });

    it("breaks rank ties by creation time and then by id", () => {
      const rows = [
        oasstMessage("r", null, "prompter", "Frage eins"),
        oasstMessage("b", "r", "assistant", "B", { created_date: "2023-03-01T00:00:00Z" }),
        oasstMessage("a", "r", "assistant", "A", { created_date: "2023-03-01T00:00:00Z" }),
        oasstMessage("pb", "b", "prompter", "Folge von B"),
        oasstMessage("pa", "a", "prompter", "Folge von A"),
      ].map((entry) => entry.row);
      expect(userTurns(convertOasstTree("t", rows, set).scenario)).toEqual([
        "Frage eins",
        "Folge von A",
      ]);
    });

    it("skips a thread with one prompter turn, a missing root or an unusable root", () => {
      const shortThread = [
        oasstMessage("r", null, "prompter", "Nur eine Frage"),
        oasstMessage("a", "r", "assistant", "Antwort"),
      ].map((entry) => entry.row);
      expect(convertOasstTree("t", shortThread, set)).toEqual({ skip: "fewUserTurns" });
      const orphan = [oasstMessage("c", "missing-parent", "prompter", "Waise")].map((e) => e.row);
      expect(convertOasstTree("t", orphan, set)).toEqual({ skip: "noRoot" });
      const rejected = [oasstMessage("r", null, "prompter", "Frage", { review_result: false })].map(
        (entry) => entry.row,
      );
      expect(convertOasstTree("t", rejected, set)).toEqual({ skip: "noRoot" });
    });

    it("stops at a cycle instead of looping", () => {
      const rows = [
        oasstMessage("r", null, "prompter", "Erste Frage"),
        oasstMessage("a1", "r", "assistant", "A"),
        oasstMessage("p1", "a1", "prompter", "Zweite Frage"),
        oasstMessage("a2", "p1", "assistant", "B"),
        // A malformed row that repeats an id and closes the loop back to the first assistant message.
        oasstMessage("a1", "a2", "prompter", "Schleife"),
      ].map((entry) => entry.row);
      expect(userTurns(convertOasstTree("t", rows, set).scenario)).toEqual([
        "Erste Frage",
        "Zweite Frage",
      ]);
    });

    it("groups rows by tree in first-appearance order and counts malformed rows", () => {
      const entries = [
        oasstMessage("a", null, "prompter", "x", { message_tree_id: "second" }),
        oasstMessage("b", null, "prompter", "y", { message_tree_id: "first" }),
        oasstMessage("c", "a", "assistant", "z", { message_tree_id: "second" }),
        { row: { message_id: "d" } },
        undefined,
      ];
      const { trees, malformed } = groupOasstMessages(entries);
      expect([...trees.keys()]).toEqual(["second", "first"]);
      expect(trees.get("second")).toHaveLength(2);
      expect(malformed).toBe(2);
    });
  });

  describe("LongMemEval", () => {
    function instance(overrides = {}) {
      return {
        question_id: "e47becba",
        question_type: "single-session-user",
        question: "What degree did I graduate with?",
        answer: "Business Administration",
        question_date: "2023/05/30 (Tue) 23:40",
        haystack_session_ids: ["filler-1", "answer_e47becba", "filler-2", "filler-3"],
        haystack_dates: ["d1", "d2", "d3", "d4"],
        haystack_sessions: [
          [
            { role: "user", content: "FILLER1-U1 mail me at filler@example.com" },
            { role: "assistant", content: "FILLER1-A1" },
            { role: "user", content: "FILLER1-U2" },
          ],
          [
            {
              role: "user",
              content: "EVIDENCE-U1 I graduated in Business Administration.",
              has_answer: true,
            },
            { role: "assistant", content: "EVIDENCE-A1" },
            { role: "user", content: "EVIDENCE-U2 call 1234567890 or evidence@example.com" },
          ],
          [
            { role: "user", content: "FILLER2-U1" },
            { role: "user", content: "FILLER2-U2" },
          ],
          [{ role: "user", content: "FILLER3-U1" }],
        ],
        answer_session_ids: ["answer_e47becba"],
        ...overrides,
      };
    }

    it("maps an answerable question to a truth fact, a probe and the user turns in order", () => {
      const { scenario, redactions } = convertLongMemEval(instance());
      expect(validateScenario(scenario)).toBeTruthy();
      expect(scenario).toMatchObject({
        schemaVersion: 1,
        id: "longmemeval-e47becba",
        language: "en",
        class: "anchor-benchmark",
        difficulty: "split",
        truth: [
          {
            key: "e47becba",
            seed: "Business Administration",
            must: true,
            terms: [["Business Administration"]],
          },
        ],
        probes: [
          {
            id: "question",
            question: "What degree did I graduate with?",
            expect: { kind: "answer", terms: [["Business Administration"]] },
          },
        ],
      });
      expect(userTurns(scenario).map((text) => text.split(" ")[0])).toEqual([
        "FILLER1-U1",
        "FILLER1-U2",
        "EVIDENCE-U1",
        "EVIDENCE-U2",
        "FILLER2-U1",
        "FILLER2-U2",
        "FILLER3-U1",
      ]);
      expect(JSON.stringify(scenario)).not.toMatch(/FILLER1-A1|EVIDENCE-A1/u);
      expect(scenario.description).toContain("single-session-user question over 4 of 4 sessions");
      expect(redactions.email).toBe(1);
    });

    it("keeps the full answer as one alternative, never split into words", () => {
      const { scenario } = convertLongMemEval(
        instance({ answer: "The Seattle area, 20 miles away" }),
      );
      expect(scenario.truth[0].terms).toEqual([["The Seattle area, 20 miles away"]]);
      expect(scenario.probes[0].expect.terms).toEqual([["The Seattle area, 20 miles away"]]);
    });

    it("redacts the filler sessions and leaves the synthetic evidence session verbatim", () => {
      const { scenario } = convertLongMemEval(instance());
      const text = userTurns(scenario).join("\n");
      expect(text).not.toContain("filler@example.com");
      expect(text).toContain("EVIDENCE-U2 call 1234567890 or evidence@example.com");
    });

    it("drops filler sessions first, in order, and keeps the evidence sessions whole", () => {
      const capped = convertLongMemEval(instance(), 4).scenario;
      // Budget 4 - 2 evidence turns = 2: filler 1 fits (2 turns); the later fillers no longer fit.
      expect(userTurns(capped).map((text) => text.split(" ")[0])).toEqual([
        "FILLER1-U1",
        "FILLER1-U2",
        "EVIDENCE-U1",
        "EVIDENCE-U2",
      ]);
      const tight = convertLongMemEval(instance(), 1).scenario;
      expect(userTurns(tight).map((text) => text.split(" ")[0])).toEqual([
        "EVIDENCE-U1",
        "EVIDENCE-U2",
      ]);
    });

    it("recognizes evidence by the has_answer flag when the session ids are missing", () => {
      const bare = instance({ haystack_session_ids: undefined, answer_session_ids: [] });
      const { scenario } = convertLongMemEval(bare, 2);
      expect(userTurns(scenario).map((text) => text.split(" ")[0])).toEqual([
        "EVIDENCE-U1",
        "EVIDENCE-U2",
      ]);
    });

    it.each([
      ["the _abs suffix", { question_id: "e47becba_abs" }],
      ["the abstention question type", { question_type: "abstention" }],
    ])("treats a question marked by %s as an abstention", (_name, overrides) => {
      const { scenario } = convertLongMemEval(
        instance({ answer: "Not enough information", ...overrides }),
      );
      expect(scenario.truth).toEqual([]);
      expect(scenario.probes[0]).toEqual({
        id: "question",
        question: "What degree did I graduate with?",
        expect: { kind: "abstain" },
      });
      expect(scenario.description).toContain("(abstention)");
      expect(validateScenario(scenario)).toBeTruthy();
    });

    it("needs no answer for an abstention but needs one otherwise", () => {
      expect(
        convertLongMemEval(instance({ question_id: "q_abs", answer: undefined })).scenario,
      ).toBeDefined();
      expect(convertLongMemEval(instance({ answer: "  " }))).toEqual({ skip: "noAnswer" });
      expect(convertLongMemEval(instance({ answer: null }))).toEqual({ skip: "noAnswer" });
    });

    it("writes a numeric answer as text", () => {
      const { scenario } = convertLongMemEval(instance({ answer: 7 }));
      expect(scenario.truth[0]).toMatchObject({ seed: "7", terms: [["7"]] });
      expect(scenario.probes[0].expect.terms).toEqual([["7"]]);
    });

    it.each([
      ["gpt4_2655b836", "longmemeval-gpt4-2655b836"],
      ["6D55-0036__abs", "longmemeval-6d55-0036-abs"],
      ["..x..y..", "longmemeval-x-y"],
    ])("builds the id from the question id %s", (questionId, id) => {
      expect(convertLongMemEval(instance({ question_id: questionId })).scenario.id).toBe(id);
    });

    it.each([
      ["no question id", { question_id: undefined }, "malformed"],
      ["an empty slug", { question_id: "___" }, "malformed"],
      ["an id that is too long", { question_id: "x".repeat(60) }, "malformed"],
      ["no question", { question: "" }, "malformed"],
      ["no haystack", { haystack_sessions: undefined }, "malformed"],
      ["no evidence session", { answer_session_ids: [], haystack_session_ids: [] }, "noEvidence"],
    ])("skips an instance with %s", (_name, overrides, reason) => {
      const bare = instance(overrides);
      if (reason === "noEvidence")
        for (const session of bare.haystack_sessions)
          for (const turn of session) delete turn.has_answer;
      expect(convertLongMemEval(bare)).toEqual({ skip: reason });
    });

    it("skips a preference question, whose answer is a rubric no term match can find", () => {
      const rubric = instance({
        question_type: "single-session-preference",
        answer: "The user would prefer replies that mention their cycling hobby.",
      });
      expect(convertLongMemEval(rubric)).toEqual({ skip: "rubricAnswer" });
      // An abstention is never a rubric question: it has no expected terms at all.
      expect(
        convertLongMemEval({ ...rubric, question_id: "pref_abs" }).scenario.probes[0].expect,
      ).toEqual({ kind: "abstain" });
    });

    it("skips an instance whose kept sessions hold no user turn", () => {
      const assistantOnly = instance({
        haystack_session_ids: ["answer_e47becba"],
        haystack_sessions: [[{ role: "assistant", content: "only me" }]],
      });
      expect(convertLongMemEval(assistantOnly)).toEqual({ skip: "noUserTurns" });
    });

    it("skips null and non-object instances", () => {
      expect(convertLongMemEval(null)).toEqual({ skip: "malformed" });
      expect(convertLongMemEval("text")).toEqual({ skip: "malformed" });
    });
  });
});

describe("memory lab anchor conversion pipeline", () => {
  const directories = [];
  function scratch() {
    const directory = mkdtempSync(join(tmpdir(), "anchor-convert-"));
    directories.push(directory);
    return directory;
  }
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  // Writes a fetched set the way the fetcher does: raw pages chained by rows received.
  function writeFetchedSet(inDir, name, entries, { pageSize = 2, manifest = {} } = {}) {
    const setDir = join(inDir, name);
    mkdirSync(join(setDir, "pages"), { recursive: true });
    for (let offset = 0; offset < entries.length; offset += pageSize)
      writeFileSync(
        join(setDir, "pages", `${String(offset)}.json`),
        JSON.stringify({
          rows: entries.slice(offset, offset + pageSize),
          num_rows_total: entries.length,
        }),
      );
    writeFileSync(
      join(setDir, "fetch-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        set: name,
        rowCount: entries.length,
        fetchedAt: "2026-11-03T20:00:00.000Z",
        limit: null,
        partial: false,
        ...manifest,
      }),
    );
  }

  function wildChatRows() {
    return [
      wildChatEntry("a1", [
        "Hallo, ich bin Erika und mag Tabellen. Mail: erika@example.com",
        "Meine IBAN DE89 3704 0044 0532 0130 00 bitte merken",
        `Danke, Token ${KEY_SHAPE} und Tel +49 170 1234567`,
      ]),
      wildChatEntry("b1", ["nur eine Frage"]),
      wildChatEntry("c1", ["x".repeat(4001), "zweite"]),
      wildChatEntry(
        "d1",
        Array.from({ length: 41 }, (_u, i) => `turn ${String(i)}`),
      ),
      wildChatEntry("a1", ["Hallo, ich bin Erika und mag Tabellen.", "doppelt"]),
      { ...wildChatEntry("e1", ["a", "b"]), truncated_cells: ["conversation"] },
      wildChatEntry("f1", ["a", "b"], { conversation: "kein Gespräch" }),
      wildChatEntry("g1", ["", "Bitte kurz", "  ", "und knapp"]),
    ];
  }

  function convert(inDir, overrides = {}) {
    const out = join(scratch(), "target");
    const manifest = convertAnchorSets({ in: inDir, out, ...overrides });
    return { out, manifest };
  }

  it("converts WildChat rows into scenarios the lab loads, with a body-free manifest", () => {
    const inDir = scratch();
    writeFetchedSet(inDir, "wildchat-de", wildChatRows());
    const { out, manifest } = convert(inDir);

    const loaded = loadScenarioDirectory(join(out, "scenarios"));
    expect(loaded).toHaveLength(2);
    expect(readdirSync(join(out, "scenarios")).toSorted()).toEqual(
      loaded.map((scenario) => `${scenario.id}.json`).toSorted(),
    );
    const erika = loaded.find((scenario) => scenario.turns[0].user.includes("Erika"));
    expect(erika.turns).toHaveLength(3);
    expect(erika.turns.map((turn) => turn.user).join("\n")).not.toMatch(
      /erika@|DE89|sk-Ab|170 1234/u,
    );

    const stats = manifest.sets["wildchat-de"];
    expect(stats).toMatchObject({
      dataset: "allenai/WildChat-1M",
      license: "ODC-By-1.0",
      language: "de",
      examined: 8,
      produced: 2,
      skipped: {
        fewUserTurns: 1,
        turnTooLong: 1,
        tooManyUserTurns: 1,
        duplicate: 1,
        truncated: 1,
        malformed: 1,
      },
      redactions: { email: 1, iban: 1, token: 1, phone: 1, bearer: 0, hex: 0, total: 4 },
      fetch: { fetchedAt: "2026-11-03T20:00:00.000Z", rowCount: 8, limit: null, partial: false },
    });
    expect(stats.citation).toContain("WildChat");
    expect(stats.style.userTurns).toBe(5);
    expect(stats.style.userTurnsPerScenario).toEqual({ min: 2, median: 3, p90: 3, max: 3 });
    expect(manifest.counts).toEqual({
      total: 2,
      bySet: { "wildchat-de": 2 },
      byLanguage: { de: 2 },
    });
    expect(manifest.limits).toMatchObject({ sample: null, maxTurns: 200, maxTurnChars: 4000 });
    // The digests are the ones the lab's own loader and manifest function produce for this directory.
    expect(manifest.scenarioSet).toEqual(scenarioSetManifest(loaded));
    expect(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"))).toEqual(manifest);

    const everything = [
      JSON.stringify(manifest),
      ...readdirSync(join(out, "scenarios")).map((name) =>
        readFileSync(join(out, "scenarios", name), "utf8"),
      ),
    ].join("\n");
    expect(everything).not.toContain(ASSISTANT_MARKER);
    expect(JSON.stringify(manifest)).not.toMatch(/Erika|Tabellen|erika@|IBAN/u);
  });

  it("is deterministic: the same input converts to the same bytes", () => {
    const inDir = scratch();
    writeFetchedSet(inDir, "wildchat-de", wildChatRows());
    const first = convert(inDir);
    const second = convert(inDir);
    expect(second.manifest).toEqual(first.manifest);
    const names = readdirSync(join(first.out, "scenarios")).toSorted();
    expect(readdirSync(join(second.out, "scenarios")).toSorted()).toEqual(names);
    for (const name of names)
      expect(readFileSync(join(second.out, "scenarios", name), "utf8")).toBe(
        readFileSync(join(first.out, "scenarios", name), "utf8"),
      );
  });

  it("takes the first N scenarios of each set in fetched order", () => {
    const inDir = scratch();
    const rows = Array.from({ length: 6 }, (_u, i) =>
      wildChatEntry(`row-${String(i)}`, [`Reihe ${String(i)} erste`, `Reihe ${String(i)} zweite`]),
    );
    writeFetchedSet(inDir, "wildchat-de", rows);
    const sampled = convert(inDir, { sample: 3 });
    const firstTurns = loadScenarioDirectory(join(sampled.out, "scenarios"))
      .map((scenario) => scenario.turns[0].user)
      .toSorted((left, right) => left.localeCompare(right));
    expect(firstTurns).toEqual(["Reihe 0 erste", "Reihe 1 erste", "Reihe 2 erste"]);
    expect(sampled.manifest.sets["wildchat-de"]).toMatchObject({ examined: 3, produced: 3 });
    expect(sampled.manifest.limits.sample).toBe(3);
    expect(sampled.manifest.scenarioSet.count).toBe(3);
  });

  it("counts a skipped row against the sample's examined rows, not its produced ones", () => {
    const inDir = scratch();
    const rows = [
      wildChatEntry("short", ["eine"]),
      wildChatEntry("ok-1", ["a", "b"]),
      wildChatEntry("ok-2", ["c", "d"]),
    ];
    writeFetchedSet(inDir, "wildchat-de", rows);
    const { manifest } = convert(inDir, { sample: 1 });
    expect(manifest.sets["wildchat-de"]).toMatchObject({
      examined: 2,
      produced: 1,
      skipped: { fewUserTurns: 1 },
    });
  });

  it("reconstructs OASST2 threads from fetched message rows", () => {
    const inDir = scratch();
    const rows = [
      oasstMessage("r1", null, "prompter", "Wie plane ich eine Reise?", { message_tree_id: "t1" }),
      oasstMessage("a1", "r1", "assistant", "Antwort", { message_tree_id: "t1", rank: 0 }),
      oasstMessage("p1", "a1", "prompter", "Und der Preis?", { message_tree_id: "t1" }),
      oasstMessage("r2", null, "prompter", "Allein", { message_tree_id: "t2" }),
      { row: { message_id: "broken" } },
    ];
    writeFetchedSet(inDir, "oasst2-de", rows);
    const { out, manifest } = convert(inDir);
    const [scenario] = loadScenarioDirectory(join(out, "scenarios"));
    expect(userTurns(scenario)).toEqual(["Wie plane ich eine Reise?", "Und der Preis?"]);
    expect(manifest.sets["oasst2-de"]).toMatchObject({
      license: "Apache-2.0",
      examined: 3,
      produced: 1,
      skipped: { malformed: 1, fewUserTurns: 1 },
    });
  });

  it("converts the LongMemEval file with the turn cap and the benchmark classes", () => {
    const inDir = scratch();
    const setDir = join(inDir, "longmemeval");
    mkdirSync(setDir, { recursive: true });
    const instances = [
      {
        question_id: "q1",
        question_type: "knowledge-update",
        question: "Where do I live now?",
        answer: "Lisbon",
        haystack_session_ids: ["f1", "answer_q1", "f2"],
        haystack_sessions: [
          [
            { role: "user", content: "FILLER-ONE" },
            { role: "user", content: "FILLER-ONE-B" },
          ],
          [{ role: "user", content: "I moved to Lisbon." }],
          [{ role: "user", content: "FILLER-TWO" }],
        ],
        answer_session_ids: ["answer_q1"],
      },
      {
        question_id: "q2_abs",
        question_type: "single-session-user",
        question: "What is my dog's name?",
        answer: "You never told me.",
        haystack_session_ids: ["x1"],
        haystack_sessions: [[{ role: "user", content: "I like tea." }]],
        answer_session_ids: ["x1"],
      },
      { question_id: "q3", question: "?", answer: "x", haystack_sessions: "broken" },
    ];
    writeFileSync(join(setDir, "longmemeval_s_cleaned.json"), JSON.stringify(instances));
    writeFileSync(
      join(setDir, "fetch-manifest.json"),
      JSON.stringify({
        set: "longmemeval",
        file: "longmemeval_s_cleaned.json",
        rowCount: null,
        bytes: 1,
        sha256: "0".repeat(64),
      }),
    );
    const { out, manifest } = convert(inDir, { maxTurns: 2 });
    const scenarios = loadScenarioDirectory(join(out, "scenarios"));
    expect(scenarios.map((scenario) => scenario.id)).toEqual([
      "longmemeval-q1",
      "longmemeval-q2-abs",
    ]);
    // Cap 2: the evidence session (1 turn) is kept whole, the 2-turn filler no longer fits.
    expect(userTurns(scenarios[0])).toEqual(["I moved to Lisbon.", "FILLER-TWO"]);
    expect(scenarios[1].probes[0].expect).toEqual({ kind: "abstain" });
    expect(manifest.sets.longmemeval).toMatchObject({
      license: "MIT",
      examined: 3,
      produced: 2,
      skipped: { malformed: 1 },
      fetch: { file: "longmemeval_s_cleaned.json", bytes: 1 },
    });
    expect(manifest.limits.maxTurns).toBe(2);
    expect(manifest.counts.byLanguage).toEqual({ en: 2 });
  });

  it("converts several sets into one manifest with counts per set and language", () => {
    const inDir = scratch();
    writeFetchedSet(inDir, "wildchat-de", [wildChatEntry("de-1", ["eins", "zwei"])]);
    writeFetchedSet(inDir, "wildchat-en", [
      wildChatEntry("en-1", ["one", "two"]),
      wildChatEntry("en-2", ["three", "four"]),
    ]);
    const { manifest } = convert(inDir);
    expect(manifest.counts).toEqual({
      total: 3,
      bySet: { "wildchat-de": 1, "wildchat-en": 2 },
      byLanguage: { de: 1, en: 2 },
    });
    expect(manifest.scenarioSet.count).toBe(3);
    expect(Object.keys(manifest.sets)).toEqual(["wildchat-de", "wildchat-en"]);
  });

  describe("refusals", () => {
    it("refuses a target or a source inside the checkout and creates nothing", () => {
      const inDir = scratch();
      writeFetchedSet(inDir, "wildchat-de", wildChatRows());
      const inside = join(REPO_ROOT, "anchor-convert-refusal-test");
      expect(() => convertAnchorSets({ in: inDir, out: inside })).toThrow(
        /--out must lie outside the checkout/u,
      );
      expect(() => convertAnchorSets({ in: inside, out: join(scratch(), "t") })).toThrow(
        /--in must lie outside the checkout/u,
      );
      expect(existsSync(inside)).toBe(false);
    });

    it("refuses to overwrite an existing conversion", () => {
      const inDir = scratch();
      writeFetchedSet(inDir, "wildchat-de", wildChatRows());
      const { out } = convert(inDir);
      expect(() => convertAnchorSets({ in: inDir, out })).toThrow(/refusing to overwrite/u);
      rmSync(join(out, "manifest.json"));
      expect(() => convertAnchorSets({ in: inDir, out })).toThrow(/refusing to overwrite/u);
    });

    it("refuses a source without fetched sets, or a set that was never fetched", () => {
      const empty = scratch();
      expect(() => convertAnchorSets({ in: empty, out: join(scratch(), "t") })).toThrow(
        /holds no fetched set/u,
      );
      expect(() =>
        convertAnchorSets({ in: empty, out: join(scratch(), "t"), sets: ["oasst2-de"] }),
      ).toThrow(/oasst2-de has no fetch-manifest\.json/u);
    });

    it("refuses an unknown set and a manifest that belongs to another set", () => {
      const inDir = scratch();
      writeFetchedSet(inDir, "wildchat-de", wildChatRows());
      expect(() =>
        convertAnchorSets({ in: inDir, out: join(scratch(), "t"), sets: ["nothing"] }),
      ).toThrow(/unknown set "nothing"/u);
      writeFileSync(
        join(inDir, "wildchat-de", "fetch-manifest.json"),
        JSON.stringify({ set: "oasst2-de", rowCount: 1 }),
      );
      expect(() => convertAnchorSets({ in: inDir, out: join(scratch(), "t") })).toThrow(
        /is not wildchat-de/u,
      );
    });

    it("fails closed when the page chain ends before the fetched row count", () => {
      const inDir = scratch();
      writeFetchedSet(inDir, "wildchat-de", wildChatRows());
      rmSync(join(inDir, "wildchat-de", "pages", "2.json"));
      const out = join(scratch(), "t");
      expect(() => convertAnchorSets({ in: inDir, out })).toThrow(
        /pages hold 2 of 8 fetched rows/u,
      );
    });

    it("never reads a page outside the chain nor rows beyond the fetched count", () => {
      const inDir = scratch();
      writeFetchedSet(inDir, "wildchat-de", wildChatRows().slice(0, 4), {
        manifest: { rowCount: 3 },
      });
      writeFileSync(
        join(inDir, "wildchat-de", "pages", "99.json"),
        JSON.stringify({ rows: [wildChatEntry("stale", ["alt", "alt"])] }),
      );
      const { manifest } = convert(inDir);
      expect(manifest.sets["wildchat-de"].examined).toBe(3);
    });

    it("never quotes conversation text when a page cannot be parsed", () => {
      const inDir = scratch();
      writeFetchedSet(inDir, "wildchat-de", wildChatRows());
      writeFileSync(
        join(inDir, "wildchat-de", "pages", "0.json"),
        '{"rows": [SECRET-CONVERSATION-TEXT',
      );
      const failure = captureError(() =>
        convertAnchorSets({ in: inDir, out: join(scratch(), "t") }),
      );
      expect(failure.message).toMatch(/a fetched page is not readable JSON/u);
      expect(failure.message).not.toContain("SECRET-CONVERSATION-TEXT");
      expect(failure.cause).toBeUndefined();
    });

    it("refuses a LongMemEval manifest that names a path instead of a file", () => {
      const inDir = scratch();
      mkdirSync(join(inDir, "longmemeval"), { recursive: true });
      writeFileSync(
        join(inDir, "longmemeval", "fetch-manifest.json"),
        JSON.stringify({ set: "longmemeval", file: "../escape.json", rowCount: null }),
      );
      expect(() => convertAnchorSets({ in: inDir, out: join(scratch(), "t") })).toThrow(
        /plain file/u,
      );
    });
  });

  describe("command line", () => {
    it("normalizes options and rejects defects", () => {
      expect(
        normalizeConvertOptions({
          in: "a",
          out: "b",
          set: ["wildchat-de,oasst2-de"],
          sample: "5",
          "max-turns": "50",
        }),
      ).toMatchObject({ sets: ["wildchat-de", "oasst2-de"], sample: 5, maxTurns: 50 });
      expect(normalizeConvertOptions({ in: "a", out: "b" }).sets).toBeUndefined();
      expect(() => normalizeConvertOptions({ in: "a" })).toThrow(/--in and --out are required/u);
      expect(() => normalizeConvertOptions({ in: "a", out: "b", sample: "0" })).toThrow(
        /--sample must be a positive integer/u,
      );
      expect(() => normalizeConvertOptions({ in: "a", out: "b", set: ["x"] })).toThrow(
        /unknown set/u,
      );
    });

    it("converts and prints counts only", async () => {
      const inDir = scratch();
      writeFetchedSet(inDir, "wildchat-de", wildChatRows());
      const out = join(scratch(), "cli");
      const lines = [];
      expect(
        await main(["--in", inDir, "--out", out, "--sample", "1"], (line) => lines.push(line)),
      ).toBe(0);
      expect(lines[0]).toMatch(/^wildchat-de examined=1 produced=1 skipped=- redactions=4$/u);
      expect(lines.at(-2)).toBe(`scenarios: ${join(out, "scenarios")}`);
      expect(lines.at(-1)).toBe("PASS anchor-convert scenarios=1");
      expect(lines.join("\n")).not.toContain("Erika");
    });

    it("prints usage for --help and refuses an unknown option", async () => {
      const lines = [];
      expect(await main(["--help"], (line) => lines.push(line))).toBe(0);
      expect(lines.join("\n")).toContain(
        "usage: node scripts/testing/memory-lab/anchor/convert.mjs",
      );
      await expect(main(["--nope"])).rejects.toThrow(/nope/u);
    });
  });
});
