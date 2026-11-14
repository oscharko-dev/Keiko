import { describe, expect, it, vi } from "vitest";

const nativeReads = vi.hoisted(() => new Map());
vi.mock("../testing/jira-chat-lab/lab-client.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  basicAuth: (_session, actor) => `auth:${actor}`,
  checked: vi.fn(async (_session, _name, _method, path) => structuredClone(nativeReads.get(path))),
}));
import {
  SELECTION_CASES,
  selectionTruth,
} from "../testing/jira-chat-lab/catalog-selection-cases.mjs";
import {
  callTrace,
  carriesTruth,
  describeSummary,
  describeTrace,
  gradeSelection,
  refusalTrace,
  selectionPath,
  summarizeSelection,
} from "../testing/jira-chat-lab/catalog-selection-grade.mjs";
import {
  strayWrites,
  voteKey,
  voteRows,
} from "../testing/jira-chat-lab/catalog-selection-objects.mjs";
import {
  attemptBatches,
  LIFECYCLE_ATTEMPTS_MAX,
  turnRefusals,
} from "../testing/jira-chat-lab/catalog-selection.mjs";
import { actorDetails } from "../testing/jira-chat-lab/lab-client.mjs";
import { LANGUAGE_SELECTION_CASES } from "../testing/jira-chat-lab/catalog-selection-cases.mjs";

const FIXTURE = {
  project: "KEIKO",
  selection: {
    commentId: "77",
    commentBody: "Auswahl Kommentar t",
    extraIssueKeys: [],
    issueKey: "KEIKO-1",
    linkTargetKey: "KEIKO-2",
    componentName: "Auswahl Komponente t",
    versionName: "Auswahl Version t",
    remoteLinkTitle: "Auswahl Link t",
    propertyKey: "keiko.selection.owned.t",
    filterName: "Auswahl Favorit t",
    boardName: "Auswahl Board t",
    sprintName: "Auswahl Sprint t",
    watcherName: "synthetic-assignee",
  },
};
const READ = { id: "priorities", tool: "jira.priorities", effect: "read" };
const WRITE = { id: "worklog", tool: "jira.create-worklog", effect: "write" };
const call = (name, data = { outcome: "succeeded", items: [{ name: "High" }] }) => ({
  call: { name },
  result: { status: "completed", data },
});
const healthy = { unrecovered: 0, circuit: 0 };

describe("catalog selection cases", () => {
  it("never names the tool, its alias or an argument object in the request", () => {
    for (const entry of SELECTION_CASES) {
      const prompt = entry.prompt(FIXTURE, "Auswahl m", "tag", { key: "KEIKO-9" });
      expect(prompt).not.toContain(entry.tool);
      expect(prompt).not.toContain(entry.tool.replaceAll(/[.-]/gu, "_"));
      expect(prompt).not.toMatch(/jira[._]/u);
      expect(prompt).not.toMatch(/"[a-zA-Z]+Id"\s*:/u);
    }
  });

  it("covers discovery-only reads, base-catalog controls and writes with unique ids", () => {
    const ids = SELECTION_CASES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const kinds = (catalog, effect) =>
      SELECTION_CASES.filter((entry) => entry.catalog === catalog && entry.effect === effect)
        .length;
    expect(kinds("discovery", "read")).toBeGreaterThanOrEqual(12);
    expect(kinds("base", "read")).toBeGreaterThanOrEqual(3);
    expect(kinds("discovery", "write")).toBeGreaterThanOrEqual(5);
    for (const entry of SELECTION_CASES)
      expect(entry.effect === "write" ? entry.verify : entry.truth).toBeTypeOf("function");
  });
});

