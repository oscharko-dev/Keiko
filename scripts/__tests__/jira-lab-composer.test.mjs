// The Composer lane (#4369): graders and journeys in both directions, through the real entry points,
// over an in-memory Jira and a stub model. No live Jira, no model, no Knowledge Pod.
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  COMPOSER_JOURNEYS,
  COMPOSER_JOURNEY_IDS,
  COMPOSER_MODES,
  COMPOSER_WITHOUT_BASELINE,
  composerSelection,
  prepareTemplates,
  templateState,
} from "../testing/jira-chat-lab/requirements/composer.mjs";
import {
  gradeAttachmentRefusal,
  gradeComment,
  gradeComposerCreate,
  gradeComposerRefusal,
  gradeEditBreaking,
  gradeEditPreexisting,
  gradeMultiCreate,
  gradeReloadReconcile,
  gradeRepeatInChat,
  gradeNoTemplate,
  hasTemplateHint,
  gradeUnrepairable,
  gradeUngovernedChange,
  gradeWatcher,
  keysListed,
} from "../testing/jira-chat-lab/requirements/composer-graders.mjs";
import { COMPOSER_SCENARIOS } from "../testing/jira-chat-lab/requirements/composer-catalog.mjs";
import {
  COMPOSER_TYPES,
  composerConformity,
  composerTemplates,
  createPrompt,
  unrepairablePrompt,
  violationPrompt,
} from "../testing/jira-chat-lab/requirements/composer-templates.mjs";
import { SCENARIOS } from "../testing/jira-chat-lab/requirements/catalog.mjs";
import { evidenceLines, scenarioVerdict } from "../testing/jira-chat-lab/requirements/coverage.mjs";
import { turnIssues } from "../testing/jira-chat-lab/requirements/oracles.mjs";

const LINK = "customfield_10109";
const FIXTURE = { epic: "REQ-1", task: "REQ-2", epicLink: LINK };
const wiki = (sections) => sections.map((name) => `h3. ${name}\nInhalt.`).join("\n\n");
const SECTIONS = {
  Epic: ["Ziel", "Abnahmekriterien"],
  Story: ["Nutzerziel", "Akzeptanzkriterien", "Definition of Done"],
  Task: ["Umsetzungsschritte", "Definition of Done", "Testhinweise"],
  "Sub-task": ["Umsetzungsschritte", "Definition of Done", "Testhinweise"],
  Bug: ["Erwartet", "Tatsächlich", "Reproduktionsschritte", "Umgebung"],
};
/** A conformant issue of `type` with the relations the create prompt names. */
function conformant(key, type, summary = `Composer ${type}`) {
  const fields = {
    issuetype: { name: type },
    summary,
    labels: [],
    description: wiki(SECTIONS[type]),
  };
  if (type === "Sub-task") fields.parent = { key: FIXTURE.task };
  if (["Story", "Task", "Bug"].includes(type)) fields[LINK] = FIXTURE.epic;
  if (type === "Bug") {
    fields.priority = { name: "High" };
    fields.issuelinks = [{ type: { name: "Relates" }, outwardIssue: { key: FIXTURE.task } }];
  }
  return { key, fields };
}

describe("templates and prompts of the lane", () => {
  const templates = composerTemplates("REQ", LINK);

  it("holds one template per type, all for the work project, none naming a requirement", () => {
    expect(templates.map((entry) => entry.issueType)).toEqual(COMPOSER_TYPES);
    for (const { markdown, issueType } of templates) {
      expect(markdown).toContain("keiko: jira-issue-template");
      expect(markdown).toContain("project: REQ");
      expect(markdown).toContain(`issueType: "${issueType}"`);
      expect(markdown).toContain("activateOn: [create]");
      expect(markdown).not.toMatch(/LH-|Lastenheft|Anforderung/u);
    }
    expect(templates.find((entry) => entry.issueType === "Sub-task").markdown).toContain(
      'parentIssueTypes: ["Task"]',
    );
    expect(templates.find((entry) => entry.issueType === "Bug").markdown).toContain(
      'requiredFields: ["priority"]',
    );
    expect(templates.find((entry) => entry.issueType === "Task").markdown).toContain(
      `parentField: "${LINK}"`,
    );
  });

  it("activates on edit too when the edit lane asks for it", () => {
    for (const { markdown } of composerTemplates("REQ", LINK, { activateOn: ["create", "edit"] }))
      expect(markdown).toContain("activateOn: [create, edit]");
  });

  it("asks in plain words: a title and the named parents, never a requirement or a structure", () => {
    for (const type of COMPOSER_TYPES) {
      for (const prompt of [
        createPrompt(type, "Mein Titel", FIXTURE),
        violationPrompt(type, "Mein Titel", FIXTURE),
      ]) {
        expect(prompt).toContain("„Mein Titel“");
        expect(prompt).toContain("REQ");
        expect(prompt).not.toMatch(/Lastenheft|Anforderung|LH-|Strukturvorgabe/u);
      }
    }
    expect(createPrompt("Sub-task", "t", FIXTURE)).toContain("REQ-2");
    expect(createPrompt("Bug", "t", FIXTURE)).toMatch(/Relates.*REQ-2/u);
    expect(createPrompt("Story", "t", FIXTURE)).toContain("REQ-1");
  });
});

