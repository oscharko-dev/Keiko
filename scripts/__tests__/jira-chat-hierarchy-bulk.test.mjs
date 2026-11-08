import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gradeHierarchyBulk,
  hierarchyBulkPlan,
  runHierarchyBulk,
} from "../testing/jira-chat-lab/requirements/hierarchy-bulk.mjs";

const PROJECT = "LIM7";
const EPIC_LINK = "customfield_10014";
const REQUIRED = {
  Task: ["summary", "project", "issuetype", "customfield_10006"],
  Bug: ["summary", "project", "issuetype", "priority"],
  "Sub-task": ["summary", "project", "issuetype", "parent"],
};
const TASK_SECTIONS = ["Umsetzungsschritte", "Definition of Done", "Testhinweise"];
const BUG_SECTIONS = ["Erwartet", "Tatsächlich", "Reproduktionsschritte", "Umgebung"];
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function requirements(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `REQ-FA-${String(index + 1).padStart(3, "0")}`,
    title: `Synthetic requirement ${index + 1}`,
    acceptanceCriteria: ["Synthetic acceptance criterion."],
    sectionPath: ["3 Functional requirements", `3.${index + 1} Synthetic section`],
    layout: { pdf: { firstPage: index + 2, lastPage: index + 2 } },
  }));
}

function epics(items, projectKey = PROJECT) {
  return items.map((item, index) => ({
    id: String(10001 + index),
    key: `${projectKey}-${index + 1}`,
    fields: {
      summary: `[${item.id}] ${item.title}`,
      issuetype: { name: "Epic" },
      project: { key: projectKey },
      labels: [],
    },
  }));
}

function description(sections) {
  return sections.map((section) => `h2. ${section}\nSynthetic implementation detail.`).join("\n\n");
}

function childIssue(number, requirementNumber, suffix, type, parentKey, relatesKey) {
  const id = `REQ-FA-${String(requirementNumber).padStart(3, "0")}`;
  return {
    id: String(20000 + number),
    key: `${PROJECT}-${number}`,
    fields: {
      summary: `[${id}] [HB-${suffix}] Synthetic child`,
      description: description(type === "Bug" ? BUG_SECTIONS : TASK_SECTIONS),
      issuetype: { name: type },
      project: { key: PROJECT },
      labels: [],
      customfield_10006: 0,
      ...(type === "Sub-task" ? { parent: { key: parentKey } } : { [EPIC_LINK]: parentKey }),
      ...(type === "Bug"
        ? {
            priority: { name: "Medium" },
            issuelinks: [{ type: { name: "Relates" }, outwardIssue: { key: relatesKey } }],
          }
        : {}),
    },
  };
}

// The eight-Epic graph is specified separately from the planner, including both fifth-Task parents.
function nativeFixture() {
  const items = requirements(8);
  const nativeEpics = epics(items);
  const tasks = [
    [1, "T1"],
    [2, "T1"],
    [3, "T1"],
    [3, "T2"],
    [4, "T1"],
    [5, "T1"],
    [6, "T1"],
    [6, "T2"],
    [7, "T1"],
    [8, "T1"],
  ].map(([requirement, suffix], index) =>
    childIssue(1001 + index, requirement, suffix, "Task", `${PROJECT}-${requirement}`),
  );
  const issues = [
    ...nativeEpics,
    ...tasks,
    childIssue(1011, 8, "B1", "Bug", "LIM7-8", "LIM7-1010"),
    childIssue(1012, 4, "T1-S1", "Sub-task", "LIM7-1005"),
    childIssue(1013, 8, "T1-S1", "Sub-task", "LIM7-1010"),
  ];
  const plan = hierarchyBulkPlan({ projectKey: PROJECT, requirements: items, epics: nativeEpics });
  return { plan, issues };
}

function grade(fixture) {
  return gradeHierarchyBulk({
    ...fixture,
    epicLinkField: EPIC_LINK,
    requiredFieldsByType: REQUIRED,
  });
}