describe("gradeSelection", () => {
  it("credits a read only when the target succeeded and carries every native token", () => {
    const turn = { exchanges: [call("jira_discover"), call("jira_priorities")], gateway: healthy };
    expect(gradeSelection(READ, turn, { tokens: ["High"] })).toMatchObject({
      status: "selected",
      path: "discovery",
    });
    expect(gradeSelection(READ, turn, { tokens: ["High", "Lowest"] }).status).toBe("wrong-result");
    expect(gradeSelection(READ, turn, { tokens: [] }).status).toBe("wrong-result");
  });

  it("separates a wrong tool, no tool and a failed target call", () => {
    const fixed = { outcome: "succeeded", items: [{ name: "Fixed" }] };
    const wrong = { exchanges: [call("jira_resolutions", fixed)], gateway: healthy };
    expect(gradeSelection(READ, wrong, { tokens: ["High"] }).status).toBe("wrong-tool");
    expect(
      gradeSelection(READ, { exchanges: [], gateway: healthy }, { tokens: ["High"] }),
    ).toMatchObject({ status: "no-tool", path: "direct" });
    const failed = {
      exchanges: [{ call: { name: "jira_priorities" }, result: { status: "failed", data: {} } }],
      gateway: healthy,
    };
    expect(gradeSelection(READ, failed, { tokens: ["High"] }).status).toBe("wrong-result");
  });

  it("grades a gateway outage as invalid, never as a model or product verdict", () => {
    const gateway = { unrecovered: 1, circuit: 0 };
    expect(gradeSelection(READ, { exchanges: [], gateway }, { tokens: ["High"] }).status).toBe(
      "invalid",
    );
  });

  it("judges the successful target call when the model corrected a failed first call", () => {
    const failed = (name) => ({ call: { name }, result: { status: "failed", data: {} } });
    const turn = {
      exchanges: [failed("jira_priorities"), call("jira_priorities")],
      gateway: healthy,
    };
    expect(gradeSelection(READ, turn, { tokens: ["High"] }).status).toBe("selected");
    const retried = [failed("jira_create_worklog"), call("jira_create_worklog")];
    const write = { exchanges: retried, gateway: healthy };
    expect(gradeSelection(WRITE, write, { effect: { effects: 1 } }).status).toBe("selected");
  });

  it("lets a corrected successful read supply the truth, even after a wrong first read", () => {
    const wrong = call("jira_priorities", { outcome: "succeeded", items: [{ name: "Other" }] });
    const right = call("jira_priorities");
    const turn = { exchanges: [wrong, right], gateway: healthy };
    expect(gradeSelection(READ, turn, { tokens: ["High"] }).status).toBe("selected");
    const onlyWrong = { exchanges: [wrong, wrong], gateway: healthy };
    expect(gradeSelection(READ, onlyWrong, { tokens: ["High"] }).status).toBe("wrong-result");
  });

  it("grades a turn that failed without a transcript as invalid, read or write", () => {
    const turn = { exchanges: [], failure: "Live Chat HTTP stage failed", gateway: healthy };
    expect(gradeSelection(READ, turn, { tokens: ["High"] })).toMatchObject({
      status: "invalid",
      detail: "the turn failed before it returned a transcript",
    });
    expect(gradeSelection(WRITE, turn, { effect: { effects: 1 } }).status).toBe("invalid");
  });

  it("counts a reviewed equivalent that answers completely as an alternative, apart from selected", () => {
    const other = { exchanges: [call("jira_create_fields")], gateway: healthy };
    const reviewed = { ...READ, alternatives: ["jira.create-fields"] };
    expect(gradeSelection(reviewed, other, { tokens: ["High"] })).toMatchObject({
      status: "alternative",
      detail: "jira_create_fields carried every native token",
    });
    expect(gradeSelection(reviewed, other, { tokens: ["High", "Low"] }).status).toBe("wrong-tool");
    // A result that carries the token by coincidence is no alternative without a review.
    expect(gradeSelection(READ, other, { tokens: ["High"] }).status).toBe("wrong-tool");
    const write = { exchanges: [call("jira_edit")], gateway: healthy };
    expect(gradeSelection(WRITE, write, { effect: { effects: 1 } }).status).toBe("alternative");
    expect(gradeSelection(WRITE, write, { effect: { effects: 1, stray: 1 } }).status).toBe(
      "wrong-tool",
    );
  });

  it("grades an unavailable native truth as invalid, never as a model verdict", () => {
    const turn = { exchanges: [call("jira_priorities")], gateway: healthy };
    expect(gradeSelection(READ, turn, { truthUnavailable: true })).toMatchObject({
      status: "invalid",
      detail: "the native truth read failed",
    });
  });

  it("keeps the verdict when a circuit opened and recovered without failing a call", () => {
    const gateway = { unrecovered: 0, circuit: 2 };
    expect(gradeSelection(READ, { exchanges: [], gateway }, { tokens: ["High"] }).status).toBe(
      "no-tool",
    );
  });

  it("requires every token as a whole value, not inside a longer one", () => {
    const turn = {
      exchanges: [call("jira_priorities", { outcome: "succeeded", items: [{ name: "Highest" }] })],
      gateway: healthy,
    };
    expect(gradeSelection(READ, turn, { tokens: ["High"] }).status).toBe("wrong-result");
    const quoted = call("x", { outcome: "succeeded", items: [{ name: 'Say "hi"' }] });
    expect(carriesTruth(quoted, ['Say "hi"']).complete).toBe(true);
  });

  it("credits a write only for exactly one correct native effect through the target", () => {
    const turn = { exchanges: [call("jira_create_worklog")], gateway: healthy };
    expect(gradeSelection(WRITE, turn, { effect: { effects: 1 } }).status).toBe("selected");
    expect(gradeSelection(WRITE, turn, { effect: { effects: 2 } }).status).toBe("wrong-result");
    expect(gradeSelection(WRITE, turn, { effect: { effects: 1, wrongValue: true } }).status).toBe(
      "wrong-result",
    );
    const failed = {
      exchanges: [
        { call: { name: "jira_create_worklog" }, result: { status: "failed", data: {} } },
      ],
      gateway: healthy,
    };
    expect(gradeSelection(WRITE, failed, { effect: { effects: 1 } }).status).toBe("wrong-result");
    const other = { exchanges: [call("jira_edit")], gateway: healthy };
    expect(gradeSelection(WRITE, other, { effect: { effects: 2 } }).status).toBe("wrong-tool");
    expect(gradeSelection(WRITE, other, { effect: { effects: 0 } }).status).toBe("wrong-tool");
    const none = { exchanges: [], gateway: healthy };
    expect(gradeSelection(WRITE, none, { effect: { effects: 0 } }).status).toBe("no-tool");
  });

  it("grades another operation's stray write as a wrong tool, not as a wrong result", () => {
    const comment = { exchanges: [call("jira_add_comment")], gateway: healthy };
    expect(gradeSelection(WRITE, comment, { effect: { effects: 0, stray: 1 } })).toMatchObject({
      status: "wrong-tool",
      detail: "1 other operation calls, 0 native effects",
    });
  });

  it("grades a target the gateway refused for its arguments as wrong-arguments", () => {
    const gateway = { ...healthy, rejected: { "keiko.jira.create.worklog": 2, "keiko.jira.x": 1 } };
    const turn = { exchanges: [call("jira_discover")], gateway };
    expect(gradeSelection(WRITE, turn, { effect: { effects: 0 } })).toMatchObject({
      status: "wrong-arguments",
      detail: "the target was called; 2 calls refused for their arguments",
    });
    const read = {
      exchanges: [],
      gateway: { ...healthy, rejected: { "keiko.jira.priorities": 1 } },
    };
    expect(gradeSelection(READ, read, { tokens: ["High"] }).status).toBe("wrong-arguments");
    const other = { ...healthy, rejected: { "keiko.jira.resolutions": 1 } };
    expect(
      gradeSelection(READ, { exchanges: [], gateway: other }, { tokens: ["High"] }).status,
    ).toBe("no-tool");
    const exact = { exchanges: [call("jira_edit")], gateway };
    expect(gradeSelection(WRITE, exact, { effect: { effects: 1 } }).status).toBe("alternative");
    const stray = gradeSelection(WRITE, turn, { effect: { effects: 0, stray: 1 } });
    expect(stray.status).toBe("wrong-tool");
    const dashed = { ...healthy, rejected: { "keiko.jira.issue.property.keys": 1 } };
    const keys = { id: "k", tool: "jira.issue-property-keys", effect: "read" };
    expect(gradeSelection(keys, { exchanges: [], gateway: dashed }, { tokens: ["a"] }).status).toBe(
      "wrong-arguments",
    );
  });

  it("reads no refusal evidence for a turn the lane aborted", () => {
    const evidence = { rejected: { "keiko.jira.priorities": 1 }, unidentified: 0, failedCalls: 1 };
    expect(turnRefusals({}, () => evidence)).toBe(evidence);
    expect(turnRefusals({ failure: "aborted" }, () => evidence)).toEqual({
      rejected: {},
      unidentified: 0,
      failedCalls: 0,
    });
  });

  it("fails a correct write that also wrote objects the request did not ask for", () => {
    const turn = { exchanges: [call("jira_create_worklog")], gateway: healthy };
    expect(gradeSelection(WRITE, turn, { effect: { effects: 1, stray: 1 } })).toMatchObject({
      status: "wrong-result",
      detail: "1 writes the request did not ask for",
    });
  });
});

