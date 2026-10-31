import { describe, expect, it } from "vitest";
import { SCENARIOS } from "../testing/jira-chat-lab/requirements/catalog.mjs";
import { scenarioVerdict } from "../testing/jira-chat-lab/requirements/coverage.mjs";
import { STRUCTURE_RULES, buildCorpus } from "../testing/jira-chat-lab/requirements/corpus.mjs";
import { JOURNEYS } from "../testing/jira-chat-lab/requirements/journey-checks.mjs";

const scenario = (id) => SCENARIOS.find((entry) => entry.id === id);
const TRUTH = buildCorpus(1).truth;
const MUSS = TRUTH.filter((item) => item.priority === "Muss").map((item) => item.id);
const EPIC_LINK = "customfield_10001";
const wiki = (sections) => sections.map((name) => `h3. ${name}\nInhalt.`).join("\n\n");

/** An in-memory REQ project: the oracles read it through `search`, the stub turns write into it. */
function fakeJira() {
  const issues = [];
  const queries = [];
  return {
    queries,
    issues,
    createEpic(requirementId, { summary, labels = ["anforderung"] } = {}) {
      const title = TRUTH.find((item) => item.id === requirementId)?.title ?? "Titel";
      return add("Epic", {
        summary: summary ?? `[${requirementId}] ${title}`,
        description: wiki(STRUCTURE_RULES.Epic.sections),
        labels,
      });
    },
    createTask(epicKey, { sections = STRUCTURE_RULES.Task.sections } = {}) {
      return add("Task", {
        summary: "Umsetzung LH-002",
        description: wiki(sections),
        [EPIC_LINK]: epicKey,
      });
    },
    async search(query) {
      queries.push(query);
      const type = /issuetype = (\w+)/.exec(query)?.[1];
      const requirement = /summary ~ "(LH-\d{3})"/.exec(query)?.[1];
      return issues.filter(
        (issue) =>
          issue.fields.issuetype.name === type &&
          (requirement === undefined || issue.fields.summary.includes(requirement)),
      );
    },
  };
  function add(type, fields) {
    const key = `REQ-${issues.length + 1}`;
    issues.push({ key, fields: { issuetype: { name: type }, ...fields } });
    return key;
  }
}

/** Context whose turn runs `act` (the product's effects) and answers with what `act` returns. */
function context(jira, act, truth = { fieldIds: { epicLink: EPIC_LINK }, issues: [] }) {
  return {
    truth,
    search: (query) => jira.search(query),
    refusals: () => 0,
    turn: async () => {
      const { answer = "", writes = 1, toolExchanges = [] } = act();
      return {
        answer,
        toolExchanges,
        failure: undefined,
        durationMs: 1000,
        toolCalls: 2,
        approvals: { reads: 1, writes },
      };
    },
  };
}

const identityOf = (n) => `keiko-draft-${n.toString(16).padStart(20, "0")}`;
const draftEpic = (jira, requirementId, n) =>
  jira.createEpic(requirementId, { labels: ["anforderung", identityOf(n)] });
/** The completed `jira.draft` exchange of a turn; each item is `[state, issueKey?]`. */
const draftExchange = (items) => ({
  call: { id: "call-draft", name: "jira.draft", arguments: {} },
  result: {
    status: "completed",
    data: {
      outcome: "succeeded",
      items: items.map(([state, issueKey], index) => ({
        ref: `epic${index}`,
        state,
        ...(issueKey === undefined ? {} : { issueKey }),
      })),
    },
  },
});

const run = (id, ctx) => JOURNEYS[id](ctx, { id: "chat" });

