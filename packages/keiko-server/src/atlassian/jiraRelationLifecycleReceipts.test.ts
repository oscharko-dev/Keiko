import { describe, expect, it, vi } from "vitest";
import {
  JIRA_LINK_MUTATIONS,
  JIRA_RELEASE_LIFECYCLE_MUTATIONS,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  canConfirmJiraRelationLifecycle,
  isJiraRelationLifecycleOperation,
  validJiraRelationLifecycleReceipt,
  type JiraRelationLifecycleOperation,
} from "./jiraRelationLifecycleReceipts.js";
import { jiraAttemptToolResult, validJiraMutationAttempt } from "./jiraMutationResult.js";

const ISSUE = { issueId: "10001", issueKey: "SYN-1", userKey: "synthetic-actor" } as const;
const RELATION = {
  ...ISSUE,
  linkedIssueId: "10002",
  linkedIssueKey: "SYN-2",
  linkTypeId: "42",
  linkId: "9223372036854775807",
} as const;
const PROJECT = { projectId: "10000", projectKey: "SYN", userKey: "synthetic-actor" } as const;
const VERSION = { ...PROJECT, versionId: "9007199254740993" } as const;
const CASES = [
  {
    operation: "jira.create-issue-link",
    receipt: { ...RELATION, linkPresent: true },
    confirm: true,
  },
  {
    operation: "jira.delete-issue-link",
    receipt: { ...RELATION, linkPresent: false },
    confirm: true,
  },
  {
    operation: "jira.upsert-remote-link",
    receipt: { ...ISSUE, linkId: "42", linkPresent: true },
    confirm: true,
  },
  {
    operation: "jira.update-remote-link",
    receipt: { ...ISSUE, linkId: "42", linkPresent: true },
    confirm: true,
  },
  {
    operation: "jira.delete-remote-link",
    receipt: { ...ISSUE, linkId: "42", linkPresent: false },
    confirm: true,
  },
  {
    operation: "jira.delete-remote-link-by-global-id",
    receipt: { ...ISSUE, linkId: "42", linkPresent: false },
    confirm: true,
  },
  {
    operation: "jira.delete-component",
    receipt: { ...PROJECT, componentId: "42" },
    confirm: false,
  },
  {
    operation: "jira.merge-version",
    receipt: { ...VERSION, targetVersionId: "9223372036854775807" },
    confirm: false,
  },
  { operation: "jira.move-version", receipt: VERSION, confirm: true },
  {
    operation: "jira.remove-and-swap-version",
    receipt: { ...VERSION, replacementVersionIds: ["42", "9223372036854775807"] },
    confirm: false,
  },
] as const satisfies readonly {
  readonly operation: JiraRelationLifecycleOperation;
  readonly receipt: JiraMutationReceipt;
  readonly confirm: boolean;
}[];

function withField(
  receipt: JiraMutationReceipt,
  key: PropertyKey,
  value: unknown,
): JiraMutationReceipt {
  const result = { ...receipt };
  Object.defineProperty(result, key, { value, enumerable: true, configurable: true });
  return result;
}
function expectRefused(
  receipt: JiraMutationReceipt,
  operation: JiraRelationLifecycleOperation,
): void {
  expect(validJiraRelationLifecycleReceipt(receipt, operation)).toBe(false);
  expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual({
    ok: false,
    reason: "malformed-payload",
  });
  expect(
    validJiraMutationAttempt({ ok: false, reason: "timeout", receipt }, operation),
  ).not.toHaveProperty("receipt");
}