describe("write verification of the remote link and the worklog", () => {
  const issue = "/rest/api/2/issue/KEIKO-1";
  const session = {};
  const entryOf = (id) => SELECTION_CASES.find((entry) => entry.id === id);
  const link = (url) => [{ id: 4, object: { title: "Auswahl t-1 L", url } }];

  it("credits a remote link only with the requested URL and keeps a wrong one for cleanup", async () => {
    const entry = entryOf("remote-link");
    nativeReads.set(`${issue}/remotelink`, link("https://example.invalid/t-1-remote-link"));
    const good = await entry.verify(session, FIXTURE, "Auswahl t-1", "t-1-remote-link");
    expect(good).toMatchObject({ effects: 1, wrongValue: false });
    nativeReads.set(`${issue}/remotelink`, link("https://example.invalid/other"));
    const bad = await entry.verify(session, FIXTURE, "Auswahl t-1", "t-1-remote-link");
    expect(bad).toMatchObject({ effects: 0, wrongValue: true });
    expect(bad.cleanup).toEqual([`${issue}/remotelink/4`]);
  });

  it("credits a worklog only with the requested start instant", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const entry = entryOf("worklog");
    const worklog = (started) => ({
      worklogs: [{ id: "6", comment: "Auswahl t-1 W", timeSpentSeconds: 1800, started }],
    });
    entry.prompt(FIXTURE, "Auswahl t-1", "t");
    nativeReads.set(`${issue}/worklog`, worklog(`${day}T09:00:00.000+0000`));
    expect(await entry.verify(session, FIXTURE, "Auswahl t-1")).toMatchObject({ effects: 1 });
    for (const started of [`${day}T10:00:00.000+0000`, `${day}T09:00:00.000+0200`, "garbage"]) {
      nativeReads.set(`${issue}/worklog`, worklog(started));
      const bad = await entry.verify(session, FIXTURE, "Auswahl t-1");
      expect(bad).toMatchObject({ effects: 0, wrongValue: true });
      expect(bad.cleanup).toEqual([`${issue}/worklog/6`]);
    }
  });
});