describe("scenario verdict", () => {
  const s05 = scenario("S05");
  const journey = (covers, status = "green") => ({ layer: "journey", status, covers });
  const probe = (status = "green") => ({ layer: "probe", status, covers: ["fields-writable"] });

  it("is unchecked without checks and probe-only without a journey", () => {
    expect(scenarioVerdict(s05, []).status).toBe("unchecked");
    expect(scenarioVerdict(s05, [probe()]).status).toBe("probe-only");
  });

  it("is partial when a green journey leaves obligations uncovered", () => {
    const verdict = scenarioVerdict(s05, [journey(["epic-per-requirement"]), probe()]);
    expect(verdict.status).toBe("partial");
    expect(verdict.uncovered).toEqual(["template-conformance", "single-approval"]);
  });

  it("is green only when every obligation is covered by a passing check", () => {
    const all = journey(["epic-per-requirement", "template-conformance", "single-approval"]);
    expect(scenarioVerdict(s05, [all]).status).toBe("partial");
    expect(scenarioVerdict(s05, [all, probe()]).status).toBe("green");
  });

  it("credits nothing from a red check and turns red when any check is red", () => {
    const all = ["epic-per-requirement", "template-conformance", "single-approval"];
    expect(scenarioVerdict(s05, [journey(all, "red"), probe()]).status).toBe("red");
    expect(scenarioVerdict(s05, [journey(all), probe("red")]).status).toBe("red");
  });

  it("fails closed on an obligation the catalog does not know and on a check without covers", () => {
    expect(() => scenarioVerdict(s05, [journey(["invented"])])).toThrow(TypeError);
    expect(scenarioVerdict(s05, [{ layer: "journey", status: "green" }]).status).toBe("partial");
  });

  it("gives every scenario unique obligations", () => {
    for (const entry of SCENARIOS) {
      expect(entry.obligations.length, entry.id).toBeGreaterThan(0);
      expect(new Set(entry.obligations).size, entry.id).toBe(entry.obligations.length);
    }
  });
});

describe("S04 requirement listing", () => {
  const line = (item, parts) => parts.map((part) => item[part]).join(" | ");
  const answerOf = (parts) => TRUTH.map((item) => line(item, parts)).join("\n");
  const grade = async (answer) =>
    run(
      "S04",
      context(fakeJira(), () => ({ answer })),
    );

  it("is green only with title, priority and chapter for every requirement", async () => {
    expect((await grade(answerOf(["id", "title", "priority", "chapter"]))).status).toBe("green");
  });

  it("is not green for a bare id list", async () => {
    expect((await grade(TRUTH.map((item) => item.id).join("\n"))).status).toBe("red");
  });

  it.each([
    ["title", ["id", "priority", "chapter"]],
    ["priority", ["id", "title", "chapter"]],
    ["chapter", ["id", "title", "priority"]],
  ])("is not green when every %s is missing", async (_aspect, parts) => {
    expect((await grade(answerOf(parts))).status).toBe("red");
  });

  it("is not green when one chapter is wrong or one requirement is invented", async () => {
    const [first, ...rest] = TRUTH;
    const wrong = [{ ...first, chapter: first.chapter + 1 }, ...rest]
      .map((item) => line(item, ["id", "title", "priority", "chapter"]))
      .join("\n");
    expect((await grade(wrong)).status).toBe("red");
    const invented = `${answerOf(["id", "title", "priority", "chapter"])}\nLH-999 | Erfunden | Muss | 2`;
    expect((await grade(invented)).status).toBe("red");
  });
});

describe("S05 epics in one approval", () => {
  const ids = ["LH-001", "LH-002", "LH-003"];
  const createAll = (jira) => () => {
    ids.forEach((id) => jira.createEpic(id));
    return { writes: 1 };
  };

  it("is green for three conforming new epics approved once", async () => {
    const jira = fakeJira();
    expect((await run("S05", context(jira, createAll(jira)))).status).toBe("green");
  });

  it("is not green when the epics needed more than one approval", async () => {
    const jira = fakeJira();
    const ctx = context(jira, () => {
      createAll(jira)();
      return { writes: 3 };
    });
    expect((await run("S05", ctx)).status).toBe("red");
  });

  it("does not credit epics of an earlier run to a second turn that wrote nothing", async () => {
    const jira = fakeJira();
    await run("S05", context(jira, createAll(jira)));
    const second = await run(
      "S05",
      context(jira, () => ({ writes: 0 })),
    );
    expect(second.status).toBe("red");
    expect(second.detail).toContain("0/3 conforming epics, 0 epics created");
  });

  it("verifies each of two rapid consecutive runs on its own effects", async () => {
    const jira = fakeJira();
    const first = await run("S05", context(jira, createAll(jira)));
    const second = await run("S05", context(jira, createAll(jira)));
    expect([first.status, second.status]).toEqual(["green", "green"]);
    expect(jira.issues).toHaveLength(6);
  });

  it("reads Jira without any timestamp, so the actor's timezone cannot matter", async () => {
    const jira = fakeJira();
    await run("S05", context(jira, createAll(jira)));
    expect(jira.queries.length).toBeGreaterThan(0);
    for (const query of jira.queries) expect(query).not.toMatch(/created/i);
  });

  it("is only partial together with a passing probe until the journey is complete", async () => {
    const jira = fakeJira();
    const check = { layer: "journey", ...(await run("S05", context(jira, createAll(jira)))) };
    expect(scenarioVerdict(scenario("S05"), [check]).status).toBe("partial");
    const probe = { layer: "probe", status: "green", covers: ["fields-writable"] };
    expect(scenarioVerdict(scenario("S05"), [probe, check]).status).toBe("green");
  });
});

