import { describe, expect, it } from "vitest";
import {
  JIRA_GROUP_MUTATIONS,
  JIRA_ISSUE_ACTION_MUTATIONS,
  JIRA_MAINTENANCE_MUTATIONS,
  JIRA_SCHEMA_MUTATIONS,
  JIRA_DIRECTORY_ACCESS_MUTATIONS,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { GROUP_MUTATION_FIXTURE_CASES } from "../../../../tests/support/jira-group-mutation-fixture.js";
import { ISSUE_ACTION_FIXTURE_CASES } from "../../../../tests/support/jira-issue-action-fixture.js";
import { MAINTENANCE_MUTATION_FIXTURE_CASES } from "../../../../tests/support/jira-maintenance-mutation-fixture.js";
import {
  JIRA_SYSTEM_ACTION_RECEIPTS,
  canConfirmJiraSystemAction,
  validJiraSystemActionReceipt,
  type JiraSystemActionOperation,
} from "./jiraSystemActionReceipts.js";
import { validJiraMutationAttempt } from "./jiraMutationResult.js";

const ID = "9223372036854775807";
const USER = { actorUserKey: "operator-key", userKey: "target-key", username: "Target User" };
const CASES = [
  ...GROUP_MUTATION_FIXTURE_CASES,
  ...ISSUE_ACTION_FIXTURE_CASES,
  ...MAINTENANCE_MUTATION_FIXTURE_CASES,
  {
    name: "jira.set-application-role",
    receipt: { actorUserKey: "operator-key", applicationRoleKeys: ["jira-software"] },
  },
  {
    name: "jira.set-application-roles",
    receipt: {
      actorUserKey: "operator-key",
      applicationRoleKeys: ["jira-software", "jira-servicedesk"],
    },
  },
  {
    name: "jira.add-user-application",
    receipt: { ...USER, applicationRoleKeys: ["jira-software"], applicationAccessRequested: true },
  },
  {
    name: "jira.remove-user-application",
    receipt: { ...USER, applicationRoleKeys: ["jira-software"], applicationAccessRequested: false },
  },
  {
    name: "jira.set-user-columns",
    receipt: { ...USER, columnIds: ["summary", "status", "summary"] },
  },
  { name: "jira.reset-user-columns", receipt: { ...USER, columnsResetRequested: true } },
  {
    name: "jira.create-custom-field",
    receipt: { userKey: "actor", fieldId: `customfield_${ID}`, fieldPresent: true },
  },
  {
    name: "jira.delete-custom-fields",
    receipt: { userKey: "actor", fieldIds: [`customfield_${ID}`], fieldPresent: false },
  },
  {
    name: "jira.create-issue-type",
    receipt: { userKey: "actor", issueTypeId: ID, issueTypePresent: true },
  },
  {
    name: "jira.update-issue-type",
    receipt: { userKey: "actor", issueTypeId: ID, issueTypePresent: true },
  },
  {
    name: "jira.delete-issue-type",
    receipt: {
      userKey: "actor",
      issueTypeId: ID,
      issueTypePresent: false,
      replacementIssueTypeId: "7",
    },
  },
  {
    name: "jira.create-link-type",
    receipt: { userKey: "actor", linkTypeId: ID, linkTypePresent: true },
  },
  {
    name: "jira.update-link-type",
    receipt: { userKey: "actor", linkTypeId: ID, linkTypePresent: true },
  },
  {
    name: "jira.delete-link-type",
    receipt: { userKey: "actor", linkTypeId: ID, linkTypePresent: false },
  },
  { name: "jira.reset-link-type-order", receipt: { userKey: "actor", linkTypeIds: [] } },
  {
    name: "jira.move-link-type",
    receipt: { userKey: "actor", linkTypeId: ID, linkTypeIds: ["7", ID] },
  },
  {
    name: "jira.set-terminology",
    receipt: { userKey: "actor", terminologyNames: ["epic", "sprint"] },
  },
] as const satisfies readonly {
  readonly name: JiraSystemActionOperation;
  readonly receipt: JiraMutationReceipt;
}[];
const CONFIRMABLE: ReadonlySet<JiraSystemActionOperation> = new Set([
  "jira.create-group",
  "jira.pin-comment",
  "jira.set-user-columns",
  "jira.update-issue-type",
  "jira.create-link-type",
  "jira.update-link-type",
  "jira.set-terminology",
]);

describe("strict system action receipt families", () => {
  it("pins all thirty-five current operation identities independently of result validity", () => {
    const names = [
      ...JIRA_GROUP_MUTATIONS,
      ...JIRA_ISSUE_ACTION_MUTATIONS,
      ...JIRA_MAINTENANCE_MUTATIONS,
      ...JIRA_SCHEMA_MUTATIONS,
      ...JIRA_DIRECTORY_ACCESS_MUTATIONS,
    ].sort();
    expect(CASES.map(({ name }) => name).sort()).toEqual(names);
    expect(Object.keys(JIRA_SYSTEM_ACTION_RECEIPTS).sort()).toEqual(names);
  });
  it.each(CASES)(
    "retains exact $name data and refuses invented confirmed success",
    ({ name, receipt }) => {
      expect(validJiraSystemActionReceipt(receipt, name)).toBe(true);
      expect(canConfirmJiraSystemAction(name)).toBe(CONFIRMABLE.has(name));
      const attempted = validJiraMutationAttempt({ ok: true, receipt }, name);
      expect(attempted.ok).toBe(CONFIRMABLE.has(name));
      expect(attempted.receipt).toEqual(receipt);
      expect(
        validJiraMutationAttempt({ ok: false, reason: "unavailable", receipt }, name),
      ).toMatchObject({ ok: false, receipt });
      expect(
        validJiraSystemActionReceipt({ ...receipt, browseUrl: "https://foreign.invalid/" }, name),
      ).toBe(false);
    },
  );
  it.each(CASES)(
    "refuses foreign prototype, hidden fields, symbols, accessors and inherited context for $name",
    ({ name, receipt }) => {
      let reads = 0;
      const field = JIRA_SYSTEM_ACTION_RECEIPTS[name][0];
      const inherited: JiraMutationReceipt = Object.create(receipt);
      expect(validJiraSystemActionReceipt(inherited, name)).toBe(false);
      for (const replacement of [
        Object.defineProperty({ ...receipt }, field, {
          enumerable: true,
          get: () => {
            reads++;
            return "getter";
          },
        }),
        Object.defineProperty({ ...receipt }, "hidden", { enumerable: false, value: "secret" }),
        { ...receipt, [Symbol("foreign")]: true },
      ]) {
        expect(validJiraMutationAttempt({ ok: true, receipt: replacement }, name)).toEqual({
          ok: false,
          reason: "malformed-payload",
        });
        expect(
          validJiraMutationAttempt(
            { ok: false, reason: "unavailable", receipt: replacement },
            name,
          ),
        ).not.toHaveProperty("receipt");
      }
      expect(reads).toBe(0);
    },
  );
  it("retains known partial context when new ACK identities were not observed", () => {
    for (const selected of [
      { name: "jira.create-custom-field", receipt: { userKey: "actor", fieldPresent: true } },
      { name: "jira.create-issue-type", receipt: { userKey: "actor", issueTypePresent: true } },
      { name: "jira.create-link-type", receipt: { userKey: "actor", linkTypePresent: true } },
      { name: "jira.process-reindex-requests", receipt: { userKey: "actor" } },
    ] as const) {
      expect(validJiraSystemActionReceipt(selected.receipt, selected.name)).toBe(true);
      expect(
        validJiraMutationAttempt({ ok: true, receipt: selected.receipt }, selected.name),
      ).toMatchObject({ ok: false, receipt: selected.receipt });
    }
    expect(
      validJiraSystemActionReceipt(
        { userKey: "actor", issueTypePresent: true },
        "jira.update-issue-type",
      ),
    ).toBe(false);
  });
  it("keeps target users distinct from actors and enforces operation-specific role cardinality", () => {
    expect(
      validJiraSystemActionReceipt(
        { ...USER, columnIds: ["summary", "summary"] },
        "jira.set-user-columns",
      ),
    ).toBe(true);
    expect(
      validJiraSystemActionReceipt(
        { userKey: "operator-key", applicationRoleKeys: ["jira-software"] },
        "jira.set-application-role",
      ),
    ).toBe(false);
    expect(
      validJiraSystemActionReceipt(
        { ...USER, applicationRoleKeys: ["jira-software"] },
        "jira.set-application-role",
      ),
    ).toBe(false);
    expect(
      validJiraSystemActionReceipt(
        {
          ...USER,
          applicationRoleKeys: ["jira-software", "jira-servicedesk"],
          applicationAccessRequested: true,
        },
        "jira.add-user-application",
      ),
    ).toBe(false);
    expect(
      validJiraSystemActionReceipt(
        { ...USER, applicationRoleKeys: ["jira-software"], applicationAccessRequested: true },
        "jira.remove-user-application",
      ),
    ).toBe(false);
    expect(
      validJiraSystemActionReceipt(
        { ...USER, username: "broken\ud800", columnIds: ["summary"] },
        "jira.set-user-columns",
      ),
    ).toBe(false);
  });
  it("binds exact group target semantics without inventing direct or effective membership", () => {
    const selected = GROUP_MUTATION_FIXTURE_CASES[3];
    expect(validJiraSystemActionReceipt(selected.receipt, selected.name)).toBe(true);
    expect(
      validJiraSystemActionReceipt(
        { ...selected.receipt, requestedDirectMembership: true },
        selected.name,
      ),
    ).toBe(false);
    expect(
      validJiraSystemActionReceipt(
        { ...GROUP_MUTATION_FIXTURE_CASES[1].receipt, swapGroupName: "R&D team" },
        "jira.delete-group",
      ),
    ).toBe(false);
    expect(
      validJiraSystemActionReceipt({ ...selected.receipt, groupPresent: false }, selected.name),
    ).toBe(false);
  });
  it("accepts only precise int64/custom-field IDs and actual target-presence flags", () => {
    for (const value of ["9223372036854775808", "01", "0", "-1", "1e3", 9007199254740992]) {
      const malformed: JiraMutationReceipt = {
        userKey: "actor",
        issueTypeId: ID,
        issueTypePresent: true,
      };
      Reflect.set(malformed, "issueTypeId", value);
      expect(validJiraSystemActionReceipt(malformed, "jira.update-issue-type")).toBe(false);
      if (typeof value === "string")
        expect(
          validJiraSystemActionReceipt(
            { userKey: "actor", fieldId: `customfield_${value}`, fieldPresent: true },
            "jira.create-custom-field",
          ),
        ).toBe(false);
    }
    expect(
      validJiraSystemActionReceipt(
        { userKey: "actor", fieldIds: ["summary"], fieldPresent: false },
        "jira.delete-custom-fields",
      ),
    ).toBe(false);
    expect(
      validJiraSystemActionReceipt(
        {
          userKey: "actor",
          issueTypeId: "7",
          replacementIssueTypeId: "7",
          issueTypePresent: false,
        },
        "jira.delete-issue-type",
      ),
    ).toBe(false);
    expect(
      validJiraSystemActionReceipt(
        { userKey: "actor", linkTypeId: "7", linkTypeIds: ["8"] },
        "jira.move-link-type",
      ),
    ).toBe(false);
    expect(
      validJiraSystemActionReceipt(
        { userKey: "actor", terminologyNames: ["epic", "epic"] },
        "jira.set-terminology",
      ),
    ).toBe(false);
  });
  it("copies and freezes every array without evaluating array accessors", () => {
    const keys = [
      "issueIds",
      "reindexRequestIds",
      "recipientUserKeys",
      "applicationRoleKeys",
      "columnIds",
      "fieldIds",
      "linkTypeIds",
      "terminologyNames",
    ] as const;
    for (const selected of CASES) {
      const receipt: JiraMutationReceipt = structuredClone(selected.receipt);
      const retained = validJiraMutationAttempt(
        { ok: false, reason: "unavailable", receipt },
        selected.name,
      ).receipt;
      expect(retained).toEqual(receipt);
      for (const key of keys) {
        if (receipt[key] === undefined) continue;
        expect(retained?.[key]).not.toBe(receipt[key]);
        expect(Object.isFrozen(retained?.[key])).toBe(true);
      }
    }
    let reads = 0;
    const ids = ["7"];
    Object.defineProperty(ids, "0", {
      enumerable: true,
      get: () => {
        reads++;
        return "7";
      },
    });
    expect(
      validJiraSystemActionReceipt(
        { userKey: "actor", reindexRequestIds: ids },
        "jira.process-reindex-requests",
      ),
    ).toBe(false);
    expect(reads).toBe(0);
  });
  it("enforces full array byte bounds without truncation or null-as-empty conversion", () => {
    expect(
      validJiraSystemActionReceipt(
        { userKey: "actor", reindexRequestIds: [] },
        "jira.process-reindex-requests",
      ),
    ).toBe(true);
    expect(
      validJiraSystemActionReceipt(
        {
          userKey: "actor",
          reindexRequestIds: Array.from({ length: 1000 }, (_, index) =>
            String(9223372036854775807n - BigInt(index)),
          ),
        },
        "jira.process-reindex-requests",
      ),
    ).toBe(false);
    expect(
      validJiraSystemActionReceipt(
        { ...USER, columnIds: Array.from({ length: 1000 }, () => "summary".repeat(30)) },
        "jira.set-user-columns",
      ),
    ).toBe(false);
    expect(
      validJiraSystemActionReceipt({ userKey: "actor", issueIds: [] }, "jira.reindex-issues"),
    ).toBe(false);
  });
});