describe("hierarchyBulkPlan", () => {
  it("pins 370 Epics, 493 Tasks, 46 Bugs and 98 Sub-tasks to 1007 issues", () => {
    const items = requirements(370);
    const plan = hierarchyBulkPlan({
      projectKey: PROJECT,
      requirements: items,
      epics: epics(items),
    });
    expect(plan.epics).toHaveLength(370);
    expect(plan.children.filter((row) => row.type === "Task")).toHaveLength(493);
    expect(plan.children.filter((row) => row.type === "Bug")).toHaveLength(46);
    const subtasks = plan.children.filter((row) => row.type === "Sub-task");
    expect(subtasks).toHaveLength(98);
    expect(plan.epics.length + plan.children.length).toBe(1007);
    expect(subtasks[0].parentReference).toBe("REQ-FA-004/T1");
    expect(subtasks[1].parentReference).toBe("REQ-FA-008/T1");
    expect(subtasks.at(-1).parentReference).toBe("REQ-FA-368/T1");
    expect(plan.children.filter((row) => row.type === "Bug").at(-1).requirementId).toBe(
      "REQ-FA-368",
    );
  });

  it("uses manifest order and exactly the independently enumerated eight-Epic rhythm", () => {
    const { plan } = nativeFixture();
    expect(plan.children.map((row) => row.reference)).toEqual([
      "REQ-FA-001/T1",
      "REQ-FA-002/T1",
      "REQ-FA-003/T1",
      "REQ-FA-003/T2",
      "REQ-FA-004/T1",
      "REQ-FA-005/T1",
      "REQ-FA-006/T1",
      "REQ-FA-006/T2",
      "REQ-FA-007/T1",
      "REQ-FA-008/T1",
      "REQ-FA-008/B1",
      "REQ-FA-004/T1-S1",
      "REQ-FA-008/T1-S1",
    ]);
  });

  it("is deterministic across native page ordering and keeps inputs unchanged", () => {
    const items = requirements(8);
    const observed = epics(items);
    const before = JSON.stringify({ items, observed });
    const first = hierarchyBulkPlan({ projectKey: PROJECT, requirements: items, epics: observed });
    const second = hierarchyBulkPlan({
      projectKey: PROJECT,
      requirements: items,
      epics: [...observed].reverse(),
    });
    expect(second).toEqual(first);
    expect(JSON.stringify({ items, observed })).toBe(before);
    expect(first.epics.every((epic) => epic.key.startsWith("LIM7-"))).toBe(true);
    expect(first.children.every((row) => row.epicKey.startsWith("LIM7-"))).toBe(true);
  });

  it("preserves dotted and underscored identifiers from the actual Golden manifest grammar", () => {
    const items = requirements(2);
    items[0].id = "ABN-45.6";
    items[1].id = "NFA_SEC-001";
    const plan = hierarchyBulkPlan({
      projectKey: PROJECT,
      requirements: items,
      epics: epics(items),
    });
    expect(plan.children.map((row) => row.reference)).toEqual(["ABN-45.6/T1", "NFA_SEC-001/T1"]);
  });

  it.each(["REQ OR project = OTHER", "../REQ", "x", ""])(
    "refuses unsafe runtime project %s",
    (projectKey) => {
      const items = requirements(1);
      expect(() =>
        hierarchyBulkPlan({ projectKey, requirements: items, epics: epics(items) }),
      ).toThrow(TypeError);
    },
  );

  it("refuses missing, duplicated, foreign, ID-less and wrongly typed Epics", () => {
    const items = requirements(2);
    const observed = epics(items);
    const variants = [
      observed.slice(0, 1),
      [observed[0], observed[0]],
      [observed[0], { ...observed[1], key: "FOREIGN-2" }],
      [observed[0], { ...observed[1], id: undefined }],
      [
        observed[0],
        { ...observed[1], fields: { ...observed[1].fields, issuetype: { name: "Task" } } },
      ],
    ];
    for (const native of variants)
      expect(() =>
        hierarchyBulkPlan({ projectKey: PROJECT, requirements: items, epics: native }),
      ).toThrow(TypeError);
    expect(() =>
      hierarchyBulkPlan({
        projectKey: PROJECT,
        requirements: [items[0], items[0]],
        epics: observed,
      }),
    ).toThrow(TypeError);
  });
});

