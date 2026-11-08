import { describe, expect, it, vi } from "vitest";
import {
  JIRA_SCREEN_CONFIGURATION_MUTATIONS, JIRA_BOARD_CONFIGURATION_MUTATIONS, JIRA_SPRINT_LIFECYCLE_MUTATIONS,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  validJiraConfigurationReceipt, canConfirmJiraConfiguration, type JiraConfigurationReceiptOperation,
} from "./jiraConfigurationMutationReceipts.js";
import { jiraAttemptToolResult, validJiraMutationAttempt } from "./jiraMutationResult.js";

const SCREEN = { screenId: "9223372036854775807", tabId: "9007199254740993" } as const;
const FIELD = { ...SCREEN, fieldId: "customfield_10020" } as const;
const BOARD = { boardId: "7", filterId: "9007199254740991", userKey: "synthetic-actor" } as const;
const SPRINT = { sprintId: "11", originBoardId: "7", userKey: "synthetic-actor" } as const;
const SAMPLE = { sprintIds: ["11", "9007199254740991"], userKey: "synthetic-actor", sprintSynced: false } as const;
const CASES = [
  { operation: "jira.add-default-screen-field", receipt: { fieldId: "summary", fieldPresent: true }, confirm: false },
  { operation: "jira.add-screen-tab-field", receipt: { ...FIELD, fieldPresent: true }, confirm: true },
  { operation: "jira.remove-screen-tab-field", receipt: { ...FIELD, fieldPresent: false }, confirm: true },
  { operation: "jira.move-screen-tab-field", receipt: FIELD, confirm: true },
  { operation: "jira.set-screen-field-show-when-empty", receipt: { ...FIELD, showWhenEmpty: false }, confirm: true },
  { operation: "jira.move-screen-tab", receipt: SCREEN, confirm: true },
  { operation: "jira.delete-board", receipt: { ...BOARD, boardPresent: false }, confirm: false },
  { operation: "jira.set-board-refined-velocity", receipt: { ...BOARD, refinedVelocityEnabled: false }, confirm: true },
  { operation: "jira.replace-sprint", receipt: { ...SPRINT, sprintPresent: true }, confirm: true },
  { operation: "jira.delete-sprint", receipt: { ...SPRINT, sprintPresent: false }, confirm: false },
  { operation: "jira.swap-sprints", receipt: { ...SPRINT, swapSprintId: "12" }, confirm: false },
  { operation: "jira.unmap-sprints", receipt: SAMPLE, confirm: true },
  { operation: "jira.unmap-all-sprints", receipt: { ...SAMPLE, allSprints: true }, confirm: false },
] as const satisfies readonly {
  readonly operation: JiraConfigurationReceiptOperation; readonly receipt: JiraMutationReceipt; readonly confirm: boolean;
}[];
function field(receipt: JiraMutationReceipt, key: PropertyKey, value: unknown): JiraMutationReceipt {
  const result = { ...receipt };
  Object.defineProperty(result, key, { value, enumerable: true, configurable: true });
  return result;
}
function refused(receipt: JiraMutationReceipt, operation: JiraConfigurationReceiptOperation): void {
  expect(validJiraConfigurationReceipt(receipt, operation)).toBe(false);
  expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual({ ok: false, reason: "malformed-payload" });
  expect(validJiraMutationAttempt({ ok: false, reason: "timeout", receipt }, operation)).not.toHaveProperty("receipt");
}
describe("screen, board and sprint configuration receipts", () => {
  it("pins all thirteen identities independently of production receipt dispatch", () => {
    expect(CASES.map(({ operation }) => operation).sort()).toEqual([
      ...JIRA_SCREEN_CONFIGURATION_MUTATIONS, ...JIRA_BOARD_CONFIGURATION_MUTATIONS, ...JIRA_SPRINT_LIFECYCLE_MUTATIONS,
    ].sort());
  });
  it.each(CASES)("keeps exact context and requested state for $operation without manufacturing confirmation", ({ operation, receipt, confirm }) => {
    expect(validJiraConfigurationReceipt(receipt, operation)).toBe(true);
    expect(canConfirmJiraConfiguration(operation)).toBe(confirm);
    expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual(confirm
      ? { ok: true, receipt } : { ok: false, reason: "malformed-payload", receipt });
    for (const outcome of ["unknown", "succeeded-unconfirmed"] as const) {
      const attempt = validJiraMutationAttempt({ ok: false, reason: "timeout", receipt }, operation);
      expect(attempt).toEqual({ ok: false, reason: "timeout", receipt });
      expect(jiraAttemptToolResult(outcome, attempt)).toMatchObject({ isError: true, data: { outcome, ...receipt } });
      expect(Object.isFrozen(attempt.receipt)).toBe(true);
    }
  });
  it.each(CASES)("requires all own selected facts for $operation", ({ operation, receipt }) => {
    for (const key of Object.keys(receipt)) {
      const missing = { ...receipt };
      Reflect.deleteProperty(missing, key);
      refused(missing, operation);
      Object.setPrototypeOf(missing, { [key]: Reflect.get(receipt, key) });
      refused(missing, operation);
      const hidden = { ...receipt };
      Object.defineProperty(hidden, key, { value: Reflect.get(receipt, key), enumerable: false });
      refused(hidden, operation);
    }
  });
  it.each(CASES)("rejects foreign fields, URLs, symbols and accessors before copying $operation", ({ operation, receipt }) => {
    for (const key of ["browseUrl", "issueKey", "selectedScreenName", "expectedValue", Symbol("foreign")])
      refused(field(receipt, key, "synthetic"), operation);
    for (const key of [...Object.keys(receipt), "foreign"]) {
      const getter = vi.fn(() => "11");
      const observed = { ...receipt };
      Object.defineProperty(observed, key, { get: getter, enumerable: true });
      refused(observed, operation);
      expect(getter).not.toHaveBeenCalled();
    }
  });
  it("preserves screen int64 values while retaining the stricter native Agile integer boundary", () => {
    expect(validJiraConfigurationReceipt(SCREEN, "jira.move-screen-tab")).toBe(true);
    for (const id of ["0", "01", "-1", "1e2", "9223372036854775808", 42])
      refused(field(SCREEN, "screenId", id), "jira.move-screen-tab");
    for (const id of ["9007199254740992", "9223372036854775807", 7]) {
      refused(field({ ...BOARD, boardPresent: false }, "boardId", id), "jira.delete-board");
      refused(field({ ...SPRINT, sprintPresent: true }, "sprintId", id), "jira.replace-sprint");
    }
    refused({ ...SPRINT, swapSprintId: SPRINT.sprintId }, "jira.swap-sprints");
  });
  it.each(CASES)("never conflates false, unknown or an operation's fixed requested presence for $operation", ({ operation, receipt }) => {
    for (const [key, value] of Object.entries(receipt)) {
      if (typeof value !== "boolean") continue;
      refused(field(receipt, key, null), operation);
      refused(field(receipt, key, String(value)), operation);
      if (key !== "showWhenEmpty" && key !== "refinedVelocityEnabled") refused(field(receipt, key, !value), operation);
    }
  });
  it("snapshots sprint IDs deeply without invoking hidden/getter elements or accepting duplicate/partial arrays", () => {
    const ids = ["11", "12"];
    const attempt = validJiraMutationAttempt({ ok: false, reason: "timeout", receipt: { ...SAMPLE, sprintIds: ids } }, "jira.unmap-sprints");
    ids[0] = "99";
    expect(attempt.receipt?.sprintIds).toEqual(["11", "12"]);
    expect(Object.isFrozen(attempt.receipt?.sprintIds)).toBe(true);
    for (const invalid of [[], ["11", "11"], ["9007199254740992"], Array(2), Array.from({ length: 51 }, (_, i) => String(i + 1))])
      refused(field(SAMPLE, "sprintIds", invalid), "jira.unmap-sprints");
    const getter = vi.fn(() => "11");
    const exotic = ["11"];
    Object.defineProperty(exotic, "0", { get: getter, enumerable: true });
    refused(field(SAMPLE, "sprintIds", exotic), "jira.unmap-sprints");
    expect(getter).not.toHaveBeenCalled();
    const hidden = ["11"];
    Object.defineProperty(hidden, Symbol("foreign"), { value: "12" });
    refused(field(SAMPLE, "sprintIds", hidden), "jira.unmap-sprints");
  });
});
