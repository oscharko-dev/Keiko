// S15 and S16 of the requirements lab (epic #4173, #4179): the quality findings reach the footers
// of the epics a draft creates, and test cases follow the form an issue template defines. Both are
// credited from the issues Jira holds, never from the answer. The footers below are produced by the
// production trace writer, so the lab's reader is proven against what the product really writes.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { SCENARIOS } from "../testing/jira-chat-lab/requirements/catalog.mjs";
import { scenarioVerdict } from "../testing/jira-chat-lab/requirements/coverage.mjs";
import { buildCorpus } from "../testing/jira-chat-lab/requirements/corpus.mjs";
import {
  expectedFindings,
  footerFindings,
  seededDefects,
} from "../testing/jira-chat-lab/requirements/draft-findings.mjs";
import { JOURNEYS } from "../testing/jira-chat-lab/requirements/journey-checks.mjs";
import {
  sectionsFilled,
  testCaseTemplateMarkdown,
} from "../testing/jira-chat-lab/requirements/template-test-cases.mjs";

const REPO = join(import.meta.dirname, "..", "..");
const quality = await import(
  pathToFileURL(join(REPO, "packages/keiko-quality-intelligence/dist/index.js")).href
);
const CORPUS = buildCorpus(1);
const INVENTORY = quality.deriveRequirementInventory({ text: CORPUS.markdown, documentKey: "lab" });
const FINDINGS = quality.assessRequirementInventoryQuality(INVENTORY.entries);
const scenario = (id) => SCENARIOS.find((entry) => entry.id === id);
const verdict = (id, check) => scenarioVerdict(scenario(id), [{ layer: "journey", ...check }]);

/** The description a production write produces for an epic that traces `id`. */
function describedBy(id, { findings = FINDINGS.get(id) ?? [], body = "Ziel\nInhalt." } = {}) {
  const entry = INVENTORY.entries.find((candidate) => candidate.id === id);
  const trace = quality.requirementTrace([
    {
      unit: {
        entry,
        source: { documentName: "Lastenheft", documentDigest: "d".repeat(64) },
        findings,
      },
    },
  ]);
  return `${body}\n\n${trace.footer}`;
}

function fakeJira() {
  const issues = [];
  return {
    issues,
    add(type, fields) {
      const key = `REQ-${issues.length + 1}`;
      issues.push({ key, fields: { issuetype: { name: type }, labels: [], ...fields } });
      return key;
    },
    async search(query) {
      const type = /issuetype = (\w+)/.exec(query)?.[1];
      return issues.filter((issue) => issue.fields.issuetype.name === type);
    },
  };
}

function skillLibrary() {
  const calls = [];
  const http = async (name, path, body) => {
    calls.push({ name, path, body });
    return name === "template-import" ? { skill: { id: "skill-1", revision: 1 } } : null;
  };
  return { calls, http };
}

/** A context whose turns run `acts` in order and answer with what each returns. */
function context(jira, acts, library = skillLibrary()) {
  const prompts = [];
  let turn = 0;
  return {
    prompts,
    library,
    http: library.http,
    search: (query) => jira.search(query),
    refusals: () => 0,
    turn: async (_chat, content) => {
      prompts.push(content);
      const { answer = "", toolExchanges = [] } = (acts[turn++] ?? (() => ({})))();
      return { answer, toolExchanges, failure: undefined, durationMs: 1000, toolCalls: 2 };
    },
  };
}

const run = (id, ctx) => JOURNEYS[id](ctx, { id: "chat" });

