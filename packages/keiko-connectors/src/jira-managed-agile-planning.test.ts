import { describe, expect, it } from "vitest";
import { parseJiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { executeJiraAgilePlanningMutation } from "./jira-managed-agile-planning.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { AGILE_PLANNING_FIXTURE_CASES as CASES, agilePlanningFixture } from "../../../tests/support/jira-agile-planning-fixture.js";

function formal(requiredFields: string) {
  const parsed = parseJiraIssueTemplate(["---", "keiko: jira-issue-template", "version: 1", "project: SYN", "issueType: Story",
    "activateOn: [edit]", `requiredFields: [${requiredFields}]`, "---", ""].join("\n"));
  if (!parsed.ok) throw new TypeError("Synthetic template must parse");
  return () => ({ templates: [parsed.template], unreadable: 0 });
}
function first(f: ReturnType<typeof agilePlanningFixture>) {
  const issue = f.issues.get("10001");
  if (issue === undefined) throw new TypeError("Missing synthetic issue");
  return issue;
}
const writes = (f: ReturnType<typeof agilePlanningFixture>) => f.calls.filter(({ method }) => method !== "GET");

describe("fixed Agile planning effects", () => {
  it.each(CASES)("binds native context and sends one $method $path", async ({ name, args, method, path, receipt }) => {
    const f = agilePlanningFixture();
    const result = await executeJiraAgilePlanningMutation(name, args, f.ports);
    expect(writes(f)).toHaveLength(1);
    expect(writes(f)[0]).toMatchObject({ root: "agile", method, path, expect: "none" });
    expect(result.receipt).toEqual(receipt);
    expect(result.ok).toBe(name === "jira.epic-remove-issues" || name === "jira.set-issue-estimation");
    expect(f.calls.slice(f.calls.findIndex((call) => call.method !== "GET") + 1).every(({ method: after }) => after === "GET")).toBe(true);
    expect(f.calls.at(-1)?.method).toBe("GET");
    expect(Object.isFrozen(result.receipt)).toBe(true);
    if (result.receipt?.issueIds !== undefined) expect(Object.isFrozen(result.receipt.issueIds)).toBe(true);
  });
  it.each(CASES)("admits $name in check mode without an effect", async ({ name, args }) => {
    const f = agilePlanningFixture();
    expect(await executeJiraAgilePlanningMutation(name, args, f.ports, true)).toEqual({ ok: true, receipt: {} });
    expect(writes(f)).toEqual([]);
  });
  it.each(CASES)("retains exact bound IDs and never retries after lost $name ACK", async ({ name, args, receipt }) => {
    const f = agilePlanningFixture(); f.controls.lostAck = true;
    expect(await executeJiraAgilePlanningMutation(name, args, f.ports)).toMatchObject({ ok: false, reason: "timeout", receipt });
    expect(writes(f)).toHaveLength(1);
    expect(f.calls.at(-1)?.method).not.toBe("GET");
  });
  it.each(CASES)("retains target context if $name independent readback is denied", async ({ name, args, receipt }) => {
    const f = agilePlanningFixture(); f.controls.denyReadback = true;
    expect(await executeJiraAgilePlanningMutation(name, args, f.ports)).toMatchObject({ ok: false, reason: "permission-denied", receipt });
    expect(writes(f)).toHaveLength(1);
  });
  it.each(CASES)("refuses changed actor before $name", async ({ name, args }) => {
    const f = agilePlanningFixture(); f.actor.key = "other-actor";
    expect(await executeJiraAgilePlanningMutation(name, args, f.ports)).toMatchObject({ ok: false, reason: "conflict" });
    expect(writes(f)).toEqual([]);
  });
  it("preserves original post-ACK defects and cancellation with known receipt", async () => {
    const selected = CASES[0];
    const f = agilePlanningFixture(); f.controls.throwReadback = true;
    await expect(executeJiraAgilePlanningMutation(selected.name, selected.args, f.ports))
      .rejects.toMatchObject({ constructor: JiraAcknowledgedMutationError, receipt: selected.receipt, cause: new Error("Synthetic planning readback defect") });
    expect(writes(f)).toHaveLength(1);
    const cancelled = agilePlanningFixture(); cancelled.controls.cancelledReadback = true;
    expect(await executeJiraAgilePlanningMutation(selected.name, selected.args, cancelled.ports))
      .toMatchObject({ ok: false, reason: "timeout", receipt: selected.receipt });
    expect(writes(cancelled)).toHaveLength(1);
  });
});

describe("reviewed membership and global rank evidence", () => {
  it("removes only the explicitly reviewed issue, using canonical identities for numeric/lowercase aliases", async () => {
    for (const selector of ["10001", "syn-1"]) {
      const f = agilePlanningFixture();
      const args = { ...CASES[0].args, issues: [{ issueIdOrKey: selector, expectedEpic: { id: "10003", key: "SYN-3" } }] };
      expect(await executeJiraAgilePlanningMutation(CASES[0].name, args, f.ports)).toEqual({ ok: true, receipt: CASES[0].receipt });
      expect(first(f).fields.customfield_10014).toBeNull();
      expect(f.issues.get("10002")?.fields.customfield_10014).toBe("SYN-3");
    }
  });
  it("refuses absent or contradictory epic evidence before POST", async () => {
    const f = agilePlanningFixture(); f.controls.omitEpic = true;
    expect(await executeJiraAgilePlanningMutation(CASES[0].name, CASES[0].args, f.ports)).toMatchObject({ ok: false });
    expect(writes(f)).toEqual([]);
    const conflict = agilePlanningFixture(); first(conflict).fields.customfield_10014 = null;
    expect(await executeJiraAgilePlanningMutation(CASES[0].name, CASES[0].args, conflict.ports)).toMatchObject({ ok: false, reason: "conflict" });
    expect(writes(conflict)).toEqual([]);
  });
  it("does not infer successful removal from missing post-ACK relationship fields", async () => {
    const f = agilePlanningFixture(); const readback = f.ports.requests.readback;
    const requests = { ...f.ports.requests, readback: () => { f.controls.omitEpic = true; return readback(); } };
    expect(await executeJiraAgilePlanningMutation(CASES[0].name, CASES[0].args, { requests })).toMatchObject({ ok: false, receipt: CASES[0].receipt });
    expect(writes(f)).toHaveLength(1);
  });
  it("reports explicit no-op removal without POST", async () => {
    const f = agilePlanningFixture(); first(f).fields.customfield_10014 = null;
    const args = { ...CASES[0].args, issues: [{ issueIdOrKey: "SYN-1", expectedEpic: null }] };
    expect(await executeJiraAgilePlanningMutation(CASES[0].name, args, f.ports)).toMatchObject({ ok: false, detail: { unchanged: true } });
    expect(writes(f)).toEqual([]);
  });
  it("keeps native partial207 unconfirmed, not rejected or success, with no replay", async () => {
    const f = agilePlanningFixture(); f.controls.partialRank = true;
    expect(await executeJiraAgilePlanningMutation(CASES[2].name, CASES[2].args, f.ports)).toMatchObject({ ok: false, reason: "unavailable", receipt: CASES[2].receipt });
    expect(first(f).fields.customfield_10019).toBe("0|native-new:");
    expect(writes(f)).toHaveLength(1);
  });
  it("refuses incomplete board subset or changed configured rank field", async () => {
    const partial = agilePlanningFixture(); partial.controls.partialBoard = true;
    expect(await executeJiraAgilePlanningMutation(CASES[2].name, CASES[2].args, partial.ports)).toMatchObject({ ok: false });
    expect(writes(partial)).toEqual([]);
    const drift = agilePlanningFixture(); drift.board.ranking = { rankCustomFieldId: 999 };
    expect(await executeJiraAgilePlanningMutation(CASES[2].name, CASES[2].args, drift.ports)).toMatchObject({ ok: false, reason: "conflict" });
    expect(writes(drift)).toEqual([]);
  });
  it("refuses duplicate alias targets and an anchor that aliases a moved issue", async () => {
    for (const args of [
      { ...CASES[2].args, issues: [{ issueIdOrKey: "SYN-1", expectedRank: "0|first:" }, { issueIdOrKey: "10001", expectedRank: "0|first:" }] },
      { ...CASES[2].args, anchorIssueIdOrKey: "10001", expectedAnchorRank: "0|first:" },
    ]) {
      const f = agilePlanningFixture();
      expect(await executeJiraAgilePlanningMutation(CASES[2].name, args, f.ports)).toMatchObject({ ok: false, reason: "field-validation" });
      expect(writes(f)).toEqual([]);
    }
  });
});

describe("native estimation units and saved formal admission", () => {
  it("preserves explicit null and zero and sends decimal text without guessing null clears", async () => {
    const f = agilePlanningFixture(); first(f).fields.customfield_10016 = null;
    const args = { ...CASES[3].args, expectedValue: null, value: "0" };
    expect(await executeJiraAgilePlanningMutation(CASES[3].name, args, f.ports)).toMatchObject({ ok: true, receipt: { estimationValue: 0, estimationUnit: "board-number" } });
    expect(writes(f)[0]?.body).toEqual({ value: "0" });
    const missing = agilePlanningFixture(); missing.controls.omitEstimate = true;
    expect(await executeJiraAgilePlanningMutation(CASES[3].name, args, missing.ports)).toMatchObject({ ok: false });
    expect(writes(missing)).toEqual([]);
  });
  it("converts original-estimate numeric minutes to independently observed native seconds", async () => {
    const f = agilePlanningFixture(); f.board.estimation = { type: "field", field: { fieldId: "timeoriginalestimate" } };
    const args = { ...CASES[3].args, fieldId: "timeoriginalestimate", unit: "minutes", expectedValue: 60, value: "2" };
    expect(await executeJiraAgilePlanningMutation(CASES[3].name, args, f.ports)).toMatchObject({ ok: true, receipt: { estimationValue: 120, estimationUnit: "seconds" } });
    expect(writes(f)[0]?.body).toEqual({ value: "2" });
  });
  it.each([null, "1w", "-1", "NaN", "0.000001", "9007199254740992"])("refuses unsupported original-estimate input %s before any request", async (value) => {
    const f = agilePlanningFixture();
    expect(await executeJiraAgilePlanningMutation(CASES[3].name, { ...CASES[3].args, fieldId: "timeoriginalestimate", unit: "minutes", value }, f.ports))
      .toMatchObject({ ok: false, reason: "field-validation" });
    expect(f.calls).toEqual([]);
  });
  it("refuses unknown field type, stale expected value, and target-unit mismatch", async () => {
    const field = agilePlanningFixture(); field.catalog[2] = { id: "customfield_10016", name: "Synthetic estimate", schema: { type: "string" } };
    expect(await executeJiraAgilePlanningMutation(CASES[3].name, CASES[3].args, field.ports)).toMatchObject({ ok: false });
    expect(writes(field)).toEqual([]);
    const stale = agilePlanningFixture(); first(stale).fields.customfield_10016 = 4;
    expect(await executeJiraAgilePlanningMutation(CASES[3].name, CASES[3].args, stale.ports)).toMatchObject({ ok: false, reason: "conflict" });
    expect(writes(stale)).toEqual([]);
    const unit = agilePlanningFixture();
    expect(await executeJiraAgilePlanningMutation(CASES[3].name, { ...CASES[3].args, unit: "minutes" }, unit.ports)).toMatchObject({ ok: false });
    expect(unit.calls).toEqual([]);
  });
  it("enforces required Epic Link removal and refuses required rank unknown post-state", async () => {
    for (const selected of [CASES[0], CASES[2]]) {
      const f = agilePlanningFixture();
      const source = formal(selected.name === "jira.epic-remove-issues" ? "customfield_10014" : "customfield_10019");
      expect(await executeJiraAgilePlanningMutation(selected.name, selected.args, { ...f.ports, templates: source })).toMatchObject({ ok: false, reason: "field-validation" });
      expect(writes(f)).toEqual([]);
    }
  });
  it("does not use old remaining-estimate evidence to admit an unknown time post-state", async () => {
    const f = agilePlanningFixture(); f.board.estimation = { type: "field", field: { fieldId: "timeoriginalestimate" } };
    const args = { ...CASES[3].args, fieldId: "timeoriginalestimate", unit: "minutes", expectedValue: 60, value: "2" };
    expect(await executeJiraAgilePlanningMutation(CASES[3].name, args, { ...f.ports, templates: formal("timeestimate") })).toMatchObject({ ok: false, reason: "field-validation" });
    expect(writes(f)).toEqual([]);
  });
  it("permits unaffected native formal evidence without a second policy engine", async () => {
    const f = agilePlanningFixture();
    expect(await executeJiraAgilePlanningMutation(CASES[3].name, CASES[3].args, { ...f.ports, templates: formal("summary") })).toMatchObject({ ok: true });
    expect(writes(f)).toHaveLength(1);
  });
});