describe("S05 reruns reconciled by the draft", () => {
  const ids = ["LH-001", "LH-002", "LH-003"];
  const seeded = (jira) => ids.map((id, index) => draftEpic(jira, id, index + 1));

  it("is green for a rerun in which every item is existing, reported as reconciled", async () => {
    const jira = fakeJira();
    const keys = seeded(jira);
    const ctx = context(jira, () => ({
      toolExchanges: [draftExchange(keys.map((key) => ["existing", key]))],
    }));
    const check = await run("S05", ctx);
    expect(check.status).toBe("green");
    expect(check.detail).toContain("3/3 conforming epics, 0 epics created, 3 reconciled");
    expect(jira.issues).toHaveLength(3);
  });

  it("is green for a run that created some epics and reconciled the others", async () => {
    const jira = fakeJira();
    const first = draftEpic(jira, ids[0], 1);
    const ctx = context(jira, () => {
      const added = [draftEpic(jira, "LH-002", 2), draftEpic(jira, "LH-003", 3)];
      return {
        toolExchanges: [
          draftExchange([["existing", first], ...added.map((key) => ["created", key])]),
        ],
      };
    });
    const check = await run("S05", ctx);
    expect(check.status).toBe("green");
    expect(check.detail).toContain("2 epics created, 1 reconciled");
  });

  it("counts neither an uncertain nor a failed item", async () => {
    const jira = fakeJira();
    const [one, two, three] = seeded(jira);
    const uncertain = context(jira, () => ({
      toolExchanges: [
        draftExchange([
          ["existing", one],
          ["existing", two],
          ["uncertain", three],
        ]),
      ],
    }));
    const check = await run("S05", uncertain);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("2/3 conforming epics, 0 epics created, 2 reconciled");
    const failed = context(jira, () => ({
      toolExchanges: [draftExchange([["existing", one], ["existing", two], ["failed"]])],
    }));
    expect((await run("S05", failed)).status).toBe("red");
  });

  it("does not credit a pre-existing epic the draft did not report", async () => {
    const jira = fakeJira();
    const [one, two] = seeded(jira);
    const ctx = context(jira, () => ({
      toolExchanges: [
        draftExchange([
          ["existing", one],
          ["existing", two],
        ]),
      ],
    }));
    const check = await run("S05", ctx);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("2/3 conforming epics");
  });

  it("does not credit pre-existing epics when the turn holds no draft result", async () => {
    const jira = fakeJira();
    seeded(jira);
    const check = await run(
      "S05",
      context(jira, () => ({ writes: 0 })),
    );
    expect(check.status).toBe("red");
    expect(check.detail).toContain("0/3 conforming epics, 0 epics created, 0 reconciled");
  });

  it("is red for a duplicate of an already existing draft identity", async () => {
    const jira = fakeJira();
    seeded(jira);
    const ctx = context(jira, () => {
      const added = ids.map((id, index) => draftEpic(jira, id, index + 1));
      return { toolExchanges: [draftExchange(added.map((key) => ["created", key]))] };
    });
    const check = await run("S05", ctx);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("3 duplicates");
  });
});

