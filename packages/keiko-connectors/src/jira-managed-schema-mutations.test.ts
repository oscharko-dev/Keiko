import { describe, expect, it } from "vitest";
import { JIRA_SCHEMA_MUTATIONS, parseJiraIssueTemplate, type JiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { SCHEMA_MUTATION_FIXTURE_CASES, SCHEMA_TYPE, SCHEMA_LINK, SCHEMA_TERMS, schemaMutationFixture } from "../../../tests/support/jira-schema-mutation-fixture.js";
import { executeJiraSchemaMutation as execute } from "./jira-managed-schema-mutations.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";

function rule(extra: readonly string[], type = "Task"): JiraIssueTemplate {
  const parsed = parseJiraIssueTemplate(["---", "keiko: jira-issue-template", "version: 1", "project: SYN", `issueType: ${type}`, "activateOn: [create, transition:Ready]", ...extra, "---", "## Acceptance"].join("\n"));
  if (!parsed.ok) throw new TypeError("Invalid synthetic formal rule");
  return parsed.template;
}
describe("fixed native schema mutations", () => {
  it("contains independent fixture inputs for every canonical operation", () => {
    expect(new Set(SCHEMA_MUTATION_FIXTURE_CASES.map((item) => item.name))).toEqual(new Set(JIRA_SCHEMA_MUTATIONS));
  });
  it.each(SCHEMA_MUTATION_FIXTURE_CASES)("sends one exact native method/query/body for $name", async (scenario) => {
    const f = schemaMutationFixture(); const result = await execute(scenario.name, structuredClone(scenario.args), f.request);
    expect(f.calls.filter((call) => call.method !== "GET")).toEqual([{ path: scenario.path, method: scenario.method, body: scenario.body,
      expect: "create" in scenario ? "json" : "none" }]);
    expect(result.receipt).toEqual(scenario.receipt); expect(result.ok).toBe(scenario.confirmed);
    expect(f.calls.at(-1)?.method).toBe("GET");
  });
  it.each(SCHEMA_MUTATION_FIXTURE_CASES)("preflights $name without an effect", async ({ name, args }) => {
    const f = schemaMutationFixture(); expect(await execute(name, structuredClone(args), f.request, true)).toEqual({ ok: true, receipt: {} });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it.each(SCHEMA_MUTATION_FIXTURE_CASES)("keeps uncertainty without replay after lost $name ACK", async (scenario) => {
    const f = schemaMutationFixture(); f.controls.lostAck = true;
    const result = await execute(scenario.name, structuredClone(scenario.args), f.request);
    expect(result).toMatchObject({ ok: false, reason: "timeout", receipt: { userKey: "synthetic-actor" } });
    if ("create" in scenario) { expect(result.receipt?.fieldId).toBeUndefined(); expect(result.receipt?.issueTypeId).toBeUndefined(); expect(result.receipt?.linkTypeId).toBeUndefined(); }
    expect(f.calls.filter((call) => call.method !== "GET")).toHaveLength(1); expect(f.calls.at(-1)?.method).not.toBe("GET");
  });
  it.each(SCHEMA_MUTATION_FIXTURE_CASES)("retains $name known IDs after readback permission loss", async (scenario) => {
    const f = schemaMutationFixture(); f.controls.denyReadback = true;
    expect(await execute(scenario.name, structuredClone(scenario.args), f.request)).toMatchObject({ ok: false, reason: "permission-denied", receipt: scenario.receipt });
    expect(f.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
  });
  it.each(SCHEMA_MUTATION_FIXTURE_CASES)("preserves native $name denial without fabricated success", async (scenario) => {
    const f = schemaMutationFixture(); f.controls.permissionDenied = true;
    expect(await execute(scenario.name, structuredClone(scenario.args), f.request)).toMatchObject({ ok: false, reason: "permission-denied" });
    expect(f.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
  });
  it.each(["jira.create-custom-field", "jira.create-issue-type", "jira.create-link-type"] as const)("never guesses a created ID after bodyless $0 ACK", async (operation) => {
    const scenario = SCHEMA_MUTATION_FIXTURE_CASES.find((item) => item.name === operation); if (scenario === undefined) throw new TypeError("Missing scenario");
    const f = schemaMutationFixture(); f.controls.absentAckId = true;
    const result = await execute(operation, scenario.args, f.request);
    expect(result).toMatchObject({ ok: false, reason: "unavailable" }); expect(f.calls.at(-1)?.method).toBe("POST");
    expect(result.receipt?.fieldId).toBeUndefined(); expect(result.receipt?.issueTypeId).toBeUndefined(); expect(result.receipt?.linkTypeId).toBeUndefined();
  });
  it("does not confirm a pre-existing link ID returned by create", async () => {
    const f = schemaMutationFixture(); f.controls.preexistingAckId = true;
    const scenario = SCHEMA_MUTATION_FIXTURE_CASES[5];
    expect(await execute(scenario.name, scenario.args, f.request)).toMatchObject({ ok: false, reason: "unavailable", receipt: { linkTypeId: "7" } });
  });
  it.each([202, 204])("confirms an approved known target from readback after status-only %s", async (status) => {
    const f = schemaMutationFixture(); f.controls.status = status;
    const scenario = SCHEMA_MUTATION_FIXTURE_CASES[3];
    expect(await execute(scenario.name, scenario.args, f.request)).toMatchObject({ ok: true });
  });
  it("preserves a native2xx even if its optional response body is malformed", async () => {
    const f = schemaMutationFixture(); f.controls.malformed2xx = true;
    const scenario = SCHEMA_MUTATION_FIXTURE_CASES[3];
    expect(await execute(scenario.name, scenario.args, f.request)).toMatchObject({ ok: true });
    expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });
  it("retains acknowledged context when a real programming defect stops readback", async () => {
    const f = schemaMutationFixture(); f.controls.throwReadback = true; const scenario = SCHEMA_MUTATION_FIXTURE_CASES[6];
    let thrown: unknown; try { await execute(scenario.name, scenario.args, f.request); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(JiraAcknowledgedMutationError);
    if (!(thrown instanceof JiraAcknowledgedMutationError)) throw new TypeError("Expected acknowledged failure");
    expect(thrown.cause).toBeInstanceOf(TypeError); expect(thrown.receipt).toEqual(scenario.receipt);
  });
  it("preserves native partial custom-field deletion as unconfirmed", async () => {
    const f = schemaMutationFixture(); f.controls.partialFieldDeletion = true; const scenario = SCHEMA_MUTATION_FIXTURE_CASES[1];
    expect(await execute(scenario.name, scenario.args, f.request)).toMatchObject({ ok: false, reason: "unavailable", receipt: scenario.receipt });
    expect(f.fields.has("customfield_12")).toBe(true);
  });
  it("refuses incompatible native type alternatives before DELETE", async () => {
    const f = schemaMutationFixture(); f.controls.incompatibleAlternative = true; const scenario = SCHEMA_MUTATION_FIXTURE_CASES[4];
    expect(await execute(scenario.name, scenario.args, f.request)).toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("keeps explicitly absent migration alternative out of the fixed native query", async () => {
    const f = schemaMutationFixture(); const scenario = SCHEMA_MUTATION_FIXTURE_CASES[4];
    const result = await execute(scenario.name, { ...scenario.args, expectedAlternative: null }, f.request);
    expect(result.ok).toBe(false); expect(result.receipt?.replacementIssueTypeId).toBeUndefined();
    expect(f.calls.find((call) => call.method === "DELETE")?.path).toBe("issuetype/1");
  });
  it("refuses duplicate reviewed identities and the native51-field limit before reads", async () => {
    const f = schemaMutationFixture(); const scenario = SCHEMA_MUTATION_FIXTURE_CASES[1];
    const duplicate = [scenario.args.expectedFields[0], scenario.args.expectedFields[0]];
    expect(await execute(scenario.name, { ...scenario.args, expectedFields: duplicate }, f.request)).toMatchObject({ ok: false });
    const oversized = Array.from({ length: 51 }, (_, i) => ({ id: `customfield_${i + 1}`, name: `Field ${i + 1}`, custom: true }));
    expect(await execute(scenario.name, { ...scenario.args, expectedFields: oversized }, f.request)).toMatchObject({ ok: false }); expect(f.calls).toEqual([]);
  });
  it("retains unknown ordering after a native acknowledgement instead of trusting array presentation", async () => {
    const f = schemaMutationFixture(); const scenario = SCHEMA_MUTATION_FIXTURE_CASES[9];
    expect(await execute(scenario.name, scenario.args, f.request)).toMatchObject({ ok: false, reason: "unavailable", receipt: scenario.receipt });
    expect(f.calls.at(-1)?.path).toBe("issueLinkType");
  });
  it("does not turn an omitted native description into reviewed null", async () => {
    const f = schemaMutationFixture(); f.controls.omitDescription = true; const scenario = SCHEMA_MUTATION_FIXTURE_CASES[3];
    expect(await execute(scenario.name, { ...scenario.args, expectedIssueType: { ...SCHEMA_TYPE, description: null } }, f.request)).toMatchObject({ ok: false });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("keeps explicit null prior description distinct from an empty desired description", async () => {
    const f = schemaMutationFixture(); const current = f.types.get("1"); if (current === undefined) throw new TypeError("Missing type"); current.description = null;
    const scenario = SCHEMA_MUTATION_FIXTURE_CASES[3];
    expect(await execute(scenario.name, { ...scenario.args, expectedIssueType: { ...SCHEMA_TYPE, description: null } }, f.request)).toMatchObject({ ok: true });
    expect(current.description).toBe("");
  });
  it("uses explicit no-op only after independently binding the exact reviewed configuration", async () => {
    const f = schemaMutationFixture();
    expect(await execute("jira.update-issue-type", { expectedActorKey: "synthetic-actor", expectedIssueType: SCHEMA_TYPE, name: "Task" }, f.request)).toMatchObject({ ok: false, detail: { unchanged: true } });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it.each([{ projectIds: [] }, { projectIds: ["9007199254740993"] }, { projectIds: ["01"] }])("refuses implicit/global or unsafe numeric project contexts %j", async ({ projectIds }) => {
    const f = schemaMutationFixture(); const scenario = SCHEMA_MUTATION_FIXTURE_CASES[0];
    expect(await execute(scenario.name, { ...scenario.args, projectIds }, f.request)).toMatchObject({ ok: false, reason: "field-validation" }); expect(f.calls).toEqual([]);
  });
  it("rejects unknown snapshot properties and unreviewed actor substitution", async () => {
    const f = schemaMutationFixture(); const scenario = SCHEMA_MUTATION_FIXTURE_CASES[6];
    expect(await execute(scenario.name, { ...scenario.args, expectedLinkType: { ...SCHEMA_LINK, self: "https://untrusted.invalid/" } }, f.request)).toMatchObject({ ok: false }); expect(f.calls).toEqual([]);
    f.actor.key = "another-actor";
    expect(await execute(scenario.name, scenario.args, f.request)).toMatchObject({ ok: false, reason: "conflict" }); expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("refuses schema migration when any active source/target type rule has unprovable post-state", async () => {
    const f = schemaMutationFixture(); const scenario = SCHEMA_MUTATION_FIXTURE_CASES[4];
    expect(await execute(scenario.name, scenario.args, f.request, false, () => ({ templates: [rule(["summaryMinLength: 8"])], unreadable: 0 }))).toMatchObject({ ok: false, violations: [{ ruleId: "template-unreadable" }] });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("checks type rename against name-selected formal rules, while allowing an unrelated type", async () => {
    const f = schemaMutationFixture(); const args = { expectedActorKey: "synthetic-actor", expectedIssueType: SCHEMA_TYPE, name: "Renamed" };
    expect(await execute("jira.update-issue-type", args, f.request, false, () => ({ templates: [rule([])], unreadable: 0 }))).toMatchObject({ ok: false, violations: [{ ruleId: "template-unreadable" }] });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    const other = schemaMutationFixture();
    expect(await execute("jira.update-issue-type", args, other.request, false, () => ({ templates: [rule([], "Bug")], unreadable: 0 }))).toMatchObject({ ok: true });
  });
  it("never interprets ordinary prose or terminology as issue enforcement", async () => {
    const f = schemaMutationFixture(); const scenario = SCHEMA_MUTATION_FIXTURE_CASES[10];
    expect(await execute(scenario.name, scenario.args, f.request, false, () => ({ templates: [rule([])], unreadable: 0 }))).toMatchObject({ ok: true });
    const noRecords = schemaMutationFixture(); const remove = SCHEMA_MUTATION_FIXTURE_CASES[4];
    expect((await execute(remove.name, remove.args, noRecords.request, false, () => ({ templates: [], unreadable: 0 }))).receipt).toEqual(remove.receipt);
  });
  it("preserves false/default state and rejects incomplete terminology review", async () => {
    const f = schemaMutationFixture();
    const epic = SCHEMA_TERMS.find((entry) => entry.originalName === "epic");
    if (epic === undefined) throw new TypeError("Missing native epic terminology fixture");
    expect(await execute("jira.set-terminology", { expectedActorKey: "synthetic-actor", expectedEntries: [epic], entries: [{ originalName: "epic", newName: "goal", newNamePlural: "goals" }] }, f.request)).toMatchObject({ ok: false }); expect(f.calls).toEqual([]);
  });
});