describe("selection helpers", () => {
  it("records each called tool with its closed result, never its arguments or data", () => {
    const exchanges = [
      { call: { name: "jira.discover", arguments: { query: "secret words" } }, result: {} },
      call("jira_priorities"),
    ];
    expect(callTrace(exchanges)).toEqual([
      "jira_discover:none:none",
      "jira_priorities:completed:succeeded",
    ]);
    expect(
      gradeSelection(READ, { exchanges, gateway: healthy }, { tokens: ["High"] }).calls,
    ).toHaveLength(2);
  });

  it("reads the path and the truth from the transcript only", () => {
    expect(selectionPath([call("jira_describe")])).toBe("discovery");
    expect(selectionPath([call("jira.search")])).toBe("direct");
    expect(carriesTruth(call("x", { a: "Sprint 1" }), ["Sprint 1"])).toEqual({
      complete: true,
      missing: 0,
    });
  });

  it("finds writes beyond the expected effect and leaves foreign objects in place", () => {
    const row = (owned, label) => ({ owned, label });
    const before = {
      issueState: "a",
      objects: new Map([["/rest/api/2/component/1", row(false, "Old")]]),
    };
    const after = {
      issueState: "b",
      objects: new Map([
        ["/rest/api/2/component/1", row(false, "Old")],
        ["/rest/api/2/component/2", row(false, "Auswahl t-1 K")],
        ["/rest/api/2/component/3", row(false, "Other lane")],
        ["/rest/api/2/component/4", row(false, "Auswahl t-1 K2")],
        ["/issue/X/worklog/9", row(true, "")],
      ]),
    };
    expect(strayWrites(before, after, ["/rest/api/2/component/2"], "Auswahl t")).toEqual({
      remove: ["/rest/api/2/component/4", "/issue/X/worklog/9"],
      foreign: 1,
      changed: 0,
      removed: 0,
      issueChanged: 1,
      count: 4,
    });
    const same = strayWrites(before, before, [], "Auswahl t");
    expect(same.count).toBe(0);
  });

  it("counts renamed, re-stamped and removed objects that the lane cannot undo", () => {
    const before = {
      issueState: "a",
      objects: new Map([
        ["/rest/api/2/component/1", { owned: false, label: "Old" }],
        ["/rest/api/2/issue/K-9", { owned: false, label: "Other", stamp: "t1" }],
        ["/issue/X/remotelink/5", { owned: true, label: "Link" }],
      ]),
    };
    const after = {
      issueState: "a",
      objects: new Map([
        ["/rest/api/2/component/1", { owned: false, label: "Renamed" }],
        ["/rest/api/2/issue/K-9", { owned: false, label: "Other", stamp: "t2" }],
      ]),
    };
    expect(strayWrites(before, after, [], "Auswahl t")).toEqual({
      remove: [],
      foreign: 0,
      changed: 2,
      removed: 1,
      issueChanged: 0,
      count: 3,
    });
  });

  it("removes a stray vote as its own voter and skips the expected one by its key", () => {
    const issue = "/rest/api/2/issue/X";
    const api = actorDetails("api").name;
    const editor = actorDetails("editor").name;
    const before = { issueState: "a", objects: new Map() };
    const after = {
      issueState: "a",
      objects: new Map(
        voteRows(issue, { voters: [{ name: api }, { name: editor }, { name: "x" }] }),
      ),
    };
    // The vote case's expected removal, built through the same key helper as the snapshot.
    const expected = [{ key: voteKey(issue, api), path: `${issue}/votes`, actor: "api" }];
    expect(strayWrites(before, after, expected, "Auswahl t")).toEqual({
      remove: [{ path: `${issue}/votes`, actor: "editor" }],
      foreign: 1,
      changed: 0,
      removed: 0,
      issueChanged: 0,
      count: 2,
    });
  });

  it("marks a run that lost most attempts as insufficient", () => {
    const attempts = (statuses) => statuses.map((status) => ({ id: "a", catalog: "base", status }));
    expect(summarizeSelection(attempts(["invalid", "invalid", "selected"])).sufficient).toBe(false);
    expect(summarizeSelection(attempts(["invalid", "selected"])).sufficient).toBe(true);
    expect(summarizeSelection([]).sufficient).toBe(false);
  });

  it("summarizes the pass rate over valid attempts and counts invalid ones apart", () => {
    const summary = summarizeSelection([
      { id: "a", catalog: "base", status: "selected" },
      { id: "a", catalog: "base", status: "invalid" },
      { id: "b", catalog: "discovery", status: "wrong-tool" },
    ]);
    expect(summary).toMatchObject({ valid: 2, selected: 1, invalid: 1 });
    expect(summary.rows.find((row) => row.id === "a")).toMatchObject({ valid: 1, selected: 1 });
  });
});

