import { describe, expect, it } from "vitest";
import { SELECTION_CASES } from "../testing/jira-chat-lab/catalog-selection-cases.mjs";
import {
  callTrace,
  carriesTruth,
  gradeSelection,
  selectionPath,
  summarizeSelection,
} from "../testing/jira-chat-lab/catalog-selection-grade.mjs";
import { strayWrites } from "../testing/jira-chat-lab/catalog-selection-objects.mjs";

const FIXTURE = {
  project: "KEIKO",
  selection: {
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
      const prompt = entry.prompt(FIXTURE, "Auswahl m", "tag");
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
    const wrong = { exchanges: [call("jira_resolutions")], gateway: healthy };
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
    expect(gradeSelection(WRITE, other, { effect: { effects: 1 } }).status).toBe("wrong-tool");
    expect(gradeSelection(WRITE, other, { effect: { effects: 0 } }).status).toBe("no-tool");
  });

  it("fails a correct write that also wrote objects the request did not ask for", () => {
    const turn = { exchanges: [call("jira_create_worklog")], gateway: healthy };
    expect(gradeSelection(WRITE, turn, { effect: { effects: 1, stray: 1 } })).toMatchObject({
      status: "wrong-result",
      detail: "1 writes the request did not ask for",
    });
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
      issueChanged: 1,
      count: 4,
    });
    const same = strayWrites(before, before, [], "Auswahl t");
    expect(same.count).toBe(0);
  });

  it("removes a stray vote as its own voter and skips the expected one by its key", () => {
    const vote = (actor) => ({
      owned: true,
      label: actor,
      removal: { path: "/issue/X/votes", actor },
    });
    const before = { issueState: "a", objects: new Map() };
    const after = {
      issueState: "a",
      objects: new Map([
        ["/issue/X/votes@keiko-api", vote("api")],
        ["/issue/X/votes@keiko-editor", vote("editor")],
        ["/issue/X/votes@someone", { owned: false, label: "someone" }],
      ]),
    };
    const expected = [{ key: "/issue/X/votes@keiko-api", path: "/issue/X/votes", actor: "api" }];
    expect(strayWrites(before, after, expected, "Auswahl t")).toEqual({
      remove: [{ path: "/issue/X/votes", actor: "editor" }],
      foreign: 1,
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
