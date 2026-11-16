import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gradeStoryBulk,
  runStoryBulk,
  selectStoryRequirements,
  storyBulkPlan,
  storyPrompt,
} from "../testing/jira-chat-lab/requirements/story-bulk.mjs";
import { STRUCTURE_RULES } from "../testing/jira-chat-lab/requirements/corpus.mjs";
import {
  STORY_STRUCTURE_RULE,
  storyTemplateMarkdown,
  subtaskTemplateMarkdown,
} from "../testing/jira-chat-lab/requirements/templates.mjs";

const PROJECT = "LIM9";
const EPIC_LINK = "customfield_10014";
const REQUIRED = {
  Story: ["summary", "project", "issuetype"],
  "Sub-task": ["summary", "project", "issuetype", "parent"],
};
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function requirements() {
  return Array.from({ length: 9 }, (_, index) => ({
    id: `REQ-FA-${String(index + 1).padStart(3, "0")}`,
    title: `Synthetic requirement ${index + 1}`,
    // Every third requirement has no criteria, so the selection must skip it.
    acceptanceCriteria:
      index % 3 === 2
        ? []
        : [`Criterion A of ${index + 1} is observable.`, `Criterion B of ${index + 1} holds.`],
    sectionPath: ["3 Functional requirements", `3.${index + 1} Synthetic section`],
    layout: { pdf: { firstPage: index + 2, lastPage: index + 2 } },
  }));
}

function epics(items) {
  return items.map((item, index) => ({
    id: String(10001 + index),
    key: `${PROJECT}-${index + 1}`,
    fields: {
      summary: `[${item.id}] ${item.title}`,
      issuetype: { name: "Epic" },
      project: { key: PROJECT },
    },
  }));
}

const sectionBody = (sections) =>
  sections.map((name) => `h3. ${name}\nSynthetic content.`).join("\n\n");

function storyDescription(requirement, { criteria = requirement.acceptanceCriteria } = {}) {
  return [
    "h3. Nutzerziel\nSynthetic goal.",
    "",
    "h3. Akzeptanzkriterien",
    ...criteria.map((criterion) => `* ${criterion}`),
    "",
    "h3. Definition of Done\nSynthetic done list.",
    "",
    "----",
    "Keiko traceability",
    `Requirement: ${requirement.id} · ${requirement.title}`,
    `Reference: ${requirement.id}@doc-1`,
    `Source: synthetic.pdf · ${requirement.sectionPath.join(" · ")}`,
    "End of Keiko traceability",
  ].join("\n");
}

let counter = 0;
function native(fields) {
  counter += 1;
  return {
    id: String(50000 + counter),
    key: `${PROJECT}-${500 + counter}`,
    fields: { project: { key: PROJECT }, labels: [], ...fields },
  };
}

/** The issues Jira would hold once the stages through `stage` completed correctly. */
function jiraIssues(plan, items, stage = "all") {
  const byId = new Map(items.map((item) => [item.id, item]));
  const stories = plan.stories.map((row) =>
    native({
      summary: row.summary,
      issuetype: { name: "Story" },
      description: storyDescription(byId.get(row.requirementId)),
      [EPIC_LINK]: row.epicKey,
    }),
  );
  if (stage === "stories") return stories;
  const subtasks = plan.subtasks.map((row, index) =>
    native({
      summary: row.summary,
      issuetype: { name: "Sub-task" },
      description: sectionBody(STRUCTURE_RULES.Task.sections),
      parent: { key: stories[index].key, fields: { issuetype: { name: "Story" } } },
    }),
  );
  return [...stories, ...subtasks];
}

function fixture() {
  const items = requirements();
  const plan = storyBulkPlan({ projectKey: PROJECT, requirements: items, epics: epics(items) });
  const grade = (issues, stage = "all") =>
    gradeStoryBulk({
      plan,
      issues,
      requirements: items,
      stage,
      epicLinkField: EPIC_LINK,
      requiredFieldsByType: REQUIRED,
    });
  return { items, plan, grade };
}