describe("gradeHierarchyBulk", () => {
  it("accepts the full independent native graph, including required numeric zero", () => {
    const actual = grade(nativeFixture());
    expect(actual.ok).toBe(true);
    expect(actual.counts).toMatchObject({
      epics: 8,
      tasks: 10,
      bugs: 1,
      subtasks: 2,
      missing: 0,
      duplicates: 0,
    });
  });

  it.each([
    [
      "Task assigned to a sibling Epic",
      8,
      (issue) => {
        issue.fields[EPIC_LINK] = "LIM7-2";
      },
      "invalidParents",
    ],
    [
      "Sub-task directly under Epic",
      19,
      (issue) => {
        issue.fields.parent.key = "LIM7-4";
      },
      "invalidParents",
    ],
    [
      "Sub-task under a Task of another Epic",
      20,
      (issue) => {
        issue.fields.parent.key = "LIM7-1005";
      },
      "invalidParents",
    ],
    [
      "Bug linked to a different Task",
      18,
      (issue) => {
        issue.fields.issuelinks[0].outwardIssue.key = "LIM7-1009";
      },
      "invalidLinks",
    ],
    [
      "Bug with no priority",
      18,
      (issue) => {
        delete issue.fields.priority;
      },
      "invalidRequired",
    ],
    [
      "missing Task section",
      8,
      (issue) => {
        issue.fields.description = "h2. Umsetzungsschritte\nSynthetic text";
      },
      "invalidStructure",
    ],
    [
      "wrong native issue type",
      8,
      (issue) => {
        issue.fields.issuetype.name = "Bug";
      },
      "invalidRequired",
    ],
    [
      "blank metadata-required field",
      8,
      (issue) => {
        issue.fields.customfield_10006 = " ";
      },
      "invalidRequired",
    ],
    [
      "ID-less native issue",
      8,
      (issue) => {
        delete issue.id;
      },
      "invalidIds",
    ],
    [
      "unsafe numeric ID",
      8,
      (issue) => {
        issue.id = 20001;
      },
      "invalidIds",
    ],
    [
      "foreign project key",
      8,
      (issue) => {
        issue.key = "OTHER-1001";
      },
      "invalidIds",
    ],
    [
      "native project differs from the runtime project",
      8,
      (issue) => {
        issue.fields.project.key = "OTHER";
      },
      "invalidIds",
    ],
    [
      "changed Epic identity",
      0,
      (issue) => {
        issue.id = "90000";
      },
      "invalidEpics",
    ],
  ])("refuses %s", (_name, index, mutate, counter) => {
    const fixture = nativeFixture();
    mutate(fixture.issues[index]);
    const actual = grade(fixture);
    expect(actual.ok).toBe(false);
    expect(actual.counts[counter]).toBeGreaterThan(0);
  });

  it("requires the exact planned Task even when another Task belongs to the same Epic", () => {
    const items = requirements(15);
    const nativeEpics = epics(items);
    const tasks = [
      [1, "T1"],
      [2, "T1"],
      [3, "T1"],
      [3, "T2"],
      [4, "T1"],
      [5, "T1"],
      [6, "T1"],
      [6, "T2"],
      [7, "T1"],
      [8, "T1"],
      [9, "T1"],
      [9, "T2"],
      [10, "T1"],
      [11, "T1"],
      [12, "T1"],
      [12, "T2"],
      [13, "T1"],
      [14, "T1"],
      [15, "T1"],
      [15, "T2"],
    ].map(([requirement, suffix], index) =>
      childIssue(1001 + index, requirement, suffix, "Task", `LIM7-${requirement}`),
    );
    const fixture = {
      plan: hierarchyBulkPlan({ projectKey: PROJECT, requirements: items, epics: nativeEpics }),
      issues: [
        ...nativeEpics,
        ...tasks,
        childIssue(2001, 8, "B1", "Bug", "LIM7-8", "LIM7-1010"),
        childIssue(2002, 4, "T1-S1", "Sub-task", "LIM7-1005"),
        childIssue(2003, 8, "T1-S1", "Sub-task", "LIM7-1010"),
        childIssue(2004, 12, "T1-S1", "Sub-task", "LIM7-1015"),
        childIssue(2005, 15, "T2-S1", "Sub-task", "LIM7-1020"),
      ],
    };
    expect(grade(fixture).ok).toBe(true);
    expect(tasks.at(-2).fields[EPIC_LINK]).toBe("LIM7-15");
    expect(tasks.at(-1).fields[EPIC_LINK]).toBe("LIM7-15");
    fixture.issues.at(-1).fields.parent.key = "LIM7-1019";
    expect(grade(fixture).ok).toBe(false);
    expect(grade(fixture).counts.invalidParents).toBe(1);
  });

  it("detects missing, repeated and invented child identities independently of totals", () => {
    const missing = nativeFixture();
    missing.issues.splice(8, 1);
    expect(grade(missing).counts.missing).toBe(1);
    const duplicate = nativeFixture();
    duplicate.issues.push({ ...duplicate.issues[8], id: "90001", key: "LIM7-9001" });
    expect(grade(duplicate).counts.duplicates).toBe(1);
    const invented = nativeFixture();
    invented.issues[8].fields.summary = "[REQ-FA-999] [HB-T1] Invented";
    expect(grade(invented).counts).toMatchObject({ missing: 1, unexpected: 1 });
    expect([missing, duplicate, invented].every((fixture) => !grade(fixture).ok)).toBe(true);
  });

  it("detects repeated native IDs, keys and deterministic draft identities", () => {
    for (const field of ["id", "key", "draftIdentity"]) {
      const fixture = nativeFixture();
      if (field === "draftIdentity") {
        fixture.issues[8].fields.labels = ["keiko-draft-1234567890abcdef1234"];
        fixture.issues[9].fields.labels = ["keiko-draft-1234567890abcdef1234"];
      } else fixture.issues[9][field] = fixture.issues[8][field];
      expect(grade(fixture).ok).toBe(false);
      expect(grade(fixture).counts.duplicates).toBeGreaterThan(0);
    }
  });

  it("accepts required false and refuses unknown required-field coverage", () => {
    const fixture = nativeFixture();
    fixture.issues[8].fields.customfield_10006 = false;
    expect(grade(fixture).ok).toBe(true);
    expect(gradeHierarchyBulk({ ...fixture, epicLinkField: EPIC_LINK }).ok).toBe(false);
  });
});