describe("S07 tasks under the requirement epic", () => {
  const epicOf = (jira) => jira.createEpic("LH-002");
  const twoTasks = (jira, epic) => () => {
    jira.createTask(epic);
    jira.createTask(epic);
    return {};
  };

  it("is green for two new conforming tasks linked to the LH-002 epic", async () => {
    const jira = fakeJira();
    const epic = epicOf(jira);
    expect((await run("S07", context(jira, twoTasks(jira, epic)))).status).toBe("green");
  });

  it("does not pass on tasks of an earlier journey when the turn wrote nothing", async () => {
    const jira = fakeJira();
    const epic = epicOf(jira);
    await run("S07", context(jira, twoTasks(jira, epic)));
    const second = await run(
      "S07",
      context(jira, () => ({ writes: 0 })),
    );
    expect(second.status).toBe("red");
    expect(second.detail).toContain("0 of 0 tasks created in this turn");
  });

  it("verifies each of two rapid consecutive runs on its own two tasks", async () => {
    const jira = fakeJira();
    const epic = epicOf(jira);
    const first = await run("S07", context(jira, twoTasks(jira, epic)));
    const second = await run("S07", context(jira, twoTasks(jira, epic)));
    expect([first.status, second.status]).toEqual(["green", "green"]);
  });

  it("is not green for one new task, for an unlinked task or for missing sections", async () => {
    const one = fakeJira();
    const oneEpic = epicOf(one);
    expect(
      (
        await run(
          "S07",
          context(one, () => (one.createTask(oneEpic), {})),
        )
      ).status,
    ).toBe("red");
    const unlinked = fakeJira();
    epicOf(unlinked);
    const loose = context(unlinked, () => {
      unlinked.createTask("REQ-99");
      unlinked.createTask("REQ-99");
      return {};
    });
    expect((await run("S07", loose)).status).toBe("red");
    const bare = fakeJira();
    const bareEpic = epicOf(bare);
    const sparse = context(bare, () => {
      bare.createTask(bareEpic, { sections: ["Umsetzungsschritte"] });
      bare.createTask(bareEpic, { sections: ["Umsetzungsschritte"] });
      return {};
    });
    expect((await run("S07", sparse)).status).toBe("red");
  });
});

