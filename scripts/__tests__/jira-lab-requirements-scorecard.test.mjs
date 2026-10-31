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
      const { answer = "", writes = 1 } = act();
      return {
        answer,
        failure: undefined,
        durationMs: 1000,
        toolCalls: 2,
        approvals: { reads: 1, writes },
      };
    },
  };
}

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
  const issues = [
    { key: "RPT-1", deviations: ["summary", "section:Abgrenzung"] },
    { key: "RPT-2", deviations: [] },
    { key: "RPT-3", deviations: ["parent"] },
  ];
  const truth = { fieldIds: {}, issues };
  const grade = async (answer) =>
    run(
      "S11",
      context(fakeJira(), () => ({ answer }), truth),
    );

  it("is green when every deviating issue and each of its deviations is described", async () => {
    const answer = [
      "RPT-1: Zusammenfassung ohne [LH-xxx]-Präfix; Abschnitt Abgrenzung fehlt",
      "RPT-3: kein Epic zugeordnet",
    ].join("\n");
    expect((await grade(answer)).status).toBe("green");
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