function runFixture() {
  const manifest = JSON.parse(
    readFileSync(
      new URL(
        "../../tests/fixtures/requirements/lastenheft-kundenportal/manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const native = epics(manifest.requirements);
  const directory = mkdtempSync(join(tmpdir(), "jira-hierarchy-bulk-"));
  directories.push(directory);
  const state = {};
  const events = [];
  const pages = [];
  const ctx = {
    projectKey: PROJECT,
    sessionDir: directory,
    chat: { id: "synthetic-chat" },
    signal: new globalThis.AbortController().signal,
    truth: { fieldIds: { epicLink: EPIC_LINK }, requiredFieldsByType: structuredClone(REQUIRED) },
    intent: {
      state,
      update: vi.fn((patch) => {
        Object.assign(state, patch);
      }),
      record: vi.fn(),
    },
    onState: vi.fn((event) => {
      events.push(event);
    }),
    beforeBatch: vi.fn(),
    afterBatch: vi.fn(),
    checkLicense: vi.fn(() => Promise.resolve()),
    search: vi.fn((query, fields) => {
      expect(query).toBe('project = "LIM7" ORDER BY id ASC');
      expect(fields).toBe("*all");
      const observed = [];
      for (let offset = 0; offset < native.length; offset += 100) {
        const page = native.slice(offset, offset + 100);
        pages.push(page.length);
        observed.push(...page);
      }
      return Promise.resolve(structuredClone(observed));
    }),
    turn: vi.fn((_chat, prompt) => {
      const rows = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
      for (const row of rows) native.push(nativeFromRequest(row, native.length + 1001));
      return Promise.resolve({ answer: "Synthetic answer is not grading evidence." });
    }),
  };
  return { ctx, native, events, pages };
}

function nativeFromRequest(row, number) {
  return {
    id: String(number + 30000),
    key: `LIM7-${number}`,
    fields: {
      summary: row.summary,
      description: description(row.descriptionSections),
      project: { key: PROJECT },
      issuetype: { name: row.issueType },
      labels: [],
      customfield_10006: 0,
      ...(row.issueType === "Sub-task"
        ? { parent: { key: row.parentTaskKey } }
        : { [EPIC_LINK]: row.epicKey }),
      ...(row.issueType === "Bug"
        ? {
            priority: { name: "Medium" },
            issuelinks: [{ type: { name: "Relates" }, outwardIssue: { key: row.relatesTaskKey } }],
          }
        : {}),
    },
  };
}

describe("runHierarchyBulk(ctx, { faults })", () => {
  it("uses bounded browser turns, delegated faults and the full paginated native oracle", async () => {
    const { ctx, native, events, pages } = runFixture();
    const faults = { maybeInject: vi.fn(() => Promise.resolve()) };
    const actual = await runHierarchyBulk(ctx, { faults });
    expect(actual.step).toBe("ac4-hierarchy-bulk");
    expect(actual.status).toBe("green");
    expect(actual.counts).toMatchObject({ epics: 370, tasks: 493, bugs: 46, subtasks: 98 });
    expect(native).toHaveLength(1007);
    expect(ctx.turn).toHaveBeenCalledTimes(26);
    expect(ctx.beforeBatch).toHaveBeenCalledTimes(26);
    expect(ctx.afterBatch).toHaveBeenCalledTimes(26);
    expect(ctx.checkLicense).toHaveBeenCalledTimes(26);
    expect(faults.maybeInject.mock.calls[0]).toEqual([ctx, 0]);
    expect(faults.maybeInject.mock.calls.at(-1)).toEqual([ctx, 1]);
    expect(ctx.beforeBatch.mock.calls.every(([event]) => event.count <= 25)).toBe(true);
    expect(ctx.intent.state.hierarchyBulk).toMatchObject({ phase: "complete", next: 26 });
    expect(pages).toContain(100);
    expect(pages.at(-1)).toBe(7);
    expect(JSON.stringify({ actual, events })).not.toMatch(
      /Synthetic|REQ-FA|LIM7-\d|summary|description/,
    );
    expect(statSync(actual.evidenceFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(actual.evidenceFile, "utf8"))).toMatchObject(actual);
  });

  it("observes exact native Task keys before requesting dependent children", async () => {
    const { ctx } = runFixture();
    expect((await runHierarchyBulk(ctx, {})).status).toBe("green");
    const batches = ctx.turn.mock.calls.map(([, prompt]) =>
      JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)),
    );
    expect(
      batches.slice(0, 20).every((rows) => rows.every((row) => row.issueType === "Task")),
    ).toBe(true);
    expect(
      batches[20].every((row) => row.issueType === "Bug" && /^LIM7-\d+$/.test(row.relatesTaskKey)),
    ).toBe(true);
    expect(
      batches[22].every(
        (row) => row.issueType === "Sub-task" && /^LIM7-\d+$/.test(row.parentTaskKey),
      ),
    ).toBe(true);
    expect(batches[22][0].parentTaskKey).not.toBe(batches[22][0].epicKey);
  });

  it("offers the exact link review operation only for Bug batches", async () => {
    const { ctx } = runFixture();
    expect((await runHierarchyBulk(ctx, {})).status).toBe("green");
    const options = ctx.turn.mock.calls.map(([, , turnOptions]) => turnOptions.operations);
    expect(
      options
        .slice(0, 20)
        .every(
          (operations) =>
            JSON.stringify(operations) === JSON.stringify(["jira.draft", "jira.create"]),
        ),
    ).toBe(true);
    expect(options.slice(20, 22)).toEqual([
      ["jira.draft", "jira.create", "jira.create-issue-link"],
      ["jira.draft", "jira.create", "jira.create-issue-link"],
    ]);
    expect(options.slice(22)).toEqual(
      Array.from({ length: 4 }, () => ["jira.draft", "jira.create"]),
    );
  });

  it("preserves explicit narrower review operations and other caller turn options", async () => {
    const { ctx } = runFixture();
    const operations = Object.freeze(["jira.create"]);
    ctx.turnOptions = { operations, timeoutMs: 321 };
    expect((await runHierarchyBulk(ctx, {})).status).toBe("green");
    expect(ctx.turn.mock.calls.every(([, , options]) => options.operations === operations)).toBe(
      true,
    );
    expect(ctx.turn.mock.calls.every(([, , options]) => options.timeoutMs === 321)).toBe(true);
  });

  it("stops before writing when the existing license window cannot be confirmed", async () => {
    const { ctx } = runFixture();
    ctx.checkLicense.mockRejectedValue(new TypeError("synthetic-license-refusal"));
    expect((await runHierarchyBulk(ctx, {})).status).toBe("unverified");
    expect(ctx.turn).not.toHaveBeenCalled();
    expect(ctx.intent.state.hierarchyBulk).toBeUndefined();
  });

  it("stops after a wrong native parent despite a successful browser answer", async () => {
    const { ctx, native } = runFixture();
    const original = ctx.turn.getMockImplementation();
    ctx.turn.mockImplementation(async (...args) => {
      await original(...args);
      native.at(-1).fields[EPIC_LINK] = "LIM7-370";
      return { answer: "All done" };
    });
    const actual = await runHierarchyBulk(ctx, {});
    expect(actual.status).toBe("red");
    expect(actual.counts.invalidParents).toBe(1);
    expect(ctx.turn).toHaveBeenCalledTimes(1);
    expect(ctx.intent.state.hierarchyBulk.phase).toBe("writing");
  });

  it("requires native create metadata before any read or write", async () => {
    const { ctx } = runFixture();
    const independent = runFixture().ctx;
    const originalRequired = structuredClone(REQUIRED);
    delete ctx.truth.requiredFieldsByType.Bug;
    const actual = await runHierarchyBulk(ctx, {});
    expect(actual.status).toBe("unverified");
    expect(actual.detail).toContain("create-metadata-unavailable");
    expect(ctx.search).not.toHaveBeenCalled();
    expect(ctx.turn).not.toHaveBeenCalled();
    expect(REQUIRED).toEqual(originalRequired);
    expect(independent.truth.requiredFieldsByType).toEqual(originalRequired);
  });

  it("refuses a truncated first page instead of assuming the other Epics exist", async () => {
    const { ctx, native } = runFixture();
    ctx.search.mockResolvedValue(native.slice(0, 100));
    expect((await runHierarchyBulk(ctx, {})).status).toBe("unverified");
    expect(ctx.search).toHaveBeenCalledTimes(1);
    expect(ctx.turn).not.toHaveBeenCalled();
  });

  it("never replays an uncertain partially written batch", async () => {
    const { ctx, native } = runFixture();
    ctx.turn.mockImplementation((_chat, prompt) => {
      const rows = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
      for (const row of rows.slice(0, 5)) native.push(nativeFromRequest(row, native.length + 1001));
      return Promise.reject(new TypeError("synthetic-response-loss"));
    });
    expect((await runHierarchyBulk(ctx, {})).status).toBe("unverified");
    expect(ctx.intent.state.hierarchyBulk).toMatchObject({ phase: "writing", next: 0 });
    expect((await runHierarchyBulk(ctx, {})).status).toBe("unverified");
    expect(ctx.turn).toHaveBeenCalledTimes(1);
    expect(native).toHaveLength(375);
  });

  it("reconciles a completely observed lost-response batch without issuing it twice", async () => {
    const { ctx } = runFixture();
    const original = ctx.turn.getMockImplementation();
    ctx.turn.mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new TypeError("synthetic-response-loss");
    });
    expect((await runHierarchyBulk(ctx, {})).status).toBe("unverified");
    expect((await runHierarchyBulk(ctx, {})).status).toBe("green");
    expect(ctx.turn).toHaveBeenCalledTimes(26);
    expect(ctx.intent.state.hierarchyBulk).toMatchObject({ phase: "complete", next: 26 });
  });

  it("rechecks a completed intent without replaying any write", async () => {
    const { ctx } = runFixture();
    expect((await runHierarchyBulk(ctx, {})).status).toBe("green");
    const faults = { maybeInject: vi.fn(() => Promise.resolve()) };
    ctx.beforeBatch.mockClear();
    ctx.afterBatch.mockClear();
    ctx.checkLicense.mockClear();
    ctx.onState.mockClear();
    const readsBefore = ctx.search.mock.calls.length;
    expect((await runHierarchyBulk(ctx, { faults })).status).toBe("green");
    expect(ctx.search).toHaveBeenCalledTimes(readsBefore + 1);
    expect(ctx.turn).toHaveBeenCalledTimes(26);
    expect(faults.maybeInject).not.toHaveBeenCalled();
    expect(ctx.beforeBatch).not.toHaveBeenCalled();
    expect(ctx.afterBatch).not.toHaveBeenCalled();
    expect(ctx.checkLicense).not.toHaveBeenCalled();
    expect(ctx.onState).not.toHaveBeenCalled();
  });

  it("refuses a changed native graph on completed-intent reconciliation without replay", async () => {
    const { ctx, native } = runFixture();
    expect((await runHierarchyBulk(ctx, {})).status).toBe("green");
    const subtask = native.find((issue) => issue.fields.issuetype.name === "Sub-task");
    subtask.fields.parent.key = "LIM7-4";
    const faults = { maybeInject: vi.fn(() => Promise.resolve()) };
    ctx.beforeBatch.mockClear();
    ctx.afterBatch.mockClear();
    ctx.checkLicense.mockClear();
    const actual = await runHierarchyBulk(ctx, { faults });
    expect(actual.status).toBe("unverified");
    expect(actual.counts.invalidParents).toBe(1);
    expect(ctx.turn).toHaveBeenCalledTimes(26);
    expect(faults.maybeInject).not.toHaveBeenCalled();
    expect(ctx.beforeBatch).not.toHaveBeenCalled();
    expect(ctx.afterBatch).not.toHaveBeenCalled();
    expect(ctx.checkLicense).not.toHaveBeenCalled();
  });

  it("honors cancellation and refuses an unavailable browser context without writes", async () => {
    const { ctx } = runFixture();
    ctx.signal = globalThis.AbortSignal.abort();
    const cancelled = await runHierarchyBulk(ctx, {});
    expect(cancelled.status).toBe("unverified");
    expect(cancelled.detail).toContain("interrupted-or-invalid-evidence");
    delete ctx.chat;
    expect((await runHierarchyBulk(ctx, {})).status).toBe("unverified");
    expect(ctx.turn).not.toHaveBeenCalled();
    expect(ctx.search).not.toHaveBeenCalled();
  });
});
