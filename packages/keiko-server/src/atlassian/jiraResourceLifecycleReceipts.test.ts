import { describe, expect, it } from "vitest";
import type { JiraMutationReceipt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { ISSUE_LIFECYCLE_FIXTURE_CASES } from "../../../../tests/support/jira-issue-lifecycle-fixture.js";
import { PROJECT_LIFECYCLE_FIXTURE_CASES } from "../../../../tests/support/jira-project-lifecycle-fixture.js";
import { BULK_CREATE_RECEIPT } from "../../../../tests/support/jira-bulk-create-fixture.js";
import {
  JIRA_RESOURCE_LIFECYCLE_RECEIPTS,
  validJiraResourceLifecycleReceipt,
  type JiraResourceLifecycleOperation,
} from "./jiraResourceLifecycleReceipts.js";
import { validJiraMutationAttempt } from "./jiraMutationResult.js";

const RECIPROCAL = {
  userKey: "actor",
  issueId: "10001",
  issueKey: "SYN-1",
  applicationLinkId: "01234567-89ab-cdef-0123-456789abcdef",
  applicationLinkDestinationDigest: "4".repeat(64),
  selectedRemoteIssueId: "9223372036854775807",
  delegatedEffectRequested: true,
} as const;
const CASES = [
  ...ISSUE_LIFECYCLE_FIXTURE_CASES,
  ...PROJECT_LIFECYCLE_FIXTURE_CASES,
  { name: "jira.create-issues", receipt: BULK_CREATE_RECEIPT },
  { name: "jira.create-reciprocal-remote-link", receipt: RECIPROCAL },
] as const satisfies readonly {
  readonly name: JiraResourceLifecycleOperation;
  readonly receipt: JiraMutationReceipt;
}[];

describe("strict issue/project lifecycle receipts", () => {
  it("pins all fourteen identities", () => {
    expect(CASES.map(({ name }) => name).sort()).toEqual(
      Object.keys(JIRA_RESOURCE_LIFECYCLE_RECEIPTS).sort(),
    );
  });
  it.each(CASES)(
    "retains $name known context while refusing completed-effect claims",
    ({ name, receipt }) => {
      expect(validJiraResourceLifecycleReceipt(receipt, name)).toBe(true);
      expect(validJiraMutationAttempt({ ok: true, receipt }, name)).toMatchObject({
        ok: false,
        reason: "malformed-payload",
        receipt,
      });
      expect(
        validJiraMutationAttempt({ ok: false, reason: "timeout", receipt }, name),
      ).toMatchObject({ ok: false, receipt });
      expect(
        validJiraResourceLifecycleReceipt(
          { ...receipt, browseUrl: "https://foreign.invalid/" },
          name,
        ),
      ).toBe(false);
    },
  );
  it.each(CASES)(
    "refuses original foreign/hidden/accessor/symbol/inherited $name fields",
    ({ name, receipt }) => {
      let reads = 0;
      const required = JIRA_RESOURCE_LIFECYCLE_RECEIPTS[name][0];
      const inherited: JiraMutationReceipt = Object.create(receipt) as JiraMutationReceipt;
      for (const bad of [
        inherited,
        { ...receipt, [Symbol("foreign")]: "x" },
        Object.defineProperty({ ...receipt }, "hidden", { enumerable: false, value: true }),
        Object.defineProperty({ ...receipt }, required, {
          enumerable: true,
          get: () => {
            reads++;
            return "actor";
          },
        }),
      ]) {
        expect(validJiraMutationAttempt({ ok: true, receipt: bad }, name)).toEqual({
          ok: false,
          reason: "malformed-payload",
        });
        expect(
          validJiraMutationAttempt({ ok: false, reason: "unavailable", receipt: bad }, name),
        ).not.toHaveProperty("receipt");
      }
      expect(reads).toBe(0);
    },
  );
  it("preserves ACK identities and native error indexes without inventing item attribution", () => {
    const receipt = {
      userKey: "actor",
      requestedIssueCount: 2,
      issueIds: ["9223372036854775807"],
      issueKeys: ["SYN-2"],
      bulkFailedElementNumbers: [2147483647],
      bulkFailureStatuses: [400],
    };
    const saved = validJiraMutationAttempt(
      { ok: false, reason: "unavailable", receipt },
      "jira.create-issues",
    );
    expect(saved.receipt).toEqual(receipt);
    for (const value of [
      saved.receipt?.issueIds,
      saved.receipt?.issueKeys,
      saved.receipt?.bulkFailedElementNumbers,
      saved.receipt?.bulkFailureStatuses,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    receipt.issueIds[0] = "42";
    receipt.bulkFailedElementNumbers[0] = 0;
    expect(saved.receipt?.issueIds).toEqual(["9223372036854775807"]);
    expect(saved.receipt?.bulkFailedElementNumbers).toEqual([2147483647]);
    expect(
      validJiraResourceLifecycleReceipt(
        { userKey: "actor", requestedIssueCount: 2 },
        "jira.create-issues",
      ),
    ).toBe(true);
    expect(
      validJiraResourceLifecycleReceipt(
        { userKey: "actor", requestedIssueCount: 2, issueIds: ["1"] },
        "jira.create-issues",
      ),
    ).toBe(false);
    expect(
      validJiraResourceLifecycleReceipt(
        { userKey: "actor", requestedIssueCount: 2, bulkFailureStatuses: [400] },
        "jira.create-issues",
      ),
    ).toBe(false);
  });
  it("never evaluates hostile array entries or retains oversized identities", () => {
    let reads = 0;
    const ids = ["1"];
    Object.defineProperty(ids, "0", {
      enumerable: true,
      get: () => {
        reads++;
        return "1";
      },
    });
    expect(
      validJiraResourceLifecycleReceipt(
        { userKey: "actor", requestedIssueCount: 1, issueIds: ids, issueKeys: ["SYN-1"] },
        "jira.create-issues",
      ),
    ).toBe(false);
    expect(reads).toBe(0);
    for (const id of ["0", "01", "9223372036854775808", "1e3"])
      expect(
        validJiraResourceLifecycleReceipt(
          { ...RECIPROCAL, selectedRemoteIssueId: id },
          "jira.create-reciprocal-remote-link",
        ),
      ).toBe(false);
  });
  it("requires operation-fixed targets, current parent context and distinct native move positions", () => {
    expect(
      validJiraResourceLifecycleReceipt(
        { userKey: "actor", issueId: "1", issueKey: "SYN-1", issueArchivedRequested: true },
        "jira.restore-issue",
      ),
    ).toBe(false);
    expect(
      validJiraResourceLifecycleReceipt(
        { userKey: "actor", projectId: "1", projectKey: "SYN", projectPresent: false },
        "jira.delete-project",
      ),
    ).toBe(true);
    expect(
      validJiraResourceLifecycleReceipt(
        { userKey: "actor", projectId: "1", projectPresent: false },
        "jira.delete-project",
      ),
    ).toBe(false);
    expect(
      validJiraResourceLifecycleReceipt(
        {
          userKey: "actor",
          issueId: "1",
          issueKey: "SYN-1",
          subtaskIds: ["2", "3"],
          originalPosition: 0,
          currentPosition: 0,
        },
        "jira.move-subtask",
      ),
    ).toBe(false);
  });
});
