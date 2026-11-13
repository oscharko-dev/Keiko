import { describe, expect, it } from "vitest";
import type { JiraReportHttp, JiraReportRecordRead } from "./jira-report-http.js";
import { JIRA_EPIC_LINK_SCHEMA_KEY, resolveJiraReportEpicScope } from "./jira-report-epic.js";

const CATALOG = [{ id: "customfield_10014", name: "Link", schemaKey: JIRA_EPIC_LINK_SCHEMA_KEY }];
const KEYS = ["REP-1", ...Array.from({ length: 249 }, (_, index) => `REP-${String(100 + index)}`)];

interface Page {
  readonly startAt: number;
  readonly total: number;
  readonly keys: readonly string[];
}
/** A member list as Jira answers it, paged by the requested offset, with a way to distort a page. */
function memberHttp(distort: (page: Page, call: number) => Page, pageSize = 100): JiraReportHttp {
  let call = 0;
  const getRecord = (path: string): Promise<JiraReportRecordRead> => {
    call += 1;
    const startAt = Number(new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("startAt"));
    const honest: Page = {
      startAt,
      total: KEYS.length,
      keys: KEYS.slice(startAt, startAt + pageSize),
    };
    const page = distort(honest, call);
    return Promise.resolve({
      ok: true,
      body: {
        startAt: page.startAt,
        total: page.total,
        issues: page.keys.map((key) => ({
          key,
          fields: { issuetype: { id: "11", subtask: false } },
        })),
      },
    });
  };
  const refused = (): Promise<never> => Promise.reject(new Error("unexpected request"));
  return { request: refused, getRecord, getAgileRecord: getRecord, getArray: refused };
}
const resolve = (http: JiraReportHttp): ReturnType<typeof resolveJiraReportEpicScope> =>
  resolveJiraReportEpicScope(http, "REP-1", CATALOG);

describe("the Epic member read is complete or it is not a success (#4356)", () => {
  it.each([100, 37, 250])(
    "control: an honest list in pages of %i resolves every member",
    async (size) => {
      const result = await resolve(memberHttp((page) => page, size));
      expect(result.kind).toBe("resolved");
      if (result.kind === "resolved") expect(result.scope.memberCount).toBe(KEYS.length - 1);
    },
  );

  it("does not resolve when an empty page arrives before the stated total", async () => {
    const result = await resolve(
      memberHttp((page, call) => (call === 2 ? { ...page, keys: [] } : page)),
    );
    expect(result).toEqual({ kind: "failed", reason: "malformed-payload" });
  });

  it("reports the scope as moved when the total changes between pages", async () => {
    const result = await resolve(
      memberHttp((page, call) => (call === 2 ? { ...page, total: page.total + 1 } : page)),
    );
    expect(result).toEqual({ kind: "moved" });
  });

  it("reports the scope as moved when a page repeats a key it already enumerated", async () => {
    const result = await resolve(
      memberHttp((page, call) =>
        call === 2 ? { ...page, keys: [KEYS[1] ?? "", ...page.keys.slice(1)] } : page,
      ),
    );
    expect(result).toEqual({ kind: "moved" });
  });

  it("does not resolve a page that starts elsewhere than asked or overruns the total", async () => {
    for (const bad of [
      (page: Page): Page => ({ ...page, startAt: page.startAt + 1 }),
      (page: Page): Page => ({ ...page, total: page.startAt + 1 }),
    ]) {
      const result = await resolve(memberHttp((page, call) => (call === 2 ? bad(page) : page)));
      expect(result.kind).not.toBe("resolved");
    }
  });
});
