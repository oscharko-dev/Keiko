// The Composer lane (#4369): graders and journeys in both directions, through the real entry points,
// over an in-memory Jira and a stub model. No live Jira, no model, no Knowledge Pod.
import { describe, expect, it, vi } from "vitest";
import {
  COMPOSER_JOURNEYS,
  COMPOSER_JOURNEY_IDS,
  COMPOSER_MODES,
  gradeComposerCreate,
  gradeComposerRefusal,
  gradeEditRefused,
  gradeNoTemplate,
  gradeComposerRerun,
} from "../testing/jira-chat-lab/requirements/composer.mjs";
import { COMPOSER_SCENARIOS } from "../testing/jira-chat-lab/requirements/composer-catalog.mjs";
import {
  COMPOSER_TYPES,
  composerConformity,
  composerTemplates,
  createPrompt,
  typeSlug,
  violationPrompt,
} from "../testing/jira-chat-lab/requirements/composer-templates.mjs";
import { SCENARIOS } from "../testing/jira-chat-lab/requirements/catalog.mjs";
import { scenarioVerdict } from "../testing/jira-chat-lab/requirements/coverage.mjs";
import { JOURNEYS } from "../testing/jira-chat-lab/requirements/journey-checks.mjs";
import { modesAndReadableApproval } from "../testing/jira-chat-lab/requirements/modes.mjs";
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
  it("adds C01-C07 beside S01-S20 and leaves those untouched", () => {
    expect(COMPOSER_SCENARIOS.map((entry) => entry.id)).toEqual([
      "C01",
      "C02",
      "C03",
      "C04",
      "C05",
      "C06",
      "C07",
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

  it("is green only when a journey covers every obligation", () => {
    const scenario = COMPOSER_SCENARIOS.find((entry) => entry.id === "C01");
    const covers = COMPOSER_TYPES.map((type) => `create-conformant-${typeSlug(type)}`);
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

describe("obligation a) creation", () => {
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

describe("obligation b) refusal before any card or effect", () => {
  const grade = (type, exchanges, issues) =>
    gradeComposerRefusal({
      exchanges,
      issues,
      template: `REQ/${type}`,
      conforms: composerConformity(type, { epicLink: LINK }),
    });

  it.each(COMPOSER_TYPES)("%s: refused without card, then corrected: green", (type) => {
    const result = grade(type, [refusal(type), success("REQ-5")], [conformant("REQ-5", type)]);
    expect(result.status).toBe("green");
  });

  it("is red when a card was shown for the refused write", () => {
    const card = { approval: { state: "pending", approvalId: "a1" } };
    const result = grade(
      "Task",
      [refusal("Task", card), success("REQ-5")],
      [conformant("REQ-5", "Task")],
    );
    expect(result.status).toBe("red");
    expect(result.detail).toContain("a card was shown for a refused write");
  });

  it("is red when the refusal carries a receipt, so the effect had happened", () => {
    const withReceipt = refusal("Task", {}, { issueKey: "REQ-4" });
    expect(
      grade("Task", [withReceipt, success("REQ-5")], [conformant("REQ-5", "Task")]).status,
    ).toBe("red");
  });

  it("is red when the corrected issue still violates the template", () => {
    const bad = conformant("REQ-5", "Task");
    bad.fields.description = "Kurzer Test.";
    expect(grade("Task", [refusal("Task"), success("REQ-5")], [bad]).status).toBe("red");
  });

  it("is red when no corrected issue followed the refusal", () => {
    expect(grade("Task", [refusal("Task")], []).status).toBe("red");
  });

  it("is unverified, crediting nothing, when no refusal happened", () => {
    expect(grade("Task", [success("REQ-5")], [conformant("REQ-5", "Task")]).status).toBe(
      "unverified",
    );
  });

  it("does not credit another template's refusal", () => {
    expect(
      grade("Task", [refusal("Bug"), success("REQ-5")], [conformant("REQ-5", "Task")]).status,
    ).toBe("unverified");
  });
});

describe("obligation c) no template for the type", () => {
  const issues = (count) =>
    turnOf(Array.from({ length: count }, (_, i) => conformant(`REQ-${i + 5}`, "Task")));

  it("is green only when nothing was written and the answer says to create a template", () => {
    expect(
      gradeNoTemplate({
        issues: issues(0),
        answer: "Dafür gibt es keine Vorlage. Bitte lege eine Vorlage an.",
      }).status,
    ).toBe("green");
  });

  it("is red when the write passed unchecked (today's product)", () => {
    const result = gradeNoTemplate({ issues: issues(1), answer: "Angelegt: REQ-5" });
    expect(result.status).toBe("red");
    expect(result.detail).toContain("although no template governs");
  });

  it("is red, not invalid, when the refusal gives no hint to create a template", () => {
    for (const answer of ["Das war nicht möglich.", "", undefined, "Es gibt eine Vorlage"])
      expect(gradeNoTemplate({ issues: issues(0), answer }).status).toBe("red");
  });
});

describe("obligation d) an edit that breaks conformance", () => {
  const conforms = composerConformity("Task", { epicLink: LINK });
  const good = conformant("REQ-2", "Task");
  const broken = { ...good, fields: { ...good.fields, description: "" } };

  it("is green when the issue is still conformant after an attempted edit", () => {
    expect(gradeEditRefused({ before: good, after: good, attempted: true, conforms }).status).toBe(
      "green",
    );
  });

  it("is red when the edit was applied", () => {
    expect(
      gradeEditRefused({ before: good, after: broken, attempted: true, conforms }).status,
    ).toBe("red");
    const orphan = { ...good, fields: { ...good.fields, [LINK]: null } };
    expect(
      gradeEditRefused({ before: good, after: orphan, attempted: true, conforms }).status,
    ).toBe("red");
  });

  it("is unverified when no edit was attempted or the fixture was not conformant", () => {
    expect(gradeEditRefused({ before: good, after: good, attempted: false, conforms }).status).toBe(
      "unverified",
    );
    expect(
      gradeEditRefused({ before: broken, after: broken, attempted: true, conforms }).status,
    ).toBe("unverified");
  });
});

describe("obligation e) re-run", () => {
  const title = "Composer Wiederholung";
  const epic = (key) => conformant(key, "Epic", title);
  const grade = ({ first, after, second }) =>
    gradeComposerRerun({ title, afterSecond: after, first: turnOf(first), second: turnOf(second) });

  it("is green when the second run created nothing and one issue holds the title", () => {
    expect(grade({ first: [epic("REQ-5")], after: [epic("REQ-5")], second: [] }).status).toBe(
      "green",
    );
  });

  it("is red when the title exists twice or the second run created an issue", () => {
    expect(
      grade({
        first: [epic("REQ-5")],
        after: [epic("REQ-5"), epic("REQ-6")],
        second: [epic("REQ-6")],
      }).status,
    ).toBe("red");
  });

  it("is unverified when the first run wrote nothing", () => {
    expect(grade({ first: [], after: [], second: [] }).status).toBe("unverified");
  });
});

// ---------- journeys through the real entry points ----------

/** An in-memory Jira, a template library and a stub model; `act` plays the model's effects. */
function lane({ act, templates = [] } = {}) {
  const issues = [];
  let counter = 0;
  const calls = { turns: [], fresh: [], http: [] };
  const ctx = {
    calls,
    issues,
    truth: {
      fieldIds: { epicName: "customfield_10105", epicLink: LINK, storyPoints: "customfield_10111" },
    },
    nativeCreate: async (fields) => {
      counter += 1;
      const key = `REQ-${counter}`;
      issues.push({ key, fields: { ...fields, issuetype: { name: fields.issuetype.name } } });
      return key;
    },
    search: async (query) => {
      const type = /issuetype = "?([\w-]+)"?/.exec(query)?.[1];
      const key = /key = ([\w-]+)/.exec(query)?.[1];
      // Jira answers with a fresh copy on every read, so a stored `before` never follows the edit.
      return structuredClone(
        issues.filter(
          (entry) =>
            (key === undefined || entry.key === key) &&
            (type === undefined || entry.fields.issuetype.name === type),
        ),
      );
    },
    http: async (name, _path, body) => {
      calls.http.push(name);
      if (name === "template-import")
        return { skill: { id: `s${calls.http.length}`, revision: 1, digest: "d" } };
      if (name === "template-list") return { templates };
      return {};
    },
    freshChat: async (mode) => {
      calls.fresh.push(mode);
      return { id: `chat-${calls.fresh.length}`, mode };
    },
    turn: async (chat, content, options) => {
      calls.turns.push({ chat, content });
      const played = (await act({ chat, content, options, ctx, add })) ?? {};
      return {
        answer: played.answer ?? "",
        toolExchanges: played.toolExchanges ?? [],
        failure: undefined,
        durationMs: 1000,
        toolCalls: (played.toolExchanges ?? []).length,
        approvals: { writes: played.writes ?? 0, records: played.records ?? [] },
      };
    },
  };
  const add = (type, extra = {}, summary) => {
    counter += 1;
    const issue = conformant(`REQ-${counter}`, type, summary);
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

describe("C01 creates every type", () => {
  it("is green when each plain instruction creates a conformant issue, and red when one does not", async () => {
    const good = lane({ act: ({ content, add }) => void add(typeOfPrompt(content)) });
    const check = await COMPOSER_JOURNEYS.C01(good, undefined);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual(
      COMPOSER_TYPES.map((type) => `create-conformant-${typeSlug(type)}`),
    );
    expect(good.calls.fresh.every((mode) => mode === "autonomous-delivery")).toBe(true);
    // The five templates were imported and removed again around the turns.
    expect(good.calls.http.filter((name) => name === "template-import")).toHaveLength(5);
    expect(good.calls.http.filter((name) => name === "template-delete")).toHaveLength(5);

    const bad = lane({
      act: ({ content, add }) =>
        void add(
          typeOfPrompt(content),
          typeOfPrompt(content) === "Story" ? { description: "kurz" } : {},
        ),
    });
    const red = await COMPOSER_JOURNEYS.C01(bad, undefined);
    expect(red.status).toBe("red");
    expect(red.detail).toContain("create Story: red");
  });
});

describe("C02 refuses violations in every mode", () => {
  it("runs 15 requests, each in a fresh Chat of its own mode", async () => {
    const ctx = lane({
      act: ({ content, add }) => {
        const type = typeOfPrompt(content);
        const issue = add(type);
        return { toolExchanges: [refusal(type), success(issue.key)] };
      },
    });
    const check = await COMPOSER_JOURNEYS.C02(ctx, undefined);
    expect(check.status).toBe("green");
    expect(ctx.calls.fresh).toHaveLength(COMPOSER_TYPES.length * COMPOSER_MODES.length);
    expect(new Set(ctx.calls.fresh)).toEqual(new Set(COMPOSER_MODES.map((entry) => entry.mode)));
    expect(check.covers).toHaveLength(15);
  });

  it("is red when one mode shows a card for the refused write", async () => {
    const ctx = lane({
      act: ({ chat, content, add }) => {
        const type = typeOfPrompt(content);
        const issue = add(type);
        const card =
          chat.mode === "governed-assist"
            ? { approval: { state: "pending", approvalId: "a" } }
            : {};
        return { toolExchanges: [refusal(type, card), success(issue.key)] };
      },
    });
    const check = await COMPOSER_JOURNEYS.C02(ctx, undefined);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("a card was shown");
  });

  it("is unverified when the gate never refused anything", async () => {
    const ctx = lane({
      act: ({ content, add }) => ({ toolExchanges: [success(add(typeOfPrompt(content)).key)] }),
    });
    expect((await COMPOSER_JOURNEYS.C02(ctx, undefined)).status).toBe("unverified");
  });
});

describe("C03 without a template", () => {
  it("is red on a product that writes unchecked, green on one that refuses with the hint", async () => {
    const unchecked = lane({ act: ({ content, add }) => void add(typeOfPrompt(content)) });
    const red = await COMPOSER_JOURNEYS.C03(unchecked, undefined);
    expect(red.status).toBe("red");
    expect(unchecked.calls.http).not.toContain("template-import");

    const refusing = lane({
      act: () => ({ answer: "Für diesen Typ gibt es keine Vorlage. Lege zuerst eine Vorlage an." }),
    });
    const green = await COMPOSER_JOURNEYS.C03(refusing, undefined);
    expect(green.status).toBe("green");
    expect(green.covers).toHaveLength(COMPOSER_TYPES.length);
  });

  it("is unverified when a template already governs the project: the precondition fails", async () => {
    const ctx = lane({
      act: () => ({}),
      templates: [{ id: "x", project: "REQ", issueType: "Task" }],
    });
    const check = await COMPOSER_JOURNEYS.C03(ctx, undefined);
    expect(check.status).toBe("unverified");
    expect(check.covers).toEqual([]);
    expect(ctx.calls.turns).toHaveLength(0);
  });
});

describe("C04 breaking edits", () => {
  const editExchange = {
    call: { id: "e", name: "jira_edit", arguments: {} },
    result: {
      toolRef: { canonicalId: "keiko.jira.edit", contractVersion: 3 },
      status: "failed",
      data: { outcome: "rejected" },
    },
  };

  it("is red on a product that applies the edit and green on one that refuses it", async () => {
    const applying = lane({
      act: ({ content, ctx }) => {
        const key = /REQ-\d+/u.exec(content)[0];
        const issue = ctx.issues.find((entry) => entry.key === key);
        if (/Beschreibung/u.test(content)) issue.fields.description = "";
        else issue.fields[LINK] = null;
        return { toolExchanges: [editExchange] };
      },
    });
    const red = await COMPOSER_JOURNEYS.C04(applying, undefined);
    expect(red.status).toBe("red");
    expect(applying.calls.http.filter((name) => name === "template-import")).toHaveLength(5);

    const refusing = lane({ act: () => ({ toolExchanges: [editExchange] }) });
    const green = await COMPOSER_JOURNEYS.C04(refusing, undefined);
    expect(green.status).toBe("green");
    expect(green.covers).toEqual(["edit-clear-required-refused", "edit-parent-refused"]);
  });

  it("is unverified when the model never tried an edit", async () => {
    const idle = lane({ act: () => ({}) });
    expect((await COMPOSER_JOURNEYS.C04(idle, undefined)).status).toBe("unverified");
  });
});

describe("C05 re-run", () => {
  it("is green when the second Chat reconciles and red when it duplicates", async () => {
    const reconciling = lane({
      act: ({ add, ctx }) => {
        if (
          !ctx.issues.some(
            (entry) =>
              entry.fields.summary === "Composer Wiederholung" &&
              entry.fields.issuetype.name === "Epic" &&
              entry.key !== "REQ-1",
          )
        )
          add("Epic", {}, "Composer Wiederholung");
      },
    });
    expect((await COMPOSER_JOURNEYS.C05(reconciling, undefined)).status).toBe("green");
    const duplicating = lane({ act: ({ add }) => void add("Epic", {}, "Composer Wiederholung") });
    expect((await COMPOSER_JOURNEYS.C05(duplicating, undefined)).status).toBe("red");
  });
});

describe("C06 modes and C07 reports reuse the document lane's graders", () => {
  it("passes a plain request, never a requirement, to the three mode runs", async () => {
    const prompts = [];
    const ctx = lane({
      act: ({ content, add, options }) => {
        prompts.push(content);
        return { writes: 0, toolExchanges: [] };
      },
    });
    ctx.search = async () => [];
    await modesAndReadableApproval(ctx, {
      promptFor: (run) => createPrompt("Epic", `Modus ${run.label}`, FIXTURE),
    });
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) expect(prompt).not.toMatch(/Lastenheft|LH-/u);
    // Without the option the document lane's wording is unchanged.
    prompts.length = 0;
    await modesAndReadableApproval(ctx);
    expect(prompts.every((prompt) => /Lastenheft/u.test(prompt))).toBe(true);
  });

  it("C06 runs the three modes with the Epic template active", async () => {
    const ctx = lane({ act: () => ({}) });
    ctx.search = async () => [];
    await COMPOSER_JOURNEYS.C06(ctx, undefined);
    expect(ctx.calls.fresh).toEqual(COMPOSER_MODES.map((entry) => entry.mode));
    expect(ctx.calls.http.filter((name) => name === "template-import")).toHaveLength(1);
  });

  it("C07 runs S10 and S11 unchanged, each in a fresh Chat", async () => {
    const s10 = vi
      .spyOn(JOURNEYS, "S10")
      .mockResolvedValue({ status: "green", covers: ["counts-by-type-status"], detail: "ok" });
    const s11 = vi
      .spyOn(JOURNEYS, "S11")
      .mockResolvedValue({ status: "green", covers: ["deviating-issues"], detail: "ok" });
    const ctx = lane({ act: () => ({}) });
    const check = await COMPOSER_JOURNEYS.C07(ctx, undefined);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual(["counts-by-type-status", "deviating-issues"]);
    expect(s10).toHaveBeenCalledOnce();
    expect(s11).toHaveBeenCalledOnce();
    expect(ctx.calls.fresh).toHaveLength(2);
    s11.mockResolvedValue({ status: "red", covers: [], detail: "bad" });
    expect((await COMPOSER_JOURNEYS.C07(ctx, undefined)).status).toBe("red");
    vi.restoreAllMocks();
  });
});
