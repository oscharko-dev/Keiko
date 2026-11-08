import { describe, expect, it, vi } from "vitest";
import { JIRA_AGILE_PLANNING_MUTATIONS, JIRA_VERSION_REMOTE_LINK_MUTATIONS, JIRA_PROJECT_CATEGORY_MUTATIONS,
  type JiraMutationReceipt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { validJiraMutationAttempt, jiraAttemptToolResult } from "./jiraMutationResult.js";
import { validJiraPlanningLifecycleReceipt, canConfirmJiraPlanningLifecycle, type JiraPlanningLifecycleOperation } from "./jiraPlanningLifecycleReceipts.js";
import { AGILE_PLANNING_FIXTURE_CASES } from "../../../../tests/support/jira-agile-planning-fixture.js";
import { VERSION_LINK_MUTATION_CASES } from "../../../../tests/support/jira-version-link-mutation-fixture.js";

const CASES: readonly { operation: JiraPlanningLifecycleOperation; receipt: JiraMutationReceipt; confirm: boolean }[] = [
  ...AGILE_PLANNING_FIXTURE_CASES.map(({ name, receipt }) => ({ operation: name, receipt,
    confirm: name === "jira.epic-remove-issues" || name === "jira.set-issue-estimation" })),
  ...VERSION_LINK_MUTATION_CASES.map(({ tool, expectedReceipt }) => ({ operation: tool, receipt: expectedReceipt, confirm: true })),
  { operation: "jira.create-project-category", receipt: { categoryId: "9223372036854775807", userKey: "synthetic-actor", categoryPresent: true }, confirm: true },
  { operation: "jira.update-project-category", receipt: { categoryId: "9007199254740993", userKey: "synthetic-actor", categoryPresent: true }, confirm: true },
  { operation: "jira.delete-project-category", receipt: { categoryId: "7", userKey: "synthetic-actor", categoryPresent: false }, confirm: false },
];
function changed(receipt: JiraMutationReceipt, key: PropertyKey, value: unknown): JiraMutationReceipt {
  const copy = { ...receipt };
  Object.defineProperty(copy, key, { value, enumerable: true, configurable: true });
  return copy;
}
function refused(receipt: JiraMutationReceipt, operation: JiraPlanningLifecycleOperation): void {
  expect(validJiraPlanningLifecycleReceipt(receipt, operation)).toBe(false);
  expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual({ ok: false, reason: "malformed-payload" });
  expect(validJiraMutationAttempt({ ok: false, reason: "timeout", receipt }, operation)).not.toHaveProperty("receipt");
}
describe("Agile planning, version link and category exact receipts", () => {
  it("pins all eleven operations independently", () => {
    expect(CASES.map(({ operation }) => operation).sort()).toEqual([
      ...JIRA_AGILE_PLANNING_MUTATIONS, ...JIRA_VERSION_REMOTE_LINK_MUTATIONS, ...JIRA_PROJECT_CATEGORY_MUTATIONS,
    ].sort());
  });
  it.each(CASES)("retains validated $operation target context without fake confirmation", ({ operation, receipt, confirm }) => {
    expect(validJiraPlanningLifecycleReceipt(receipt, operation)).toBe(true);
    expect(canConfirmJiraPlanningLifecycle(operation)).toBe(confirm);
    expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual(confirm
      ? { ok: true, receipt } : { ok: false, reason: "malformed-payload", receipt });
    for (const outcome of ["unknown", "succeeded-unconfirmed"] as const) {
      const attempt = validJiraMutationAttempt({ ok: false, reason: "timeout", receipt }, operation);
      expect(attempt).toMatchObject({ ok: false, receipt });
      expect(jiraAttemptToolResult(outcome, attempt)).toMatchObject({ isError: true, data: { outcome, ...receipt } });
    }
  });
  it.each(CASES)("requires own complete context for $operation without invoking getters", ({ operation, receipt }) => {
    const plain = { ...receipt };
    Object.setPrototypeOf(plain, null);
    expect(validJiraPlanningLifecycleReceipt(plain, operation)).toBe(true);
    for (const key of Object.keys(receipt)) {
      const missing = { ...receipt }; Reflect.deleteProperty(missing, key);
      refused(missing, operation);
      Object.setPrototypeOf(missing, { [key]: Reflect.get(receipt, key) });
      refused(missing, operation);
      const hidden = { ...receipt }; Object.defineProperty(hidden, key, { value: Reflect.get(receipt, key), enumerable: false });
      refused(hidden, operation);
      const getter = vi.fn(() => Reflect.get(receipt, key));
      const accessor = { ...receipt }; Object.defineProperty(accessor, key, { get: getter, enumerable: true });
      refused(accessor, operation);
      expect(getter).not.toHaveBeenCalled();
    }
  });
  it.each(CASES)("refuses foreign URL/value/schema fields and symbols for $operation", ({ operation, receipt }) => {
    for (const key of ["browseUrl", "valueNodes", "absolutePosition", "rank", "expectedActorKey", Symbol("private")])
      refused(changed(receipt, key, "synthetic"), operation);
    refused(changed(receipt, "userKey", "synthetic\ud800"), operation);
  });
  it("requires exact canonical int64 context and distinct aligned issue/anchor identities", () => {
    const rank = AGILE_PLANNING_FIXTURE_CASES[1].receipt;
    for (const value of ["0", "01", "9223372036854775808", 42, undefined])
      refused(changed(rank, "anchorIssueId", value), "jira.rank-epic");
    refused({ ...rank, issueIds: ["10001", "10003"] }, "jira.rank-epic");
    refused({ ...rank, anchorIssueId: "10001" }, "jira.rank-epic");
    refused({ ...rank, anchorIssueKey: "SYN-1" }, "jira.rank-epic");
    refused({ ...rank, boardId: "9007199254740992" }, "jira.rank-epic");
    refused({ ...rank, fieldId: "customfield_9007199254740992" }, "jira.rank-epic");
    expect(validJiraPlanningLifecycleReceipt({ ...rank, issueIds: ["9223372036854775807"] }, "jira.rank-epic")).toBe(true);
  });
  it("deep copies only validated arrays and refuses indexed accessor/sparse/foreign-array data", () => {
    const globalIds = ["release:one", "release:two"];
    const receipt = { versionId: "81", projectId: "10000", projectKey: "SYN", userKey: "synthetic-actor", linkPresent: false, globalIds };
    const retained = validJiraMutationAttempt({ ok: false, reason: "timeout", receipt }, "jira.delete-version-remote-links");
    globalIds[0] = "changed";
    expect(retained.receipt?.globalIds).toEqual(["release:one", "release:two"]);
    expect(Object.isFrozen(retained.receipt?.globalIds)).toBe(true);
    const bad = ["release:one"]; const getter = vi.fn(() => "release:one");
    Object.defineProperty(bad, "0", { get: getter, enumerable: true });
    refused({ ...receipt, globalIds: bad }, "jira.delete-version-remote-links");
    expect(getter).not.toHaveBeenCalled();
    const sparse: string[] = []; sparse.length = 1;
    refused({ ...receipt, globalIds: sparse }, "jira.delete-version-remote-links");
    refused({ ...receipt, globalIds: ["same", "same"] }, "jira.delete-version-remote-links");
    const hidden = ["one"]; Object.defineProperty(hidden, Symbol("foreign"), { value: "x" });
    refused({ ...receipt, globalIds: hidden }, "jira.delete-version-remote-links");
    const hiddenIndex = ["one"]; Object.defineProperty(hiddenIndex, "0", { value: "one", enumerable: false });
    refused({ ...receipt, globalIds: hiddenIndex }, "jira.delete-version-remote-links");
    const inheritedArray = ["one"]; Object.setPrototypeOf(inheritedArray, null);
    refused({ ...receipt, globalIds: inheritedArray }, "jira.delete-version-remote-links");
    expect(validJiraPlanningLifecycleReceipt({ ...receipt, globalIds: [] }, "jira.delete-version-remote-links")).toBe(true);
    const issues = ["10001"]; const keys = ["SYN-1"];
    const removal = validJiraMutationAttempt({ ok: true, receipt: { userKey: "synthetic-actor", issueIds: issues, issueKeys: keys, epicPresent: false } }, "jira.epic-remove-issues");
    issues[0] = "10002"; keys[0] = "SYN-2";
    expect(removal.receipt?.issueIds).toEqual(["10001"]);
    expect(removal.receipt?.issueKeys).toEqual(["SYN-1"]);
  });
  it("keeps opaque collection global IDs distinct from fixed path selectors and bounded in bytes", () => {
    const base = VERSION_LINK_MUTATION_CASES[0].expectedReceipt;
    expect(validJiraPlanningLifecycleReceipt({ ...base, globalId: "https://reference.invalid/opaque?id=1" }, "jira.upsert-version-remote-link")).toBe(true);
    for (const globalId of ["path/segment", "\\", "%2F", ".", "..", "line\n", "bad\ud800"])
      refused({ ...base, globalId }, "jira.upsert-version-remote-link-by-global-id");
    const large = Array.from({ length: 20 }, (_, i) => `${i}:${"é".repeat(1000)}`);
    refused({ versionId: "81", projectId: "10000", projectKey: "SYN", userKey: "synthetic-actor", linkPresent: false, globalIds: large }, "jira.delete-version-remote-links");
  });
  it("binds requested false/presence and seconds rather than inferring them", () => {
    const estimate = AGILE_PLANNING_FIXTURE_CASES[3].receipt;
    expect(validJiraPlanningLifecycleReceipt({ ...estimate, estimationValue: 0 }, "jira.set-issue-estimation")).toBe(true);
    for (const estimationValue of [null, "0", -1, Number.NaN, Number.POSITIVE_INFINITY])
      refused(changed(estimate, "estimationValue", estimationValue), "jira.set-issue-estimation");
    refused({ ...estimate, estimationUnit: "seconds" }, "jira.set-issue-estimation");
    refused({ ...estimate, fieldId: "timeoriginalestimate", estimationUnit: "seconds", estimationValue: 0.1 }, "jira.set-issue-estimation");
    refused({ ...AGILE_PLANNING_FIXTURE_CASES[0].receipt, epicPresent: true }, "jira.epic-remove-issues");
    refused({ ...VERSION_LINK_MUTATION_CASES[2].expectedReceipt, linkPresent: true }, "jira.delete-version-remote-link");
    refused({ categoryId: "7", userKey: "synthetic-actor", categoryPresent: true }, "jira.delete-project-category");
  });
});
