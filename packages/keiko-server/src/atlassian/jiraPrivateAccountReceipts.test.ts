import { describe, expect, it, vi } from "vitest";
import { JIRA_PRIVATE_ACCOUNT_MUTATIONS, type JiraMutationReceipt, type JiraPrivateAccountMutation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { jiraAttemptToolResult, validJiraMutationAttempt } from "./jiraMutationResult.js";
import { validJiraPrivateAccountReceipt as valid, canConfirmJiraPrivateAccount } from "./jiraPrivateAccountReceipts.js";

const SELF = { actorUserKey: "actor-key", userKey: "actor-key", username: "operator" };
const CASES = [
  { operation: "jira.update-myself", receipt: SELF, confirm: true },
  { operation: "jira.update-my-password", receipt: SELF, confirm: false },
  { operation: "jira.update-user-password", receipt: { ...SELF, userKey: "target-key", username: "target" }, confirm: false },
  { operation: "jira.login", receipt: { ...SELF, sessionEstablished: true }, confirm: true },
  { operation: "jira.logout", receipt: SELF, confirm: false },
  { operation: "jira.release-websudo", receipt: SELF, confirm: false },
] as const;
function changed(receipt: JiraMutationReceipt, key: PropertyKey, value: unknown): JiraMutationReceipt {
  const result = { ...receipt }; Object.defineProperty(result, key, { value, enumerable: true, configurable: true }); return result;
}
function refused(receipt: JiraMutationReceipt, operation: JiraPrivateAccountMutation): void {
  expect(valid(receipt, operation)).toBe(false);
  expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual({ ok: false, reason: "malformed-payload" });
  expect(validJiraMutationAttempt({ ok: false, reason: "timeout", receipt }, operation)).not.toHaveProperty("receipt");
}
describe("private account receipt evidence", () => {
  it("pins only the six real write operations, never POST validation or unimplemented unlock", () => {
    expect(CASES.map(({ operation }) => operation)).toEqual([...JIRA_PRIVATE_ACCOUNT_MUTATIONS]);
  });
  it.each(CASES)("keeps $operation observed identities without credential/session claims", ({ operation, receipt, confirm }) => {
    expect(valid(receipt, operation)).toBe(true);
    expect(canConfirmJiraPrivateAccount(operation, receipt)).toBe(confirm);
    expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual(confirm
      ? { ok: true, receipt } : { ok: false, reason: "malformed-payload", receipt });
    const uncertain = validJiraMutationAttempt({ ok: false, reason: "timeout", receipt }, operation);
    const stored = JSON.parse(JSON.stringify(jiraAttemptToolResult("unknown", uncertain)));
    expect(stored).toMatchObject({ isError: true, data: { outcome: "unknown", ...receipt } });
    expect(Object.isFrozen(uncertain.receipt)).toBe(true);
  });
  it("does not substitute a native login acknowledgement for independent cookie identity proof", () => {
    expect(valid(SELF, "jira.login")).toBe(true);
    expect(validJiraMutationAttempt({ ok: true, receipt: SELF }, "jira.login"))
      .toEqual({ ok: false, reason: "malformed-payload", receipt: SELF });
    expect(validJiraMutationAttempt({ ok: false, reason: "unavailable", receipt: SELF }, "jira.login"))
      .toEqual({ ok: false, reason: "unavailable", receipt: SELF });
    for (const flag of [false, "true", 1, null, undefined]) refused(changed(SELF, "sessionEstablished", flag), "jira.login");
    refused({ ...SELF, sessionEstablished: true }, "jira.logout");
  });
  it.each(CASES)("validates original own-data $operation receipts before copying", ({ operation, receipt }) => {
    for (const key of ["password", "currentPassword", "license", "cookie", "headers", "inputId", "displayName", "sessionInvalidated", Symbol("foreign")])
      refused(changed(receipt, key, "synthetic"), operation);
    for (const key of ["actorUserKey", "userKey", "username"] as const) {
      const missing = { ...receipt }; Reflect.deleteProperty(missing, key); refused(missing, operation);
      for (const value of [null, "", "\ud800", "x".repeat(256)]) refused(changed(receipt, key, value), operation);
      const hidden = { ...receipt }; Object.defineProperty(hidden, key, { value: receipt[key], enumerable: false }); refused(hidden, operation);
      const inherited = { ...receipt }; Reflect.deleteProperty(inherited, key); Object.setPrototypeOf(inherited, { [key]: receipt[key] }); refused(inherited, operation);
      const getter = vi.fn(() => receipt[key]); const accessor = { ...receipt };
      Object.defineProperty(accessor, key, { get: getter, enumerable: true }); refused(accessor, operation); expect(getter).not.toHaveBeenCalled();
    }
  });
  it("separates administrator password targets from the connected actor's self operations", () => {
    const other = { ...SELF, userKey: "other" };
    expect(valid(other, "jira.update-user-password")).toBe(true);
    for (const operation of JIRA_PRIVATE_ACCOUNT_MUTATIONS.filter((candidate) => candidate !== "jira.update-user-password"))
      refused(other, operation);
    const maximum = "x".repeat(255);
    expect(valid({ actorUserKey: maximum, userKey: maximum, username: maximum }, "jira.update-myself")).toBe(true);
  });
  it("retains explicit pre-effect unchanged metadata while credential actions remain unconfirmed", () => {
    expect(validJiraMutationAttempt({ ok: false, reason: "conflict", detail: { unchanged: true }, receipt: SELF }, "jira.update-myself"))
      .toMatchObject({ ok: false, reason: "conflict", detail: { unchanged: true }, receipt: SELF });
  });
});

it("retains an unlock target without accepting confirmation or invented process proof", () => {
  const operation = "jira.unlock-user-anonymization" as const;
  const receipt = { actorUserKey: "admin-key", userKey: "anonymized-user", executingNode: "node-2", anonymizationSubmittedTime: "2026-11-08T01:00:00Z" };
  expect(valid(receipt, operation)).toBe(true);
  expect(canConfirmJiraPrivateAccount(operation, receipt)).toBe(false);
  expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual({ ok: false, reason: "malformed-payload", receipt });
  expect(validJiraMutationAttempt({ ok: false, reason: "unavailable", receipt }, operation)).toEqual({ ok: false, reason: "unavailable", receipt });
  expect(valid({ ...receipt, username: "foreign-context" }, operation)).toBe(false);
  expect(valid(changed(receipt, "ownerShutdownVerified", true), operation)).toBe(false);
  expect(valid({ ...receipt, anonymizationSubmittedTime: "x".repeat(129) }, operation)).toBe(false);
  const getter = vi.fn(() => "node-2"); const accessor = { ...receipt };
  Object.defineProperty(accessor, "executingNode", { get: getter, enumerable: true });
  expect(valid(accessor, operation)).toBe(false); expect(getter).not.toHaveBeenCalled();
});