describe("S11 compliance report", () => {
  const OBLIGATIONS = ["deviating-issues", "deviation-detail"];
  const FIELDS = { epicLink: "customfield_10001", storyPoints: "customfield_10002" };
  const issues = [
    { key: "RPT-1", deviations: ["summary", "section:Abgrenzung"] },
    { key: "RPT-2", deviations: [] },
    { key: "RPT-3", deviations: ["parent"] },
  ];
  const truth = { fieldIds: FIELDS, issues };
  /** The deviation list of a completed `jira.report` call, as the tool returns it. */
  const reportOf = (items) => ({
    call: { id: "call-1", name: "jira.report", arguments: { projectKey: "RPT" } },
    result: {
      status: "completed",
      data: {
        outcome: "succeeded",
        status: "complete",
        report: { compliance: { deviations: { total: items.length, items } } },
      },
    },
  });
  const ENTRIES = [
    { key: "RPT-1", ruleIds: ["template.summary", "template.section.abgrenzung"], fieldIds: [] },
    { key: "RPT-3", ruleIds: ["required-field-empty"], fieldIds: [FIELDS.epicLink] },
  ];
  const grade = async (answer, toolExchanges = [reportOf(ENTRIES)], world = truth) =>
    run(
      "S11",
      context(fakeJira(), () => ({ answer, toolExchanges }), world),
    );
  const verdict = (check) => scenarioVerdict(scenario("S11"), [{ layer: "journey", ...check }]);

  it("is green when every deviating issue is reported by the tool and each deviation described", async () => {
    const answer = [
      "RPT-1: Zusammenfassung ohne [LH-xxx]-Präfix; Abschnitt Abgrenzung fehlt",
      "RPT-3: kein Epic zugeordnet",
    ].join("\n");
    const check = await grade(answer);
    expect(check.status).toBe("green");
    expect(verdict(check).status).toBe("green");
  });

  it("is not green for the right keys without their deviations", async () => {
    expect((await grade("RPT-1\nRPT-3")).status).toBe("red");
  });

  it("is not green when one seeded deviation of an issue is not described", async () => {
    const answer = "RPT-1: Abschnitt Abgrenzung fehlt\nRPT-3: Epic-Zuordnung fehlt";
    const check = await grade(answer);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("1 of 3 seeded deviations not described");
  });

  it("is not green for a false finding or a missed issue", async () => {
    expect((await grade("RPT-1: Zusammenfassung, Abgrenzung\nRPT-2: Zusammenfassung")).status).toBe(
      "red",
    );
  });

  it("does not take a compliant issue for a false finding", async () => {
    const answer = [
      "RPT-1: Zusammenfassung ohne Präfix; Abschnitt Abgrenzung fehlt",
      "RPT-2: keine Abweichung",
      "RPT-3: Epic fehlt",
    ].join("\n");
    expect((await grade(answer)).status).toBe("green");
  });

  describe("an answer that denies the seeded deviations", () => {
    const FIVE = ["summary", "parent", "estimate", "label:req", "section:Abnahmekriterien"];
    const fiveTruth = { fieldIds: FIELDS, issues: [{ key: "RPT-1", deviations: FIVE }] };
    const fiveEntry = {
      key: "RPT-1",
      ruleIds: [
        "template.summary-prefix",
        "template.parent-epic",
        "template.estimate-missing",
        "template.label-req",
        "template.section-abnahmekriterien",
      ],
      fieldIds: [],
    };
    const gradeFive = (answer, toolExchanges = [reportOf([fiveEntry])]) =>
      grade(answer, toolExchanges, fiveTruth);
    const DESCRIBED = [
      "Summary ohne Präfix [LH-",
      "Parent: kein Epic zugeordnet",
      "Estimate fehlt",
      "Label req fehlt",
    ];

    it("is not green and credits no obligation for the reviewer's negated answer", async () => {
      const check = await gradeFive(
        "RPT-1: Keine Abweichung. Summary, Parent, Estimate, Label und Abnahmekriterien sind vollständig und korrekt.",
      );
      expect(check.status).toBe("red");
      expect(check.detail).toContain("5 of 5 seeded deviations not described");
      const result = verdict(check);
      expect(result.status).toBe("red");
      expect(result.uncovered).toEqual(OBLIGATIONS);
      expect(result.covered).toEqual([]);
    });

    it.each([
      "RPT-1: Keine Abweichung. Summary, Parent, Estimate, Label und Abnahmekriterien.",
      "Summary, Parent, Estimate, Label und Abnahmekriterien von RPT-1 sind vollständig und korrekt.",
      "RPT-1: No deviation. Summary, parent, estimate, label and Abnahmekriterien are compliant.",
      "RPT-1: Abweichungen: keine. Summary, Parent, Estimate, Label und Abnahmekriterien.",
      "RPT-1: nothing to report. Summary, parent, estimate, label and Abnahmekriterien.",
      "RPT-1: kein Fehler gefunden; Summary, Parent, Estimate, Label, Abnahmekriterien in Ordnung.",
      "RPT-1 is correct: summary, parent, estimate, label and Abnahmekriterien all match the template.",
    ])("is not green for the denial %#", async (answer) => {
      const check = await gradeFive(answer);
      expect(check.status).toBe("red");
      expect(check.detail).toMatch(/[1-5] of 5 seeded deviations not described/);
    });

    it("is green when a structured result and an answer naming each deviation agree", async () => {
      const check = await gradeFive(
        [...DESCRIBED, "Abschnitt Abnahmekriterien fehlt"]
          .map((line) => `RPT-1: ${line}`)
          .join("\n"),
      );
      expect(check.status).toBe("green");
      expect(verdict(check).covered).toEqual(OBLIGATIONS);
    });

    it("keeps a deviation that merely contains a denial word described", async () => {
      const answer = [
        "RPT-1: Summary entspricht nicht der Vorgabe; Parent ist nicht korrekt gesetzt",
        "Estimate fehlt, Label req fehlt, Abschnitt Abnahmekriterien fehlt vollständig",
      ].join("\n");
      expect((await gradeFive(answer)).status).toBe("green");
    });

    it("is red with one undescribed deviation when four are described and one is denied", async () => {
      const answer = [
        `RPT-1: ${DESCRIBED.join("; ")}.`,
        "Abnahmekriterien sind vollständig und korrekt.",
      ].join("\n");
      const check = await gradeFive(answer);
      expect(check.status).toBe("red");
      expect(check.detail).toContain("1 of 5 seeded deviations not described");
      expect(verdict(check).covered).toEqual([]);
    });
  });

  describe("without a matching structured result", () => {
    const answer = [
      "RPT-1: Zusammenfassung ohne Präfix; Abschnitt Abgrenzung fehlt",
      "RPT-3: kein Epic zugeordnet",
    ].join("\n");

    it("credits nothing when the turn holds no jira.report result", async () => {
      for (const exchanges of [
        [],
        null,
        [
          {
            call: { id: "c", name: "jira.search", arguments: {} },
            result: { status: "completed", data: {} },
          },
        ],
        [{ ...reportOf(ENTRIES), result: { status: "failed", reason: "x", data: null } }],
        [{ ...reportOf(ENTRIES), result: { status: "completed", data: { outcome: "failed" } } }],
      ]) {
        const check = await grade(answer, exchanges);
        expect(check.status).toBe("unverified");
        expect(check.covers).toEqual([]);
        const result = verdict(check);
        expect(result.status).toBe("partial");
        expect(result.uncovered).toEqual(OBLIGATIONS);
      }
    });

    it("is red when the tool did not report a seeded deviation for the right issue", async () => {
      const wrongIssue = [{ ...ENTRIES[0], key: "RPT-2" }, ENTRIES[1]];
      const check = await grade(answer, [reportOf(wrongIssue)]);
      expect(check.status).toBe("red");
      expect(check.detail).toContain("2 not reported by the tool");
      const missingRule = [
        { key: "RPT-1", ruleIds: ["template.summary"], fieldIds: [] },
        ENTRIES[1],
      ];
      expect((await grade(answer, [reportOf(missingRule)])).status).toBe("red");
    });

    it("reads deviations that arrive in a later section page", async () => {
      const page = {
        call: { id: "call-2", name: "jira.report", arguments: { section: "deviations" } },
        result: {
          status: "completed",
          data: {
            outcome: "succeeded",
            section: { name: "deviations", total: 1, items: [ENTRIES[1]] },
          },
        },
      };
      expect((await grade(answer, [reportOf([ENTRIES[0]]), page])).status).toBe("green");
    });
  });
});

