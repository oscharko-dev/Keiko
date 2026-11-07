import { describe, expect, it, vi } from "vitest";
import type {
  JiraMutationReceipt,
  JiraSavedConfigurationMutation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  canConfirmJiraSavedConfiguration,
  isJiraSavedConfigurationOperation,
  validJiraSavedConfigurationReceipt,
} from "./jiraSavedConfigurationReceipts.js";
import { jiraAttemptToolResult, validJiraMutationAttempt } from "./jiraMutationResult.js";

const USER = { userKey: "JIRAUSER10100", username: "Synthetic User" } as const;
const FILTER = { filterId: "9223372036854775807", userKey: USER.userKey } as const;
const PREFERENCE = { ...USER, preferenceKey: "user.notify.own.changes" } as const;
const CASES = [
  { operation: "jira.create-filter", receipt: { ...FILTER, defaultSharingAtomic: false, observedShareScope: "PRIVATE" }, confirm: true },
  { operation: "jira.update-filter", receipt: FILTER, confirm: true },
  { operation: "jira.delete-filter", receipt: FILTER, confirm: false },
  { operation: "jira.set-filter-share-scope", receipt: { ...USER, observedShareScope: "AUTHENTICATED" }, confirm: true },
  { operation: "jira.set-filter-columns", receipt: FILTER, confirm: true },
  { operation: "jira.reset-filter-columns", receipt: FILTER, confirm: true },
  { operation: "jira.add-filter-permission", receipt: { ...FILTER, permissionId: "9007199254740993" }, confirm: true },
  { operation: "jira.delete-filter-permission", receipt: { ...FILTER, permissionId: "9223372036854775807" }, confirm: true },
  { operation: "jira.set-my-preference", receipt: { ...PREFERENCE, preferencePresent: true }, confirm: true },
  { operation: "jira.delete-my-preference", receipt: { ...PREFERENCE, preferencePresent: false }, confirm: false },
] as const satisfies readonly {
  readonly operation: JiraSavedConfigurationMutation;
  readonly receipt: JiraMutationReceipt;
  readonly confirm: boolean;
}[];

function withField(receipt: JiraMutationReceipt, key: PropertyKey, value: unknown): JiraMutationReceipt {
  const result = { ...receipt };
  Object.defineProperty(result, key, { value, enumerable: true, configurable: true });
  return result;
}

function expectRefused(receipt: JiraMutationReceipt, operation: JiraSavedConfigurationMutation): void {
  expect(validJiraSavedConfigurationReceipt(receipt, operation)).toBe(false);
  expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual({ ok: false, reason: "malformed-payload" });
  expect(validJiraMutationAttempt({ ok: false, reason: "timeout", receipt }, operation)).not.toHaveProperty("receipt");
}

describe("saved Jira configuration receipt identities", () => {
  it.each(CASES)("retains exact observed identities and honest confirmation for $operation", ({ operation, receipt, confirm }) => {
    expect(isJiraSavedConfigurationOperation(operation)).toBe(true);
    expect(canConfirmJiraSavedConfiguration(operation)).toBe(confirm);
    expect(validJiraSavedConfigurationReceipt(receipt, operation)).toBe(true);
    const observed = validJiraMutationAttempt({ ok: true, receipt }, operation);
    expect(observed).toEqual(confirm ? { ok: true, receipt } : {
      ok: false, reason: "malformed-payload", receipt,
    });
    const uncertain = validJiraMutationAttempt({ ok: false, reason: "timeout", receipt }, operation);
    expect(uncertain).toEqual({ ok: false, reason: "timeout", receipt });
    for (const outcome of ["unknown", "succeeded-unconfirmed"] as const) {
      const result = jiraAttemptToolResult(outcome, uncertain);
      expect(result).toMatchObject({ isError: true, data: { outcome, ...receipt } });
      expect(result.data).not.toHaveProperty("value");
      expect(result.data).not.toHaveProperty("jql");
    }
    expect(Object.isFrozen(uncertain.receipt)).toBe(true);
  });

  it("does not classify unrelated operations as saved configuration", () => {
    expect(isJiraSavedConfigurationOperation("jira.comment")).toBe(false);
    expect(isJiraSavedConfigurationOperation("jira.delete-worklog")).toBe(false);
  });

  it.each(CASES.filter((entry) => entry.confirm))("requires every own confirmation field for $operation", ({ operation, receipt }) => {
    for (const key of Object.keys(receipt)) {
      const missing = { ...receipt };
      Reflect.deleteProperty(missing, key);
      expect(validJiraMutationAttempt({ ok: true, receipt: missing }, operation)).toEqual({ ok: false, reason: "malformed-payload" });
      Object.setPrototypeOf(missing, { [key]: Reflect.get(receipt, key) });
      expect(validJiraMutationAttempt({ ok: true, receipt: missing }, operation)).toEqual({ ok: false, reason: "malformed-payload" });
    }
  });

  it.each(["filterId", "permissionId"] as const)("keeps canonical int64 precision for %s", (key) => {
    const operation = "jira.add-filter-permission";
    const receipt = { ...FILTER, permissionId: "42" };
    for (const value of ["1", "9007199254740993", "9223372036854775807"])
      expect(validJiraSavedConfigurationReceipt(withField(receipt, key, value), operation)).toBe(true);
    for (const value of ["0", "01", "-1", "+1", "1.0", "1e3", " 1", "1 ", "9223372036854775808", "99999999999999999999", "", 42, 9007199254740992, null])
      expectRefused(withField(receipt, key, value), operation);
  });

  it.each(["userKey", "username"] as const)("preserves bounded native %s and refuses malformed identity text", (key) => {
    const receipt = { ...PREFERENCE, preferencePresent: true };
    for (const value of ["Synthetic User", "x".repeat(255), "Synthetic \u{1f680}"])
      expect(validJiraSavedConfigurationReceipt(withField(receipt, key, value), "jira.set-my-preference")).toBe(true);
    for (const value of ["", " ", "x".repeat(256), "synthetic\nuser", "synthetic\ud800", "synthetic\udc00", null, false])
      expectRefused(withField(receipt, key, value), "jira.set-my-preference");
  });
});