describe("the create prompt carries what the template asks for", () => {
  const sectionsOf = (markdown) =>
    [...markdown.matchAll(/^## (.+)$/gmu)].map((match) => match[1].trim());
  const fieldsOf = (markdown) => {
    const line = /^requiredFields: \[(.*)\]$/mu.exec(markdown)?.[1] ?? "";
    return line === "" ? [] : line.split(",").map((name) => name.trim().replaceAll('"', ""));
  };
  const templates = composerTemplates("REQ", LINK);

  it.each(COMPOSER_TYPES)(
    "%s: every section of the template has its content in the request, and no way out",
    (type) => {
      const { markdown } = templates.find((entry) => entry.issueType === type);
      const sections = sectionsOf(markdown.split("\n---\n").at(-1));
      expect(sections.length).toBeGreaterThan(0);
      const prompt = createPrompt(type, "Mein Titel", FIXTURE);
      for (const name of sections) expect(prompt).toContain(`${name}: Synthetischer Inhalt`);
      expect(prompt).not.toContain("genauen Fehler");
      expect(prompt).toMatch(/Melde den Vorgangsschlüssel\.$/u);
    },
  );

  it("names the value of every required field of the template (a Bug's priority)", () => {
    for (const { markdown, issueType } of templates) {
      const prompt = createPrompt(issueType, "t", FIXTURE);
      for (const field of fieldsOf(markdown))
        expect(prompt.toLowerCase()).toContain(field === "priority" ? "priorität ist high" : field);
    }
    expect(fieldsOf(templates.find((entry) => entry.issueType === "Bug").markdown)).toEqual([
      "priority",
    ]);
  });

  it("the unrepairable request holds complete content and only a wrong parent", () => {
    const prompt = unrepairablePrompt("Titel", { story: "REQ-3" });
    expect(prompt).toContain("unter dem Vorgang REQ-3");
    const { markdown } = templates.find((entry) => entry.issueType === "Sub-task");
    for (const name of sectionsOf(markdown.split("\n---\n").at(-1)))
      expect(prompt).toContain(`${name}: Synthetischer Inhalt`);
  });
});

describe("conformity of each type, as Jira holds it", () => {
  it.each(COMPOSER_TYPES)("%s: conformant passes, each missing part fails", (type) => {
    const conforms = composerConformity(type, { epicLink: LINK });
    const good = conformant("REQ-9", type);
    expect(conforms(good)).toBe(true);
    expect(conforms({ ...good, fields: { ...good.fields, description: "Kurzer Test." } })).toBe(
      false,
    );
    if (type === "Sub-task")
      expect(conforms({ ...good, fields: { ...good.fields, parent: undefined } })).toBe(false);
    if (["Story", "Task", "Bug"].includes(type))
      expect(conforms({ ...good, fields: { ...good.fields, [LINK]: "" } })).toBe(false);
    if (type === "Bug")
      expect(conforms({ ...good, fields: { ...good.fields, priority: undefined } })).toBe(false);
  });
});

describe("the catalog", () => {
  it("adds C01-C09 beside S01-S20 and leaves those untouched", () => {
    expect(COMPOSER_SCENARIOS.map((entry) => entry.id)).toEqual([
      "C01",
      "C02",
      "C03",
      "C04",
      "C05",
      "C06",
      "C07",
      "C08",
      "C09",
    ]);
    expect(COMPOSER_JOURNEY_IDS).toEqual(COMPOSER_SCENARIOS.map((entry) => entry.id));
    const ids = SCENARIOS.map((entry) => entry.id);
    for (let n = 1; n <= 20; n += 1) expect(ids).toContain(`S${String(n).padStart(2, "0")}`);
    expect(SCENARIOS.some((entry) => entry.id.startsWith("C"))).toBe(false);
  });

  it("names every obligation once and covers C02 per type and per mode", () => {
    for (const scenario of COMPOSER_SCENARIOS)
      expect(new Set(scenario.obligations).size).toBe(scenario.obligations.length);
    const c02 = COMPOSER_SCENARIOS.find((entry) => entry.id === "C02").obligations;
    expect(c02).toHaveLength(COMPOSER_TYPES.length * COMPOSER_MODES.length);
    expect(c02).toContain("refused-sub-task-full-access");
  });

  it("shows C03 and C04 red with their obligation text, never invalid or deferred", () => {
    for (const id of ["C03", "C04"]) {
      const scenario = COMPOSER_SCENARIOS.find((entry) => entry.id === id);
      const journey = {
        layer: "journey",
        status: "red",
        covers: scenario.obligations,
        detail: "product wrote unchecked",
      };
      const verdict = scenarioVerdict(scenario, [journey]);
      expect(verdict.status).toBe("red");
      expect(verdict.deferred).toEqual([]);
      const lines = evidenceLines({ ...scenario, ...verdict, checks: [journey] });
      expect(lines.join("\n")).toContain(`uncovered: ${scenario.obligations.join(", ")}`);
    }
  });

  it("is green only when a journey covers every obligation", () => {
    const scenario = COMPOSER_SCENARIOS.find((entry) => entry.id === "C01");
    const covers = scenario.obligations;
    expect(scenarioVerdict(scenario, [{ layer: "journey", status: "green", covers }]).status).toBe(
      "green",
    );
    expect(
      scenarioVerdict(scenario, [{ layer: "journey", status: "green", covers: covers.slice(1) }])
        .status,
    ).not.toBe("green");
  });
});

// ---------- graders ----------

const turnOf = (issues, exchanges = []) =>
  turnIssues({ before: { keys: new Set(), identities: new Set() }, issues, exchanges });

describe("obligation a) creation, one and several", () => {
  const grade = (type, issues, overrides = {}) => {
    const fixture = { ...FIXTURE, ...overrides };
    return gradeComposerCreate({
      type,
      issues: turnOf(issues),
      conforms: composerConformity(type, fixture),
      related: (issue) =>
        type === "Sub-task"
          ? issue.fields.parent?.key === fixture.task
          : issue.fields[LINK] === fixture.epic,
    });
  };

  it("is red when the turn also created an issue of ANOTHER type, however conformant", () => {
    const result = grade("Task", [conformant("REQ-5", "Task"), conformant("REQ-6", "Bug")]);
    expect(result.status).toBe("red");
    expect(result.detail).toContain("REQ-6 (Bug)");
    expect(grade("Task", [conformant("REQ-6", "Story")]).status).toBe("red");
  });

  it("is green for one conformant issue with its relation, red otherwise", () => {
    expect(grade("Task", [conformant("REQ-5", "Task")]).status).toBe("green");
    expect(grade("Task", []).status).toBe("red");
    expect(grade("Task", [conformant("REQ-5", "Task"), conformant("REQ-6", "Task")]).status).toBe(
      "red",
    );
    const bare = conformant("REQ-5", "Task");
    bare.fields.description = "x";
    expect(grade("Task", [bare]).detail).toContain("does not conform");
    expect(grade("Task", [conformant("REQ-5", "Task")], { epic: "REQ-99" }).detail).toContain(
      "relation missing",
    );
  });

  const TITLES = ["Titel A", "Titel B", "Titel C"];
  const several = (made, answer = "", exchanges = []) =>
    gradeMultiCreate({
      type: "Task",
      titles: TITLES,
      issues: turnOf(made),
      conforms: composerConformity("Task", FIXTURE),
      related: (issue) => issue.fields[LINK] === FIXTURE.epic,
      answer,
      exchanges,
    });
  const three = ["REQ-5", "REQ-6", "REQ-7"].map((key, i) =>
    conformant(key, "Task", `Titel ${"ABC"[i]}`),
  );

  it("creates all natively and lists every key in the answer", () => {
    const grade = several(three, "Angelegt: REQ-5, REQ-6 und REQ-7");
    expect([grade.created.status, grade.listed.status]).toEqual(["green", "green"]);
  });

  it("is red when fewer than three exist natively, or one is not conformant", () => {
    expect(several(three.slice(0, 2), "REQ-5 REQ-6").created.status).toBe("red");
    const bad = [...three];
    bad[2] = { ...bad[2], fields: { ...bad[2].fields, description: "" } };
    expect(several(bad, "REQ-5 REQ-6 REQ-7").created.status).toBe("red");
  });

  it("is red when the three issues exist but carry other titles than the request, or a fourth of another type", () => {
    const retitled = three.map((issue, i) => ({
      ...issue,
      fields: { ...issue.fields, summary: `Anderer ${i}` },
    }));
    const grade = several(retitled, "REQ-5 REQ-6 REQ-7");
    expect(grade.created.status).toBe("red");
    expect(grade.created.detail).toContain("titles differ");
    const twice = [
      three[0],
      { ...three[1], fields: { ...three[1].fields, summary: "Titel A" } },
      three[2],
    ];
    expect(several(twice, "REQ-5 REQ-6 REQ-7").created.status).toBe("red");
    const stray = several([...three, conformant("REQ-8", "Bug")], "REQ-5 REQ-6 REQ-7 REQ-8");
    expect(stray.created.status).toBe("red");
    expect(stray.created.detail).toContain("REQ-8 (Bug)");
  });

  it("is red when a created key is missing from the answer and the result, green via the result card", () => {
    expect(several(three, "REQ-5 und REQ-6").listed).toMatchObject({ status: "red" });
    const card = {
      call: { id: "c", name: "jira_draft", arguments: {} },
      result: {
        toolRef: { canonicalId: "keiko.jira.draft", contractVersion: 3 },
        status: "completed",
        data: { items: [{ issueKey: "REQ-5" }, { issueKey: "REQ-6" }, { issueKey: "REQ-7" }] },
      },
    };
    expect(several(three, "Fertig.", [card]).listed.status).toBe("green");
    expect(keysListed(turnOf(three).created, "REQ-5", [])).toHaveLength(2);
    expect(several([], "").listed.status).toBe("unverified");
  });
});

const createExchange = (data, status = "failed", extra = {}) => ({
  call: { id: "c", name: "jira_create", arguments: {} },
  result: { toolRef: { canonicalId: "keiko.jira.create", contractVersion: 3 }, status, data },
  ...extra,
});
const refusal = (type, extra = {}, data = {}) =>
  createExchange(
    {
      outcome: "rejected",
      reason: "field-validation",
      violations: [{ ruleId: "section-missing", template: `REQ/${type}` }],
      ...data,
    },
    "failed",
    extra,
  );
const success = (key) => createExchange({ outcome: "succeeded", issueKey: key }, "completed");
/** The gate's refusal of a create when no template governs the type (#4354): its rule ids, no receipt. */
const refusedNoTemplate = (extra = {}, ruleId = "template-missing") =>
  createExchange(
    { outcome: "rejected", reason: "field-validation", violations: [{ ruleId }] },
    "failed",
    extra,
  );
/** A create that failed for another reason: the product's closed refusal is not a gate refusal. */
const failedElsewhere = () =>
  createExchange({ outcome: "failed", reason: "unavailable" }, "failed");
const editResult = (data, status = "failed") => ({
  call: { id: "e", name: "jira_edit", arguments: {} },
  result: { toolRef: { canonicalId: "keiko.jira.edit", contractVersion: 3 }, status, data },
});
const refusedEdit = (ruleId) =>
  editResult({
    outcome: "rejected",
    reason: "field-validation",
    violations: [{ ruleId, template: "REQ/Task" }],
  });
const succeededEdit = (notices) =>
  editResult(
    { outcome: "succeeded", ...(notices ? { templateNotices: notices } : {}) },
    "completed",
  );

describe("obligation b) refusal before any card or effect, decided by the native state", () => {
  const grade = (type, exchanges, created) =>
    gradeComposerRefusal({
      type,
      exchanges,
      created,
      template: `REQ/${type}`,
      conforms: composerConformity(type, { epicLink: LINK }),
    });
  const violating = (key, type) => {
    const issue = conformant(key, type);
    issue.fields.description = "Kurzer Test.";
    return issue;
  };

  it.each(COMPOSER_TYPES)("%s: refused without card, then corrected: green", (type) => {
    expect(grade(type, [refusal(type), success("REQ-5")], [conformant("REQ-5", type)]).status).toBe(
      "green",
    );
  });

  it("is RED when the violating issue exists, whatever the trace says: no refusal at all", () => {
    const result = grade("Task", [success("REQ-5")], [violating("REQ-5", "Task")]);
    expect(result.status).toBe("red");
    expect(result.detail).toContain("violating Task exists in Jira");
  });

  it("is red when the violating issue exists although a refusal was traced", () => {
    expect(
      grade("Task", [refusal("Task"), success("REQ-5")], [violating("REQ-5", "Task")]).status,
    ).toBe("red");
  });

  it("is red when the refused request left an issue of ANOTHER type behind", () => {
    const result = grade(
      "Task",
      [refusal("Task"), success("REQ-5")],
      [conformant("REQ-5", "Task"), conformant("REQ-6", "Story")],
    );
    expect(result.status).toBe("red");
    expect(result.detail).toContain("REQ-6 (Story)");
    expect(grade("Task", [refusal("Task")], [conformant("REQ-6", "Bug")]).status).toBe("red");
  });

  it("is red when a card was shown for the refused write, or the refusal carries a receipt", () => {
    const card = { approval: { state: "pending", approvalId: "a1" } };
    const shown = grade(
      "Task",
      [refusal("Task", card), success("REQ-5")],
      [conformant("REQ-5", "Task")],
    );
    expect(shown.status).toBe("red");
    expect(shown.detail).toContain("a card was shown for a refused write");
    const receipt = refusal("Task", {}, { issueKey: "REQ-4" });
    expect(grade("Task", [receipt, success("REQ-5")], [conformant("REQ-5", "Task")]).status).toBe(
      "red",
    );
  });

  it("is red when two issues exist or none followed the refusal", () => {
    expect(grade("Task", [refusal("Task")], []).status).toBe("red");
    const two = [conformant("REQ-5", "Task"), conformant("REQ-6", "Task")];
    expect(grade("Task", [refusal("Task"), success("REQ-5")], two).status).toBe("red");
  });

  it("is unverified only when the native state is clean and the gate never refused", () => {
    expect(grade("Task", [success("REQ-5")], [conformant("REQ-5", "Task")]).status).toBe(
      "unverified",
    );
    expect(grade("Task", [], []).status).toBe("unverified");
  });

  it("does not credit another template's refusal", () => {
    expect(
      grade("Task", [refusal("Bug"), success("REQ-5")], [conformant("REQ-5", "Task")]).status,
    ).toBe("unverified");
  });
});

describe("the template hint is a template-creation phrase, not a refusal to create the issue", () => {
  it.each([
    "Dafür gibt es keine Vorlage. Bitte lege zuerst eine Vorlage an.",
    "Lege zuerst eine Vorlage für diesen Vorgangstyp an.",
    "Erstelle bitte eine Vorlage, dann lege ich den Vorgang an.",
    "There is no template for this type; please create a template first.",
    "Es fehlt eine Vorlage, sie müsste definiert werden.",
  ])("accepts: %s", (answer) => {
    expect(hasTemplateHint(answer)).toBe(true);
  });

  it.each([
    "Ich konnte den Vorgang nicht anlegen.",
    "Ich konnte den Vorgang nicht anlegen, weil keine Vorlage existiert.",
    "I could not create the issue because there is no template.",
    "Das Anlegen ist nicht möglich.",
    "Die Vorlage ist leider nicht verfügbar.",
    "",
    undefined,
  ])("refuses: %s", (answer) => {
    expect(hasTemplateHint(answer)).toBe(false);
  });

  it("a plain refusal to create the issue is not the hint in the no-template grader", () => {
    const grade = gradeNoTemplate({
      created: [],
      exchanges: [refusedNoTemplate()],
      answer: "Ich konnte den Vorgang nicht anlegen, weil es keine Vorlage gibt.",
    });
    expect(grade.status).toBe("red");
    expect(grade.detail).toContain("no hint to create a template");
  });
});

describe("obligation c) no template: nothing written, the gate refused, no card, the hint", () => {
  const hint = "Dafür gibt es keine Vorlage. Bitte lege zuerst eine Vorlage an.";
  const created = (count) =>
    turnOf(
      Array.from({ length: count }, (_, i) => conformant(`REQ-${i + 5}`, i % 2 ? "Bug" : "Task")),
    ).created;

  it("is green only when all four claims hold", () => {
    for (const ruleId of ["template-missing", "template-not-activated"])
      expect(
        gradeNoTemplate({
          created: [],
          exchanges: [refusedNoTemplate({}, ruleId)],
          answer: hint,
        }).status,
      ).toBe("green");
  });

  it("is unverified, never green, when the create failed for another reason or the rule is another one", () => {
    for (const exchanges of [
      [failedElsewhere()],
      [refusedNoTemplate({}, "section-missing")],
      [success("REQ-5")],
    ]) {
      const grade = gradeNoTemplate({ created: [], exchanges, answer: hint });
      expect(grade.status).toBe("unverified");
      expect(grade.detail).toContain("template-missing");
    }
  });

  it("is red when anything was written, of any type", () => {
    expect(
      gradeNoTemplate({ created: created(1), exchanges: [success("REQ-5")], answer: "Angelegt" })
        .status,
    ).toBe("red");
    expect(
      gradeNoTemplate({ created: created(2), exchanges: [refusedNoTemplate()], answer: hint })
        .detail,
    ).toContain("2 issues were written");
  });

  it("is unverified when the model never attempted the create, red when a card appeared or the hint is missing", () => {
    expect(gradeNoTemplate({ created: [], exchanges: [], answer: hint }).status).toBe("unverified");
    const card = refusedNoTemplate({ approval: { state: "pending", approvalId: "a" } });
    expect(gradeNoTemplate({ created: [], exchanges: [card], answer: hint }).status).toBe("red");
    // The hint is a second condition: without it a traced gate refusal alone is still red.
    for (const answer of ["Das war nicht möglich.", "", undefined, "Es gibt eine Vorlage"])
      expect(
        gradeNoTemplate({ created: [], exchanges: [refusedNoTemplate()], answer }).status,
      ).toBe("red");
  });
});

describe("the unrepairable request: refused by the gate, said in plain words", () => {
  const mismatch = () =>
    createExchange(
      {
        outcome: "rejected",
        reason: "field-validation",
        violations: [{ ruleId: "parent-type-mismatch" }],
      },
      "failed",
    );
  const plain =
    "Eine Teilaufgabe braucht eine Aufgabe als Eltern, keine Story. Nenne mir eine Aufgabe.";
  const grade = (overrides) =>
    gradeUnrepairable({ created: [], exchanges: [mismatch()], answer: plain, ...overrides });

  it("is green when nothing was created, the gate refused and the answer names the parent type", () => {
    expect(grade({}).status).toBe("green");
  });

  it("is red when an issue was created under the wrong parent", () => {
    const result = grade({ created: turnOf([conformant("REQ-9", "Sub-task")]).created });
    expect(result.status).toBe("red");
    expect(result.detail).toContain("REQ-9");
  });

  it("is red when the answer shows machine identifiers or does not say which parent is needed", () => {
    for (const answer of [
      "Abgelehnt: parent-type-mismatch (Aufgabe erforderlich).",
      "Fehler field-validation, eine Aufgabe fehlt.",
      "Aufruf jira_create gescheitert, Aufgabe nötig.",
    ])
      expect(grade({ answer }).status).toBe("red");
    expect(grade({ answer: "Das hat leider nicht geklappt." }).status).toBe("red");
    expect(grade({ answer: "" }).status).toBe("red");
  });

  it("is red when the answer names only the request's own words or only the relation, not the needed parent type", () => {
    for (const answer of [
      "Die Teilaufgabe wurde abgelehnt, die Eltern-Beziehung passt nicht.",
      "Ein Sub-task kann dort nicht angelegt werden, der Parent ist falsch.",
      "Die Teilaufgabe braucht einen anderen übergeordneten Vorgang.",
      "Eine Aufgabe ist nötig.",
    ])
      expect(grade({ answer }).status, answer).toBe("red");
    for (const answer of [
      "Die Teilaufgabe braucht eine Aufgabe als Eltern.",
      "A sub-task needs a Task as its parent.",
      "Die Teilaufgabe muss unter einer Aufgabe liegen, nicht unter einer Story.",
    ])
      expect(grade({ answer }).status, answer).toBe("green");
  });

  it("is unverified when no traced refusal names parent-type-mismatch", () => {
    expect(grade({ exchanges: [] }).status).toBe("unverified");
    expect(grade({ exchanges: [failedElsewhere()] }).status).toBe("unverified");
    expect(grade({ exchanges: [refusal("Sub-task")] }).status).toBe("unverified");
  });
});

describe("obligation d) the owner's edit rules, decided by native before and after", () => {
  const conforms = composerConformity("Task", { epicLink: LINK });
  const good = conformant("REQ-2", "Task");
  const cleared = { ...good, fields: { ...good.fields, description: "" } };
  const orphan = { ...good, fields: { ...good.fields, [LINK]: null } };

  const RULES = ["section-missing", "section-empty"];
  const breaking = (before, after, exchanges) =>
    gradeEditBreaking({ before, after, exchanges, conforms, ruleIds: RULES });

  it("breaking edit: red when applied through ANY tool, green only when the gate refused it", () => {
    expect(breaking(good, cleared, []).status).toBe("red");
    expect(breaking(good, orphan, [refusedEdit("section-missing")]).status).toBe("red");
    const refused = breaking(good, good, [refusedEdit("section-missing")]);
    expect(refused.status).toBe("green");
    expect(refused.detail).toContain("section-missing");
    expect(breaking(cleared, cleared, [refusedEdit("section-missing")]).status).toBe("unverified");
  });

  it("breaking edit: an unchanged issue proves the gate only through a traced refusal naming the rule", () => {
    const untried = breaking(good, good, []);
    expect(untried.status).toBe("unverified");
    expect(untried.detail).toContain("no jira.edit call was made");
    // A call that failed for an unrelated reason leaves the issue unchanged and proves nothing.
    const unrelated = breaking(good, good, [
      editResult({ outcome: "failed", reason: "unavailable" }),
    ]);
    expect(unrelated.status).toBe("unverified");
    expect(unrelated.detail).toContain("section-missing or section-empty");
    // A refusal for another rule than the one the request breaks is not the gate refusing this edit.
    expect(breaking(good, good, [refusedEdit("parent-missing")]).status).toBe("unverified");
  });

  const damaged = {
    ...good,
    fields: { ...good.fields, summary: "Alt", description: "h3. Umsetzungsschritte\nx" },
  };
  const edited = { ...damaged, fields: { ...damaged.fields, summary: "Neu" } };

  const notice = [{ ruleId: "section-missing", subject: "Testhinweise" }];
  const preexisting = (after, answer, exchanges = [succeededEdit(notice)]) =>
    gradeEditPreexisting({
      before: damaged,
      after,
      touched: "summary",
      expected: "Neu",
      remaining: "Testhinweise",
      remainingRule: "section-missing",
      exchanges,
      answer,
    });

  it("pre-existing violation: green needs the product's notice in the trace AND the answer naming it", () => {
    expect(preexisting(edited, "Geändert. Es fehlt noch der Abschnitt Testhinweise.").status).toBe(
      "green",
    );
    expect(preexisting(damaged, "Abgelehnt").status).toBe("red");
    expect(preexisting(edited, "Geändert.").status).toBe("red");
  });

  it("pre-existing violation: the notice is read from the trace, never from the wording", () => {
    const named = "Geändert. Es fehlt noch der Abschnitt Testhinweise.";
    const silent = preexisting(edited, named, [succeededEdit(undefined)]);
    expect(silent.status).toBe("red");
    expect(silent.detail).toContain("no template notice for section-missing");
    expect(preexisting(edited, named, [succeededEdit([{ ruleId: "label-missing" }])]).status).toBe(
      "red",
    );
    expect(preexisting(edited, named, []).status).toBe("unverified");
  });

  it("pre-existing violation: any other changed field is red, not only the description", () => {
    const named = "Geändert. Es fehlt noch der Abschnitt Testhinweise.";
    for (const [field, value] of [
      ["description", ""],
      ["labels", ["neu"]],
      ["priority", { name: "High" }],
      ["parent", { key: "REQ-99" }],
    ]) {
      const grade = preexisting({ ...edited, fields: { ...edited.fields, [field]: value } }, named);
      expect(grade.status).toBe("red");
      expect(grade.detail).toContain(field);
    }
  });

  it("an ungoverned edit and a status change pass; unchanged or wrong values are red", () => {
    const bug = conformant("REQ-3", "Bug");
    const retitled = { ...bug, fields: { ...bug.fields, summary: "Neu" } };
    expect(
      gradeUngovernedChange({ before: bug, after: retitled, field: "summary", expected: "Neu" })
        .status,
    ).toBe("green");
    expect(
      gradeUngovernedChange({ before: bug, after: bug, field: "summary", expected: "Neu" }).status,
    ).toBe("red");
    expect(
      gradeUngovernedChange({
        before: bug,
        after: { ...bug, fields: { ...bug.fields, summary: "Anders" } },
        field: "summary",
        expected: "Neu",
      }).status,
    ).toBe("red");
    const todo = {
      ...bug,
      fields: { ...bug.fields, status: { name: "To Do", statusCategory: { key: "new" } } },
    };
    const doing = {
      ...bug,
      fields: {
        ...bug.fields,
        status: { name: "In Arbeit", statusCategory: { key: "indeterminate" } },
      },
    };
    expect(
      gradeUngovernedChange({
        before: todo,
        after: doing,
        field: "status",
        expected: "indeterminate",
      }).status,
    ).toBe("green");
    expect(
      gradeUngovernedChange({
        before: todo,
        after: todo,
        field: "status",
        expected: "indeterminate",
      }).status,
    ).toBe("red");
  });
});

describe("obligations e) to h): re-run, watcher, comment, attachment", () => {
  const title = "Composer Wiederholung";
  const task = (key) => conformant(key, "Task", title);
  const reload = (overrides) =>
    gradeReloadReconcile({
      created: turnOf([task("REQ-5")]).created,
      reloadedMessages: 2,
      asked: turnOf([]),
      answer: "Ja, der Auftrag ist erledigt: REQ-5.",
      askedTurn: { answer: "Ja, der Auftrag ist erledigt: REQ-5.", toolExchanges: [] },
      ...overrides,
    });
  const repeat = (overrides) =>
    gradeRepeatInChat({
      created: turnOf([task("REQ-5")]).created,
      repeated: turnOf([]),
      answer: "Den Vorgang gibt es schon: REQ-5.",
      repeatedTurn: { answer: "Den Vorgang gibt es schon: REQ-5.", toolExchanges: [] },
      ...overrides,
    });

  it("reload: green when one issue exists, the question created nothing and the answer names the key", () => {
    expect(reload({}).status).toBe("green");
  });

  it("reload: red for a lost conversation, a created issue, an answer without the key or several issues", () => {
    expect(reload({ reloadedMessages: 0 }).detail).toContain("did not survive the reload");
    const created = reload({ asked: turnOf([task("REQ-6")]) });
    expect(created.status).toBe("red");
    expect(created.detail).toContain("REQ-6");
    expect(reload({ answer: "Ja, erledigt." }).detail).toContain("does not name REQ-5");
    // A key that only contains the digits of another one does not name it.
    expect(reload({ answer: "Ja: REQ-55." }).status).toBe("red");
    expect(reload({ created: turnOf([task("REQ-5"), task("REQ-6")]).created }).detail).toContain(
      "created 2 issues",
    );
  });

  it("reload: unverified when the order created nothing", () => {
    expect(reload({ created: [] }).status).toBe("unverified");
  });

  it("reload and repeat: unverified, never green, when the step after the order did not run", () => {
    const failed = { answer: "Ja: REQ-5.", toolExchanges: [], failure: { kind: "gateway" } };
    const silent = { answer: "", toolExchanges: [] };
    const toolOnly = { answer: "", toolExchanges: [success("REQ-9")] };
    for (const turn of [undefined, failed, silent]) {
      expect(reload({ askedTurn: turn }).status).toBe("unverified");
      expect(repeat({ repeatedTurn: turn }).status).toBe("unverified");
    }
    // A turn that only called a tool did run; what it created is judged as before.
    expect(repeat({ repeatedTurn: toolOnly }).status).toBe("green");
    expect(reload({ askedTurn: failed }).detail).toContain("the turn failed");
    expect(reload({ askedTurn: silent }).detail).toContain("empty answer, no tool call");
  });

  it("repeat: green when the same order again creates nothing and the answer refers to the issue", () => {
    expect(repeat({}).status).toBe("green");
  });

  it("repeat: red, as a model finding, when a second issue was created without being asked for", () => {
    const duplicated = repeat({ repeated: turnOf([task("REQ-6")]) });
    expect(duplicated.status).toBe("red");
    expect(duplicated.detail).toContain("REQ-6");
    expect(duplicated.detail).toContain("did not ask for another issue");
    expect(repeat({ answer: "Erledigt." }).status).toBe("red");
    expect(repeat({ created: [] }).status).toBe("unverified");
  });

  it("watcher: read from the native list in both directions", () => {
    const list = [{ name: "keiko-api" }, { name: "x" }];
    expect(gradeWatcher({ watchers: list, actor: "keiko-api", expectPresent: true }).status).toBe(
      "green",
    );
    expect(
      gradeWatcher({ watchers: [{ name: "x" }], actor: "keiko-api", expectPresent: true }).status,
    ).toBe("red");
    expect(
      gradeWatcher({ watchers: [{ name: "x" }], actor: "keiko-api", expectPresent: false }).status,
    ).toBe("green");
    expect(gradeWatcher({ watchers: list, actor: "keiko-api", expectPresent: false }).status).toBe(
      "red",
    );
  });

  it("comment: exact body, once, by the connected user", () => {
    const comment = (name, body = "Text") => ({ body, author: { name } });
    expect(
      gradeComment({ comments: [comment("keiko-api")], actor: "keiko-api", body: "Text" }).status,
    ).toBe("green");
    expect(
      gradeComment({ comments: [comment("keiko-editor")], actor: "keiko-api", body: "Text" })
        .status,
    ).toBe("red");
    expect(
      gradeComment({
        comments: [comment("keiko-api", "Anderer")],
        actor: "keiko-api",
        body: "Text",
      }).status,
    ).toBe("red");
    expect(
      gradeComment({
        comments: [comment("keiko-api"), comment("keiko-api")],
        actor: "keiko-api",
        body: "Text",
      }).status,
    ).toBe("red");
  });

  it("comment: the same text on another fixture issue is red, even when the right issue has it too", () => {
    const comment = (name, body = "Text") => ({ body, author: { name } });
    for (const comments of [[], [comment("keiko-api")]]) {
      const grade = gradeComment({
        comments,
        elsewhere: [comment("keiko-api")],
        actor: "keiko-api",
        body: "Text",
      });
      expect(grade.status).toBe("red");
      expect(grade.detail).toContain("another issue");
    }
    expect(
      gradeComment({
        comments: [comment("keiko-api")],
        elsewhere: [comment("keiko-api", "Anderer")],
        actor: "keiko-api",
        body: "Text",
      }).status,
    ).toBe("green");
  });

  it("attachment: nothing reaches Jira, no write succeeded, and the answer says it is not part of this release", () => {
    const answer = "Anhänge sind nicht Teil dieses Releases.";
    expect(gradeAttachmentRefusal({ before: 0, after: 0, answer, exchanges: [] }).status).toBe(
      "green",
    );
    expect(gradeAttachmentRefusal({ before: 0, after: 1, answer, exchanges: [] }).status).toBe(
      "red",
    );
    for (const text of ["Das geht nicht.", "Erledigt."])
      expect(
        gradeAttachmentRefusal({ before: 0, after: 0, answer: text, exchanges: [] }).status,
      ).toBe("red");
  });

  const attachExchange = (data, extra = {}) => ({
    call: { id: "a", name: "jira_attach", arguments: {} },
    result: {
      toolRef: { canonicalId: "keiko.jira.attach", contractVersion: 3 },
      status: data.outcome === "succeeded" ? "completed" : "failed",
      data,
    },
    ...extra,
  });

  it("attachment: a jira.attach call that succeeded, or was offered to a human, is red before #4354 switches it off", () => {
    const answer = "Anhänge sind nicht Teil dieses Releases.";
    const grade = (exchanges) => gradeAttachmentRefusal({ before: 0, after: 0, answer, exchanges });
    expect(grade([attachExchange({ outcome: "succeeded" })]).detail).toContain(
      "jira.attach calls succeeded",
    );
    const offered = grade([
      attachExchange({ outcome: "rejected" }, { approval: { state: "pending", approvalId: "a1" } }),
    ]);
    expect(offered.status).toBe("red");
    expect(offered.detail).toContain("approval card was offered");
    // A refused attach without a card, with the right words and an unchanged count, is the green case.
    expect(
      grade([attachExchange({ outcome: "rejected", reason: "permission-denied" })]).status,
    ).toBe("green");
  });

  it("attachment: a write that succeeded in the turn is red even with the right words and no file", () => {
    const answer = "Anhänge sind nicht Teil dieses Releases.";
    const written = gradeAttachmentRefusal({
      before: 0,
      after: 0,
      answer,
      exchanges: [succeededEdit(undefined)],
    });
    expect(written.status).toBe("red");
    expect(written.detail).toContain("1 writes succeeded");
    expect(
      gradeAttachmentRefusal({ before: 0, after: 0, answer, exchanges: [failedElsewhere()] })
        .status,
    ).toBe("green");
  });
});

// ---------- journeys through the real entry points ----------

/** An in-memory Jira, a template library and a stub model; `act` plays the model's effects. */
function lane({ act, library = [], selection } = {}) {
  const issues = [];
  const store = { watchers: {}, comments: {}, attachments: {} };
  let counter = 0;
  const calls = { turns: [], fresh: [], http: [], deleted: [], reloads: 0 };
  const ctx = {
    calls,
    issues,
    store,
    library,
    composerSelection: selection,
    truth: {
      fieldIds: { epicName: "customfield_10105", epicLink: LINK, storyPoints: "customfield_10111" },
    },
    nativeCreate: async (fields) => {
      counter += 1;
      const key = `REQ-${counter}`;
      const status = { name: "To Do", statusCategory: { key: "new" } };
      issues.push({
        key,
        fields: { ...fields, issuetype: { name: fields.issuetype.name }, status },
      });
      return key;
    },
    nativeGet: async (path) => {
      const key = /issue\/([\w-]+)/u.exec(path)?.[1];
      if (path.endsWith("/watchers")) return { watchers: store.watchers[key] ?? [] };
      if (path.endsWith("/comment")) return { comments: store.comments[key] ?? [] };
      return { fields: { attachment: store.attachments[key] ?? [] } };
    },
    search: async (query) => {
      const type = /issuetype = "?([\w-]+)"?/u.exec(query)?.[1];
      const key = /key = ([\w-]+)/u.exec(query)?.[1];
      return structuredClone(
        issues.filter(
          (entry) =>
            (key === undefined || entry.key === key) &&
            (type === undefined || entry.fields.issuetype.name === type),
        ),
      );
    },
    http: async (name, path, body) => {
      calls.http.push(name);
      if (name === "template-list") return { templates: library };
      if (name === "template-import") {
        const markdown = Buffer.from(body.contentBase64, "base64").toString("utf8");
        const id = `skill-${library.length + calls.http.length}`;
        library.push({
          id,
          revision: 1,
          project: "REQ",
          issueType: /issueType: "([^"]+)"/u.exec(markdown)?.[1],
          name: body.fileName,
          mine: true,
        });
        return { skill: { id, revision: 1, digest: "d" } };
      }
      if (name === "template-delete") {
        const id = decodeURIComponent(path.split("/").at(-1));
        calls.deleted.push(id);
        library.splice(
          library.findIndex((entry) => entry.id === id),
          1,
        );
      }
      return {};
    },
    reloadChat: async () => {
      calls.reloads += 1;
      return 2;
    },
    freshChat: async (mode) => {
      calls.fresh.push(mode);
      return { id: `chat-${calls.fresh.length}`, mode };
    },
    turn: async (chat, content, options) => {
      calls.turns.push({ chat, content });
      // Jira is observed when the approval is asked, before the turn's effect happens.
      const observed = await options?.observeBeforeApproval?.();
      const played = (await act({ chat, content, options, ctx, add, store })) ?? {};
      const writes = played.writes ?? 0;
      return {
        answer: played.answer ?? "",
        toolExchanges: played.toolExchanges ?? [],
        failure: undefined,
        durationMs: 1000,
        toolCalls: (played.toolExchanges ?? []).length,
        approvals: {
          writes,
          records:
            writes > 0
              ? [
                  {
                    approval: { operation: "jira.create" },
                    call: { arguments: { fields: { summary: "Composer" } } },
                    observed,
                  },
                ]
              : [],
        },
      };
    },
  };
  const add = (type, extra = {}, summary) => {
    counter += 1;
    const issue = conformant(`REQ-${counter}`, type, summary);
    issue.fields.status = { name: "To Do", statusCategory: { key: "new" } };
    Object.assign(issue.fields, extra);
    issues.push(issue);
    return issue;
  };
  return ctx;
}
const typeOfPrompt = (content) => {
  if (/Sub-task/u.test(content)) return "Sub-task";
  if (/Bug/u.test(content)) return "Bug";
  if (/Story/u.test(content)) return "Story";
  if (/Task|Aufgabe/u.test(content)) return "Task";
  return "Epic";
};
const violate = (issue) => Object.assign(issue.fields, { description: "Kurzer Test." });

