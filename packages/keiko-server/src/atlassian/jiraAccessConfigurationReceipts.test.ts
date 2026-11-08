import { describe, expect, it, vi } from "vitest";
import {
  JIRA_ROLE_MUTATIONS,
  JIRA_PERMISSION_SCHEME_MUTATIONS,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { ROLE_MUTATION_FIXTURE_CASES } from "../../../../tests/support/jira-role-mutation-fixture.js";
import { PERMISSION_SCHEME_MUTATION_CASES } from "../../../../tests/support/jira-permission-scheme-mutation-fixture.js";
import { validJiraMutationAttempt, jiraAttemptToolResult } from "./jiraMutationResult.js";
import {
  validJiraAccessConfigurationReceipt as valid,
  canConfirmJiraAccessConfiguration,
  type JiraAccessConfigurationOperation,
} from "./jiraAccessConfigurationReceipts.js";

const CASES: readonly {
  operation: JiraAccessConfigurationOperation;
  receipt: JiraMutationReceipt;
  confirm: boolean;
}[] = [
  ...ROLE_MUTATION_FIXTURE_CASES.map(({ name, receipt, confirmed }) => ({
    operation: name,
    receipt,
    confirm: confirmed,
  })),
  ...PERMISSION_SCHEME_MUTATION_CASES.map(({ tool, receipt }) => ({
    operation: tool,
    receipt,
    confirm: tool !== "jira.delete-permission-scheme",
  })),
];
function changed(
  receipt: JiraMutationReceipt,
  key: PropertyKey,
  value: unknown,
): JiraMutationReceipt {
  const copy = { ...receipt };
  Object.defineProperty(copy, key, { value, enumerable: true, configurable: true });
  return copy;
}
function refused(receipt: JiraMutationReceipt, operation: JiraAccessConfigurationOperation): void {
  expect(valid(receipt, operation)).toBe(false);
  expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual({
    ok: false,
    reason: "malformed-payload",
  });
  expect(
    validJiraMutationAttempt({ ok: false, reason: "timeout", receipt }, operation),
  ).not.toHaveProperty("receipt");
}
describe("exact role and permission configuration receipt boundaries", () => {
  it("pins all fifteen operation-specific contexts", () => {
    expect(CASES.map(({ operation }) => operation).sort()).toEqual(
      [...JIRA_ROLE_MUTATIONS, ...JIRA_PERMISSION_SCHEME_MUTATIONS].sort(),
    );
  });
  it.each(CASES)(
    "keeps $operation targets distinct from confirmed effects",
    ({ operation, receipt, confirm }) => {
      expect(valid(receipt, operation)).toBe(true);
      expect(canConfirmJiraAccessConfiguration(operation)).toBe(confirm);
      expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual(
        confirm ? { ok: true, receipt } : { ok: false, reason: "malformed-payload", receipt },
      );
      for (const outcome of ["unknown", "succeeded-unconfirmed"] as const) {
        const retained = validJiraMutationAttempt(
          { ok: false, reason: "timeout", receipt },
          operation,
        );
        expect(jiraAttemptToolResult(outcome, retained)).toMatchObject({
          isError: true,
          data: { outcome, ...receipt },
        });
      }
    },
  );
  it.each(CASES)(
    "rejects foreign, hidden, accessor, symbol and inherited context for $operation",
    ({ operation, receipt }) => {
      const plain = { ...receipt };
      Object.setPrototypeOf(plain, null);
      expect(valid(plain, operation)).toBe(true);
      for (const key of [
        "browseUrl",
        "effectivePermissions",
        "principals",
        "description",
        "body",
        Symbol("foreign"),
      ])
        refused(changed(receipt, key, "synthetic"), operation);
      for (const key of Object.keys(receipt)) {
        const hidden = { ...receipt };
        Object.defineProperty(hidden, key, { value: Reflect.get(receipt, key), enumerable: false });
        refused(hidden, operation);
        const getter = vi.fn(() => Reflect.get(receipt, key) as unknown);
        const accessor = { ...receipt };
        Object.defineProperty(accessor, key, { get: getter, enumerable: true });
        refused(accessor, operation);
        expect(getter).not.toHaveBeenCalled();
        const inherited = { ...receipt };
        Reflect.deleteProperty(inherited, key);
        Object.setPrototypeOf(inherited, { [key]: Reflect.get(receipt, key) as unknown });
        refused(inherited, operation);
      }
    },
  );
  it.each([
    {
      operation: "jira.create-role",
      receipt: { userKey: "synthetic-actor", rolePresent: true },
      ackKey: "roleId",
    },
    {
      operation: "jira.create-permission-scheme",
      receipt: { userKey: "synthetic-actor", schemePresent: true },
      ackKey: "schemeId",
    },
    {
      operation: "jira.add-permission-grant",
      receipt: { userKey: "synthetic-actor", schemeId: "7", grantPresent: true },
      ackKey: "permissionId",
    },
  ] as const)(
    "retains known context without inventing the missing ACK ID for $operation",
    ({ operation, receipt, ackKey }) => {
      expect(valid(receipt, operation)).toBe(true);
      expect(
        validJiraMutationAttempt({ ok: false, reason: "timeout", receipt }, operation),
      ).toEqual({ ok: false, reason: "timeout", receipt });
      expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual({
        ok: false,
        reason: "malformed-payload",
        receipt,
      });
      refused(changed(receipt, "userKey", undefined), operation);
      const plain = { ...receipt };
      Object.setPrototypeOf(plain, null);
      expect(valid(plain, operation)).toBe(true);
      refused(changed(receipt, ackKey, undefined), operation);
      const getter = vi.fn(() => "7");
      const accessor = { ...receipt };
      Object.defineProperty(accessor, ackKey, { get: getter, enumerable: true });
      refused(accessor, operation);
      expect(getter).not.toHaveBeenCalled();
    },
  );
  it("does not accept incomplete known target or project context", () => {
    const source = ROLE_MUTATION_FIXTURE_CASES[6].receipt;
    for (const key of Object.keys(source)) {
      const value = { ...source };
      Reflect.deleteProperty(value, key);
      refused(value, "jira.add-project-role-actors");
    }
    refused({ userKey: "synthetic-actor", schemePresent: true }, "jira.update-permission-scheme");
    refused(
      { userKey: "synthetic-actor", schemeId: "7", grantPresent: false },
      "jira.delete-permission-grant",
    );
  });
  it("accepts exact string int64 maxima but rejects numeric/lossy/noncanonical identities", () => {
    const role = ROLE_MUTATION_FIXTURE_CASES[0].receipt;
    expect(valid({ ...role, roleId: "9223372036854775807" }, "jira.create-role")).toBe(true);
    for (const id of ["0", "01", "9223372036854775808", "1e3", 7, 9007199254740992, null])
      refused(changed(role, "roleId", id), "jira.create-role");
    const project = ROLE_MUTATION_FIXTURE_CASES[7].receipt;
    refused({ ...project, roleId: "9007199254740993" }, "jira.set-project-role-actors");
    expect(
      valid({ ...project, projectId: "9223372036854775807" }, "jira.set-project-role-actors"),
    ).toBe(true);
  });
  it("validates optional swap only for deletion and a different observed role", () => {
    const deletion = ROLE_MUTATION_FIXTURE_CASES[3].receipt;
    refused({ ...deletion, swapRoleId: "7" }, "jira.delete-role");
    const withoutSwap = { ...deletion };
    Reflect.deleteProperty(withoutSwap, "swapRoleId");
    expect(valid(withoutSwap, "jira.delete-role")).toBe(true);
    refused(changed(ROLE_MUTATION_FIXTURE_CASES[1].receipt, "swapRoleId", "9"), "jira.update-role");
  });
  it("enforces exact actor namespace, operation and principal counts", () => {
    const add = ROLE_MUTATION_FIXTURE_CASES[4].receipt;
    refused({ ...add, roleActorsScope: "project-membership" }, "jira.add-role-default-actors");
    refused({ ...add, actorChange: "replace" }, "jira.add-role-default-actors");
    refused({ ...add, actorGroupNames: ["group"] }, "jira.add-role-default-actors");
    refused({ ...add, actorUserKeys: [] }, "jira.add-role-default-actors");
    const remove = ROLE_MUTATION_FIXTURE_CASES[8].receipt;
    refused({ ...remove, actorUserKeys: ["first", "second"] }, "jira.delete-project-role-actor");
    const replace = ROLE_MUTATION_FIXTURE_CASES[7].receipt;
    expect(
      valid({ ...replace, actorUserKeys: [], actorGroupNames: [] }, "jira.set-project-role-actors"),
    ).toBe(true);
    expect(
      valid(
        { ...replace, actorUserKeys: ["same"], actorGroupNames: ["same"] },
        "jira.set-project-role-actors",
      ),
    ).toBe(true);
  });
  it("copies and freezes original validated principal arrays without invoking getters", () => {
    const keys = ["next-key"];
    const names: string[] = [];
    const receipt = {
      ...ROLE_MUTATION_FIXTURE_CASES[4].receipt,
      actorUserKeys: keys,
      actorGroupNames: names,
    };
    const result = validJiraMutationAttempt(
      { ok: false, reason: "timeout", receipt },
      "jira.add-role-default-actors",
    );
    keys[0] = "changed";
    names.push("changed");
    expect(result.receipt?.actorUserKeys).toEqual(["next-key"]);
    expect(result.receipt?.actorGroupNames).toEqual([]);
    expect(Object.isFrozen(result.receipt?.actorUserKeys)).toBe(true);
    expect(Object.isFrozen(result.receipt?.actorGroupNames)).toBe(true);
    const getter = vi.fn(() => "next-key");
    const indexed = ["next-key"];
    Object.defineProperty(indexed, "0", { get: getter, enumerable: true });
    refused(
      { ...ROLE_MUTATION_FIXTURE_CASES[4].receipt, actorUserKeys: indexed },
      "jira.add-role-default-actors",
    );
    expect(getter).not.toHaveBeenCalled();
    const sparse: string[] = [];
    sparse.length = 1;
    refused(
      { ...ROLE_MUTATION_FIXTURE_CASES[4].receipt, actorUserKeys: sparse },
      "jira.add-role-default-actors",
    );
    const foreign = ["next-key"];
    Object.defineProperty(foreign, Symbol("extra"), { value: "hidden" });
    refused(
      { ...ROLE_MUTATION_FIXTURE_CASES[4].receipt, actorUserKeys: foreign },
      "jira.add-role-default-actors",
    );
    const hiddenIndex = ["next-key"];
    Object.defineProperty(hiddenIndex, "0", { value: "next-key", enumerable: false });
    refused(
      { ...ROLE_MUTATION_FIXTURE_CASES[4].receipt, actorUserKeys: hiddenIndex },
      "jira.add-role-default-actors",
    );
    const inheritedArray = ["next-key"];
    Object.setPrototypeOf(inheritedArray, null);
    refused(
      { ...ROLE_MUTATION_FIXTURE_CASES[4].receipt, actorUserKeys: inheritedArray },
      "jira.add-role-default-actors",
    );
  });
  it("keeps complete principal receipt bytes and text within the producer boundary", () => {
    const receipt = ROLE_MUTATION_FIXTURE_CASES[4].receipt;
    for (const key of ["actorUserKeys", "actorGroupNames"])
      for (const value of [
        ["bad\ud800"],
        ["line\n"],
        ["same", "same"],
        Array.from({ length: 51 }, (_, index) => String(index)),
      ])
        refused(changed(receipt, key, value), "jira.add-role-default-actors");
    const large = Array.from(
      { length: 50 },
      (_, index) => `${String(index)}${"\u754c".repeat(250)}`,
    );
    refused({ ...receipt, actorUserKeys: large }, "jira.add-role-default-actors");
    refused({ ...receipt, userKey: "bad\ud800" }, "jira.add-role-default-actors");
  });
  it("keeps false deletion/attribute targets literal and validates the shared path key", () => {
    const deletion = PERMISSION_SCHEME_MUTATION_CASES[2].receipt;
    refused({ ...deletion, schemePresent: true }, "jira.delete-permission-scheme");
    const grant = PERMISSION_SCHEME_MUTATION_CASES[4].receipt;
    refused({ ...grant, grantPresent: true }, "jira.delete-permission-grant");
    const attribute = PERMISSION_SCHEME_MUTATION_CASES[5].receipt;
    expect(
      valid({ ...attribute, attributeEnabled: false }, "jira.set-permission-scheme-attribute"),
    ).toBe(true);
    for (const value of ["false", 0, null, undefined])
      refused(
        changed(attribute, "attributeEnabled", value),
        "jira.set-permission-scheme-attribute",
      );
    for (const attributeKey of ["../foreign", "%2f", "a\\b", "bad\ud800"])
      refused({ ...attribute, attributeKey }, "jira.set-permission-scheme-attribute");
  });
});