describe("saved configuration receipt object boundaries", () => {
  it.each(CASES)("refuses foreign fields, symbols and hidden fields on $operation", ({ operation, receipt }) => {
    for (const key of ["issueId", "projectId", "issueKeys", "jql", "value", Symbol("foreign")])
      expectRefused(withField(receipt, key, "synthetic"), operation);
    const hidden = { ...receipt };
    Object.defineProperty(hidden, "foreign", { value: "synthetic", enumerable: false });
    expectRefused(hidden, operation);
    const hiddenSymbol = { ...receipt };
    Object.defineProperty(hiddenSymbol, Symbol("hidden"), { value: "synthetic", enumerable: false });
    expectRefused(hiddenSymbol, operation);
  });

  it.each(["userKey", "filterId", "foreign"])("never executes an accessor on %s before rejecting the original candidate", (key) => {
    const receipt = { ...FILTER };
    const getter = vi.fn(() => key === "filterId" ? FILTER.filterId : USER.userKey);
    Object.defineProperty(receipt, key, { get: getter, enumerable: true });
    expectRefused(receipt, "jira.update-filter");
    expect(getter).not.toHaveBeenCalled();
  });

  it("never borrows inherited actor context", () => {
    const receipt = { filterId: FILTER.filterId };
    Object.setPrototypeOf(receipt, { userKey: USER.userKey });
    expectRefused(receipt, "jira.update-filter");
  });

  it("does not evaluate a later filterId getter while validating an earlier browseUrl field", () => {
    const receipt: JiraMutationReceipt = {
      browseUrl: `https://jira.example.test/issues/?filter=${FILTER.filterId}`,
      userKey: USER.userKey,
    };
    const getter = vi.fn(() => FILTER.filterId);
    Object.defineProperty(receipt, "filterId", { get: getter, enumerable: true });
    expectRefused(receipt, "jira.update-filter");
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not invoke or copy an inherited foreign issueKeys getter during partial snapshotting", () => {
    const receipt = { ...FILTER };
    const getter = vi.fn(() => ["SYN-1"]);
    const prototype = {};
    Object.defineProperty(prototype, "issueKeys", { get: getter });
    Object.setPrototypeOf(receipt, prototype);
    const attempt = validJiraMutationAttempt({ ok: false, reason: "timeout", receipt }, "jira.update-filter");
    expect(getter).not.toHaveBeenCalled();
    expect(attempt.receipt).not.toHaveProperty("issueKeys");
    if (attempt.receipt !== undefined) expect(attempt.receipt).toEqual(FILTER);
  });
});