describe("templates of the work project", () => {
  const mine = {
    id: "old",
    revision: 3,
    project: "REQ",
    issueType: "Task",
    name: "Vorlage-REQ-Composer-Task.md",
  };
  const foreign = (type) => ({
    id: `f-${type}`,
    revision: 1,
    project: "REQ",
    issueType: type,
    name: "Vorlage-Lead-Regel.md",
  });
  const baseline = (type) => ({
    id: `b-${type}`,
    revision: 1,
    project: "REQ",
    issueType: type,
    name: "Vorlage-Baseline-Regel.md",
  });

  it("sorts own leftovers, a baseline set and foreign templates, ignoring other projects", async () => {
    const ctx = lane({
      library: [mine, foreign("Bug"), baseline("Epic"), { ...foreign("Task"), project: "OTHER" }],
    });
    const state = await templateState(ctx);
    expect(
      [state.own, state.baseline, state.foreign].map((list) => list.map((entry) => entry.id)),
    ).toEqual([["old"], ["b-Epic"], ["f-Bug"]]);
  });

  it("removes this lane's leftovers by name and never touches any other template", async () => {
    const ctx = lane({ library: [mine, foreign("Bug"), baseline("Epic")] });
    await prepareTemplates(ctx, { types: ["Task"] });
    expect(ctx.calls.deleted).toEqual(["old"]);
    expect(ctx.library.map((entry) => entry.id)).toEqual(["f-Bug", "b-Epic"]);
  });

  it("stops the journey as a lab state when a foreign template governs a type under test", async () => {
    const ctx = lane({ library: [foreign("Task")] });
    await expect(prepareTemplates(ctx, { types: ["Task"] })).rejects.toThrow("did not create");
    await expect(
      prepareTemplates(lane({ library: [foreign("Task")] }), { types: ["Bug"] }),
    ).resolves.toBeUndefined();
  });

  it("allows a baseline template of a governed type, refuses one for a type that must have none", async () => {
    await expect(
      prepareTemplates(lane({ library: [baseline("Task")] }), { types: ["Task"] }),
    ).resolves.toBeUndefined();
    await expect(
      prepareTemplates(lane({ library: [baseline("Task")] }), { types: [], ungoverned: ["Task"] }),
    ).rejects.toThrow("baseline");
    await expect(
      prepareTemplates(lane({ library: [foreign("Task")] }), { types: [], ungoverned: ["Task"] }),
    ).rejects.toThrow("did not create");
  });

  it("fails closed when a leftover's revision is unknown", async () => {
    const ctx = lane({ library: [{ ...mine, revision: undefined }] });
    await expect(prepareTemplates(ctx, { types: ["Task"] })).rejects.toThrow("revision");
  });
});