describe("S17 long backlog request", () => {
  const createFor = (jira, ids) => ids.map((id) => jira.createEpic(id));
  const keysOf = (jira) => jira.issues.map((issue) => issue.key).join(", ");

  it("is green when new epics map one to one onto the Muss requirements and the answer lists them", async () => {
    const jira = fakeJira();
    const ctx = context(jira, () => {
      createFor(jira, MUSS);
      return { answer: `Angelegt: ${keysOf(jira)}` };
    });
    const check = await run("S17", ctx);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual([
      "epic-per-must-requirement",
      "answer-lists-created-keys",
      "no-generation-refusal",
    ]);
  });

  it("is not green for unrelated epics of the right number with an answer without keys", async () => {
    const jira = fakeJira();
    const ctx = context(jira, () => {
      for (let n = 0; n < MUSS.length; n += 1) jira.createEpic("LH-000", { summary: `Etwas ${n}` });
      return { answer: "Fertig, alle Epics sind angelegt." };
    });
    expect((await run("S17", ctx)).status).toBe("red");
  });

  it("is not green when the answer omits one created key", async () => {
    const jira = fakeJira();
    const ctx = context(jira, () => {
      createFor(jira, MUSS);
      return {
        answer: `Angelegt: ${jira.issues
          .slice(1)
          .map((issue) => issue.key)
          .join(", ")}`,
      };
    });
    expect((await run("S17", ctx)).status).toBe("red");
  });

  it("is not green when one requirement is created twice and another is missed", async () => {
    const jira = fakeJira();
    const ctx = context(jira, () => {
      createFor(jira, [MUSS[0], ...MUSS.slice(0, -1)]);
      return { answer: keysOf(jira) };
    });
    expect((await run("S17", ctx)).status).toBe("red");
  });

  it("does not count the epics of an earlier run for a second turn that wrote nothing", async () => {
    const jira = fakeJira();
    const first = context(jira, () => {
      createFor(jira, MUSS);
      return { answer: keysOf(jira) };
    });
    expect((await run("S17", first)).status).toBe("green");
    const second = context(jira, () => ({ answer: keysOf(jira), writes: 0 }));
    const check = await run("S17", second);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("0 epics created");
  });

  it("is not green when a generation-changed refusal was logged during the turn", async () => {
    const jira = fakeJira();
    let refusals = 0;
    const ctx = {
      ...context(jira, () => {
        createFor(jira, MUSS);
        refusals += 1;
        return { answer: keysOf(jira) };
      }),
      refusals: () => refusals,
    };
    expect((await run("S17", ctx)).status).toBe("red");
  });
});

