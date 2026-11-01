import { describe, expect, it } from "vitest";
import { harness, idOf, record, reportOf } from "./jira-report.harness.js";
import { DECOY_BLOB, DECOY_RANK, EPIC_LINK, syntheticProject } from "./jira-report.fixture.js";
import type { JiraReportHttp } from "./jira-report-http.js";
import { discoverHierarchyFields } from "./jira-report-metadata.js";

function listing(items: readonly unknown[]): JiraReportHttp {
  return {
    getArray: () => Promise.resolve({ ok: true, items }),
    getRecord: () => Promise.resolve({ ok: false, reason: "not-found" }),
  };
}

describe("hierarchy discovery depends on the schema shape, never on an app's field-type key", () => {
  it("reads the same report from an instance whose hierarchy app uses other type keys", async () => {
    const issues = syntheticProject(120);
    const known = reportOf(await harness({ issues }).run({ projectKey: "REP" }));
    const foreign = reportOf(
      await harness({ issues, foreignFieldTypeKeys: true }).run({ projectKey: "REP" }),
    );
    expect(record(foreign.hierarchy)).toEqual({
      discovery: "complete",
      fieldCount: 3,
      observedFieldCount: 1,
    });
    expect(foreign.epics).toEqual(known.epics);
    expect(foreign.coverage).toEqual(known.coverage);
    expect(foreign.digest).toBe(known.digest);
  });

  it("asks for every candidate field and trusts only the ones that hold an issue key", async () => {
    const h = harness({ issues: syntheticProject(30), foreignFieldTypeKeys: true });
    const result = await h.run({ projectKey: "REP" });
    const asked = h.fixture.requests.find((request) => request.includes("search?"));
    for (const id of [EPIC_LINK, DECOY_RANK, DECOY_BLOB]) expect(asked).toContain(id);
    expect(record(reportOf(result).hierarchy).observedFieldCount).toBe(1);
    expect(record(record(reportOf(result).coverage).uncoveredEpics).items).toEqual(["REP-4"]);
  });

  it("does not guess when an instance has more candidates than it can read, and says so", async () => {
    const issues = syntheticProject(40);
    const h = harness({ issues, extraOpaqueFields: 40 });
    const first = await h.run({ projectKey: "REP" });
    const second = await h.run({ reportId: idOf(first) });
    expect(second.data.status).toBe("incomplete");
    expect(record(reportOf(second).completeness)).toMatchObject({
      reason: "read-failed",
      failure: "bounds-exceeded",
    });
    const named = reportOf(
      await harness({ issues, extraOpaqueFields: 40 }).run({
        projectKey: "REP",
        parentFieldIds: [EPIC_LINK],
      }),
    );
    expect(record(named.hierarchy)).toEqual({
      discovery: "unavailable",
      fieldCount: 1,
      observedFieldCount: 1,
    });
    expect(record(named.completeness).complete).toBe(true);
  });

  it("selects only app-defined fields of an opaque value shape", async () => {
    const app = { type: "any", custom: "vendor.example:any-key", customId: 1 };
    const outcome = await discoverHierarchyFields(
      listing([
        { id: "customfield_2", schema: app },
        { id: "customfield_1", schema: app },
        { id: "customfield_3", schema: { ...app, type: "string" } },
        { id: "customfield_4", schema: { type: "any" } },
        { id: "customfield_5", schema: { ...app, system: "parent" } },
        { id: "not a field id", schema: app },
        { id: "customfield_6" },
        "not a record",
      ]),
    );
    expect(outcome).toMatchObject({
      discovery: "complete",
      parentFieldIds: ["customfield_1", "customfield_2"],
    });
  });

  it("states an unreadable field list as unavailable with its closed reason", async () => {
    const outcome = await discoverHierarchyFields({
      getArray: () => Promise.resolve({ ok: false, reason: "permission-denied" }),
      getRecord: () => Promise.resolve({ ok: false, reason: "not-found" }),
    });
    expect(outcome).toMatchObject({
      discovery: "unavailable",
      reason: "permission-denied",
      parentFieldIds: [],
    });
  });
});