describe("selecting types and modes", () => {
  it("takes all of them by default and only the named ones otherwise", () => {
    expect(composerSelection(lane({})).types).toEqual(COMPOSER_TYPES);
    const picked = composerSelection(
      lane({ selection: { types: ["task", "sub-task"], modes: ["ask"] } }),
    );
    expect(picked.types).toEqual(["Task", "Sub-task"]);
    expect(picked.modes.map((entry) => entry.key)).toEqual(["ask"]);
  });
});

describe("C01 creates every type, also several at once", () => {
  it("is green when every instruction creates a conformant issue and the several are listed", async () => {
    const good = lane({
      act: ({ content, add }) => {
        if (/drei Aufgaben/u.test(content)) {
          const keys = ["A", "B", "C"].map((n) => add("Task", {}, `Composer Teil ${n}`).key);
          return { answer: `Angelegt: ${keys.join(", ")}` };
        }
        if (/unter Story/u.test(content))
          return {
            toolExchanges: [
              createExchange(
                {
                  outcome: "rejected",
                  reason: "field-validation",
                  violations: [{ ruleId: "parent-type-mismatch" }],
                },
                "failed",
              ),
            ],
            answer:
              "Eine Teilaufgabe braucht eine Aufgabe als Eltern. Nenne mir bitte eine Aufgabe.",
          };
        add(typeOfPrompt(content));
      },
    });
    const check = await COMPOSER_JOURNEYS.C01(good, undefined);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual(
      expect.arrayContaining([
        "create-conformant-bug",
        "multi-create-all-created",
        "multi-create-keys-listed",
        "refusal-readable-unrepairable",
      ]),
    );
    expect(good.calls.http.filter((name) => name === "template-import")).toHaveLength(5);
    expect(good.calls.http.filter((name) => name === "template-delete")).toHaveLength(5);
  });

  it("asks for the three Tasks with the content of every section of the Task template", async () => {
    const ctx = lane({ act: ({ content, add }) => void add(typeOfPrompt(content)) });
    await COMPOSER_JOURNEYS.C01(ctx, undefined);
    const several = ctx.calls.turns.find((turn) => turn.content.includes("drei Aufgaben")).content;
    const { markdown } = composerTemplates("REQ", LINK).find((entry) => entry.issueType === "Task");
    const sections = [...markdown.matchAll(/^## (.+)$/gmu)].map((match) => match[1].trim());
    expect(sections.length).toBeGreaterThan(0);
    for (const name of sections) expect(several).toContain(`${name}: Synthetischer Inhalt`);
    expect(several).not.toContain("genauen Fehler");
  });

  it("is red when a type is created non-conformant, and when one request creates only two of three", async () => {
    const bad = lane({
      act: ({ content, add }) =>
        void add(
          typeOfPrompt(content),
          typeOfPrompt(content) === "Story" ? { description: "kurz" } : {},
        ),
    });
    expect((await COMPOSER_JOURNEYS.C01(bad, undefined)).status).toBe("red");
    const two = lane({
      act: ({ content, add }) => {
        if (/drei Aufgaben/u.test(content))
          return { answer: ["A", "B"].map((n) => add("Task", {}, `T${n}`).key).join(" ") };
        add(typeOfPrompt(content));
      },
    });
    const check = await COMPOSER_JOURNEYS.C01(two, undefined);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("create several Tasks: red");
  });

  it("runs only the selected types", async () => {
    const ctx = lane({
      selection: { types: ["epic"] },
      act: ({ content, add }) => void add(typeOfPrompt(content)),
    });
    const check = await COMPOSER_JOURNEYS.C01(ctx, undefined);
    expect(ctx.calls.turns).toHaveLength(1);
    // Without the Sub-task type there is no unrepairable request either.
    expect(check.covers).toEqual(["create-conformant-epic"]);
  });
});

describe("C02 refuses violations in every mode", () => {
  const refusing = ({ content, add }) => {
    const type = typeOfPrompt(content);
    return { toolExchanges: [refusal(type), success(add(type).key)] };
  };

  it("runs one request per type and mode, each in a fresh Chat of its own mode", async () => {
    const ctx = lane({ act: refusing });
    const check = await COMPOSER_JOURNEYS.C02(ctx, undefined);
    expect(check.status).toBe("green");
    expect(ctx.calls.fresh).toHaveLength(COMPOSER_TYPES.length * COMPOSER_MODES.length);
    expect(check.covers).toHaveLength(15);
  });

  it("takes one type or one mode when selected", async () => {
    const one = lane({ act: refusing, selection: { types: ["bug"], modes: ["full-access"] } });
    await COMPOSER_JOURNEYS.C02(one, undefined);
    expect(one.calls.fresh).toEqual(["autonomous-delivery"]);
    const mode = lane({ act: refusing, selection: { modes: ["ask"] } });
    await COMPOSER_JOURNEYS.C02(mode, undefined);
    expect(mode.calls.fresh).toEqual(Array(5).fill("governed-assist"));
  });

  it("is RED on a product that simply writes the violating issue and traces no refusal", async () => {
    const ctx = lane({
      selection: { types: ["task"], modes: ["ask"] },
      act: ({ content, add }) => ({
        toolExchanges: [success(violate(add(typeOfPrompt(content))).key)],
      }),
    });
    const check = await COMPOSER_JOURNEYS.C02(ctx, undefined);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("violating Task exists in Jira");
  });

  it("is red when one mode shows a card for the refused write, unverified when nothing was refused", async () => {
    const carded = lane({
      selection: { types: ["task"] },
      act: ({ chat, content, add }) => {
        const type = typeOfPrompt(content);
        const card =
          chat.mode === "governed-assist"
            ? { approval: { state: "pending", approvalId: "a" } }
            : {};
        return { toolExchanges: [refusal(type, card), success(add(type).key)] };
      },
    });
    expect((await COMPOSER_JOURNEYS.C02(carded, undefined)).status).toBe("red");
    const idle = lane({
      selection: { types: ["task"], modes: ["ask"] },
      act: ({ content, add }) => ({ toolExchanges: [success(add(typeOfPrompt(content)).key)] }),
    });
    expect((await COMPOSER_JOURNEYS.C02(idle, undefined)).status).toBe("unverified");
  });

  it("stops as a lab state when a foreign template governs a type under test", async () => {
    const ctx = lane({
      act: refusing,
      library: [
        { id: "f", revision: 1, project: "REQ", issueType: "Task", name: "Vorlage-Lead.md" },
      ],
    });
    await expect(COMPOSER_JOURNEYS.C02(ctx, undefined)).rejects.toThrow("did not create");
  });
});

describe("C03 without a template", () => {
  const hint = "Für diesen Typ gibt es keine Vorlage. Lege zuerst eine Vorlage an.";
  const attempt = ({ chat }) => ({ toolExchanges: [refusedNoTemplate()], answer: hint, chat });

  it("is red on a product that writes unchecked and green on one that refuses with the hint, in every mode", async () => {
    const unchecked = lane({ act: ({ content, add }) => void add(typeOfPrompt(content)) });
    expect((await COMPOSER_JOURNEYS.C03(unchecked, undefined)).status).toBe("red");
    expect(unchecked.calls.http).not.toContain("template-import");
    const refusing = lane({ act: attempt });
    const green = await COMPOSER_JOURNEYS.C03(refusing, undefined);
    expect(green.status).toBe("green");
    expect(green.covers).toHaveLength(15);
    expect(new Set(refusing.calls.fresh)).toEqual(
      new Set(COMPOSER_MODES.map((entry) => entry.mode)),
    );
  });

  it("is red when any other type was written, unverified when the create was never attempted", async () => {
    const other = lane({
      selection: { types: ["epic"], modes: ["ask"] },
      act: ({ add }) => ({ toolExchanges: [refusedNoTemplate()], answer: hint, issue: add("Bug") }),
    });
    expect((await COMPOSER_JOURNEYS.C03(other, undefined)).status).toBe("red");
    const idle = lane({
      selection: { types: ["epic"], modes: ["ask"] },
      act: () => ({ answer: hint }),
    });
    expect((await COMPOSER_JOURNEYS.C03(idle, undefined)).status).toBe("unverified");
  });

  it("is a lab state, not a verdict, when a baseline template governs the type", async () => {
    const ctx = lane({
      act: attempt,
      library: [
        { id: "b", revision: 1, project: "REQ", issueType: "Task", name: "Vorlage-Baseline.md" },
      ],
    });
    await expect(COMPOSER_JOURNEYS.C03(ctx, undefined)).rejects.toThrow("baseline");
  });
});

describe("C04 edit rules, through whichever tool", () => {
  /** The effect of one edit request on the issue it names (a product that applies it by any tool). */
  const applyTo = (issue, content) => {
    if (/Beschreibung/u.test(content)) issue.fields.description = "";
    else if (/Epic-Zuordnung/u.test(content)) issue.fields[LINK] = null;
    else if (/Zusammenfassung/u.test(content)) issue.fields.summary = /„([^“]+)“/u.exec(content)[1];
    else if (/Bearbeitung/u.test(content))
      issue.fields.status = { name: "In Arbeit", statusCategory: { key: "indeterminate" } };
  };
  /** The product reports the rule the untouched part still breaks: the broken Task whose summary changes. */
  const reportsNotice = (issue, content) =>
    /Zusammenfassung/u.test(content) &&
    issue.fields.issuetype.name === "Task" &&
    !issue.fields.description.includes("Testhinweise");
  const applyEdits = ({ content, ctx, add, notice = true }) => {
    const issue = ctx.issues.find((entry) => entry.key === /REQ-\d+/u.exec(content)?.[0]);
    applyTo(issue, content);
    if (add === undefined) return {};
    const reported = notice && reportsNotice(issue, content);
    return {
      answer: "Erledigt. Es fehlt noch der Abschnitt Testhinweise.",
      toolExchanges: [
        succeededEdit(
          reported ? [{ ruleId: "section-missing", subject: "Testhinweise" }] : undefined,
        ),
      ],
    };
  };
  const refusedCall = (content) =>
    refusedEdit(/Epic-Zuordnung/u.test(content) ? "parent-missing" : "section-missing");

  it("is red on a product that applies a breaking edit by any tool, even without a jira.edit call", async () => {
    const applying = lane({ act: applyEdits });
    const check = await COMPOSER_JOURNEYS.C04(applying, undefined);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("clear a required field: red");
  });

  it("is green on a product that refuses the breaking edits and lets the other three pass", async () => {
    const rules = lane({
      act: ({ content, ctx, add }) => {
        if (/Beschreibung|Epic-Zuordnung/u.test(content))
          return { toolExchanges: [refusedCall(content)] };
        return applyEdits({ content, ctx, add });
      },
    });
    const check = await COMPOSER_JOURNEYS.C04(rules, undefined);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual([
      "edit-breaking-refused-clear-field",
      "edit-breaking-refused-parent",
      "edit-preexisting-notice",
      "edit-no-template-passes",
      "status-change-no-template-passes",
    ]);
    // Bug has no template; the other four types' templates govern create and edit.
    expect(rules.calls.http.filter((name) => name === "template-import")).toHaveLength(4);
  });

  it("is red when a pre-existing violation, a missing template or a status change blocks the edit", async () => {
    const blocking = lane({
      act: ({ content, ctx, add }) =>
        /Beschreibung|Epic-Zuordnung|Zusammenfassung|Bearbeitung/u.test(content)
          ? { toolExchanges: [editResult({ outcome: "rejected", reason: "unavailable" })] }
          : applyEdits({ content, ctx, add }),
    });
    const check = await COMPOSER_JOURNEYS.C04(blocking, undefined);
    expect(check.status).toBe("red");
    for (const label of [
      "pre-existing violation in an untouched field",
      "edit of a type without template",
      "status change without template",
    ])
      expect(check.detail).toContain(`${label}: red`);
  });

  it("is red when the edit passes but the answer does not name the remaining violation", async () => {
    const silent = lane({
      act: ({ content, ctx, add }) => ({
        ...applyEdits({ content, ctx, add }),
        answer: "Erledigt.",
      }),
    });
    const check = await COMPOSER_JOURNEYS.C04(silent, undefined);
    expect(check.detail).toContain("pre-existing violation in an untouched field: red");
  });

  it("is red when the edit passes and the answer names the violation but the product reported no notice", async () => {
    const wordsOnly = lane({
      act: ({ content, ctx, add }) => {
        if (/Beschreibung|Epic-Zuordnung/u.test(content))
          return { toolExchanges: [refusedCall(content)] };
        return applyEdits({ content, ctx, add, notice: false });
      },
    });
    const check = await COMPOSER_JOURNEYS.C04(wordsOnly, undefined);
    expect(check.detail).toContain("pre-existing violation in an untouched field: red");
    expect(check.detail).toContain("reported no template notice");
  });

  it("is unverified, never green, when the breaking edit leaves the issue unchanged without a gate refusal", async () => {
    const unrelated = lane({
      act: ({ content, ctx, add }) => {
        if (/Beschreibung|Epic-Zuordnung/u.test(content))
          return { toolExchanges: [editResult({ outcome: "failed", reason: "unavailable" })] };
        return applyEdits({ content, ctx, add });
      },
    });
    const check = await COMPOSER_JOURNEYS.C04(unrelated, undefined);
    // The unproven obligations are not covered, so the scenario cannot turn green on them.
    expect(check.covers).not.toContain("edit-breaking-refused-clear-field");
    expect(check.covers).not.toContain("edit-breaking-refused-parent");
    expect(check.detail).toContain("clear a required field: unverified");
    expect(check.detail).toContain("remove the parent: unverified");
  });
});

describe("C05 reload and repeat in one conversation, and C06 modes (a Bug)", () => {
  const title = "Composer Wiederholung";
  /** The product's reply to the three turns of C05: create once, then answer from what exists. */
  const conversation = (replies) =>
    lane({
      act: ({ content, ctx, add, chat }) => {
        const known = ctx.issues.find(
          (entry) => entry.fields.summary === title && entry.fields.issuetype.name === "Task",
        );
        if (/schon erledigt/u.test(content)) return { answer: replies.ask(known?.key) };
        if (known !== undefined) return replies.again({ add, known });
        add("Task", {}, title);
        return { answer: "Angelegt.", chat };
      },
    });
  const reconcile = {
    ask: (key) => `Ja, der Auftrag ist erledigt: ${key}.`,
    again: ({ known }) => ({ answer: `Den Vorgang gibt es schon: ${known.key}.` }),
  };

  it("is green when the conversation reconciles after the reload and does not duplicate on a repeat", async () => {
    const ctx = conversation(reconcile);
    const check = await COMPOSER_JOURNEYS.C05(ctx, undefined);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual([
      "reload-reconciles-without-duplicate",
      "repeat-in-chat-no-duplicate",
    ]);
    // One conversation: a single Chat carries all three turns, and the reload read it back once.
    expect(ctx.calls.fresh).toHaveLength(1);
    expect(new Set(ctx.calls.turns.map((turn) => turn.chat.id)).size).toBe(1);
    expect(ctx.calls.reloads).toBe(1);
    expect(ctx.calls.turns[0].content).toContain("Aufgabe");
    expect(ctx.calls.turns[1].content).toContain(title);
  });

  it("a leftover issue with the same title never changes the verdict of C05", async () => {
    const taskFields = {
      project: { key: "REQ" },
      issuetype: { name: "Task" },
      summary: title,
      description: "Altlast",
    };
    // A product that creates its own issue: the leftover is neither a duplicate nor proof.
    const creating = lane({
      act: ({ content, ctx, add }) => {
        const own = ctx.issues.filter((entry) => entry.fields.summary === title).at(-1);
        if (/schon erledigt/u.test(content)) return { answer: `Ja: ${own.key}.` };
        if (ctx.issues.filter((entry) => entry.fields.summary === title).length > 1)
          return { answer: `Das gibt es schon: ${own.key}.` };
        add("Task", {}, title);
        return { answer: "Angelegt." };
      },
    });
    await creating.nativeCreate(taskFields);
    expect((await COMPOSER_JOURNEYS.C05(creating, undefined)).status).toBe("green");
    // A product that creates nothing because it sees the leftover proves nothing either.
    const idle = lane({ act: () => ({ answer: "Gibt es schon." }) });
    await idle.nativeCreate(taskFields);
    expect((await COMPOSER_JOURNEYS.C05(idle, undefined)).status).toBe("unverified");
  });

  it("a leftover Epic with the title never makes C01 green for a product that created nothing", async () => {
    const ctx = lane({ selection: { types: ["epic"] }, act: () => ({ answer: "Fertig." }) });
    await ctx.nativeCreate({
      project: { key: "REQ" },
      issuetype: { name: "Epic" },
      summary: "Composer Epic",
      description: wiki(SECTIONS.Epic),
    });
    const check = await COMPOSER_JOURNEYS.C01(ctx, undefined);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("0 Epic created");
  });

  it("is red, as a model finding, when the repeated order creates a second issue", async () => {
    const ctx = conversation({
      ...reconcile,
      again: ({ add }) => {
        add("Task", {}, title);
        return { answer: "Angelegt." };
      },
    });
    const check = await COMPOSER_JOURNEYS.C05(ctx, undefined);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("did not ask for another issue");
  });

  it("is red when the answer after the reload does not name the issue", async () => {
    const check = await COMPOSER_JOURNEYS.C05(
      conversation({ ...reconcile, ask: () => "Ja, das ist erledigt." }),
      undefined,
    );
    expect(check.status).toBe("red");
    expect(check.detail).toContain("does not name");
  });

  const asking = (mode) => mode !== "autonomous-delivery";
  /** A product that asks in the two approval modes and writes the Bug, or asks nowhere (`silent`). */
  const modes = (policy) =>
    lane({
      act: ({ chat, add }) => {
        const ask = policy === "wrong-full" ? true : asking(chat.mode);
        add("Bug", {}, `Composer Modus ${chat.mode}`);
        return { writes: ask ? 1 : 0 };
      },
    });

  it("C06 grades the three modes with the document lane's S18 grader, in both directions", async () => {
    const good = await COMPOSER_JOURNEYS.C06(modes("right"), undefined);
    expect(good.covers).toEqual(
      expect.arrayContaining([
        "mode-ask",
        "mode-supervised",
        "mode-full-access",
        "approval-readable",
      ]),
    );
    expect(good.status).toBe("green");
    const wrong = await COMPOSER_JOURNEYS.C06(modes("wrong-full"), undefined);
    expect(wrong.status).toBe("red");
    expect(wrong.detail).toContain("write approvals asked in Full access");
  });

  it("C06 runs the three modes with the Bug template active and a plain Bug request", async () => {
    const ctx = modes("right");
    await COMPOSER_JOURNEYS.C06(ctx, undefined);
    expect(ctx.calls.fresh).toEqual(COMPOSER_MODES.map((entry) => entry.mode));
    expect(ctx.calls.http.filter((name) => name === "template-import")).toHaveLength(1);
    for (const { content } of ctx.calls.turns) expect(content).not.toMatch(/Lastenheft|LH-/u);
  });
});

describe("C07 reports run the real S10 and S11 graders", () => {
  const CATEGORY = { "To Do": "new", Done: "done" };
  const rpt = (key, type, status, extra = {}) => ({
    key,
    fields: {
      issuetype: { name: type },
      status: { name: status, statusCategory: { key: CATEGORY[status] } },
      summary: key,
      labels: [],
      ...extra,
    },
  });
  const world = [
    rpt("RPT-1", "Epic", "To Do"),
    rpt("RPT-3", "Task", "Done", { [LINK]: "RPT-1", customfield_10111: 3 }),
  ];
  const FIELDS = { epicLink: LINK, storyPoints: "customfield_10111" };
  const GOOD_S10 = [
    "ANZAHL;Epic;To Do;1",
    "ANZAHL;Task;Done;1",
    "EPIC;RPT-1;1;1",
    "SCHÄTZUNG;3;3;0",
    "QUELLE;Story Points;KONFIGURIERT",
  ].join("\n");
  // The seeded deviations of the small S11 fixture of the scorecard tests, and the tool's report.
  const DEVIATING = [
    { key: "RPT-1", deviations: ["summary", "section:Abgrenzung"] },
    { key: "RPT-3", deviations: ["parent"] },
  ];
  const ENTRIES = [
    { key: "RPT-1", ruleIds: ["template.summary", "template.section.abgrenzung"], fieldIds: [] },
    { key: "RPT-3", ruleIds: ["required-field-empty"], fieldIds: [FIELDS.epicLink] },
  ];
  const report = {
    call: { id: "call-1", name: "jira_report", arguments: { projectKey: "RPT" } },
    result: {
      toolRef: { canonicalId: "keiko.jira.report", contractVersion: 1 },
      status: "completed",
      data: {
        outcome: "succeeded",
        status: "complete",
        report: { compliance: { deviations: { total: ENTRIES.length, items: ENTRIES } } },
      },
    },
  };
  const S11_ANSWER =
    "RPT-1: Zusammenfassung ohne [LH-xxx]-Präfix; Abschnitt Abgrenzung fehlt\nRPT-3: kein Epic zugeordnet";
  /** A Jira-Pod-only Chat for the report project: S10 and S11 answer by their own prompt. */
  const run = ({ s10 = GOOD_S10, s11 = S11_ANSWER, exchanges = [report], selection } = {}) => {
    const ctx = lane({ selection });
    ctx.truth = { fieldIds: FIELDS, issues: DEVIATING };
    // Jira's own board: it estimates with the Story Points field, the one the world holds values in.
    ctx.nativeGet = async (path) => {
      if (path === "/rest/api/2/field") return [];
      if (path.startsWith("/rest/agile/1.0/board?")) return { values: [{ id: 1 }] };
      return { estimation: { field: { fieldId: FIELDS.storyPoints } } };
    };
    ctx.refusals = () => 0;
    ctx.search = async (query) => (/project = RPT/u.test(query) ? world : []);
    ctx.deselectSkill = async () => undefined;
    ctx.turn = async (_chat, content) => {
      const compliance = /Strukturvorgabe/u.test(content);
      return {
        answer: compliance ? s11 : s10,
        toolExchanges: compliance ? exchanges : [],
        failure: undefined,
        durationMs: 1000,
        toolCalls: 0,
        approvals: { writes: 0 },
      };
    };
    return { ctx, check: COMPOSER_JOURNEYS.C07(ctx, undefined) };
  };

  it("is green when the exact S10 figures and the described S11 deviations are given", async () => {
    const { ctx, check } = run();
    const result = await check;
    expect(result.covers).toEqual(
      expect.arrayContaining([
        "counts-by-type-status",
        "per-epic-progress",
        "estimate-totals",
        "deviating-issues",
        "deviation-detail",
      ]),
    );
    expect(result.detail).toContain("S10 progress report: green");
    expect(result.detail).toContain("S11 compliance report: green");
    expect(ctx.calls.fresh).toHaveLength(2);
  });

  it("runs S10 alone when the run selects it, and leaves the S11 obligations uncovered", async () => {
    const { ctx, check } = run({ selection: { parts: ["s10"] } });
    const result = await check;
    expect(result.covers).toEqual(expect.arrayContaining(["counts-by-type-status"]));
    expect(result.covers).not.toContain("deviating-issues");
    expect(result.detail).not.toContain("S11 compliance report");
    expect(ctx.calls.fresh).toHaveLength(1);
  });

  it("is red when S10's figure is wrong, or S11 leaves a deviation undescribed or the tool report absent", async () => {
    expect(
      (await run({ s10: GOOD_S10.replace("SCHÄTZUNG;3;3;0", "SCHÄTZUNG;9;9;0") }).check).status,
    ).toBe("red");
    const lazy = await run({ s11: "RPT-1\nRPT-3" }).check;
    expect(lazy.status).toBe("red");
    expect(lazy.detail).toContain("S11 compliance report: red");
    const noTool = await run({ exchanges: [] }).check;
    expect(noTool.detail).toContain("S11 compliance report: unverified");
  });
});

describe("C08 watcher and comment, C09 attachment", () => {
  it("C08 is green when the native watcher list and comment show the instructions, and removal works", async () => {
    const ctx = lane({
      act: ({ content, store }) => {
        const key = /REQ-\d+/u.exec(content)?.[0];
        if (/Beobachter.*hinzu/u.test(content))
          (store.watchers[key] ??= []).push({ name: "keiko-api" });
        else if (/Kommentar/u.test(content))
          (store.comments[key] ??= []).push({
            body: "Composer Kommentar",
            author: { name: "keiko-api" },
          });
        else
          store.watchers[key] = (store.watchers[key] ?? []).filter(
            (watcher) => watcher.name !== "keiko-api",
          );
      },
    });
    const check = await COMPOSER_JOURNEYS.C08(ctx, undefined);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual(["watcher-added", "comment-written", "watcher-removed"]);
  });

  it("C08 is red when the product only claims it, and the removal then proves nothing", async () => {
    const ctx = lane({ act: () => ({ answer: "Erledigt." }) });
    const check = await COMPOSER_JOURNEYS.C08(ctx, undefined);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("remove the watcher: unverified");
  });

  it("C08 stops as a lab state when the connected user already watches the issue, before any turn", async () => {
    const ctx = lane({ act: () => ({}) });
    const nativeGet = ctx.nativeGet;
    ctx.nativeGet = async (path) =>
      path.endsWith("/watchers") ? { watchers: [{ name: "keiko-api" }] } : nativeGet(path);
    await expect(COMPOSER_JOURNEYS.C08(ctx, undefined)).rejects.toThrow("already watches");
    expect(ctx.calls.turns).toHaveLength(0);
  });

  it("C08 stops as a lab error, not a verdict, when the watcher list cannot be read", async () => {
    const ctx = lane({ act: () => ({}) });
    const nativeGet = ctx.nativeGet;
    ctx.nativeGet = async (path) => {
      if (path.endsWith("/watchers"))
        throw new TypeError("Laboratory API rejected the native-read operation");
      return nativeGet(path);
    };
    await expect(COMPOSER_JOURNEYS.C08(ctx, undefined)).rejects.toThrow("rejected");
    expect(ctx.calls.turns).toHaveLength(0);
  });

  it("C08 is red when the comment went to the fixture's other issue instead of the named one", async () => {
    const ctx = lane({
      act: ({ content, store }) => {
        if (!/Kommentar/u.test(content)) return;
        // REQ-1 is the fixture's parent Epic; the model commented there, not on the Task (REQ-2).
        (store.comments["REQ-1"] ??= []).push({
          body: "Composer Kommentar",
          author: { name: "keiko-api" },
        });
      },
    });
    const check = await COMPOSER_JOURNEYS.C08(ctx, undefined);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("write a comment: red");
    expect(check.detail).toContain("another issue");
  });

  it("C09 is red when a write succeeded in the turn although no file reached Jira", async () => {
    const ctx = lane({
      act: () => ({
        answer: "Anhänge sind nicht Teil dieses Releases.",
        toolExchanges: [succeededEdit(undefined)],
      }),
    });
    const check = await COMPOSER_JOURNEYS.C09(ctx, undefined);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("writes succeeded");
  });

  it("C09 is green when nothing reaches Jira and the answer says so, red otherwise", async () => {
    const refusing = lane({ act: () => ({ answer: "Anhänge sind nicht Teil dieses Releases." }) });
    expect((await COMPOSER_JOURNEYS.C09(refusing, undefined)).status).toBe("green");
    const attaching = lane({
      act: ({ content, store }) =>
        void (store.attachments[/REQ-\d+/u.exec(content)[0]] = [{ filename: "bericht.pdf" }]),
    });
    expect((await COMPOSER_JOURNEYS.C09(attaching, undefined)).status).toBe("red");
  });

  it("holds no attachment case anywhere else in the lane", () => {
    for (const id of COMPOSER_JOURNEY_IDS.filter((entry) => entry !== "C09"))
      expect(COMPOSER_JOURNEYS[id].toString()).not.toMatch(/attachment|bericht\.pdf/u);
  });

  it("names the journeys that need a product without the baseline template set", () => {
    expect(COMPOSER_WITHOUT_BASELINE).toEqual(["C03", "C04"]);
  });
});
