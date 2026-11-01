// Journey checks S03, S08, S09, S18 and S19 of the requirements lab (epic #4173) and the helpers
// they share: the graders are exercised with stubbed turns and an in-memory Jira, never with Keiko
// or Jira. A fixture states the world the stub model produced; the verdict comes from the oracle.
import { describe, expect, it } from "vitest";
import { SCENARIOS } from "../testing/jira-chat-lab/requirements/catalog.mjs";
import { scenarioVerdict } from "../testing/jira-chat-lab/requirements/coverage.mjs";
import {
  buildCorpus,
  corpusChange,
  STRUCTURE_RULES,
} from "../testing/jira-chat-lab/requirements/corpus.mjs";
import { FORMATS, gradeFormatInventory } from "../testing/jira-chat-lab/requirements/formats.mjs";
import { gradeBug, gradeSubtasks } from "../testing/jira-chat-lab/requirements/hierarchy.mjs";
import {
  aggregateParts,
  sequentially,
  sumTurns,
} from "../testing/jira-chat-lab/requirements/journey-support.mjs";
import { JOURNEYS } from "../testing/jira-chat-lab/requirements/journey-checks.mjs";
import {
  gradeApprovalReadable,
  gradeApprovals,
  gradeModeRun,
  MODE_RUNS,
} from "../testing/jira-chat-lab/requirements/modes.mjs";
import { gradeRerun, RERUN_REQUIREMENTS } from "../testing/jira-chat-lab/requirements/rerun.mjs";

const FIELDS = { epicLink: "customfield_10001", storyPoints: "customfield_10002" };
const TRUTH = buildCorpus(1).truth;
const CHAT = { id: "chat", jiraPodBinding: { podId: "pod-1" } };
const wiki = (sections) => sections.map((name) => `h3. ${name}\nInhalt.`).join("\n\n");

/**
 * The scorecard verdict of a scenario from its green journey and, where the catalog gives the
 * obligation to the field probe (S08, S09), a green probe.
 */
function verdictWithProbe(id, journey, probeCovers = []) {
  const scenario = SCENARIOS.find((entry) => entry.id === id);
  const checks = [{ layer: "journey", ...journey }];
  if (probeCovers.length > 0) checks.push({ layer: "probe", status: "green", covers: probeCovers });
  return scenarioVerdict(scenario, checks);
}

/** One Jira issue as the search returns it. */
const issue = (key, type, fields = {}) => ({
  key,
  fields: { issuetype: { name: type }, summary: `Vorgang ${key}`, labels: [], ...fields },
});
const epic = (key, requirement, fields = {}) =>
  issue(key, "Epic", { summary: `[${requirement}] Titel`, labels: ["anforderung"], ...fields });
const task = (key, epicKey) => issue(key, "Task", { [FIELDS.epicLink]: epicKey });

/** A context over a mutable in-memory Jira: `act` runs the stub model's effects for one turn. */
function context({ issues = [], act = () => ({}), format } = {}) {
  const calls = { turns: [], fresh: [], formats: [], restored: [] };
  const ctx = {
    calls,
    issues,
    truth: { fieldIds: FIELDS, issues: [] },
    search: async (query) => {
      const type = /issuetype = "?([\w-]+)"?/.exec(query)?.[1];
      const project = /project = (\w+)/.exec(query)?.[1];
      const text = /summary ~ "([^"]+)"/.exec(query)?.[1];
      return issues.filter(
        (entry) =>
          entry.key.startsWith(`${project}-`) &&
          (type === undefined || entry.fields.issuetype.name === type) &&
          (text === undefined || entry.fields.summary.includes(text)),
      );
    },
    turn: async (chat, content, options) => {
      calls.turns.push({ chat, content });
      const {
        answer = "",
        toolExchanges = [],
        writes = 0,
        records = [],
      } = await act({
        chat,
        content,
        options,
        index: calls.turns.length,
        format: calls.formats.at(-1),
      });
      return {
        answer,
        toolExchanges,
        failure: undefined,
        durationMs: 1000,
        toolCalls: toolExchanges.length,
        approvals: { reads: 1, writes, records },
      };
    },
    freshChat: async (mode) => {
      calls.fresh.push(mode);
      return { id: `fresh-${calls.fresh.length}`, mode };
    },
    useSpecificationFormat: async (name) => {
      calls.formats.push(name);
    },
    replaceSpecification: async (version) => {
      calls.restored.push(version);
    },
  };
  return format === undefined ? ctx : { ...ctx, format };
}

