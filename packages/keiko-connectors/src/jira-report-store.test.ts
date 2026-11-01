// The owner's finished reports (#4179): what a comparison with the backlog may read without a
// report id. A report still being read, another owner's and an expired one are never listed.
import { describe, expect, it } from "vitest";

import type { JiraReportRequest } from "./jira-report-session.js";
import { createJiraReportStore } from "./jira-report-store.js";
import type { JiraReport } from "./jira-report-types.js";

const REQUEST: JiraReportRequest = {
  projectKey: "REP",
  jql: undefined,
  estimateFieldId: undefined,
  asOf: undefined,
  parentFieldIds: [],
  requirementIds: [],
};
// Only identity matters to the store: a finished session holds some report.
const FINISHED = {} as JiraReport;

function counterStore(
  options: { readonly idleTtlMs?: number } = {},
): ReturnType<typeof createJiraReportStore> & { readonly tick: (ms: number) => void } {
  let clock = 0;
  let next = 0;
  const store = createJiraReportStore({
    now: () => clock,
    newId: () => `id-${String(next++)}`,
    ...options,
  });
  return Object.assign(store, {
    tick: (ms: number): void => {
      clock += ms;
    },
  });
}

describe("finished reports of an owner", () => {
  it("lists only finished reports of that owner, newest first", () => {
    const store = counterStore();
    const first = store.start("chat-1", REQUEST);
    store.tick(10);
    const second = store.start("chat-1", REQUEST);
    store.tick(10);
    const reading = store.start("chat-1", REQUEST);
    const other = store.start("chat-2", REQUEST);
    for (const session of [first, second, other]) {
      session.phase = "finished";
      session.report = FINISHED;
    }
    reading.phase = "reading";

    expect(store.finished("chat-1").map((session) => session.id)).toEqual([second.id, first.id]);
    expect(store.finished("chat-2").map((session) => session.id)).toEqual([other.id]);
    expect(store.finished("chat-3")).toEqual([]);
  });

  it("does not list a finished session that holds no report, nor renew the expiry", () => {
    const store = counterStore({ idleTtlMs: 1000 });
    const session = store.start("chat-1", REQUEST);
    session.phase = "finished";
    expect(store.finished("chat-1")).toEqual([]);

    session.report = FINISHED;
    store.tick(900);
    expect(store.finished("chat-1")).toHaveLength(1);
    store.tick(200);
    expect(store.finished("chat-1")).toEqual([]);
  });
});