describe("S17 reruns reconciled by the draft", () => {
  const seeded = (jira) => MUSS.map((id, index) => draftEpic(jira, id, index + 1));
  const existing = (keys) => draftExchange(keys.map((key) => ["existing", key]));

  it("is green for a rerun of only existing items whose keys the answer lists", async () => {
    const jira = fakeJira();
    const keys = seeded(jira);
    const ctx = context(jira, () => ({
      answer: `Bereits vorhanden: ${keys.join(", ")}`,
      toolExchanges: [existing(keys)],
    }));
    const check = await run("S17", ctx);
    expect(check.status).toBe("green");
    expect(check.detail).toContain(`0 epics created, ${MUSS.length} reconciled`);
  });

  it("is green for a mixed run and requires the answer to list the reconciled keys too", async () => {
    const mixed = (answerOf) => {
      const jira = fakeJira();
      const first = draftEpic(jira, MUSS[0], 1);
      return context(jira, () => {
        const added = MUSS.slice(1).map((id, index) => draftEpic(jira, id, index + 2));
        return {
          answer: answerOf([first, ...added]),
          toolExchanges: [
            draftExchange([["existing", first], ...added.map((key) => ["created", key])]),
          ],
        };
      });
    };
    const omitted = await run(
      "S17",
      mixed((keys) => keys.slice(1).join(", ")),
    );
    expect(omitted.status).toBe("red");
    expect(omitted.detail).toContain("1 reported keys missing from the answer");
    const listed = await run(
      "S17",
      mixed((keys) => keys.join(", ")),
    );
    expect(listed.status).toBe("green");
    expect(listed.detail).toContain(`${MUSS.length - 1} epics created, 1 reconciled`);
  });

  it("does not count an uncertain item nor an unreported pre-existing epic", async () => {
    const jira = fakeJira();
    const keys = seeded(jira);
    const uncertain = context(jira, () => ({
      answer: keys.join(", "),
      toolExchanges: [
        draftExchange([...keys.slice(1).map((key) => ["existing", key]), ["uncertain", keys[0]]]),
      ],
    }));
    expect((await run("S17", uncertain)).status).toBe("red");
    const unreported = context(jira, () => ({
      answer: keys.join(", "),
      toolExchanges: [existing(keys.slice(1))],
    }));
    expect((await run("S17", unreported)).status).toBe("red");
  });

  it("is red for a duplicate of an already existing draft identity", async () => {
    const jira = fakeJira();
    seeded(jira);
    const ctx = context(jira, () => {
      const added = MUSS.map((id, index) => draftEpic(jira, id, index + 1));
      return {
        answer: added.join(", "),
        toolExchanges: [draftExchange(added.map((key) => ["created", key]))],
      };
    });
    const check = await run("S17", ctx);
    expect(check.status).toBe("red");
    expect(check.detail).toContain(`${MUSS.length} duplicates`);
  });
});