describe("everyday operations beyond the base set (#4369)", () => {
  const entryOf = (id) => SELECTION_CASES.find((entry) => entry.id === id);
  const comment = "/rest/api/2/issue/KEIKO-1/comment/77";
  const session = {};

  it("holds a case for every everyday operation the child names", () => {
    const tools = new Set(SELECTION_CASES.map((entry) => entry.tool));
    for (const tool of [
      "jira.update-comment",
      "jira.get-comment",
      "jira.create-issue-link",
      "jira.link-types",
      "jira.users",
      "jira.myself",
      "jira.fields",
      "jira.priorities",
      "jira.statuses",
      "jira.resolutions",
      "jira.project-statuses",
      "jira.delete-issue",
    ])
      expect(tools, tool).toContain(tool);
  });

  it("grades get-comment from the native comment text", async () => {
    nativeReads.set(comment, { id: "77", body: "Auswahl Kommentar t" });
    expect(await entryOf("get-comment").truth(session, FIXTURE)).toEqual(["Auswahl Kommentar t"]);
  });

  it("credits an updated comment only with the requested text and expects its own change", async () => {
    const entry = entryOf("update-comment");
    nativeReads.set(comment, { body: "Auswahl t-1 U" });
    expect(await entry.verify(session, FIXTURE, "Auswahl t-1")).toMatchObject({
      effects: 1,
      wrongValue: false,
      changed: [comment],
    });
    nativeReads.set(comment, { body: "Something else" });
    expect(await entry.verify(session, FIXTURE, "Auswahl t-1")).toMatchObject({
      effects: 0,
      wrongValue: true,
    });
    nativeReads.set(comment, { body: "Auswahl Kommentar t" });
    expect(await entry.verify(session, FIXTURE, "Auswahl t-1")).toMatchObject({
      effects: 0,
      wrongValue: false,
    });
  });

  it("does not count the case's own comment change or issue removal as stray writes", () => {
    const row = (label) => ({ owned: true, label });
    const before = {
      issueState: "a",
      objects: new Map([
        [comment, row("old")],
        ["/rest/api/2/issue/KEIKO-9", { owned: false, label: "Auswahl Löschen t", stamp: "s" }],
      ]),
    };
    const after = { issueState: "a", objects: new Map([[comment, row("new")]]) };
    expect(strayWrites(before, after, [], "Auswahl t").count).toBe(2);
    expect(
      strayWrites(before, after, [], "Auswahl t", {
        changed: [comment],
        removed: ["/rest/api/2/issue/KEIKO-9"],
      }).count,
    ).toBe(0);
  });
});

describe("catalog-level refusals of jira.describe (#4369)", () => {
  const refused = (name = "jira_describe") => ({
    call: { name },
    result: {
      status: "failed",
      reason: "provider-reported-error",
      data: { outcome: "failed", reason: "invalid-arguments" },
    },
  });
  const rejected = {
    call: { name: "jira.describe" },
    result: { status: "rejected", reason: "invalid-arguments", data: null },
  };

  it("counts a tool's own failed result and a dispatcher rejection, and the first call", () => {
    expect(describeTrace([refused(), call("jira_describe"), rejected])).toEqual({
      calls: 3,
      refused: 2,
      failed: 2,
      gatewayRefused: 0,
      firstRefused: true,
    });
    expect(describeTrace([call("jira_describe"), refused()])).toEqual({
      calls: 2,
      refused: 1,
      failed: 1,
      gatewayRefused: 0,
      firstRefused: false,
    });
  });

  it("counts neither other tools nor another failure of describe", () => {
    const other = {
      call: { name: "jira_describe" },
      result: { status: "failed", data: { outcome: "failed", reason: "selection-too-large" } },
    };
    expect(describeTrace([refused("jira_priorities"), other, call("jira_discover")])).toEqual({
      calls: 1,
      refused: 0,
      failed: 1,
      gatewayRefused: 0,
      firstRefused: false,
    });
    expect(describeTrace([])).toEqual({
      calls: 0,
      refused: 0,
      failed: 0,
      gatewayRefused: 0,
      firstRefused: false,
    });
  });

  it("reports the trace on every graded attempt and summarizes the valid ones", () => {
    const graded = gradeSelection(
      READ,
      { exchanges: [refused(), call("jira_describe"), call("jira_priorities")], gateway: healthy },
      { tokens: ["High"] },
    );
    expect(graded.describe).toEqual({
      calls: 2,
      refused: 1,
      failed: 1,
      gatewayRefused: 0,
      firstRefused: true,
    });
    const invalid = {
      status: "invalid",
      describe: { calls: 1, refused: 1, failed: 1, firstRefused: true },
    };
    expect(
      describeSummary([
        { status: "selected", describe: graded.describe },
        { status: "selected", describe: { calls: 0, refused: 0, failed: 0, firstRefused: false } },
        invalid,
      ]),
    ).toEqual({
      turns: 1,
      firstRefusedTurns: 1,
      calls: 2,
      refused: 1,
      failed: 1,
      gatewayRefused: 0,
      validTurns: 2,
    });
    expect(summarizeSelection([{ id: "a", catalog: "base", ...graded }]).describe).toMatchObject({
      firstRefusedTurns: 1,
    });
  });
});

describe("the gateway's own refusal of jira.describe (#4369)", () => {
  it("is counted apart from the transcript, which never holds it", () => {
    const rejected = { "keiko.jira.describe": 2, "keiko.jira.edit": 1 };
    expect(describeTrace([], { rejected })).toMatchObject({ calls: 0, gatewayRefused: 2 });
    const graded = gradeSelection(
      READ,
      { exchanges: [call("jira_priorities")], gateway: { ...healthy, rejected } },
      { tokens: ["High"] },
    );
    expect(graded.describe.gatewayRefused).toBe(2);
    expect(
      describeSummary([{ status: "selected", describe: graded.describe }]).gatewayRefused,
    ).toBe(2);
  });
});