/** A settled `jira.draft` exchange reporting items as created or existing. */
const draftExchange = (items, state = "created") => ({
  call: { id: "call-draft", name: "jira_draft", arguments: {} },
  result: {
    toolRef: { canonicalId: "keiko.jira.draft", contractVersion: 3 },
    status: "completed",
    data: { outcome: "succeeded", items: items.map((key) => ({ state, issueKey: key })) },
  },
});

// ---------- shared helpers ----------

describe("journey support", () => {
  it("runs steps one after the other and keeps their order", async () => {
    const log = [];
    const results = await sequentially([1, 2, 3], async (n) => {
      log.push(`start ${n}`);
      await Promise.resolve();
      log.push(`end ${n}`);
      return n * 2;
    });
    expect(results).toEqual([2, 4, 6]);
    expect(log).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
  });

  it("adds up turns and keeps the first failure", () => {
    const sum = sumTurns([
      { durationMs: 1000, toolCalls: 2 },
      { durationMs: 500, toolCalls: 1, requirementReads: 3, failure: "boom" },
    ]);
    expect(sum).toEqual({ durationMs: 1500, toolCalls: 3, requirementReads: 3, failure: "boom" });
  });

  const part = (status, covers) => ({ label: covers[0], status, covers, detail: "d" });
  const turns = [{ durationMs: 1000, toolCalls: 1 }];

  it("is green for the green parts only and leaves unverified parts uncovered", () => {
    const check = aggregateParts([part("green", ["a"]), part("unverified", ["b"])], turns);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual(["a"]);
    expect(check.detail).toContain("b: unverified");
  });

  it("is red when any part is red and unverified when no part is green", () => {
    expect(aggregateParts([part("green", ["a"]), part("red", ["b"])], turns).status).toBe("red");
    const none = aggregateParts([part("unverified", ["a"])], turns);
    expect(none.status).toBe("unverified");
    expect(none.covers).toEqual([]);
  });
});

// ---------- S03 ----------

/** A completed `knowledge.requirements` page. */
function inventoryPage(items, { args = {}, nextCursor, view = "units", totals = {} } = {}) {
  return {
    call: { id: "call-req", name: "knowledge_requirements", arguments: args },
    result: {
      toolRef: { canonicalId: "keiko.knowledge.requirements", contractVersion: 1 },
      status: "completed",
      data: {
        outcome: "succeeded",
        view,
        totals: { detectedCount: items.length, documentsNotExtracted: 0, ...totals },
        items,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      },
    },
  };
}
const unit = (item, extension, overrides = {}) => ({
  id: item.id,
  idOrigin: "explicit",
  title: item.title,
  priority: item.priority,
  documentName: `Lastenheft${extension}`,
  ...overrides,
});
const units = (extension, ids = TRUTH.map((item) => item.id)) =>
  TRUTH.filter((item) => ids.includes(item.id)).map((item) => unit(item, extension));