describe("the Story plan", () => {
  it("spreads three requirements that carry criteria over the manifest", () => {
    const { items, plan } = fixture();
    expect(plan.stories.map((row) => row.requirementId)).toEqual([
      "REQ-FA-001",
      "REQ-FA-004",
      "REQ-FA-007",
    ]);
    expect(plan.subtasks.map((row) => row.parentReference)).toEqual(
      plan.stories.map((row) => row.reference),
    );
    expect(plan.stories.map((row) => row.epicKey)).toEqual([
      `${PROJECT}-1`,
      `${PROJECT}-4`,
      `${PROJECT}-7`,
    ]);
    expect(plan.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(selectStoryRequirements(items, 3)).toHaveLength(3);
  });

  it("refuses a missing, ambiguous or non-Epic parent and too few candidates", () => {
    const items = requirements();
    const all = epics(items);
    const without = all.filter((epic) => !epic.fields.summary.startsWith("[REQ-FA-004]"));
    const twice = [...all, { ...all[3], id: "10999", key: `${PROJECT}-99` }];
    const wrongType = all.map((epic, index) =>
      index === 3 ? { ...epic, fields: { ...epic.fields, issuetype: { name: "Task" } } } : epic,
    );
    for (const list of [without, twice, wrongType])
      expect(() =>
        storyBulkPlan({ projectKey: PROJECT, requirements: items, epics: list }),
      ).toThrow(TypeError);
    expect(() => selectStoryRequirements(items.slice(0, 2), 3)).toThrow("story-requirements");
    expect(() => storyBulkPlan({ projectKey: "bad key", requirements: items, epics: all })).toThrow(
      TypeError,
    );
  });
});

describe("the native Story oracle", () => {
  it("accepts three Stories with their Sub-tasks, criteria verbatim and a trace", () => {
    const { items, plan, grade } = fixture();
    const result = grade(jiraIssues(plan, items));
    expect(result).toMatchObject({
      ok: true,
      counts: { stories: 3, subtasks: 3, missing: 0, duplicates: 0, unexpected: 0 },
    });
    expect(grade(jiraIssues(plan, items, "stories"), "stories").ok).toBe(true);
  });

  it.each([
    [
      "a Story that is a Task",
      (issues) => (issues[0].fields.issuetype = { name: "Task" }),
      "invalidType",
    ],
    [
      "a Story without its Epic link",
      (issues) => (issues[0].fields[EPIC_LINK] = undefined),
      "invalidEpic",
    ],
    [
      "a Story under another Epic",
      (issues) => (issues[0].fields[EPIC_LINK] = `${PROJECT}-2`),
      "invalidEpic",
    ],
    [
      "a Sub-task under another Story",
      (issues) => (issues[3].fields.parent.key = issues[1].key),
      "invalidParent",
    ],
    [
      "a Sub-task whose parent is a Task",
      (issues) => (issues[3].fields.parent.fields.issuetype.name = "Task"),
      "invalidParent",
    ],
    [
      "a Sub-task without a parent",
      (issues) => (issues[3].fields.parent = undefined),
      "invalidParent",
    ],
    [
      "a Story without the traceability footer",
      (issues) => (issues[0].fields.description = issues[0].fields.description.split("----")[0]),
      "invalidTrace",
    ],
    [
      "a Story that traces another requirement",
      (issues) =>
        (issues[0].fields.description = issues[0].fields.description.replaceAll(
          "REQ-FA-001",
          "REQ-FA-002",
        )),
      "invalidTrace",
    ],
    [
      "a Story that lost a criterion",
      (issues) =>
        (issues[0].fields.description = issues[0].fields.description.replace(
          "* Criterion B of 1 holds.\n",
          "",
        )),
      "invalidCriteria",
    ],
    [
      "a Story with a reworded criterion",
      (issues) =>
        (issues[0].fields.description = issues[0].fields.description.replace(
          "Criterion A of 1 is observable.",
          "Criterion A of 1 is mostly observable.",
        )),
      "invalidCriteria",
    ],
    [
      "a Story with an invented criterion",
      (issues) =>
        (issues[0].fields.description = issues[0].fields.description.replace(
          "\nh3. Definition of Done",
          "* Invented criterion.\n\nh3. Definition of Done",
        )),
      "invalidCriteria",
    ],
    [
      "a Story without its Definition of Done",
      (issues) =>
        (issues[0].fields.description = issues[0].fields.description.replace(
          "h3. Definition of Done",
          "h3. Something else",
        )),
      "invalidTemplate",
    ],
    [
      "a Sub-task without a Testhinweise section",
      (issues) =>
        (issues[3].fields.description = issues[3].fields.description.replace(
          "h3. Testhinweise",
          "h3. Other",
        )),
      "invalidTemplate",
    ],
    [
      "a Story with an empty required field",
      (issues) => (issues[0].fields.description = ""),
      "invalidRequired",
    ],
  ])("refuses %s", (_name, damage, counter) => {
    const { items, plan, grade } = fixture();
    const issues = jiraIssues(plan, items);
    damage(issues);
    const result = grade(issues);
    expect(result.ok).toBe(false);
    expect(result.counts[counter]).toBeGreaterThan(0);
  });

  it("refuses a missing Sub-task and a missing Story", () => {
    const { items, plan, grade } = fixture();
    const issues = jiraIssues(plan, items);
    expect(grade(issues.slice(0, 5)).counts.missing).toBe(1);
    expect(grade(issues.slice(1)).counts.missing).toBeGreaterThan(0);
  });

  it("refuses a duplicate Story, a repeated draft identity and a repeated key", () => {
    const { items, plan, grade } = fixture();
    const issues = jiraIssues(plan, items);
    const twin = native(structuredClone(issues[0].fields));
    expect(grade([...issues, twin]).counts.duplicates).toBe(1);
    const labelled = issues.map((issue) => structuredClone(issue));
    labelled[0].fields.labels = ["keiko-draft-0123456789abcdef0123"];
    labelled[1].fields.labels = ["keiko-draft-0123456789abcdef0123"];
    expect(grade(labelled).counts.duplicates).toBe(1);
    expect(grade([...issues, structuredClone(issues[2])]).counts.duplicates).toBeGreaterThan(0);
  });

  it("refuses a stray Story, a stray marker and a Sub-task before its stage", () => {
    const { items, plan, grade } = fixture();
    const issues = jiraIssues(plan, items);
    const stray = native({
      summary: "Unrelated story",
      issuetype: { name: "Story" },
      description: "text",
    });
    expect(grade([...issues, stray]).counts.unexpected).toBe(1);
    const marked = native({
      summary: "[REQ-FA-009] [ST-4] Fourth",
      issuetype: { name: "Story" },
      description: "text",
    });
    expect(grade([...issues, marked]).counts.unexpected).toBe(1);
    expect(grade(issues, "stories").counts.unexpected).toBe(3);
  });

  it("refuses an issue from another project and an invalid identity", () => {
    const { items, plan, grade } = fixture();
    const issues = jiraIssues(plan, items);
    issues[0].fields.project = { key: "OTHER" };
    issues[1].key = "bad";
    expect(grade(issues).counts.invalidIds).toBe(2);
    expect(() => grade("not a list")).toThrow(TypeError);
  });
});

describe("the Story templates", () => {
  it("define the sections of the Story and widen the Sub-task parent types", () => {
    const story = storyTemplateMarkdown(PROJECT, EPIC_LINK);
    expect(story).toContain('issueType: "Story"');
    expect(story).toContain(`parentField: "${EPIC_LINK}"`);
    for (const section of STORY_STRUCTURE_RULE.sections) expect(story).toContain(`## ${section}`);
    const both = subtaskTemplateMarkdown(PROJECT, ["Task", "Story"]);
    expect(both).toContain('parentIssueTypes: ["Task", "Story"]');
    expect(both).not.toBe(subtaskTemplateMarkdown(PROJECT, ["Task"]));
  });
});

describe("the Story prompts", () => {
  it("names every Story with its Epic, criteria, source and sections", () => {
    const { plan } = fixture();
    const prompt = storyPrompt(plan, "stories");
    const rows = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      requirementId: "REQ-FA-001",
      issueType: "Story",
      epicKey: `${PROJECT}-1`,
      descriptionSections: STORY_STRUCTURE_RULE.sections,
    });
    expect(rows[0].acceptanceCriteria).toEqual(plan.stories[0].acceptanceCriteria);
    expect(prompt).toContain("requirementIds");
  });

  it("names the observed Story key as the only parent of each Sub-task", () => {
    const { items, plan } = fixture();
    const issues = jiraIssues(plan, items, "stories");
    const byReference = new Map(plan.stories.map((row, index) => [row.reference, issues[index]]));
    const prompt = storyPrompt(plan, "all", byReference);
    const rows = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
    expect(rows.map((row) => row.parentStoryKey)).toEqual(issues.map((issue) => issue.key));
    expect(rows.every((row) => row.issueType === "Sub-task" && row.epicKey === undefined)).toBe(
      true,
    );
  });
});