describe("a native truth beyond the bound is refused, never cut (#4369)", () => {
  const entry = (id) => SELECTION_CASES.find((candidate) => candidate.id === id);
  const rows = (count) =>
    Array.from({ length: count }, (_, index) => ({ name: `Status ${index}` }));

  it.each([21, 25])(
    "refuses %s native statuses instead of grading against twenty",
    async (count) => {
      nativeReads.set("/rest/api/2/status", rows(count));
      await expect(selectionTruth({}, FIXTURE, entry("statuses"))).rejects.toThrow(TypeError);
    },
  );

  it("keeps all twenty statuses and a duplicate name counts once", async () => {
    nativeReads.set("/rest/api/2/status", [...rows(20), { name: "Status 0" }].slice(0, 20));
    expect(await selectionTruth({}, FIXTURE, entry("statuses"))).toHaveLength(20);
  });

  it("refuses any generic truth beyond twenty distinct tokens", async () => {
    nativeReads.set("/rest/api/2/priority", rows(21));
    await expect(selectionTruth({}, FIXTURE, entry("priorities"))).rejects.toThrow(RangeError);
  });
});

describe("the new cases grade red where the product is wrong (#4369)", () => {
  const entry = (id) => SELECTION_CASES.find((candidate) => candidate.id === id);
  const grade = (id, exchanges, proof) =>
    gradeSelection(entry(id), { exchanges, gateway: healthy }, proof);

  it("delete-issue: the target succeeded but the issue is still present", () => {
    const verdict = grade("delete-issue", [call("jira_delete_issue")], {
      effect: { effects: 0, stray: 0 },
    });
    expect(verdict.status).toBe("wrong-result");
  });

  it("delete-issue: another issue was deleted too, so the deletion is a stray write", () => {
    const verdict = grade("delete-issue", [call("jira_delete_issue")], {
      effect: { effects: 1, stray: 1 },
    });
    expect(verdict).toMatchObject({
      status: "wrong-result",
      detail: expect.stringContaining("1 writes"),
    });
  });

  it("delete-issue: no call and no deletion is no-tool, a deletion without the tool is wrong-tool", () => {
    expect(grade("delete-issue", [], { effect: { effects: 0, stray: 0 } }).status).toBe("no-tool");
    expect(
      grade("delete-issue", [call("jira_edit")], { effect: { effects: 0, stray: 0 } }).status,
    ).toBe("wrong-tool");
  });

  it("update-comment: a wrong value is red, the exact text is green", () => {
    const wrong = { effects: 0, wrongValue: true, stray: 0 };
    expect(grade("update-comment", [call("jira_update_comment")], { effect: wrong }).status).toBe(
      "wrong-result",
    );
    const exact = { effects: 1, wrongValue: false, stray: 0 };
    expect(grade("update-comment", [call("jira_update_comment")], { effect: exact }).status).toBe(
      "selected",
    );
  });

  it.each([
    ["users", "jira_users", ["Synthetic api"], { items: [{ displayName: "Somebody else" }] }],
    ["fields", "jira_fields", ["customfield_10112"], { items: [{ id: "customfield_10999" }] }],
    [
      "get-comment",
      "jira_get_comment",
      ["Auswahl Kommentar t"],
      { body: "Auswahl Kommentar other" },
    ],
  ])("%s: a result without the native token is wrong-result", (id, tool, tokens, data) => {
    const verdict = grade(id, [call(tool, { outcome: "succeeded", ...data })], { tokens });
    expect(verdict.status).toBe("wrong-result");
    expect(verdict.missingTokens).toEqual(tokens);
  });

  it("statuses: one status missing from an otherwise complete answer is wrong-result", () => {
    const tokens = ["To Do", "In Progress", "Done"];
    const data = { outcome: "succeeded", items: [{ name: "To Do" }, { name: "Done" }] };
    const verdict = grade("statuses", [call("jira_statuses", data)], { tokens });
    expect(verdict).toMatchObject({ status: "wrong-result", missingTokens: ["In Progress"] });
    const full = { outcome: "succeeded", items: tokens.map((name) => ({ name })) };
    expect(grade("statuses", [call("jira_statuses", full)], { tokens }).status).toBe("selected");
  });
});