describe("S15 quality findings reach the epic footers", () => {
  const { vague, withoutCriteria } = seededDefects();
  const idsLine = (ids) => ids.join(", ");
  const truth = CORPUS.truth;
  const answerTurn = () => ({
    answer: [
      `UNKLAR: ${idsLine(truth.filter((item) => item.vague).map((item) => item.id))}`,
      `OHNE ABNAHMEKRITERIEN: ${idsLine(truth.filter((item) => item.acceptanceCount === 0).map((item) => item.id))}`,
    ].join("\n"),
  });
  const epic = (jira, id, description) =>
    jira.add("Epic", { summary: `[${id}] Titel`, description });
  const journey = async (draft) => {
    const jira = fakeJira();
    const ctx = context(jira, [answerTurn, () => draft(jira)]);
    return { check: await run("S15", ctx), ctx };
  };
  const OBLIGATION = "findings-attached-to-epic-draft";

  it("derives the expected codes from the production checks", async () => {
    const expected = await expectedFindings([vague, withoutCriteria]);
    expect(expected.get(vague)).toEqual(FINDINGS.get(vague));
    // ADR-0128: the closed code of a requirement without acceptance criteria.
    expect(expected.get(withoutCriteria)).toEqual(["missing-acceptance-criteria"]);
    expect(expected.get(vague)).not.toEqual(expected.get(withoutCriteria));
  });

  it("reads the findings of a production footer, and nothing from a missing one", () => {
    expect(footerFindings(describedBy(withoutCriteria)).get(withoutCriteria)).toEqual([
      "missing-acceptance-criteria",
    ]);
    expect(footerFindings(describedBy(vague, { findings: [] })).get(vague)).toEqual([]);
    expect(footerFindings("Ziel\nInhalt.").size).toBe(0);
    expect(footerFindings(undefined).size).toBe(0);
  });

  it("is green when each epic of Jira states the matching codes in its footer", async () => {
    const { check, ctx } = await journey((jira) => {
      epic(jira, vague, describedBy(vague));
      epic(jira, withoutCriteria, describedBy(withoutCriteria));
      return { answer: "REQ-1, REQ-2" };
    });
    expect(check.status).toBe("green");
    expect(check.covers).toContain(OBLIGATION);
    expect(verdict("S15", check).status).toBe("green");
    expect(ctx.prompts[1]).toContain(vague);
    expect(ctx.prompts[1]).not.toMatch(/Quality findings|Qualit|missing-acceptance/);
  });

  it.each([
    ["the answer alone names keys but Jira holds no epic", () => ({ answer: "REQ-1, REQ-2" })],
    [
      "the footer is missing",
      (jira) => {
        epic(jira, vague, "Ziel\nInhalt.");
        epic(jira, withoutCriteria, "Ziel\nInhalt.");
        return { answer: "REQ-1, REQ-2" };
      },
    ],
    [
      "only one of the two epics exists",
      (jira) => {
        epic(jira, withoutCriteria, describedBy(withoutCriteria));
        return {};
      },
    ],
  ])("credits nothing when %s", async (_name, draft) => {
    const { check } = await journey(draft);
    expect(check.covers).not.toContain(OBLIGATION);
    expect(check.covers).toEqual(["vague-wording-findings", "missing-acceptance-findings"]);
    const result = verdict("S15", check);
    expect(result.status).toBe("partial");
    expect(result.uncovered).toEqual([OBLIGATION]);
  });

  it.each([
    [
      "a footer states the wrong codes",
      (jira) => {
        epic(jira, vague, describedBy(vague, { findings: [] }));
        epic(jira, withoutCriteria, describedBy(withoutCriteria));
      },
    ],
    [
      "a footer states an unrelated code",
      (jira) => {
        epic(jira, vague, describedBy(vague, { findings: ["missing-acceptance-criteria"] }));
        epic(jira, withoutCriteria, describedBy(withoutCriteria));
      },
    ],
    [
      "a requirement has two epics",
      (jira) => {
        epic(jira, vague, describedBy(vague));
        epic(jira, vague, describedBy(vague));
        epic(jira, withoutCriteria, describedBy(withoutCriteria));
      },
    ],
    [
      "an epic exists for a requirement that was not asked for",
      (jira) => {
        epic(jira, vague, describedBy(vague));
        epic(jira, withoutCriteria, describedBy(withoutCriteria));
        epic(jira, "LH-001", describedBy("LH-001", { findings: [] }));
      },
    ],
  ])("is red when %s", async (_name, write) => {
    const { check } = await journey((jira) => {
      write(jira);
      return {};
    });
    expect(check.status).toBe("red");
    expect(verdict("S15", check).status).toBe("red");
  });

  it("stays red when the answer turn is wrong although the footers are right", async () => {
    const jira = fakeJira();
    const ctx = context(jira, [
      () => ({ answer: "UNKLAR: LH-001\nOHNE ABNAHMEKRITERIEN: LH-001" }),
      () => {
        epic(jira, vague, describedBy(vague));
        epic(jira, withoutCriteria, describedBy(withoutCriteria));
        return {};
      },
    ]);
    expect((await run("S15", ctx)).status).toBe("red");
  });
});

