import { describe, expect, it } from "vitest";
import { harness, record, reportOf } from "./jira-report.harness.js";
import { DECOY_BLOB, DECOY_RANK, EPIC_LINK, syntheticProject } from "./jira-report.fixture.js";
import type { JiraReportHttp } from "./jira-report-http.js";
import { discoverHierarchyFields } from "./jira-report-metadata.js";
import { JIRA_REPORT_FIELD_CHUNK_CHARS } from "./jira-report-page.js";

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
      rejectedFieldCount: 2,
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

  it("reads every candidate of an instance with many app fields and yields the identical report", async () => {
    const issues = syntheticProject(120);
    const known = reportOf(await harness({ issues }).run({ projectKey: "REP" }));
    const crowded = reportOf(
      await harness({ issues, extraOpaqueFields: 60 }).run({ projectKey: "REP" }),
    );
    expect(record(crowded.completeness).complete).toBe(true);
    expect(record(crowded.hierarchy)).toEqual({
      discovery: "complete",
      fieldCount: 63,
      observedFieldCount: 1,
      // The two decoys and the thirty extra fields holding free text, shown by value.
      rejectedFieldCount: 32,
    });
    for (const section of ["progress", "epics", "coverage", "compliance"] as const)
      expect(crowded[section]).toEqual(known[section]);
  });

  it("splits a field list too long for one request across requests instead of refusing it", async () => {
    const issues = syntheticProject(60);
    const known = reportOf(await harness({ issues }).run({ projectKey: "REP" }));
    const h = harness({ issues, extraOpaqueFields: 400 });
    const crowded = reportOf(await h.run({ projectKey: "REP" }));
    const searches = h.fixture.requests.filter((request) => request.includes(" search?"));
    const lists = searches.map(
      (request) =>
        new URL(`https://x/${request.split(" ")[1] ?? ""}`).searchParams.get("fields") ?? "",
    );
    expect(lists.length).toBeGreaterThan(1);
    for (const list of lists)
      expect(list.length).toBeLessThanOrEqual(JIRA_REPORT_FIELD_CHUNK_CHARS);
    expect(record(crowded.completeness).complete).toBe(true);
    expect(crowded.epics).toEqual(known.epics);
    expect(crowded.coverage).toEqual(known.coverage);
  });

  it("stops asking for a candidate once a value shows it holds no parent, never for a named one", async () => {
    const h = harness({ issues: syntheticProject(300), pageClamp: 100 });
    await h.run({ projectKey: "REP", parentFieldIds: [DECOY_BLOB] });
    const lists = h.fixture.requests
      .filter((request) => request.includes(" search?"))
      .map((request) =>
        new URL(`https://x/${request.split(" ")[1] ?? ""}`).searchParams.get("fields"),
      );
    expect(lists.length).toBeGreaterThan(1);
    expect(lists[0]).toContain(DECOY_RANK);
    expect(lists.at(-1)).not.toContain(DECOY_RANK);
    expect(lists.at(-1)).toContain(DECOY_BLOB);
    expect(lists.at(-1)).toContain(EPIC_LINK);
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
