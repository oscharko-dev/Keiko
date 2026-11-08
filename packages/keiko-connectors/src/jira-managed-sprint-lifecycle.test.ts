import { describe, expect, it } from "vitest";
import { parseJiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { executeJiraSprintLifecycleMutation } from "./jira-managed-sprint-lifecycle.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraSprintLifecycleSnapshot } from "./jira-sprint-lifecycle-values.js";
import { gateJiraBulkReferenceChange } from "./jira-managed-template-gate.js";
import {
  SPRINT_LIFECYCLE_FIXTURE_CASES as CASES, SPRINT_LIFECYCLE_FIRST as FIRST,
  sprintLifecycleFixture,
} from "../../../tests/support/jira-sprint-lifecycle-fixture.js";

function formal(requiredFields: string, activation = "edit", project = "HIDDEN") {
  const parsed = parseJiraIssueTemplate(["---", "keiko: jira-issue-template", "version: 1",
    `project: ${project}`, "issueType: Story", `activateOn: [${activation}]`, `requiredFields: [${requiredFields}]`, "---", ""].join("\n"));
  if (!parsed.ok) throw new Error("Synthetic formal template must parse");
  return () => ({ templates: [parsed.template], unreadable: 0 });
}
const SPRINT_FIELD = { id: "customfield_10020", name: "Sprint", schema: {
  type: "array", items: "string", custom: "com.pyxis.greenhopper.jira:gh-sprint", customId: 10020,
} };

describe("fixed sprint lifecycle effects", () => {
  it.each(CASES)("sends exactly one native $method $path and independently reads afterward", async ({ name, args, method, path }) => {
    const f = sprintLifecycleFixture();
    const result = await executeJiraSprintLifecycleMutation(name, args, f.ports);
    expect(f.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
    expect(f.calls.find((call) => call.method !== "GET")).toMatchObject({ method, path });
    expect(result.receipt?.userKey).toBe("synthetic-actor");
    expect(result.ok).toBe(name === "jira.replace-sprint" || name === "jira.unmap-sprints");
    const effectIndex = f.calls.findIndex((call) => call.method !== "GET");
    expect(f.calls.slice(effectIndex + 1).some((call) => call.method === "GET")).toBe(true);
    expect(result.receipt).not.toHaveProperty("issueCount");
    expect(result.receipt).not.toHaveProperty("browseUrl");
  });

  it.each(CASES)("uses exactly the same admission but no effect for $name preflight", async ({ name, args }) => {
    const f = sprintLifecycleFixture();
    expect(await executeJiraSprintLifecycleMutation(name, args, f.ports, true)).toEqual({ ok: true, receipt: {} });
    expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
  });

  it.each(CASES)("never retries or reads an invented ACK after a lost $name response", async ({ name, args }) => {
    const f = sprintLifecycleFixture();
    f.controls.lostAck = true;
    const result = await executeJiraSprintLifecycleMutation(name, args, f.ports);
    expect(result).toMatchObject({ ok: false, reason: "timeout", receipt: { userKey: "synthetic-actor" } });
    expect(f.calls.filter(({ method }) => method !== "GET")).toHaveLength(1);
    expect(f.calls.at(-1)?.method).not.toBe("GET");
  });

  it.each(CASES)("keeps known context if $name readback is denied", async ({ name, args }) => {
    const f = sprintLifecycleFixture();
    f.controls.denyReadback = true;
    const result = await executeJiraSprintLifecycleMutation(name, args, f.ports);
    expect(result).toMatchObject({ ok: false, reason: "permission-denied", receipt: { userKey: "synthetic-actor" } });
    expect(f.calls.filter(({ method }) => method !== "GET")).toHaveLength(1);
  });

  it("preserves the original post-ACK programming error with known identity", async () => {
    const f = sprintLifecycleFixture();
    f.controls.throwReadback = true;
    const selected = CASES[0];
    await expect(executeJiraSprintLifecycleMutation(selected.name, selected.args, f.ports))
      .rejects.toMatchObject({ constructor: JiraAcknowledgedMutationError, receipt: { sprintId: "11", originBoardId: "7" }, cause: new Error("Synthetic sprint readback defect") });
    expect(f.calls.filter(({ method }) => method !== "GET")).toHaveLength(1);
  });

  it.each(CASES)("rejects stale actor or sprint snapshots before $name", async ({ name, args }) => {
    const f = sprintLifecycleFixture();
    f.actor.key = "different-actor";
    expect(await executeJiraSprintLifecycleMutation(name, args, f.ports)).toMatchObject({ ok: false, reason: "conflict" });
    expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
  });

  it("writes explicit nulls on PUT and does not interpret absent readback fields as successful clears", async () => {
    const f = sprintLifecycleFixture();
    const result = await executeJiraSprintLifecycleMutation(CASES[0].name, CASES[0].args, f.ports);
    expect(result.ok).toBe(true);
    expect(f.calls.find(({ method }) => method === "PUT")?.body).toEqual({
      id: 11, originBoardId: 7, name: "Synthetic renamed", state: "future", startDate: null,
      endDate: null, goal: null, autoStartStop: false, incompleteIssuesDestinationId: null, synced: false,
    });
    const missing = sprintLifecycleFixture();
    const readback = missing.ports.requests.readback;
    const requests = { ...missing.ports.requests, readback: () => {
      const sprint = missing.sprints.get("11");
      if (sprint !== undefined) delete sprint.goal;
      return readback();
    } };
    expect(await executeJiraSprintLifecycleMutation(CASES[0].name, CASES[0].args, { ...missing.ports, requests }))
      .toMatchObject({ ok: false, reason: "conflict", receipt: { sprintId: "11" } });
  });
});

describe("sprint snapshots, native constraints and experimental boundaries", () => {
  it("preserves missing dates and synchronization as unknown rather than null/false", () => {
    const snapshot = jiraSprintLifecycleSnapshot({ id: 11, originBoardId: 7, name: "Synthetic", state: "future" }, true);
    expect(snapshot).toEqual({ id: "11", originBoardId: "7", name: "Synthetic", state: "future" });
    expect(jiraSprintLifecycleSnapshot({ ...FIRST, id: 11 })).toBeUndefined();
    expect(jiraSprintLifecycleSnapshot({ ...FIRST, originBoardId: "9007199254740992" })).toBeUndefined();
    expect(jiraSprintLifecycleSnapshot({ ...FIRST, unreviewedMutableField: true }, true)).toBeUndefined();
  });

  it.each(["synced", "state"])("refuses delete when native %s is unknown or forbids deletion", async (field) => {
    const f = sprintLifecycleFixture();
    const snapshot: CatalogJsonObject = field === "synced" ? { ...FIRST, synced: true } : { ...FIRST, state: "active" };
    const args = { ...CASES[1].args, expectedSprint: snapshot };
    expect(await executeJiraSprintLifecycleMutation("jira.delete-sprint", args, f.ports)).toMatchObject({ ok: false });
    expect(f.calls).toEqual([]);
  });

  it.each(["jira.unmap-sprints", "jira.unmap-all-sprints"] as const)("refuses %s before requests when the closed experimental port is absent", async (name) => {
    const f = sprintLifecycleFixture();
    const selected = CASES.find((item) => item.name === name);
    if (selected === undefined) throw new Error("Missing experimental fixture");
    expect(await executeJiraSprintLifecycleMutation(name, selected.args, { requests: f.ports.requests })).toMatchObject({ ok: false, reason: "unavailable" });
    expect(f.calls).toEqual([]);
  });

  it("never treats a reviewed already-unsynced sample as proof that the whole instance is unmapped", async () => {
    const f = sprintLifecycleFixture();
    const result = await executeJiraSprintLifecycleMutation("jira.unmap-all-sprints", {
      expectedActorKey: "synthetic-actor", expectedSprints: [FIRST], confirmInstanceWide: true,
    }, f.ports);
    expect(result).toMatchObject({ ok: false, receipt: { allSprints: true, sprintSynced: false, sprintIds: ["11"] } });
    expect(f.calls.filter(({ method }) => method !== "GET")).toHaveLength(1);
    expect(f.sprints.get("12")?.synced).toBe(false);
  });

  it("refuses arbitrary headers, incomplete full replacements and unknown destructive selectors", async () => {
    for (const args of [
      { ...CASES[0].args, replacement: { name: "Partial is not replacement" } },
      { ...CASES[0].args, headers: { "X-ExperimentalApi": "true" } },
      { ...CASES[0].args, sprintId: "9007199254740992" },
    ]) {
      const f = sprintLifecycleFixture();
      expect(await executeJiraSprintLifecycleMutation("jira.replace-sprint", args, f.ports)).toMatchObject({ ok: false, reason: "field-validation" });
      expect(f.calls).toEqual([]);
    }
  });
});

describe("formal sprint-field bulk impact", () => {
  it("refuses deletion before any effect for a required Sprint field even in a project hidden from this board actor", async () => {
    const f = sprintLifecycleFixture();
    f.controls.fields = [SPRINT_FIELD];
    const result = await executeJiraSprintLifecycleMutation(CASES[1].name, CASES[1].args, {
      ...f.ports, templates: formal("Sprint"),
    });
    expect(result).toMatchObject({ ok: false, reason: "field-validation", violations: [{ ruleId: "template-unreadable" }] });
    expect(f.calls.filter(({ method }) => method !== "GET")).toEqual([]);
  });

  it("allows unaffected formal fields and never applies membership rules to synced=false only", async () => {
    const f = sprintLifecycleFixture();
    expect(await gateJiraBulkReferenceChange({ request: f.ports.requests.issue, source: formal("summary"), kind: "sprint" })).toEqual({ ok: true });
    const result = await executeJiraSprintLifecycleMutation(CASES[3].name, CASES[3].args, {
      ...f.ports, templates: formal("Sprint"),
    });
    expect(result.ok).toBe(true);
    expect(f.calls.some(({ path }) => path === "field")).toBe(false);
  });

  it("refuses an unreadable formal library and unresolved affected field without inventing zero impact", async () => {
    const f = sprintLifecycleFixture();
    for (const source of [() => ({ templates: [], unreadable: 1 }), formal("Unresolved custom field")]) {
      expect(await gateJiraBulkReferenceChange({ request: f.ports.requests.issue, source, kind: "sprint" }))
        .toMatchObject({ ok: false, reason: "field-validation" });
    }
    expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
  });
});
