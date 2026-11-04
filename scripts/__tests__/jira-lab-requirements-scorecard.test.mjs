import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { SCENARIOS } from "../testing/jira-chat-lab/requirements/catalog.mjs";
import {
  deferredObligations,
  scenarioVerdict,
} from "../testing/jira-chat-lab/requirements/coverage.mjs";
import { scorecardMarkdown } from "../testing/jira-chat-lab/requirements/scorecard-markdown.mjs";
import { STRUCTURE_RULES, buildCorpus } from "../testing/jira-chat-lab/requirements/corpus.mjs";
import {
  gradeCatalogRefresh,
  gradeInterruption,
} from "../testing/jira-chat-lab/requirements/backlog-turn.mjs";
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
    createTask(epicKey, { sections = STRUCTURE_RULES.Task.sections, labels = [] } = {}) {
      return add("Task", {
        summary: "Umsetzung LH-002",
        description: wiki(sections),
        labels,
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
/** The product's skill-library routes, recording each template import and delete. */
function fakeSkills() {
  const calls = [];
  let next = 0;
  const http = async (name, path, body) => {
    calls.push({ name, path, body });
    if (name === "template-import") {
      next += 1;
      return { skill: { id: `skill-${String(next)}`, revision: 1 } };
    }
    return null;
  };
  return { calls, http };
}

function context(
  jira,
  act,
  truth = { fieldIds: { epicLink: EPIC_LINK }, issues: [] },
  skills = fakeSkills(),
) {
  return {
    truth,
    http: skills.http,
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
        approvals: { writes },
      };
    },
  };
}

const identityOf = (n) => `keiko-draft-${n.toString(16).padStart(20, "0")}`;
const draftEpic = (jira, requirementId, n) =>
  jira.createEpic(requirementId, { labels: ["anforderung", identityOf(n)] });
/** The completed `jira.draft` exchange of a turn; each item is `[state, issueKey?]`. */
const draftExchange = (items) => ({
  call: { id: "call-draft", name: "jira_draft", arguments: {} },
  result: {
    toolRef: { canonicalId: "keiko.jira.draft", contractVersion: 3 },
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
    expect(second.detail).toContain("0 of 0 tasks of this turn");
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

describe("S07 reruns reconciled by the draft", () => {
  const draftTask = (jira, epic, n) => jira.createTask(epic, { labels: [identityOf(n)] });

  it("is green when the draft reconciles one task and creates the other", async () => {
    const jira = fakeJira();
    const epic = jira.createEpic("LH-002");
    const existing = draftTask(jira, epic, 1);
    const ctx = context(jira, () => ({
      toolExchanges: [
        draftExchange([
          ["existing", existing],
          ["created", draftTask(jira, epic, 2)],
        ]),
      ],
    }));
    const check = await run("S07", ctx);
    expect(check.status).toBe("green");
    expect(check.detail).toContain("2 of 2 tasks of this turn");
    expect(check.detail).toContain("1 tasks created, 1 reconciled");
  });

  it("credits the reconciled items of a draft whose overall status is failed", async () => {
    const jira = fakeJira();
    const epic = jira.createEpic("LH-002");
    const existing = draftTask(jira, epic, 1);
    const refused = draftExchange([["existing", existing], ["failed"]]);
    const ctx = context(jira, () => ({
      toolExchanges: [
        { ...refused, result: { ...refused.result, status: "failed" } },
        draftExchange([["created", draftTask(jira, epic, 2)]]),
      ],
    }));
    const check = await run("S07", ctx);
    expect(check.status).toBe("green");
    expect(check.detail).toContain("1 tasks created, 1 reconciled");
  });

  it("does not credit a pre-existing task the draft did not report", async () => {
    const jira = fakeJira();
    const epic = jira.createEpic("LH-002");
    draftTask(jira, epic, 1);
    const ctx = context(jira, () => ({
      toolExchanges: [draftExchange([["created", draftTask(jira, epic, 2)]])],
    }));
    const check = await run("S07", ctx);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("1 of 1 tasks of this turn");
  });

  it("is red for a new task that duplicates an existing draft identity", async () => {
    const jira = fakeJira();
    const epic = jira.createEpic("LH-002");
    const existing = draftTask(jira, epic, 1);
    const ctx = context(jira, () => ({
      toolExchanges: [
        draftExchange([
          ["existing", existing],
          ["created", draftTask(jira, epic, 1)],
        ]),
      ],
    }));
    const check = await run("S07", ctx);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("1 duplicates");
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
    call: { id: "call-1", name: "jira_report", arguments: { projectKey: "RPT" } },
    result: {
      toolRef: { canonicalId: "keiko.jira.report", contractVersion: 1 },
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

  it("judges RPT under the lead's epic, task and bug templates and removes them afterwards", async () => {
    const skills = fakeSkills();
    let activeDuringTurn = [];
    const act = () => {
      activeDuringTurn = skills.calls.map((call) => call.name);
      return { answer: "", toolExchanges: [] };
    };
    await run("S11", context(fakeJira(), act, truth, skills));
    expect(activeDuringTurn).toEqual(["template-import", "template-import", "template-import"]);
    const imported = skills.calls
      .filter((call) => call.name === "template-import")
      .map((call) => Buffer.from(call.body.contentBase64, "base64").toString("utf8"));
    expect(imported[0]).toMatch(/project: RPT\nissueType: "Epic"/u);
    expect(imported[1]).toContain(`parentField: "${FIELDS.epicLink}"`);
    expect(imported[1]).toContain(`requiredFields: ["${FIELDS.storyPoints}"]`);
    // The seed's bug parent deviations need a bug template that names the epic link.
    expect(imported[2]).toMatch(/project: RPT\nissueType: "Bug"/u);
    expect(imported[2]).toContain(`parentField: "${FIELDS.epicLink}"`);
    expect(skills.calls.slice(3).map((call) => [call.name, call.path])).toEqual([
      ["template-delete", "/api/skills/skill-3"],
      ["template-delete", "/api/skills/skill-2"],
      ["template-delete", "/api/skills/skill-1"],
    ]);
  });

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

  describe("an answer grouped by deviation (Gemma, 2026-11-01)", () => {
    it("credits each deviation its lead names to every issue of the list below it", async () => {
      const answer = [
        "### Epics",
        "*   **Zusammenfassung entspricht nicht dem Muster `[LH-xxx] <title>`:**",
        "    *   RPT-1",
        "*   **Beschreibung: Abschnitt „Abgrenzung“ fehlt:**",
        "    *   RPT-1",
        "",
        "### Tasks",
        "*   **Zugehörigkeit zum Epic (Epic Link) fehlt:**",
        "    *   RPT-3",
      ].join("\n");
      expect((await grade(answer)).status).toBe("green");
    });

    it("never credits a lead to the list above it", async () => {
      // Read as a continuation of RPT-1, the second lead would describe its Abgrenzung deviation.
      const answer = [
        "- RPT-1: Zusammenfassung ohne Präfix",
        "Abschnitt Abgrenzung fehlt:",
        "- RPT-3",
        "Epic-Zuordnung fehlt:",
        "- RPT-3",
      ].join("\n");
      const check = await grade(answer);
      expect(check.status).toBe("red");
      expect(check.detail).toContain("1 of 3 seeded deviations not described");
    });

    it("is not green when a group leaves out one seeded deviation", async () => {
      const answer = ["Zusammenfassung ohne Präfix:", "- RPT-1", "Epic fehlt:", "- RPT-3"].join(
        "\n",
      );
      const check = await grade(answer);
      expect(check.status).toBe("red");
      expect(check.detail).toContain("1 of 3 seeded deviations not described");
    });

    it("describes nothing with a lead that states the fields are fine", async () => {
      const answer = [
        "Zusammenfassung und Abgrenzung sind korrekt:",
        "- RPT-1",
        "Epic fehlt:",
        "- RPT-3",
      ].join("\n");
      const check = await grade(answer);
      expect(check.status).toBe("red");
      expect(check.detail).toContain("2 of 3 seeded deviations not described");
    });
  });

  describe("an answer headed by an explicit denial (the auditor's grouped counterexample)", () => {
    const grouped = (heading) =>
      [heading, "### Summary und Abgrenzung", "- RPT-1", "### Epic parent", "- RPT-3"].join("\n");

    it.each([
      "## No deviations found",
      "## Keine Abweichungen gefunden",
      "# Ergebnis: keine Abweichung",
      "## Nothing to report",
    ])("does not credit the inner headings of %j", async (heading) => {
      const check = await grade(grouped(heading));
      expect(check.status).toBe("red");
      expect(check.detail).toContain("3 of 3 seeded deviations not described");
      const result = verdict(check);
      expect(result.status).toBe("red");
      expect(result.covered).toEqual([]);
    });

    it("keeps the same inner headings described under a heading that states deviations", async () => {
      expect((await grade(grouped("## Abweichungen"))).status).toBe("green");
      expect((await grade(grouped("## Deviations per issue"))).status).toBe("green");
    });

    it("describes nothing with fields listed under a heading that states neither", async () => {
      const check = await grade(grouped("## Compliance-Bericht"));
      expect(check.status).toBe("red");
      expect(check.detail).toContain("3 of 3 seeded deviations not described");
    });

    it("lets a heading that names the field and calls it fine deny that field only", async () => {
      const answer = [
        "## Abweichungen",
        "### Summary ist korrekt",
        "- RPT-1: Summary",
        "### Abschnitt Abgrenzung fehlt",
        "- RPT-1",
        "### Epic parent fehlt",
        "- RPT-3",
      ].join("\n");
      const check = await grade(answer);
      expect(check.status).toBe("red");
      expect(check.detail).toContain("1 of 3 seeded deviations not described");
    });

    it("lets a later heading of the same level end the denial", async () => {
      const answer = [
        "## No deviations found",
        "### Dokumentation",
        "- RPT-2",
        "## Abweichungen",
        "### Summary und Abgrenzung",
        "- RPT-1",
        "### Epic parent",
        "- RPT-3",
      ].join("\n");
      expect((await grade(answer)).status).toBe("green");
    });

    it("still reads a genuinely missing-fields grouped answer as green", async () => {
      const answer = [
        "## Deviations",
        "### Zusammenfassung ohne Präfix und Abschnitt Abgrenzung fehlt",
        "- RPT-1",
        "### Kein Epic zugeordnet",
        "- RPT-3",
      ].join("\n");
      expect((await grade(answer)).status).toBe("green");
    });
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

    // The auditor's counterexamples (PRRT_kwDOSqilAM6yR_l4, 2026-11-01): an answer that lists the
    // checks, or that says the fields are present, describes no deviation although it contains every
    // seeded field word and no denial phrase.
    it.each([
      "RPT-1: Geprüft wurden Summary, Parent, Estimate, Label und Abnahmekriterien.",
      "RPT-1: Summary, Parent, Estimate, Label und Abnahmekriterien sind vorhanden.",
      "RPT-1: Summary, Parent, Estimate, Label und Abnahmekriterien wurden geprüft.",
      "RPT-1: Checked summary, parent, estimate, label and Abnahmekriterien.",
      "RPT-1: summary, parent, estimate, label and Abnahmekriterien are present.",
      "RPT-1: Summary, Parent, Estimate, Label und Abnahmekriterien sind nicht leer.",
      "RPT-1: Summary, Parent, Estimate, Label und Abnahmekriterien fehlen nicht.",
      "RPT-1: summary, parent, estimate, label and Abnahmekriterien are not missing.",
    ])("is not green for a bare check list or present fields %#", async (answer) => {
      const check = await gradeFive(answer);
      expect(check.status).toBe("red");
      expect(check.detail).toContain("5 of 5 seeded deviations not described");
      expect(verdict(check).covered).toEqual([]);
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
        call: { id: "call-2", name: "jira_report", arguments: { section: "deviations" } },
        result: {
          toolRef: { canonicalId: "keiko.jira.report", contractVersion: 1 },
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

describe("S17 human obligations of #4175", () => {
  const SOLL = TRUTH.filter((item) => item.priority === "Soll").map((item) => item.id);
  const journeyVerdict = (check) =>
    scenarioVerdict(scenario("S17"), [{ layer: "journey", ...check }]);
  const settled = { ok: true, startedOpen: true, turnOpen: true };

  it("keeps S17 partial for a correct backlog without a refresh or an interruption", async () => {
    // The auditor's counterexample at f47e7f0fa: 25 correctly mapped epics, every key in the answer
    // and no refusal used to be green although neither human obligation was exercised.
    const jira = fakeJira();
    const check = await run(
      "S17",
      context(jira, () => {
        const keys = MUSS.map((id) => jira.createEpic(id));
        return { answer: `Angelegt: ${keys.join(", ")}` };
      }),
    );
    expect(check.status).toBe("green");
    const verdict = journeyVerdict(check);
    expect(verdict.status).toBe("partial");
    expect(verdict.uncovered).toEqual([
      "survives-unchanged-catalog-refresh",
      "interrupted-turn-reports-created-keys",
    ]);
  });

  describe("the unchanged catalog refresh", () => {
    it.each([
      [undefined, false, undefined, "unverified"],
      [{ ok: false, error: "HTTP 502", turnOpen: true }, false, undefined, "unverified"],
      [{ ok: true, turnOpen: false }, false, undefined, "unverified"],
      [settled, true, undefined, "red"],
      [settled, false, "HTTP 400", "red"],
      [settled, false, undefined, "green"],
    ])("grades %j (refused %s, failure %s) as %s", (induced, refused, failure, status) => {
      expect(gradeCatalogRefresh({ induced, refused, failure }).status).toBe(status);
    });

    it("credits the refresh obligation only when the lab induced it during the turn", async () => {
      const jira = fakeJira();
      const ctx = context(jira, () => ({
        answer: MUSS.map((id) => jira.createEpic(id)).join(", "),
      }));
      const base = ctx.turn;
      ctx.turn = async (...args) => ({ ...(await base(...args)), induced: settled });
      const check = await run("S17", ctx);
      expect(check.covers).toContain("survives-unchanged-catalog-refresh");
      expect(journeyVerdict(check).uncovered).toEqual(["interrupted-turn-reports-created-keys"]);
    });
  });

  describe("the interrupted turn", () => {
    const epic = (key) => ({ key });
    const grade = (overrides) =>
      gradeInterruption({
        induced: settled,
        ended: true,
        created: [epic("REQ-1"), epic("REQ-2")],
        answer: "Completed: jira_create REQ-1, jira_create REQ-2",
        ...overrides,
      });

    it("is green when the early-ending answer names exactly the created keys", () => {
      expect(grade({}).status).toBe("green");
    });

    it("grades a mode change that the product acknowledged after ending the turn", () => {
      const induced = { ok: true, startedOpen: true, turnOpen: false };
      expect(grade({ induced }).status).toBe("green");
      expect(grade({ induced, answer: "Completed: jira_create REQ-1" }).status).toBe("red");
    });

    it.each([
      ["omits a created key", { answer: "Completed: jira_create REQ-1" }],
      ["names a key Jira does not show", { answer: "REQ-1, REQ-2, REQ-77" }],
      ["names none", { answer: "The request was not finished." }],
    ])("is red when the answer %s", (_name, overrides) => {
      expect(grade(overrides).status).toBe("red");
    });

    it.each([
      ["the mode was not changed mid-turn", { induced: undefined }],
      ["the mode change failed", { induced: { ok: false, error: "409", startedOpen: true } }],
      [
        "the mode change came after the turn settled",
        { induced: { ok: true, startedOpen: false, turnOpen: false } },
      ],
      ["the turn did not end early", { ended: false }],
      ["nothing had been written yet", { created: [], answer: "" }],
    ])("is unverified when %s", (_name, overrides) => {
      expect(grade(overrides).status).toBe("unverified");
    });

    function interruptedContext({ answer, ended }) {
      const jira = fakeJira();
      let ends = 0;
      let turns = 0;
      const ctx = context(jira, () => {
        turns += 1;
        if (turns === 1) {
          const keys = MUSS.map((id) => jira.createEpic(id));
          return { answer: keys.join(", ") };
        }
        const keys = SOLL.slice(0, 3).map((id) => jira.createEpic(id));
        ends += ended ? 1 : 0;
        return { answer: answer(keys) };
      });
      const base = ctx.turn;
      ctx.turn = async (...args) => ({ ...(await base(...args)), induced: settled });
      return {
        ...ctx,
        freshChat: async () => ({ id: "second" }),
        turnEnds: () => ends,
      };
    }

    it("covers the obligation through the journey only for an exact early-ending answer", async () => {
      const exact = await run(
        "S17",
        interruptedContext({
          answer: (keys) => `Not finished. Completed: ${keys.join(", ")}`,
          ended: true,
        }),
      );
      expect(exact.status).toBe("green");
      expect(exact.covers).toContain("interrupted-turn-reports-created-keys");
      expect(journeyVerdict(exact).status).toBe("green");
      const wrong = await run(
        "S17",
        interruptedContext({ answer: (keys) => keys.slice(1).join(", "), ended: true }),
      );
      expect(wrong.status).toBe("red");
      expect(wrong.detail).toContain("1 missing from");
      const notEnded = await run(
        "S17",
        interruptedContext({ answer: (keys) => keys.join(", "), ended: false }),
      );
      expect(notEnded.covers).not.toContain("interrupted-turn-reports-created-keys");
      expect(journeyVerdict(notEnded).status).toBe("partial");
    });
  });
});

describe("a deferred obligation (owner decision 2026-11-02, #4196)", () => {
  const s14 = () => scenario("S14");
  const green = {
    layer: "journey",
    status: "green",
    covers: ["changes-detected", "affected-issues"],
  };

  it("is declared only for S14, with its issue number", () => {
    const withDeferred = SCENARIOS.filter((entry) => entry.deferred !== undefined);
    expect(withDeferred.map((entry) => entry.id)).toEqual(["S14"]);
    expect(s14().deferred).toEqual([{ obligation: "edits-proposed-as-draft", issue: 4196 }]);
    expect(s14().obligations).not.toContain("edits-proposed-as-draft");
  });

  it("keeps S14 green without crediting the deferred obligation as covered", () => {
    const verdict = scenarioVerdict(s14(), [green]);
    expect(verdict.status).toBe("green");
    expect(verdict.covered).not.toContain("edits-proposed-as-draft");
    expect(verdict.deferred).toEqual([{ obligation: "edits-proposed-as-draft", issue: 4196 }]);
  });

  it("refuses a check that claims the deferred obligation", () => {
    expect(() =>
      scenarioVerdict(s14(), [{ ...green, covers: [...green.covers, "edits-proposed-as-draft"] }]),
    ).toThrow(/unknown obligations edits-proposed-as-draft/);
  });

  it("names #4196 in the scorecard text of a green S14, and in every other state", () => {
    for (const checks of [[green], []]) {
      const verdict = scenarioVerdict(s14(), checks);
      const report = {
        startedAt: "2026-11-02T00:00:00Z",
        model: null,
        counts: { green: 0, red: 0, partial: 0, "probe-only": 0, unchecked: 0 },
        results: [{ ...s14(), ...verdict, checks }],
      };
      const row = scorecardMarkdown(report)
        .split("\n")
        .find((line) => line.startsWith("| S14 "));
      expect(row).toContain("deferred to #4196: edits-proposed-as-draft");
    }
  });

  it("shows no deferral for a scenario that defers nothing", () => {
    expect(scenario("S15").deferred).toBeUndefined();
    expect(scenarioVerdict(scenario("S15"), []).deferred).toEqual([]);
  });

  it.each([
    [{ obligation: "x" }],
    [{ obligation: "x", issue: 0 }],
    [{ obligation: "x", issue: "4196" }],
    [{ obligation: "x", issue: 4196.5 }],
    [{ issue: 4196 }],
    [{ obligation: "changes-detected", issue: 4196 }],
  ])("may be deferred only with a name and an issue number: %j", (entry) => {
    expect(() =>
      deferredObligations({ id: "S99", obligations: ["changes-detected"], deferred: [entry] }),
    ).toThrow(TypeError);
  });
});

describe("catalog obligations of the human criteria that no journey exercises yet", () => {
  // #4179: S14 proposes edits as a backlog draft, S15 attaches findings to epic drafts, S16 uses the
  // format its template defines. Their journeys check only the answer-level parts, so a journey that
  // covers every other obligation leaves the scenario partial, never green.
  it.each([
    [
      "S15",
      ["vague-wording-findings", "missing-acceptance-findings"],
      ["findings-attached-to-epic-draft"],
    ],
    ["S16", ["test-case-per-criterion", "traceability"], ["template-defined-format"]],
  ])("%s stays partial with only %j covered", (id, covers, uncovered) => {
    const verdict = scenarioVerdict(scenario(id), [{ layer: "journey", status: "green", covers }]);
    expect(verdict.status).toBe("partial");
    expect(verdict.uncovered).toEqual(uncovered);
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