describe("link and release lifecycle receipt evidence", () => {
  it("covers every declared operation without treating unrelated writes as this receipt family", () => {
    expect(CASES.map(({ operation }) => operation).sort()).toEqual(
      [...JIRA_LINK_MUTATIONS, ...JIRA_RELEASE_LIFECYCLE_MUTATIONS].sort(),
    );
    expect(isJiraRelationLifecycleOperation("jira.create-version")).toBe(false);
    expect(isJiraRelationLifecycleOperation("jira.comment")).toBe(false);
  });

  it.each(CASES)(
    "retains known native identities and honest confirmation for $operation",
    ({ operation, receipt, confirm }) => {
      expect(isJiraRelationLifecycleOperation(operation)).toBe(true);
      expect(canConfirmJiraRelationLifecycle(operation)).toBe(confirm);
      expect(validJiraRelationLifecycleReceipt(receipt, operation)).toBe(true);
      expect(validJiraMutationAttempt({ ok: true, receipt }, operation)).toEqual(
        confirm ? { ok: true, receipt } : { ok: false, reason: "malformed-payload", receipt },
      );
      const uncertain = validJiraMutationAttempt(
        { ok: false, reason: "timeout", receipt },
        operation,
      );
      expect(uncertain).toEqual({ ok: false, reason: "timeout", receipt });
      expect(Object.isFrozen(uncertain.receipt)).toBe(true);
      for (const outcome of ["unknown", "succeeded-unconfirmed"] as const) {
        const result = jiraAttemptToolResult(outcome, uncertain);
        expect(result).toMatchObject({ isError: true, data: { outcome, ...receipt } });
        expect(result.data).not.toHaveProperty("confirmed");
        expect(result.data).not.toHaveProperty("browseUrl");
      }
    },
  );

  it.each(CASES)("requires every own context field for $operation", ({ operation, receipt }) => {
    for (const key of Object.keys(receipt)) {
      const missing = { ...receipt };
      Reflect.deleteProperty(missing, key);
      const partialCreate =
        key === "linkId" &&
        (operation === "jira.create-issue-link" || operation === "jira.upsert-remote-link");
      if (partialCreate) {
        expect(validJiraMutationAttempt({ ok: true, receipt: missing }, operation)).toEqual({
          ok: false,
          reason: "malformed-payload",
          receipt: missing,
        });
        expect(
          validJiraMutationAttempt({ ok: false, reason: "timeout", receipt: missing }, operation),
        ).toEqual({
          ok: false,
          reason: "timeout",
          receipt: missing,
        });
      } else expectRefused(missing, operation);
      Object.setPrototypeOf(missing, { [key]: Reflect.get(receipt, key) as unknown });
      expectRefused(missing, operation);
    }
  });

  it.each(CASES)(
    "preserves exact int64 identities without accepting lossy or noncanonical IDs for $operation",
    ({ operation, receipt }) => {
      for (const [key, original] of Object.entries(receipt)) {
        if (!key.endsWith("Id")) continue;
        for (const value of ["1", "9223372036854775807"]) {
          const changed = withField(receipt, key, value);
          // Avoid changing an ID into the intentionally different endpoint/replacement identity.
          if (
            Object.entries(receipt).some(
              ([other, id]) =>
                other !== key && (id === value || (Array.isArray(id) && id.includes(value))),
            )
          )
            continue;
          expect(validJiraRelationLifecycleReceipt(changed, operation)).toBe(true);
        }
        expect(typeof original).toBe("string");
        for (const value of [
          "0",
          "01",
          "-1",
          "+1",
          "1e3",
          "1.0",
          " 1",
          "9223372036854775808",
          42,
          null,
        ])
          expectRefused(withField(receipt, key, value), operation);
      }
    },
  );

  it.each(CASES.filter(({ operation }) => operation.includes("link")))(
    "requires the operation's exact presence target for $operation",
    ({ operation, receipt }) => {
      const current = Reflect.get(receipt, "linkPresent") as unknown;
      for (const value of [!current, String(current), null])
        expectRefused(withField(receipt, "linkPresent", value), operation);
    },
  );

  it("refuses source/replacement equality and preserves an explicit empty swap set", () => {
    expectRefused(
      { ...RELATION, linkedIssueId: RELATION.issueId, linkPresent: true },
      "jira.create-issue-link",
    );
    expectRefused(
      { ...RELATION, linkedIssueKey: "syn-1", linkPresent: true },
      "jira.create-issue-link",
    );
    expectRefused(
      { ...PROJECT, componentId: "42", replacementComponentId: "42" },
      "jira.delete-component",
    );
    expectRefused({ ...VERSION, targetVersionId: VERSION.versionId }, "jira.merge-version");
    expect(
      validJiraRelationLifecycleReceipt(
        { ...PROJECT, componentId: "42", replacementComponentId: "43" },
        "jira.delete-component",
      ),
    ).toBe(true);
    expect(
      validJiraRelationLifecycleReceipt(
        { ...VERSION, replacementVersionIds: [] },
        "jira.remove-and-swap-version",
      ),
    ).toBe(true);
  });
});