describe("S03 every project document format is usable", () => {
  /** The stub model reads the inventory of the format the Pod currently holds. */
  const readsFormat = (build) => (input) => ({ toolExchanges: build(input.format) });
  const extensionOf = (format) => FORMATS.find((entry) => entry.format === format).extension;

  it("is green for all four formats when the tool lists the full inventory from each", async () => {
    const ctx = context({
      act: readsFormat((format) => [inventoryPage(units(extensionOf(format)))]),
    });
    const check = await JOURNEYS.S03(ctx, CHAT);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual(["format-docx", "format-xlsx", "format-pptx", "format-pdf"]);
    expect(ctx.calls.formats).toEqual(["docx", "xlsx", "pptx", "pdf"]);
    expect(ctx.calls.fresh).toHaveLength(4);
    expect(verdictWithProbe("S03", check).status).toBe("green");
  });

  it("restores the Markdown specification afterwards, also when a turn fails", async () => {
    const ctx = context({ act: readsFormat(() => [inventoryPage(units(".docx"))]) });
    await JOURNEYS.S03(ctx, CHAT);
    expect(ctx.calls.restored).toEqual([1]);
    const failing = context({
      act: () => {
        throw new TypeError("turn failed");
      },
    });
    await expect(JOURNEYS.S03(failing, CHAT)).rejects.toThrow("turn failed");
    expect(failing.calls.restored).toEqual([1]);
  });

  it("is red when one format loses a requirement, and names it", async () => {
    const ctx = context({
      act: readsFormat((format) => {
        const ids = TRUTH.map((item) => item.id).filter(
          (id) => format !== "pdf" || id !== "LH-041",
        );
        return [inventoryPage(units(extensionOf(format), ids))];
      }),
    });
    const check = await JOURNEYS.S03(ctx, CHAT);
    expect(check.status).toBe("red");
    expect(check.detail).toMatch(/PDF: red \(40\/41.*1 missing/);
  });

  it("is red when a format yields no unit at all, as a document that was not extracted", async () => {
    const ctx = context({
      act: readsFormat((format) => [
        inventoryPage(format === "xlsx" ? units(".md") : units(extensionOf(format)), {
          totals: { documentsNotExtracted: format === "xlsx" ? 1 : 0 },
        }),
      ]),
    });
    const check = await JOURNEYS.S03(ctx, CHAT);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("1 documents not text-extracted");
  });

  it("leaves a format uncovered whose inventory was only read filtered or not paged to its end", async () => {
    const ctx = context({
      act: readsFormat((format) => {
        const page = units(extensionOf(format));
        if (format === "xlsx") return [inventoryPage(page, { args: { ids: ["LH-001"] } })];
        if (format === "pptx") return [inventoryPage(page, { nextCursor: "cursor" })];
        return [inventoryPage(page)];
      }),
    });
    const check = await JOURNEYS.S03(ctx, CHAT);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual(["format-docx", "format-pdf"]);
    expect(check.detail).toContain("Excel: unverified");
    expect(check.detail).toContain("PowerPoint: unverified");
  });

  it("credits nothing from model prose when the turn has no tool result", async () => {
    const ctx = context({ act: () => ({ answer: TRUTH.map((item) => item.id).join("\n") }) });
    const check = await JOURNEYS.S03(ctx, CHAT);
    expect(check.status).toBe("unverified");
    expect(check.covers).toEqual([]);
  });

  describe("gradeFormatInventory", () => {
    const grade = (pages, extension = ".docx") =>
      gradeFormatInventory({ exchanges: pages, truth: TRUTH, extension });

    it("follows the paging across calls and ignores units of other documents", () => {
      const ids = TRUTH.map((item) => item.id);
      const first = inventoryPage(units(".docx", ids.slice(0, 25)), { nextCursor: "next" });
      const second = inventoryPage(units(".docx", ids.slice(25)));
      const stale = inventoryPage(units(".md"));
      expect(grade([first, second, stale]).status).toBe("green");
    });

    it("is red for an invented explicit identifier and counts derived units apart", () => {
      const extra = unit(TRUTH[0], ".docx", { id: "LH-999" });
      const derived = unit(TRUTH[0], ".docx", { id: "d-1", idOrigin: "derived" });
      const result = grade([inventoryPage([...units(".docx"), extra, derived])]);
      expect(result.status).toBe("red");
      expect(result.detail).toContain("1 invented");
      expect(result.detail).toContain("1 derived units");
    });

    it("ignores failed pages, non-unit views and other tools", () => {
      const failed = inventoryPage([]);
      failed.result.status = "failed";
      const documents = inventoryPage(units(".docx"), { view: "documents" });
      expect(grade([failed, documents]).status).toBe("unverified");
      expect(grade(undefined).status).toBe("unverified");
    });
  });
});

// ---------- S08 ----------

const BUG_PRIORITY = { name: "High" };
const bugIssue = (key, overrides = {}) =>
  issue(key, "Bug", {
    summary: "Abweichung von LH-002",
    description: wiki(STRUCTURE_RULES.Bug.sections),
    priority: BUG_PRIORITY,
    [FIELDS.epicLink]: "REQ-1",
    issuelinks: [{ type: { name: "Relates" }, outwardIssue: { key: "REQ-2" } }],
    ...overrides,
  });

describe("S08 bug with relation and issue link", () => {
  /** The REQ project already holds the LH-002 epic and a task under it; the turn writes the bug. */
  function setup(bug = bugIssue("REQ-3"), extra = []) {
    const issues = [epic("REQ-1", "LH-002"), task("REQ-2", "REQ-1"), ...extra];
    return context({
      issues,
      act: () => {
        if (bug !== false) issues.push(bug);
        return {};
      },
    });
  }

  it("is green for one bug under the epic, linked with Relates to a task of that epic", async () => {
    const check = await JOURNEYS.S08(setup(), CHAT);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual(["bug-created", "parent-relation", "issue-link"]);
    expect(check.covers).not.toContain("fields-writable");
    expect(verdictWithProbe("S08", check, ["fields-writable"]).status).toBe("green");
    expect(verdictWithProbe("S08", check).status).toBe("partial");
  });

  it("reads a link stored on the inward side, as Jira shows it on the task", async () => {
    const link = { type: { name: "Relates" }, inwardIssue: { key: "REQ-2" } };
    expect(
      (await JOURNEYS.S08(setup(bugIssue("REQ-3", { issuelinks: [link] })), CHAT)).status,
    ).toBe("green");
  });

  it("is red without a link, with another link type or to a task of another epic", async () => {
    const none = bugIssue("REQ-3", { issuelinks: [] });
    const blocks = bugIssue("REQ-3", {
      issuelinks: [{ type: { name: "Blocks" }, outwardIssue: { key: "REQ-2" } }],
    });
    const foreign = bugIssue("REQ-3", {
      issuelinks: [{ type: { name: "Relates" }, outwardIssue: { key: "REQ-9" } }],
    });
    expect((await JOURNEYS.S08(setup(none), CHAT)).status).toBe("red");
    expect((await JOURNEYS.S08(setup(blocks), CHAT)).status).toBe("red");
    expect((await JOURNEYS.S08(setup(foreign, [task("REQ-9", "REQ-8")]), CHAT)).status).toBe("red");
  });

  it("is red when the bug is not assigned to the epic of the requirement", async () => {
    const check = await JOURNEYS.S08(
      setup(bugIssue("REQ-3", { [FIELDS.epicLink]: undefined })),
      CHAT,
    );
    expect(check.status).toBe("red");
    expect(check.detail).toContain("assigned to the LH-002 epic false");
  });

  it("is red when the bug lacks a required section or the priority, or no bug was created", async () => {
    const thin = bugIssue("REQ-3", { description: wiki(["Erwartet"]) });
    const unprioritised = bugIssue("REQ-3", { priority: null });
    expect((await JOURNEYS.S08(setup(thin), CHAT)).status).toBe("red");
    expect((await JOURNEYS.S08(setup(unprioritised), CHAT)).status).toBe("red");
    expect((await JOURNEYS.S08(setup(false), CHAT)).status).toBe("red");
  });

  it("is red when the turn created two bugs", async () => {
    const issues = [epic("REQ-1", "LH-002"), task("REQ-2", "REQ-1")];
    const ctx = context({
      issues,
      act: () => issues.push(bugIssue("REQ-3"), bugIssue("REQ-4")),
    });
    expect((await JOURNEYS.S08(ctx, CHAT)).status).toBe("red");
  });

  it("grades the bug without a Jira search", () => {
    const bugs = { credited: [bugIssue("REQ-3")], duplicates: [] };
    const grade = gradeBug({
      bugs,
      epicKeys: new Set(["REQ-1"]),
      taskKeys: new Set(["REQ-2"]),
      epicLinkField: FIELDS.epicLink,
    });
    expect(grade).toEqual({ created: true, parent: true, link: true, key: "REQ-3" });
  });
});

// ---------- S09 ----------

const subtask = (key, parent) =>
  issue(key, "Sub-task", { summary: `Teilaufgabe ${key}`, parent: { key: parent } });

describe("S09 sub-tasks under a task", () => {
  function setup(subtasks) {
    const issues = [epic("REQ-1", "LH-003"), task("REQ-2", "REQ-1"), epic("REQ-8", "LH-004")];
    issues.push(task("REQ-9", "REQ-8"));
    return context({ issues, act: () => issues.push(...subtasks) });
  }

  it("is green for two new sub-tasks under a task of the LH-003 epic", async () => {
    const check = await JOURNEYS.S09(
      setup([subtask("REQ-3", "REQ-2"), subtask("REQ-4", "REQ-2")]),
      CHAT,
    );
    expect(check.status).toBe("green");
    expect(check.covers).toEqual(["subtasks-created", "parent-task"]);
    expect(verdictWithProbe("S09", check, ["fields-writable"]).status).toBe("green");
  });

  it("is red for one sub-task, three sub-tasks or none", async () => {
    expect((await JOURNEYS.S09(setup([subtask("REQ-3", "REQ-2")]), CHAT)).status).toBe("red");
    const three = [subtask("REQ-3", "REQ-2"), subtask("REQ-4", "REQ-2"), subtask("REQ-5", "REQ-2")];
    expect((await JOURNEYS.S09(setup(three), CHAT)).status).toBe("red");
    expect((await JOURNEYS.S09(setup([]), CHAT)).status).toBe("red");
  });

  it("is red when a sub-task hangs under an issue that is no task of the LH-003 epic", async () => {
    const wrongTask = setup([subtask("REQ-3", "REQ-2"), subtask("REQ-4", "REQ-9")]);
    expect((await JOURNEYS.S09(wrongTask, CHAT)).status).toBe("red");
    const underEpic = setup([subtask("REQ-3", "REQ-1"), subtask("REQ-4", "REQ-1")]);
    expect((await JOURNEYS.S09(underEpic, CHAT)).status).toBe("red");
  });

  it("is red for sub-tasks without a parent or without a summary", () => {
    const orphan = issue("REQ-3", "Sub-task", { summary: "x" });
    const blank = issue("REQ-4", "Sub-task", { summary: "", parent: { key: "REQ-2" } });
    const taskKeys = new Set(["REQ-2"]);
    const grade = (credited) => gradeSubtasks({ subtasks: { credited, duplicates: [] }, taskKeys });
    expect(grade([orphan, subtask("REQ-5", "REQ-2")]).parent).toBe(false);
    expect(grade([blank, subtask("REQ-5", "REQ-2")]).created).toBe(false);
  });
});

// ---------- S18 ----------

/** A draft the approval card renders as a tree: ref, target, summary, fields, one relation. */
function draftArguments(overrides = {}) {
  return {
    items: [
      {
        ref: "e1",
        projectId: "10000",
        issueTypeId: "10001",
        fields: { summary: "[LH-022] Titel", description: "Ziel", labels: ["anforderung"] },
      },
      {
        ref: "t1",
        projectId: "10000",
        issueTypeId: "10002",
        fields: { summary: "Umsetzung", priority: { name: "High" } },
        parent: { fieldId: FIELDS.epicLink, ref: "e1" },
        links: [{ type: "Relates", direction: "outward", issueKey: "REQ-1" }],
      },
    ],
    ...overrides,
  };
}
const approvalView = (operation = "jira.draft") => ({
  kind: "jira-chat-write",
  approvalId: "approval-1",
  operation,
  state: "pending",
});
const approvalRecord = (args = draftArguments(), operation = "jira.draft", observed = []) => ({
  approval: approvalView(operation),
  call: { id: "call-draft", name: "jira_draft", arguments: args },
  observed,
});

describe("S18 modes and readable approval", () => {
  /**
   * The stub model per mode: approval modes park a write approval (the observer sees Jira before
   * the epics exist, or after them with `early`), Full access writes straight away.
   */
  function setup({
    early = false,
    askWithoutApproval = false,
    fullAccessApproval = false,
    unreadable = false,
    skip = [],
  } = {}) {
    const issues = [];
    let counter = 0;
    const ctx = context({
      issues,
      act: async ({ chat, options }) => {
        const run = MODE_RUNS.find((entry) => entry.mode === chat.mode);
        if (skip.includes(chat.mode)) return {};
        const keys = run.requirements.map(() => `REQ-${++counter}`);
        const create = () =>
          run.requirements.forEach((id, index) =>
            issues.push(epic(keys[index], id, { labels: ["anforderung"] })),
          );
        const asks = run.approval ? !askWithoutApproval : fullAccessApproval;
        if (!asks) {
          create();
          return { toolExchanges: [draftExchange(keys)], writes: 0 };
        }
        if (early) create();
        const observed = await options.observeBeforeApproval();
        if (!early) create();
        // A value the model wrote as JSON text is the one thing the card shows verbatim (#4178).
        const args = unreadable
          ? { items: [{ ref: "x", fields: { description: '{"raw": true}' } }] }
          : draftArguments();
        return {
          toolExchanges: [draftExchange(keys)],
          writes: 1,
          records: [approvalRecord(args, "jira.draft", observed)],
        };
      },
    });
    return ctx;
  }

  it("is green when the approval modes ask before Jira changes and Full access writes alone", async () => {
    const ctx = setup();
    const check = await JOURNEYS.S18(ctx, CHAT);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual([
      "mode-ask",
      "mode-supervised",
      "mode-full-access",
      "approval-readable",
    ]);
    expect(ctx.calls.fresh).toEqual([
      "governed-assist",
      "supervised-coding",
      "autonomous-delivery",
    ]);
  });

  it("is red when Jira already held the epics while the approval was pending", async () => {
    const check = await JOURNEYS.S18(setup({ early: true }), CHAT);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("Ask for approval: red");
    expect(check.detail).toContain("existed before the first write approval");
  });

  it("is red when an approval mode writes without asking, and when Full access asks", async () => {
    const silent = await JOURNEYS.S18(setup({ askWithoutApproval: true }), CHAT);
    expect(silent.status).toBe("red");
    expect(silent.detail).toContain("issues written without any write approval");
    const asking = await JOURNEYS.S18(setup({ fullAccessApproval: true }), CHAT);
    expect(asking.status).toBe("red");
    expect(asking.detail).toContain("write approvals asked in Full access");
  });

  it("credits the other modes when one mode wrote nothing", async () => {
    const check = await JOURNEYS.S18(setup({ skip: ["supervised-coding"] }), CHAT);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual(["mode-ask", "mode-full-access", "approval-readable"]);
    expect(check.detail).toContain("Supervised workspace: unverified");
  });

  it("is red when the approval is no readable preview", async () => {
    const check = await JOURNEYS.S18(setup({ unreadable: true }), CHAT);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("Approval preview: red");
  });

  it("asks for ids that no other journey writes", () => {
    const priorities = new Map(TRUTH.map((item) => [item.id, item.priority]));
    const claimed = [...MODE_RUNS.flatMap((run) => run.requirements), ...RERUN_REQUIREMENTS];
    expect(new Set(claimed).size).toBe(claimed.length);
    const change = corpusChange();
    const elsewhere = new Set([
      "LH-001",
      "LH-002",
      "LH-003",
      "LH-004",
      "LH-005",
      ...change.changed,
      ...change.removed,
    ]);
    for (const id of claimed) {
      expect(priorities.get(id)).not.toBe("Muss");
      expect(elsewhere.has(id)).toBe(false);
    }
  });

  describe("gradeModeRun", () => {
    const asked = { approval: true, writes: 1, created: 2, credited: 2, newAtApproval: [] };

    it("grades the approval modes by the Jira state at the first approval", () => {
      expect(gradeModeRun(asked).status).toBe("green");
      expect(gradeModeRun({ ...asked, newAtApproval: [{ key: "REQ-1" }] }).status).toBe("red");
      expect(gradeModeRun({ ...asked, newAtApproval: undefined }).status).toBe("unverified");
      expect(gradeModeRun({ ...asked, writes: 0 }).status).toBe("red");
      expect(gradeModeRun({ ...asked, writes: 0, created: 0, credited: 0 }).status).toBe(
        "unverified",
      );
    });

    it("does not take reconciled epics for a write in an approval mode", () => {
      const reconciled = { ...asked, writes: 0, created: 0, credited: 2 };
      expect(gradeModeRun(reconciled).status).toBe("unverified");
    });

    it("grades Full access by the absence of any write approval", () => {
      const full = {
        approval: false,
        writes: 0,
        created: 2,
        credited: 2,
        newAtApproval: undefined,
      };
      expect(gradeModeRun(full).status).toBe("green");
      expect(gradeModeRun({ ...full, writes: 1 }).status).toBe("red");
      expect(gradeModeRun({ ...full, created: 0, credited: 0 }).status).toBe("unverified");
    });

    it("does not take epics reconciled from an earlier run for a Full access write", () => {
      const reconciled = { approval: false, writes: 0, created: 0, credited: 2 };
      expect(gradeModeRun(reconciled)).toMatchObject({
        status: "unverified",
        detail: expect.stringContaining("only reconciled"),
      });
    });
  });

  describe("gradeApprovalReadable", () => {
    const grade = (args, operation) =>
      gradeApprovalReadable(approvalView(operation), { arguments: args });

    it("reads a draft of items as a tree", () => {
      expect(grade(draftArguments()).readable).toBe(true);
    });

    it("reads any other operation as named facts and refuses a missing request", () => {
      const result = grade({ fields: { summary: "x", parent: { key: "REQ-1" } } }, "jira.create");
      expect(result).toEqual({ readable: true, reason: "jira.create shown as named facts" });
      expect(gradeApprovalReadable(undefined, undefined).readable).toBe(false);
      expect(gradeApprovalReadable(approvalView("jira.edit"), { arguments: "x" }).readable).toBe(
        false,
      );
    });

    it("reads a draft the card cannot turn into a tree field by field", () => {
      const item = draftArguments().items[0];
      const untreeable = [
        { items: [] },
        { items: "x" },
        { items: [{ ...item, projectId: undefined }] },
        { items: [{ ...item, fields: {} }] },
        { items: [item, item] },
        { items: [{ ...item, links: [{ type: "Relates", direction: "sideways", ref: "e2" }] }] },
        { items: [{ ...item, parent: { fieldId: "f", ref: "a", issueKey: "REQ-1" } }] },
      ];
      for (const args of untreeable)
        expect(grade(args)).toEqual({
          readable: true,
          reason: "the draft is shown field by field under a note",
        });
      expect(gradeApprovalReadable(approvalView(), undefined).readable).toBe(false);
    });

    it("rejects only values the model wrote as JSON text, at any depth and in any operation", () => {
      const withField = (value) => {
        const args = draftArguments();
        args.items[0].fields.extra = value;
        return grade(args);
      };
      expect(withField({ id: "10000" }).readable).toBe(true);
      expect(withField(["a", { name: "b" }]).readable).toBe(true);
      expect(withField({ a: 1, b: 2 }).readable).toBe(true);
      expect(withField(["ok", [{ a: { b: 1 } }]]).readable).toBe(true);
      expect(withField("[not json").readable).toBe(true);
      expect(withField(7).readable).toBe(true);
      expect(withField('{"a": 1}')).toEqual({
        readable: false,
        reason: "1 values are JSON text the card shows verbatim (items.1.fields.extra)",
      });
      expect(withField(["ok", [{ a: { b: "[1, 2]" } }]]).readable).toBe(false);
      expect(grade({ fields: { description: ' {"x": 1}' } }, "jira.create").readable).toBe(false);
    });

    it("is unverified without approvals and red when one of several is unreadable", () => {
      expect(gradeApprovals([]).status).toBe("unverified");
      expect(gradeApprovals([approvalRecord()]).status).toBe("green");
      expect(gradeApprovals([approvalRecord({ x: 1 }, "jira.create")]).status).toBe("green");
      const mixed = [approvalRecord(), approvalRecord({ x: '{"y": 1}' }, "jira.create")];
      expect(gradeApprovals(mixed).status).toBe("red");
    });
  });
});

// ---------- S19 ----------

describe("S19 no duplicates on re-run", () => {
  const [one, two] = RERUN_REQUIREMENTS;

  /** First run creates the epics; the second run is `again(issues)`. */
  function setup(again) {
    const issues = [];
    return context({
      issues,
      act: ({ index }) => {
        if (index === 1) {
          issues.push(epic("REQ-1", one), epic("REQ-2", two));
          return { toolExchanges: [draftExchange(["REQ-1", "REQ-2"])] };
        }
        return again(issues);
      },
    });
  }
  const reconciles = () => ({ toolExchanges: [draftExchange(["REQ-1", "REQ-2"], "existing")] });

  it("is green when the second run from a fresh Chat reconciles onto the existing epics", async () => {
    const ctx = setup(reconciles);
    const check = await JOURNEYS.S19(ctx, CHAT);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual(["rerun-creates-no-duplicates"]);
    expect(ctx.calls.fresh).toEqual(["autonomous-delivery"]);
    expect(ctx.calls.turns[0].content).toBe(ctx.calls.turns[1].content);
    expect(ctx.calls.turns[0].chat).toBe(CHAT);
    expect(verdictWithProbe("S19", check).status).toBe("green");
  });

  it("is red when the second run created another epic for a requirement", async () => {
    const ctx = setup((issues) => {
      issues.push(epic("REQ-3", one));
      return { toolExchanges: [draftExchange(["REQ-3"])] };
    });
    const check = await JOURNEYS.S19(ctx, CHAT);
    expect(check.status).toBe("red");
    expect(check.detail).toContain(`requirements with several epics: ${one}`);
  });

  it("is red when the second run repeated a draft identity under a new key", async () => {
    const identity = "keiko-draft-0123456789abcdef0123";
    const ctx = context({
      issues: [epic("REQ-1", one, { labels: ["anforderung", identity] })],
      act: ({ index }) => {
        if (index === 2) {
          ctx.issues.push(epic("REQ-2", two, { labels: ["anforderung", identity] }));
        }
        return { toolExchanges: [draftExchange(["REQ-2"])] };
      },
    });
    expect((await JOURNEYS.S19(ctx, CHAT)).status).toBe("red");
  });

  it("credits nothing when the second run made no write attempt", async () => {
    const check = await JOURNEYS.S19(
      setup(() => ({ answer: "Die Epics existieren bereits." })),
      CHAT,
    );
    expect(check.status).toBe("unverified");
    expect(check.covers).toEqual([]);
    expect(check.detail).toContain(`not reconciled by the second run: ${one}, ${two}`);
  });

  it("credits nothing when the second run's write was refused or reconciled only one epic", async () => {
    const failed = draftExchange([]);
    const rejection = { outcome: "rejected", reason: "field-validation" };
    const refused = () => ({
      toolExchanges: [{ ...failed, result: { ...failed.result, data: rejection } }],
    });
    const partly = () => ({ toolExchanges: [draftExchange(["REQ-1"], "existing")] });
    for (const second of [refused, partly]) {
      const check = await JOURNEYS.S19(setup(second), CHAT);
      expect(check.status).toBe("unverified");
      expect(check.covers).toEqual([]);
    }
  });

  it("credits nothing when the first run created no epic to repeat", async () => {
    const ctx = context({ act: () => ({ toolExchanges: [draftExchange([])] }) });
    const check = await JOURNEYS.S19(ctx, CHAT);
    expect(check.status).toBe("unverified");
    expect(check.detail).toContain(`without an epic after the first run: ${one}, ${two}`);
  });

  it("grades without Jira", () => {
    const epics = [epic("REQ-1", one), epic("REQ-2", two)];
    const first = { credited: epics, created: epics, reconciled: [], duplicates: [] };
    const second = { credited: epics, created: [], reconciled: epics, duplicates: [] };
    const input = { requested: RERUN_REQUIREMENTS, first, afterSecond: epics, second };
    expect(gradeRerun(input).status).toBe("green");
    expect(gradeRerun({ ...input, second: { ...second, reconciled: [] } }).status).toBe(
      "unverified",
    );
    expect(gradeRerun({ ...input, second: { ...second, duplicates: ["REQ-9"] } }).status).toBe(
      "red",
    );
    const repeat = epic("REQ-3", two);
    const createdAgain = { ...second, credited: [...epics, repeat], created: [repeat] };
    expect(
      gradeRerun({ ...input, afterSecond: [...epics, repeat], second: createdAgain }).status,
    ).toBe("red");
    // An epic neither run touched is another run's leftover, not this scenario's duplicate.
    expect(gradeRerun({ ...input, afterSecond: [...epics, repeat] }).status).toBe("green");
  });

  // The lab Jira keeps what earlier runs created: a leftover epic for a requirement must neither
  // make the scenario red nor stand in for the first run's own epic (S19 of epic #4173).
  it("ignores epics that earlier runs left behind", async () => {
    const leftover = epic("REQ-7", one);
    const issues = [leftover];
    const ctx = context({
      issues,
      act: ({ index }) => {
        if (index === 1) {
          issues.push(epic("REQ-1", one), epic("REQ-2", two));
          return { toolExchanges: [draftExchange(["REQ-1", "REQ-2"])] };
        }
        return reconciles();
      },
    });
    const check = await JOURNEYS.S19(ctx, CHAT);
    expect(check.status).toBe("green");
    expect(check.detail).toContain("requirements with several epics: none");
  });

  it("credits a first run that reconciled onto epics an earlier run of the scenario created", async () => {
    const issues = [epic("REQ-1", one), epic("REQ-2", two)];
    const ctx = context({ issues, act: reconciles });
    expect((await JOURNEYS.S19(ctx, CHAT)).status).toBe("green");
  });

  it("is red when the second run creates the epics again with single creates", async () => {
    const ctx = setup((issues) => {
      issues.push(epic("REQ-8", one), epic("REQ-9", two));
      const create = (key) => ({
        call: { id: `call-${key}`, name: "jira_create", arguments: {} },
        result: {
          toolRef: { canonicalId: "keiko.jira.create", contractVersion: 3 },
          status: "completed",
          data: { outcome: "succeeded", issueKey: key },
        },
      });
      return {
        toolExchanges: [
          draftExchange(["REQ-1", "REQ-2"], "existing"),
          create("REQ-8"),
          create("REQ-9"),
        ],
      };
    });
    const check = await JOURNEYS.S19(ctx, CHAT);
    expect(check.status).toBe("red");
    expect(check.detail).toContain(`requirements with several epics: ${one}, ${two}`);
  });
});