function runContext(items, state = {}) {
  const sessionDir = mkdtempSync(join(tmpdir(), "story-bulk-"));
  directories.push(sessionDir);
  const issues = epics(items);
  const intent = {
    data: state,
    get state() {
      return structuredClone(this.data);
    },
    update: vi.fn(async function update(patch) {
      Object.assign(intent.data, patch);
    }),
    record: vi.fn(async (name, value) => {
      intent.data[name] = value;
    }),
  };
  const ctx = {
    sessionDir,
    projectKey: PROJECT,
    chat: { id: "document-chat" },
    signal: new globalThis.AbortController().signal,
    checkLicense: vi.fn(async () => 2700),
    truth: { fieldIds: { epicLink: EPIC_LINK }, requiredFieldsByType: REQUIRED },
    intent,
    search: vi.fn(async () => structuredClone(issues)),
    turn: vi.fn(),
  };
  return { ctx, issues };
}

/** A model that writes what the prompt asks, so the runner is graded against Jira, not the model. */
function writingModel(items, issues, plan, mutate = (value) => value) {
  return async (_chat, prompt) => {
    const rows = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const row of rows) {
      const requirement = byId.get(row.requirementId);
      issues.push(
        native({
          summary: row.summary,
          issuetype: { name: row.issueType },
          description:
            row.issueType === "Story"
              ? storyDescription(requirement)
              : sectionBody(STRUCTURE_RULES.Task.sections),
          ...(row.issueType === "Story"
            ? { [EPIC_LINK]: row.epicKey }
            : { parent: { key: row.parentStoryKey, fields: { issuetype: { name: "Story" } } } }),
        }),
      );
    }
    mutate(issues, plan);
    return { toolExchanges: [] };
  };
}