describe("S16 test cases in the form the template defines", () => {
  const item = CORPUS.truth.find((entry) => entry.id === "LH-002");
  const OBLIGATION = "template-defined-format";
  const answer = [
    "TESTFALL LH-002/AC1 | Schritte: Als angemeldeter Versicherungsnehmer das Portal öffnen und Einmalcode wählen | Erwartet: Einmalcode ist verfügbar und nutzbar",
    "TESTFALL LH-002/AC2 | Schritte: Einen fehlerhaften Einmalcode eingeben und Absenden drücken | Erwartet: Die fehlerhafte Eingabe wird vor dem Absenden gemeldet",
  ].join("\n");
  const body = "## Schritte\nPortal öffnen.\n\n## Erwartet\nEs funktioniert.";
  const testCase = (jira, number, overrides = {}) =>
    jira.add("Task", {
      summary: `LH-002/AC${number} Testfall`,
      description: body,
      labels: ["keiko-requirement", "keiko-req-LH-002", `keiko-ac-LH-002-AC${number}`],
      ...overrides,
    });
  const journey = async (write, library) => {
    const jira = fakeJira();
    const ctx = context(jira, [() => ({ answer }), () => write(jira)], library);
    return { check: await run("S16", ctx), ctx, jira };
  };

  it("defines the form in a REQ Task template and keeps it out of the prompt", () => {
    const markdown = testCaseTemplateMarkdown("REQ");
    expect(markdown).toContain("project: REQ");
    expect(markdown).toContain('issueType: "Task"');
    expect(markdown).toContain("## Schritte");
    expect(markdown).toContain("## Erwartet");
    expect(markdown).toContain("summaryPattern:");
    expect(markdown).toContain("AC");
  });

  it("is green for exactly one conforming issue per criterion and removes the template", async () => {
    const { check, ctx } = await journey((jira) => {
      testCase(jira, 1);
      testCase(jira, 2);
      return {};
    });
    expect(check.status).toBe("green");
    expect(check.covers).toContain(OBLIGATION);
    expect(verdict("S16", check).status).toBe("green");
    expect(ctx.library.calls.map((call) => call.name)).toEqual([
      "template-import",
      "template-delete",
    ]);
    expect(ctx.prompts[1]).not.toMatch(/Schritte|Erwartet|TESTFALL/);
    expect(item.acceptanceCount).toBe(2);
  });

  it("credits nothing for an answer alone, without any issue in Jira", async () => {
    const { check } = await journey(() => ({ answer }));
    expect(check.covers).not.toContain(OBLIGATION);
    const result = verdict("S16", check);
    expect(result.status).toBe("partial");
    expect(result.uncovered).toEqual([OBLIGATION]);
  });

  it.each([
    ["one criterion has no issue", (jira) => testCase(jira, 1)],
    [
      "a criterion has two issues",
      (jira) => {
        testCase(jira, 1);
        testCase(jira, 1);
        testCase(jira, 2);
      },
    ],
    [
      "there is a third issue",
      (jira) => {
        testCase(jira, 1);
        testCase(jira, 2);
        testCase(jira, 3);
      },
    ],
    [
      "an issue does not name its criterion in the template's form",
      (jira) => {
        testCase(jira, 1);
        testCase(jira, 2, { summary: "Testfall zum zweiten Kriterium" });
      },
    ],
    [
      "a section of the template is missing",
      (jira) => {
        testCase(jira, 1);
        testCase(jira, 2, { description: "## Schritte\nPortal öffnen." });
      },
    ],
    [
      "a section of the template is empty",
      (jira) => {
        testCase(jira, 1);
        testCase(jira, 2, { description: "## Schritte\nPortal öffnen.\n\n## Erwartet\n" });
      },
    ],
    [
      "an issue is not labelled to the requirement",
      (jira) => {
        testCase(jira, 1);
        testCase(jira, 2, { labels: [] });
      },
    ],
  ])("is red when %s", async (_name, write) => {
    const { check } = await journey((jira) => {
      write(jira);
      return {};
    });
    expect(check.status).toBe("red");
    expect(verdict("S16", check)).toMatchObject({ status: "red", covered: [] });
  });

  it("removes the template even when the write turn fails", async () => {
    const library = skillLibrary();
    const jira = fakeJira();
    const ctx = context(
      jira,
      [
        () => ({ answer }),
        () => {
          throw new Error("turn failed");
        },
      ],
      library,
    );
    await expect(run("S16", ctx)).rejects.toThrow("turn failed");
    expect(library.calls.map((call) => call.name)).toEqual(["template-import", "template-delete"]);
  });

  it("reads section content before the next heading and ignores the trace footer", () => {
    const names = ["Schritte", "Erwartet"];
    expect(sectionsFilled(body, names)).toBe(true);
    expect(sectionsFilled("h3. Schritte\nA\nh3. Erwartet\nB", names)).toBe(true);
    expect(sectionsFilled("## Schritte\n\n## Erwartet\nB", names)).toBe(false);
    expect(
      sectionsFilled(
        `## Schritte\nA\n## Erwartet\n\n----\nKeiko traceability\nRequirement: LH-002`,
        names,
      ),
    ).toBe(false);
  });
});
