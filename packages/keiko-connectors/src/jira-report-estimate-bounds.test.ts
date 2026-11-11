import { expect, it, vi } from "vitest";
import { DEFAULT_ATLASSIAN_SYNC_BOUNDS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { resolveJiraReportEstimate } from "./jira-report-estimate.js";
import type { JiraReportHttp } from "./jira-report-http.js";
import type { JiraReportRequest } from "./jira-report-session.js";

const REQUEST: JiraReportRequest = {
  projectKey: "REP",
  jql: undefined,
  estimateFieldId: undefined,
  asOf: undefined,
  parentFieldIds: [],
  requirementIds: [],
};
const FIELD = { id: "customfield_10200", name: "Story Points" };
const SCREENS = {
  state: "applied" as const,
  byType: new Map<string, readonly string[]>(),
  estimateFields: [FIELD],
};
function http(
  boards: number,
  configuration: () => Promise<Record<string, unknown>>,
): JiraReportHttp {
  return {
    request: () => Promise.resolve({ ok: false, reason: "not-found" }),
    getArray: () => Promise.resolve({ ok: true, items: [] }),
    getRecord: () => Promise.resolve({ ok: false, reason: "not-found" }),
    getAgileRecord: async (path): ReturnType<JiraReportHttp["getAgileRecord"]> => {
      if (!path.startsWith("board?")) return { ok: true, body: await configuration() };
      const query = new URL(path, "https://jira.example.invalid").searchParams;
      const startAt = Number(query.get("startAt"));
      const values = Array.from({ length: boards }, (_, index) => ({ id: index + 1 })).slice(
        startAt,
        startAt + 50,
      );
      return { ok: true, body: { startAt, isLast: startAt + values.length === boards, values } };
    },
  };
}
it("bounds concurrent board-configuration reads without omitting any board", async () => {
  let release = (): void => {
    throw new Error("Gate not initialized");
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0,
    peak = 0,
    calls = 0;
  const configuration = async (): Promise<Record<string, unknown>> => {
    calls += 1;
    active += 1;
    peak = Math.max(peak, active);
    await gate;
    active -= 1;
    return { estimation: { type: "field", field: { fieldId: FIELD.id, displayName: FIELD.name } } };
  };
  const result = resolveJiraReportEstimate(http(9, configuration), REQUEST, SCREENS, []);
  await vi.waitFor(() => {
    expect(calls).toBe(DEFAULT_ATLASSIAN_SYNC_BOUNDS.maxConcurrency);
  });
  release();
  expect(await result).toMatchObject({
    estimateFieldId: FIELD.id,
    estimateSource: "board-configuration",
  });
  expect(calls).toBe(9);
  expect(peak).toBe(DEFAULT_ATLASSIAN_SYNC_BOUNDS.maxConcurrency);
});
it("refuses board discovery above the existing item bound before requesting configurations", async () => {
  const configuration = vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({});
  const result = await resolveJiraReportEstimate(
    http(DEFAULT_ATLASSIAN_SYNC_BOUNDS.maxItems + 1, configuration),
    REQUEST,
    SCREENS,
    [],
  );
  expect(result).toMatchObject({
    estimateUnit: "unavailable",
    estimateSource: "unavailable",
    estimateUnavailableReason: "metadata-unavailable",
  });
  expect(configuration).not.toHaveBeenCalled();
});