const ports = (items) => ({
  manifest: { requirementCount: items.length, requirements: items },
  ensureTemplates: vi.fn(async () => ({ templatesInstalled: 1, templatesReplaced: 1 })),
});

describe("the Story step", () => {
  it("creates Stories and then Sub-tasks in two turns and is green on the native oracle", async () => {
    const items = requirements();
    const { ctx, issues } = runContext(items);
    const plan = storyBulkPlan({ projectKey: PROJECT, requirements: items, epics: epics(items) });
    ctx.turn.mockImplementation(writingModel(items, issues, plan));
    const outcome = await runStoryBulk(ctx, ports(items));
    expect(outcome).toMatchObject({
      step: "ac4-story-bulk",
      status: "green",
      counts: { stories: 3, subtasks: 3, templatesInstalled: 1, templatesReplaced: 1 },
    });
    expect(ctx.turn).toHaveBeenCalledTimes(2);
    expect(ctx.intent.data.storyBulk.phase).toBe("complete");
  });

  it("is red when the model writes a Story under the wrong Epic", async () => {
    const items = requirements();
    const { ctx, issues } = runContext(items);
    const plan = storyBulkPlan({ projectKey: PROJECT, requirements: items, epics: epics(items) });
    ctx.turn.mockImplementation(
      writingModel(items, issues, plan, (all) => {
        const story = all.find((issue) => issue.fields.issuetype.name === "Story");
        if (story !== undefined) story.fields[EPIC_LINK] = `${PROJECT}-9`;
      }),
    );
    const outcome = await runStoryBulk(ctx, ports(items));
    expect(outcome.status).toBe("red");
    expect(outcome.counts.invalidEpic).toBeGreaterThan(0);
    expect(ctx.turn).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a turn when the Stories already exist and are valid", async () => {
    const items = requirements();
    const { ctx, issues } = runContext(items);
    const plan = storyBulkPlan({ projectKey: PROJECT, requirements: items, epics: epics(items) });
    issues.push(...jiraIssues(plan, items, "stories"));
    ctx.turn.mockImplementation(writingModel(items, issues, plan));
    const outcome = await runStoryBulk(ctx, ports(items));
    expect(outcome.status).toBe("green");
    expect(ctx.turn).toHaveBeenCalledTimes(1);
    expect(ctx.turn.mock.calls[0][1]).toContain("parentStoryKey");
  });

  it("never replays a write whose outcome is partial or unknown", async () => {
    const items = requirements();
    const { ctx, issues } = runContext(items);
    const plan = storyBulkPlan({ projectKey: PROJECT, requirements: items, epics: epics(items) });
    issues.push(...jiraIssues(plan, items, "stories").slice(0, 1));
    const partial = await runStoryBulk(ctx, ports(items));
    expect(partial).toMatchObject({ status: "unverified" });
    expect(partial.detail).toContain("unreconciled-stories");
    expect(ctx.turn).not.toHaveBeenCalled();
    const second = runContext(items, {
      storyBulk: { phase: "writing", stage: "stories", digest: plan.digest },
    });
    const pending = await runStoryBulk(second.ctx, ports(items));
    expect(pending.status).toBe("unverified");
    expect(second.ctx.turn).not.toHaveBeenCalled();
  });

  it("refuses to resume under a checkpoint of another plan", async () => {
    const items = requirements();
    const { ctx } = runContext(items, {
      storyBulk: { phase: "ready", stage: "stories", digest: "0".repeat(64) },
    });
    const outcome = await runStoryBulk(ctx, ports(items));
    expect(outcome.status).toBe("unverified");
    expect(outcome.detail).toContain("story-checkpoint-mismatch");
    expect(ctx.turn).not.toHaveBeenCalled();
  });

  it("is unverified without Story metadata, without a context or when templates fail", async () => {
    const items = requirements();
    const first = runContext(items);
    first.ctx.truth = { fieldIds: { epicLink: EPIC_LINK }, requiredFieldsByType: {} };
    expect((await runStoryBulk(first.ctx, ports(items))).detail).toContain(
      "create-metadata-unavailable",
    );
    expect((await runStoryBulk({}, ports(items))).detail).toContain("context-unavailable");
    const failing = runContext(items);
    const failedPorts = {
      ...ports(items),
      ensureTemplates: vi.fn(async () => {
        throw new TypeError("subtask-template-unexpected");
      }),
    };
    const outcome = await runStoryBulk(failing.ctx, failedPorts);
    expect(outcome.status).toBe("unverified");
    expect(outcome.detail).toContain("subtask-template-unexpected");
    expect(failing.ctx.turn).not.toHaveBeenCalled();
  });
});