describe("issue-create cases, one per type (#4369)", () => {
  const entry = (id) => SELECTION_CASES.find((candidate) => candidate.id === id);
  const session = {};
  const searchPath = (project, type, summary) =>
    `/rest/api/2/search?jql=${encodeURIComponent(`project = ${project} AND issuetype = "${type}" AND summary ~ "\\"${summary}\\""`)}&fields=summary,parent&maxResults=10`;
  const found = (key, summary, extra = {}) => ({
    issues: [{ key, fields: { summary, ...extra } }],
  });
  const CASES = [
    ["create-task", "Task", "KEIKO"],
    ["create-subtask", "Sub-task", "KEIKO"],
    ["create-epic", "Epic", "REQ"],
    ["create-story", "Story", "REQ"],
    ["create-bug", "Bug", "REQ"],
  ];

  it("holds one write case per issue type, naming the type and the summary but never the tool", () => {
    for (const [id, type, project] of CASES) {
      const create = entry(id);
      expect(create).toMatchObject({ effect: "write", tool: "jira.create", catalog: "base" });
      const prompt = create.prompt(FIXTURE, "Auswahl t-1", "tag");
      expect(prompt).toContain(`Vorgang vom Typ ${type}`);
      expect(prompt).toContain(`Auswahl t-1 ${type}`);
      expect(prompt).toContain(project);
      expect(prompt).not.toMatch(/jira[._]/u);
    }
    expect(entry("create-subtask").prompt(FIXTURE, "m", "t")).toContain("KEIKO-1");
  });

  it.each(CASES)(
    "%s: one exact new issue is the effect and is removed by its plain path",
    async (id, type, project) => {
      const summary = `Auswahl t-1 ${type}`;
      nativeReads.set(
        searchPath(project, type, summary),
        found("KEIKO-7", summary, type === "Sub-task" ? { parent: { key: "KEIKO-1" } } : {}),
      );
      const effect = await entry(id).verify(session, FIXTURE, "Auswahl t-1");
      expect(effect).toMatchObject({ effects: 1, wrongValue: false });
      expect(effect.cleanup).toEqual(["/rest/api/2/issue/KEIKO-7"]);
    },
  );

  it("is no effect for a differing summary, and a wrong parent is a wrong value", async () => {
    nativeReads.set(
      searchPath("KEIKO", "Task", "Auswahl t-1 Task"),
      found("KEIKO-7", "Andere Zusammenfassung"),
    );
    expect(await entry("create-task").verify(session, FIXTURE, "Auswahl t-1")).toMatchObject({
      effects: 0,
      cleanup: [],
    });
    nativeReads.set(
      searchPath("KEIKO", "Sub-task", "Auswahl t-1 Sub-task"),
      found("KEIKO-8", "Auswahl t-1 Sub-task", { parent: { key: "KEIKO-99" } }),
    );
    expect(await entry("create-subtask").verify(session, FIXTURE, "Auswahl t-1")).toMatchObject({
      effects: 0,
      wrongValue: true,
    });
  });

  it("grades red where the product is wrong: no write, a stray write, a refused call", () => {
    const create = entry("create-story");
    const turn = (exchanges) => ({ exchanges, gateway: healthy });
    expect(gradeSelection(create, turn([]), { effect: { effects: 0, stray: 0 } }).status).toBe(
      "no-tool",
    );
    expect(
      gradeSelection(create, turn([call("jira_create")]), { effect: { effects: 1, stray: 2 } })
        .status,
    ).toBe("wrong-result");
    expect(
      gradeSelection(create, turn([call("jira_create")]), { effect: { effects: 0, stray: 0 } })
        .status,
    ).toBe("wrong-result");
    expect(
      gradeSelection(create, turn([call("jira_create")]), { effect: { effects: 1, stray: 0 } })
        .status,
    ).toBe("selected");
    expect(
      gradeSelection(create, turn([call("jira_edit")]), { effect: { effects: 0, stray: 0 } })
        .status,
    ).toBe("wrong-tool");
  });
});

describe("attemptBatches", () => {
  // One credential per attempt; a product instance retains at most 64 (#4352).
  const PRODUCT_CREDENTIAL_BOUND = 64;

  it("keeps every lifecycle under the product's credential bound", () => {
    expect(LIFECYCLE_ATTEMPTS_MAX).toBeLessThanOrEqual(PRODUCT_CREDENTIAL_BOUND / 2);
    const batches = attemptBatches(SELECTION_CASES, 3);
    expect(batches.every((batch) => batch.length <= LIFECYCLE_ATTEMPTS_MAX)).toBe(true);
    // The full run of three rounds exceeds the bound, which is why it needs more than one.
    expect(SELECTION_CASES.length * 3).toBeGreaterThan(PRODUCT_CREDENTIAL_BOUND);
    expect(batches.length).toBeGreaterThan(1);
  });

  it("schedules every case in every round once, in round order", () => {
    const flat = attemptBatches(SELECTION_CASES, 3).flat();
    expect(flat).toHaveLength(SELECTION_CASES.length * 3);
    expect(flat.map((item) => item.round)).toEqual(
      [1, 2, 3].flatMap((round) => SELECTION_CASES.map(() => round)),
    );
    expect(flat.slice(0, SELECTION_CASES.length).map((item) => item.entry.id)).toEqual(
      SELECTION_CASES.map((entry) => entry.id),
    );
  });

  it("handles one case, one round and an exact multiple of the lifecycle size", () => {
    const one = SELECTION_CASES.slice(0, 1);
    expect(attemptBatches(one, 1)).toHaveLength(1);
    expect(attemptBatches(one, 4, 2).map((batch) => batch.length)).toEqual([2, 2]);
    expect(attemptBatches(one, 5, 2).map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(attemptBatches([], 3)).toEqual([]);
  });
});

describe("refusalTrace", () => {
  const ok = {
    call: { name: "jira.priorities" },
    result: { status: "completed", data: { outcome: "succeeded" } },
  };

  it("keeps nothing for calls that succeeded", () => {
    expect(refusalTrace([ok])).toEqual([]);
  });

  it("keeps the closed reason, the refused argument names and the message as received", () => {
    const refused = {
      call: {
        name: "jira.upsert-remote-link",
        arguments: { url: "https://example.invalid/secret" },
      },
      result: {
        status: "failed",
        data: {
          outcome: "rejected",
          reason: "invalid-arguments",
          invalidArguments: ["globalId", "object.url"],
          guidance: "Name the link target.",
          items: [{ summary: "issue content that must not be copied" }],
        },
      },
    };
    const [entry] = refusalTrace([ok, refused]);
    expect(entry).toEqual({
      call: "jira_upsert_remote_link",
      argumentNames: ["url"],
      status: "failed",
      outcome: "rejected",
      reason: "invalid-arguments",
      invalidArguments: ["globalId", "object.url"],
      message: "Name the link target.",
    });
    expect(JSON.stringify(entry)).not.toMatch(/example\.invalid|issue content/u);
  });

  it("prefers the dispatcher's reason and bounds every field", () => {
    const [entry] = refusalTrace([
      {
        call: { name: "jira.describe" },
        result: {
          status: "failed",
          reason: "invalid-arguments",
          data: {
            message: "m".repeat(1000),
            invalidArguments: Array.from({ length: 40 }, () => "n".repeat(200)),
          },
        },
      },
    ]);
    expect(entry.reason).toBe("invalid-arguments");
    expect(entry.message).toHaveLength(400);
    expect(entry.invalidArguments).toHaveLength(16);
    expect(entry.invalidArguments.every((name) => name.length === 64)).toBe(true);
  });

  it("reports a call with no result at all with closed placeholders", () => {
    expect(refusalTrace([{ call: { name: "jira.issue" } }])).toEqual([
      {
        call: "jira_issue",
        argumentNames: [],
        status: "none",
        outcome: "none",
        reason: "none",
        invalidArguments: [],
      },
    ]);
  });

  it("names the arguments the model passed, never their values, and bounds them", () => {
    const [entry] = refusalTrace([
      {
        call: {
          name: "jira.assignable-users",
          arguments: {
            query: "keiko-api",
            ["a".repeat(200)]: 1,
            ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i])),
          },
        },
        result: {
          status: "failed",
          data: { outcome: "failed", reason: "provider-reported-error" },
        },
      },
    ]);
    expect(entry.argumentNames).toHaveLength(16);
    expect(entry.argumentNames[0]).toBe("query");
    expect(entry.argumentNames.every((name) => name.length <= 64)).toBe(true);
    expect(JSON.stringify(entry)).not.toContain("keiko-api");
    // A non-object argument list yields no names.
    expect(
      refusalTrace([{ call: { name: "jira.issue", arguments: "x" } }])[0].argumentNames,
    ).toEqual([]);
  });

  it("bounds the closed status, outcome and reason like the other fields", () => {
    const long = "x".repeat(500);
    const [entry] = refusalTrace([
      {
        call: { name: "jira.issue" },
        result: { status: long, data: { outcome: long, reason: long } },
      },
    ]);
    expect(entry.status).toHaveLength(64);
    expect(entry.outcome).toHaveLength(64);
    expect(entry.reason).toHaveLength(64);
  });

  it("is carried by every graded attempt", () => {
    const turn = { exchanges: [ok], gateway: { unrecovered: 0, rejected: {} } };
    expect(gradeSelection(READ, turn, { tokens: ["High"] }).refusals).toEqual([]);
  });
});