describe("original receipt data boundaries", () => {
  it.each(CASES)(
    "refuses foreign data, hidden fields, symbols and remote URLs for $operation",
    ({ operation, receipt }) => {
      for (const key of ["title", "expected", "browseUrl", "url", "issueKeys", Symbol("foreign")])
        expectRefused(withField(receipt, key, "https://remote.example.test/item/42"), operation);
      const hidden = { ...receipt };
      Object.defineProperty(hidden, "foreign", { value: "synthetic", enumerable: false });
      expectRefused(hidden, operation);
    },
  );

  it.each(["issueId", "linkId", "userKey", "foreign"])(
    "does not invoke an accessor on %s before refusing success or partial failure",
    (key) => {
      const receipt = { ...RELATION, linkPresent: true };
      const getter = vi.fn(() => "42");
      Object.defineProperty(receipt, key, { get: getter, enumerable: true });
      expectRefused(receipt, "jira.create-issue-link");
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it("validates the source descriptor before an earlier replacement array can read it", () => {
    const receipt: JiraMutationReceipt = { replacementVersionIds: ["42"], ...PROJECT };
    const getter = vi.fn(() => VERSION.versionId);
    Object.defineProperty(receipt, "versionId", { get: getter, enumerable: true });
    expectRefused(receipt, "jira.remove-and-swap-version");
    expect(getter).not.toHaveBeenCalled();
  });

  it("retains bounded Unicode actor identity but refuses unpaired surrogates and control text", () => {
    expect(
      validJiraRelationLifecycleReceipt(
        { ...VERSION, userKey: "Synthetic \u{1f680}" },
        "jira.move-version",
      ),
    ).toBe(true);
    for (const userKey of [
      "",
      " ",
      "x".repeat(256),
      "Synthetic\nActor",
      "Synthetic\ud800",
      "Synthetic\udc00",
    ])
      expectRefused({ ...VERSION, userKey }, "jira.move-version");
  });

  it("accepts a plain own-data dictionary and does not borrow inherited context", () => {
    const receipt: JiraMutationReceipt = { ...VERSION };
    Object.setPrototypeOf(receipt, null);
    expect(validJiraRelationLifecycleReceipt(receipt, "jira.move-version")).toBe(true);
    const inherited = { versionId: VERSION.versionId };
    Object.setPrototypeOf(inherited, PROJECT);
    expectRefused(inherited, "jira.move-version");
  });
});

describe("immutable replacement identity arrays", () => {
  it("copies and freezes validated replacement IDs even for unconfirmed attempts", () => {
    const replacementVersionIds = ["42", "9223372036854775807"];
    const receipt = { ...VERSION, replacementVersionIds };
    const attempt = validJiraMutationAttempt(
      { ok: false, reason: "timeout", receipt },
      "jira.remove-and-swap-version",
    );
    replacementVersionIds[0] = "99";
    expect(attempt.receipt?.replacementVersionIds).toEqual(["42", "9223372036854775807"]);
    expect(attempt.receipt?.replacementVersionIds).not.toBe(replacementVersionIds);
    expect(Object.isFrozen(attempt.receipt?.replacementVersionIds)).toBe(true);
    expect(Reflect.set(attempt.receipt?.replacementVersionIds ?? {}, "0", "100")).toBe(false);
    const forgedSuccess = validJiraMutationAttempt(
      { ok: true, receipt },
      "jira.remove-and-swap-version",
    );
    expect(forgedSuccess.ok).toBe(false);
    expect(Object.isFrozen(forgedSuccess.receipt?.replacementVersionIds)).toBe(true);
  });

  it("rejects duplicate, self, sparse, over-bound and hostile arrays without reading accessors", () => {
    const getter = vi.fn(() => "42");
    const accessor: string[] = ["42"];
    Object.defineProperty(accessor, "0", { get: getter, enumerable: true });
    const decorated = ["42"];
    Object.defineProperty(decorated, Symbol.iterator, { get: getter });
    const hidden = ["42"];
    Object.defineProperty(hidden, "extra", { value: "synthetic" });
    const inherited = ["42"];
    Object.setPrototypeOf(inherited, Object.create(Array.prototype) as object);
    const tooMany = Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) =>
      String(index + 1),
    );
    for (const value of [
      ["42", "42"],
      [VERSION.versionId],
      ["0"],
      [42],
      new Array(1),
      accessor,
      decorated,
      hidden,
      inherited,
      tooMany,
    ])
      expectRefused(
        withField(VERSION, "replacementVersionIds", value),
        "jira.remove-and-swap-version",
      );
    expect(getter).not.toHaveBeenCalled();
  });
});