describe("sharing and preference observations", () => {
  it.each(["PRIVATE", "AUTHENTICATED", "GLOBAL"] as const)("requires an independently observed scope and the explicit non-atomic fact for creation: %s", (observedShareScope) => {
    const receipt = { ...FILTER, defaultSharingAtomic: false, observedShareScope } as const;
    expect(validJiraMutationAttempt({ ok: true, receipt }, "jira.create-filter")).toEqual({ ok: true, receipt });
    expectRefused(withField(receipt, "defaultSharingAtomic", true), "jira.create-filter");
    expectRefused(withField(receipt, "observedShareScope", "private"), "jira.create-filter");
    const partial = { userKey: USER.userKey, defaultSharingAtomic: false } as const;
    const pending = validJiraMutationAttempt({ ok: false, reason: "timeout", receipt: partial }, "jira.create-filter");
    expect(pending).toEqual({ ok: false, reason: "timeout", receipt: partial });
    const result = jiraAttemptToolResult("unknown", pending);
    expect(result.data).not.toHaveProperty("filterId");
    expect(result.data).not.toHaveProperty("observedShareScope");
    expect(result.data).toMatchObject({ defaultSharingAtomic: false });
  });

  it.each([
    "jira.user.locale", "jira.user.timezone", "user.notifications.mimetype",
    "user.issues.per.page", "user.keyboard.shortcuts.disabled", "user.notify.own.changes",
  ])("admits only the named nonsecret preference and preserves explicit presence for %s", (preferenceKey) => {
    expect(validJiraSavedConfigurationReceipt({ ...USER, preferenceKey, preferencePresent: true }, "jira.set-my-preference")).toBe(true);
    const receipt = { ...USER, preferenceKey, preferencePresent: false };
    expect(validJiraSavedConfigurationReceipt(receipt, "jira.delete-my-preference")).toBe(true);
    expectRefused(withField(receipt, "preferencePresent", "false"), "jira.delete-my-preference");
    expectRefused(withField(receipt, "preferencePresent", true), "jira.delete-my-preference");
    expectRefused(withField(receipt, "preferencePresent", false), "jira.set-my-preference");
  });

  it.each(["password", "jira.token", "Authorization", "constructor", "__proto__", "toString", "", "jira.user.locale "])("refuses unknown or credential-like preference names: %s", (preferenceKey) => {
    expectRefused({ ...USER, preferenceKey, preferencePresent: true }, "jira.set-my-preference");
    expectRefused({ ...USER, preferenceKey, preferencePresent: false }, "jira.delete-my-preference");
  });

  it.each(CASES.filter((entry) => !entry.confirm))("never promotes an acknowledged $operation to confirmed deletion", ({ operation, receipt }) => {
    const attempt = validJiraMutationAttempt({ ok: true, receipt }, operation);
    expect(attempt).toEqual({ ok: false, reason: "malformed-payload", receipt });
    expect(canConfirmJiraSavedConfiguration(operation)).toBe(false);
    const result = jiraAttemptToolResult("succeeded-unconfirmed", attempt);
    expect(result).toMatchObject({ isError: true, data: { outcome: "succeeded-unconfirmed", ...receipt } });
    expect(result.data).not.toHaveProperty("confirmed");
  });
});

describe("optional server-minted filter links", () => {
  it.each([
    "https://jira.example.test/issues/?filter=9223372036854775807",
    "https://another.example.test/jira/issues/?filter=9223372036854775807",
    "https://jira.example.test/context/nested/issues/?filter=9223372036854775807",
  ])("preserves an exact filter link without requiring it for native confirmation: %s", (browseUrl) => {
    const receipt = { ...FILTER, browseUrl };
    expect(validJiraMutationAttempt({ ok: true, receipt }, "jira.update-filter")).toEqual({ ok: true, receipt });
    expect(validJiraMutationAttempt({ ok: true, receipt: FILTER }, "jira.update-filter")).toEqual({ ok: true, receipt: FILTER });
  });

  it.each([
    "http://127.0.0.1:8080/context/issues/?filter=9223372036854775807",
    "https://jira.example.test/issues/?filter=42",
    "https://jira.example.test/issues/?filter=09223372036854775807",
    "https://jira.example.test/issues/?filter=9223372036854775807&extra=1",
    "https://jira.example.test/issues/?filter=9223372036854775807&filter=42",
    "https://jira.example.test/issues/?filter=9223372036854775807#fragment",
    "https://synthetic:fixture@jira.example.test/issues/?filter=9223372036854775807",
    "https://jira.example.test/browse/9223372036854775807",
    "https://jira.example.test/%2fissues/?filter=9223372036854775807",
    "https://jira.example.test/issues/?filter=%39%32%32%33%33%37%32%30%33%36%38%35%34%37%37%35%38%30%37",
    "javascript:synthetic",
    "/issues/?filter=9223372036854775807",
  ])("refuses a foreign or ambiguous destination: %s", (browseUrl) => {
    expectRefused({ ...FILTER, browseUrl }, "jira.update-filter");
  });

  it("does not accept a filter link for a preference operation", () => {
    expectRefused({ ...PREFERENCE, preferencePresent: true, browseUrl: "https://jira.example.test/issues/?filter=42" }, "jira.set-my-preference");
  });
});