describe("a read restricted to one type (search-by-type, #4369)", () => {
  const [entry] = LANGUAGE_SELECTION_CASES;
  const restriction = {
    forbidden: ["KEIKO-5", "KEIKO-6"],
    typeWords: ["10002", "Task", "Aufgabe"],
  };
  const search = (jql, keys) => ({
    exchanges: [
      {
        call: { name: "jira_search", arguments: { jql } },
        result: {
          status: "completed",
          data: { outcome: "succeeded", issues: keys.map((key) => ({ key })) },
        },
      },
    ],
    gateway: healthy,
  });
  const grade = (jql, keys) =>
    gradeSelection(entry, search(jql, keys), { tokens: ["KEIKO-1", "KEIKO-2"], restriction });

  it("is wrong when the JQL names no type and the result carries the other types' keys too", () => {
    // gpt-5.4, de_DE, 2026-11-14: "project = KEIKO ORDER BY key ASC" listed all 36 issues.
    const verdict = grade("project = KEIKO ORDER BY key ASC", ["KEIKO-1", "KEIKO-2", "KEIKO-5"]);
    expect(verdict).toMatchObject({ status: "wrong-result" });
    expect(verdict.detail).toContain("1 issues of other types");
  });

  it.each([
    "project = KEIKO AND issuetype = Task",
    "project = KEIKO AND issuetype = Aufgabe ORDER BY key",
    "project = KEIKO AND type = 10002",
    'project = KEIKO AND issuetype in ("Aufgabe")',
  ])("is selected when the JQL names the type by id or name: %s", (jql) => {
    expect(grade(jql, ["KEIKO-1", "KEIKO-2"]).status).toBe("selected");
  });

  it("is selected when the result holds no other type although the JQL named none", () => {
    expect(grade("project = KEIKO", ["KEIKO-1", "KEIKO-2"]).status).toBe("selected");
  });

  it("does not read a type word inside another word or another type as a restriction", () => {
    expect(
      grade("project = KEIKO AND issuetype = Subtask", ["KEIKO-1", "KEIKO-2", "KEIKO-5"]).status,
    ).toBe("wrong-result");
    expect(
      grade("project = KEIKO AND summary ~ Aufgabe", ["KEIKO-1", "KEIKO-2", "KEIKO-6"]).status,
    ).toBe("wrong-result");
  });

  it("changes nothing for a case without a restriction", () => {
    const turn = { exchanges: [call("jira_priorities")], gateway: healthy };
    expect(gradeSelection(READ, turn, { tokens: ["High"], restriction }).status).toBe("selected");
    expect(gradeSelection(READ, turn, { tokens: ["High"] }).status).toBe("selected");
  });
});
