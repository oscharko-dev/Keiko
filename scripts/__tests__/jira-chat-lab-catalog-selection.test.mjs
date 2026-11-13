import { describe, expect, it, vi } from "vitest";

const nativeReads = vi.hoisted(() => new Map());
vi.mock("../testing/jira-chat-lab/lab-client.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  basicAuth: (_session, actor) => `auth:${actor}`,
  checked: vi.fn(async (_session, _name, _method, path) => structuredClone(nativeReads.get(path))),
}));
import { SELECTION_CASES } from "../testing/jira-chat-lab/catalog-selection-cases.mjs";
import {
  callTrace,
  carriesTruth,
  describeSummary,
  describeTrace,
  gradeSelection,
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
      firstRefused: true,
    });
    expect(describeTrace([call("jira_describe"), refused()])).toEqual({
      calls: 2,
      refused: 1,
      failed: 1,
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
      firstRefused: false,
    });
    expect(describeTrace([])).toEqual({ calls: 0, refused: 0, failed: 0, firstRefused: false });
  });

  it("reports the trace on every graded attempt and summarizes the valid ones", () => {
    const graded = gradeSelection(
      READ,
      { exchanges: [refused(), call("jira_describe"), call("jira_priorities")], gateway: healthy },
      { tokens: ["High"] },
    );
    expect(graded.describe).toEqual({ calls: 2, refused: 1, failed: 1, firstRefused: true });
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
    ).toEqual({ turns: 1, firstRefusedTurns: 1, calls: 2, refused: 1, failed: 1, validTurns: 2 });
    expect(summarizeSelection([{ id: "a", catalog: "base", ...graded }]).describe).toMatchObject({
      firstRefusedTurns: 1,
    });
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
