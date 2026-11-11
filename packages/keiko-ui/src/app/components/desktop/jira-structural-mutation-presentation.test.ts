import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { OptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import { jiraActionFacts } from "./jiraActionFacts";
import { jiraToolOutcomeView } from "./jira-tool-outcome";
import {
  jiraLocalReadFailureNotice,
  jiraMutationUnchanged,
  jiraToolState,
} from "./jira-tool-presentation";
import {
  jiraReleaseLifecycleDetails,
  jiraReleaseLifecycleIdentityComplete,
} from "./jira-release-lifecycle-presentation";
import {
  jiraLinkMutationDetails,
  jiraLinkMutationIdentityComplete,
  jiraRemoteLinkReviewDetails,
} from "./jira-link-mutation-presentation";
import { jiraStructuralMutationFacts } from "./jira-structural-mutation-approval";

const t: OptionalWidgetTranslate = (key) => key;
const PROJECT = { projectId: "10000", projectKey: "SYN", userKey: "actor-key" };
const LINK = {
  issueId: "10001",
  issueKey: "SYN-1",
  userKey: "actor-key",
  linkId: "9007199254740993",
};
const REMOTE = {
  id: "9007199254740993",
  globalId: "system:record",
  applicationType: null,
  applicationName: "Synthetic app",
  relationship: null,
  url: "https://remote.invalid/value",
  title: "Remote title",
  summary: "",
  iconUrl: null,
  iconTitle: null,
  resolved: false,
  statusIconUrl: null,
  statusIconTitle: null,
  statusIconLink: null,
};
function exchange(
  name: string,
  data: CatalogJsonObject,
  mutationOutcome?: ChatToolExchange["mutationOutcome"],
): ChatToolExchange {
  return {
    call: { id: "structural-result", name, arguments: {} },
    ...(mutationOutcome === undefined ? {} : { mutationOutcome }),
    result: {
      schemaVersion: 1,
      invocationId: "structural-result",
      toolRef: null,
      projectionDigest: null,
      effectStarted: true,
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 10 },
      status: "completed",
      reason: "none",
      page: { truncated: false, reason: "none", cursor: null },
      data,
    },
  };
}
describe("closed structural mutation receipt presentation", () => {
  it.each([
    ["jira_delete_component", { ...PROJECT, componentId: "7" }],
    ["jira_merge_version", { ...PROJECT, versionId: "8", targetVersionId: "9" }],
    ["jira_remove_and_swap_version", { ...PROJECT, versionId: "8", replacementVersionIds: [] }],
  ] as const)(
    "never claims complete issue-reference effects for %s, even from stale success",
    (tool, receipt) => {
      const source = { ...receipt, outcome: "succeeded" };
      expect(jiraReleaseLifecycleIdentityComplete(tool, source)).toBe(true);
      expect(jiraReleaseLifecycleDetails(tool, source)[0]?.labels).toContain(
        "chat.jira.releaseLifecycle.referencesUnconfirmed",
      );
      expect(jiraToolState(exchange(tool, source), "completed")).toBe(
        "chat.jira.write.unconfirmed",
      );
      expect(
        jiraMutationUnchanged(
          exchange(tool, { ...source, outcome: "rejected", reason: "conflict", unchanged: true }),
        ),
      ).toBe(false);
    },
  );
  it("shows an independently confirmed order or exact no-op only for its complete context", () => {
    const source = { ...PROJECT, versionId: "8", outcome: "succeeded" };
    expect(jiraReleaseLifecycleDetails("jira_move_version", source)[0]?.labels).toContain(
      "chat.jira.releaseLifecycle.orderConfirmed",
    );
    const unchanged = exchange("jira_move_version", {
      ...source,
      outcome: "rejected",
      reason: "conflict",
      unchanged: true,
    });
    expect(jiraMutationUnchanged(unchanged)).toBe(true);
    expect(jiraToolState(unchanged, "completed")).toBe("chat.jira.write.unchanged");
    expect(
      jiraToolState(
        exchange("jira_move_version", {
          projectKey: "SYN",
          userKey: "actor-key",
          versionId: "8",
          outcome: "succeeded",
        }),
        "completed",
      ),
    ).toBe("chat.jira.write.unknown");
  });
  it("retains native IDs without navigation and lets the journal override stale successful data", () => {
    const source = {
      ...LINK,
      linkedIssueId: "10002",
      linkedIssueKey: "SYN-2",
      linkTypeId: "10",
      linkPresent: true,
      outcome: "succeeded",
      browseUrl: "https://untrusted.invalid/browse/SYN-1",
    };
    const view = jiraToolOutcomeView(exchange("jira_create_issue_link", source, "unknown"));
    expect(view.items[0]?.labels).toContain("chat.jira.savedConfiguration.unconfirmed");
    expect(view.items[0]?.labels).not.toContain("chat.jira.savedConfiguration.confirmed");
    expect(view.items[0]?.facts).toContainEqual({
      label: "chat.jira.fact.linkId",
      value: "9007199254740993",
    });
    expect(view.items[0]?.href).toBeUndefined();
  });
  it.each([
    ["jira_create_issue_link", true],
    ["jira_delete_issue_link", false],
    ["jira_upsert_remote_link", true],
    ["jira_update_remote_link", true],
    ["jira_delete_remote_link", false],
    ["jira_delete_remote_link_by_global_id", false],
  ] as const)(
    "binds %s confirmation to exact identity and requested presence",
    (tool, linkPresent) => {
      const receipt = {
        ...LINK,
        linkPresent,
        linkedIssueId: "10002",
        linkedIssueKey: "SYN-2",
        linkTypeId: "10",
        outcome: "succeeded",
      };
      expect(jiraLinkMutationIdentityComplete(tool, receipt)).toBe(true);
      expect(jiraLinkMutationDetails(tool, receipt)[0]?.labels).toContain(
        "chat.jira.savedConfiguration.confirmed",
      );
      expect(
        jiraLinkMutationIdentityComplete(tool, { ...receipt, linkPresent: !linkPresent }),
      ).toBe(false);
      expect(jiraLinkMutationIdentityComplete(tool, { ...receipt, linkId: "01" })).toBe(false);
      expect(jiraLinkMutationIdentityComplete(tool, { ...receipt, userKey: "" })).toBe(false);
      expect(
        jiraLinkMutationDetails(tool, { ...receipt, outcome: "unknown" })[0]?.labels,
      ).not.toContain("chat.jira.savedConfiguration.confirmed");
    },
  );
});
describe("complete remote-link review projection", () => {
  it("shows every supported value with null, empty text, false and URL text kept distinct", () => {
    const details = jiraRemoteLinkReviewDetails({
      id: REMOTE.id,
      reviewSnapshotAvailable: true,
      reviewSnapshot: REMOTE,
    });
    expect(details).toHaveLength(15);
    expect(details[0]?.labels).toContain("chat.jira.linkMutation.snapshotAvailable");
    expect(details.flatMap((item) => item.labels)).toEqual(
      expect.arrayContaining([
        "chat.jira.structural.nativeNotProvided",
        "chat.jira.propertyMutation.emptyText",
        "chat.jira.propertyMutation.false",
      ]),
    );
    expect(details.flatMap((item) => item.facts)).toContainEqual({
      label: "chat.jira.linkMutation.url",
      value: REMOTE.url,
    });
    expect(details.some((item) => "href" in item)).toBe(false);
  });
  it("refuses to label absent, stale, mismatched or incomplete snapshots as reviewable", () => {
    const incomplete: Record<string, unknown> = { ...REMOTE };
    delete incomplete.summary;
    for (const source of [
      { id: REMOTE.id },
      { id: REMOTE.id, reviewSnapshotAvailable: false, reviewSnapshot: REMOTE },
      { id: "9", reviewSnapshotAvailable: true, reviewSnapshot: REMOTE },
      { id: REMOTE.id, reviewSnapshotAvailable: true, reviewSnapshot: incomplete },
    ])
      expect(jiraRemoteLinkReviewDetails(source)).toEqual([
        { facts: [], labels: ["chat.jira.linkMutation.snapshotUnavailable"] },
      ]);
  });
});
describe("reviewed structural values", () => {
  it("keeps reviewed native null separate from an explicitly requested null replacement", () => {
    const expected = jiraStructuralMutationFacts("jira.update-remote-link", "expected", REMOTE, t);
    const requested = jiraStructuralMutationFacts("jira.update-remote-link", "value", REMOTE, t);
    expect(JSON.stringify(expected)).toContain("chat.jira.structural.nativeNotProvided");
    expect(JSON.stringify(requested)).toContain("chat.jira.linkMutation.requestedNull");
    expect(JSON.stringify(requested)).not.toContain('"kind":"cleared"');
  });
  it("presents the entire source/replacement metadata and exact ordered version IDs", () => {
    const snapshot = {
      name: "Release",
      description: "",
      startDate: null,
      releaseDate: "2026-01-02",
      released: false,
      archived: null,
    };
    const facts = jiraActionFacts(
      {
        versionId: "8",
        expectedProjectId: "10000",
        expectedActorKey: "actor-key",
        expectedVersionSnapshot: snapshot,
        expectedVersionIds: ["9", "8", "10"],
        afterVersionId: "10",
      },
      true,
      t,
      undefined,
      "jira.move-version",
    );
    const order = facts.find((entry) => entry.id === "chat.jira.structural.reviewedVersionOrder");
    expect(order?.value).toEqual({
      kind: "list",
      items: ["9", "8", "10"].map((text, index) => ({
        position: index + 1,
        value: { kind: "text", text },
      })),
    });
    expect(JSON.stringify(facts)).toContain("chat.jira.propertyMutation.false");
    expect(JSON.stringify(facts)).toContain("chat.jira.propertyMutation.emptyText");
    expect(JSON.stringify(facts)).toContain("chat.jira.structural.nativeNotProvided");
  });
  it("distinguishes clearing every custom version field from an empty list of replacement targets", () => {
    const custom = jiraStructuralMutationFacts(
      "jira.remove-and-swap-version",
      "customFieldReplacementList",
      [],
      t,
    );
    const targets = jiraStructuralMutationFacts(
      "jira.remove-and-swap-version",
      "expectedReplacementVersions",
      [],
      t,
    );
    expect(custom?.[0]?.value).toEqual({
      kind: "text",
      text: "chat.jira.structural.clearAllCustomReferences",
    });
    expect(targets?.[0]?.value).toEqual({
      kind: "text",
      text: "chat.jira.structural.noReplacementVersions",
    });
    expect(jiraStructuralMutationFacts("mcp_other", "expected", REMOTE, t)).toBeUndefined();
  });
  it.each([
    ["First", "first"],
    ["Last", "last"],
    ["Earlier", "earlier"],
    ["Later", "later"],
  ] as const)(
    "names native %s without changing the selected ordering operation",
    (value, label) => {
      expect(
        jiraStructuralMutationFacts("jira.move-version", "position", value, t)?.[0]?.value,
      ).toEqual({ kind: "text", text: `chat.jira.structural.${label}` });
    },
  );
  it("shows the complete target component and existing upsert snapshot, including explicit unknown flags", () => {
    const replacement = {
      name: "Replacement component",
      description: "",
      leadUserName: null,
      assigneeType: null,
      archived: false,
      deleted: null,
    };
    const fields = jiraStructuralMutationFacts(
      "jira.delete-component",
      "expectedReplacementSnapshot",
      replacement,
      t,
    );
    expect(fields?.[0]?.id).toBe("chat.jira.structural.reviewedReplacementComponent");
    expect(JSON.stringify(fields)).toContain("Replacement component");
    expect(JSON.stringify(fields)).toContain("chat.jira.propertyMutation.false");
    expect(JSON.stringify(fields)).toContain("chat.jira.structural.nativeNotProvided");
    expect(
      jiraStructuralMutationFacts("jira.upsert-remote-link", "expected", REMOTE, t)?.[0]?.id,
    ).toBe("chat.jira.structural.reviewedRemoteLink");
  });
});

it.each([
  ["effect-denied", "chat.jira.outcome.failure.localAuthority"],
  ["cancelled", "chat.jira.outcome.failure.cancelled"],
  ["timeout", "chat.jira.outcome.failure.unavailable"],
] as const)("keeps the local session refusal %s distinct from network failure", (reason, label) => {
  const view = jiraToolOutcomeView(exchange("jira_current_session", { outcome: "failed", reason }));
  expect(view.failure).toBe(label);
  expect(view.items).toEqual([]);
});
it("names refused arguments instead of advising a connection check", () => {
  const view = jiraToolOutcomeView(
    exchange("jira_report", {
      outcome: "failed",
      reason: "invalid-input",
      invalidArguments: ["section"],
    }),
  );
  expect(view.failure).toBe("chat.jira.outcome.failure.invalidInput");
});
it("does not repurpose a mutation's technical failure as a harmless read outcome", () => {
  const call: ChatToolExchange = {
    call: { id: "mutation-failed", name: "jira_create_issue_link", arguments: {} },
    mutationOutcome: "unknown",
    result: {
      schemaVersion: 1,
      invocationId: "mutation-failed",
      toolRef: null,
      projectionDigest: null,
      effectStarted: true,
      metrics: { inputBytes: 10, outputBytes: 0, resultCount: 0, durationMs: 10 },
      status: "failed",
      reason: "handler-failed",
      page: null,
      data: null,
    },
  };
  expect(jiraLocalReadFailureNotice(call)).toBeUndefined();
  expect(jiraToolState(call, "completed")).toBe("chat.jira.write.unknown");
});

const draftItem = (state: string, reason?: string): CatalogJsonObject => ({
  ref: "a",
  state,
  ...(reason === undefined ? {} : { reason }),
});
it("names the one reason every failed draft row shares", () => {
  const view = jiraToolOutcomeView(
    exchange("jira_draft", {
      outcome: "failed",
      items: [
        draftItem("failed", "field-validation"),
        draftItem("created"),
        draftItem("failed", "field-validation"),
      ],
    }),
  );
  expect(view.failure).toBe("chat.jira.outcome.failure.fields");
});
it.each([
  [
    "rows with different reasons",
    [draftItem("failed", "conflict"), draftItem("failed", "not-found")],
  ],
  ["failed rows without a reason", [draftItem("failed")]],
  [
    "a failed row without a reason beside one with a reason",
    [draftItem("failed", "field-validation"), draftItem("failed")],
  ],
  ["a reason on a row that did not fail", [draftItem("created", "conflict")]],
  ["no rows", []],
])("falls back to the generic failure for %s", (_name, items) => {
  const view = jiraToolOutcomeView(exchange("jira_draft", { outcome: "failed", items }));
  expect(view.failure).toBe("chat.jira.outcome.failure.unavailable");
});
it("prefers the top-level reason over the shared row reason", () => {
  const view = jiraToolOutcomeView(
    exchange("jira_draft", {
      outcome: "failed",
      reason: "permission-denied",
      items: [draftItem("failed", "conflict")],
    }),
  );
  expect(view.failure).toBe("chat.jira.outcome.failure.permission");
});
const APPROVAL: ChatToolWriteApprovalView = {
  kind: "jira-chat-write",
  approvalId: "approval-1",
  chatId: "chat-1",
  podId: "11111111-1111-4111-8111-111111111111",
  bindingGeneration: 1,
  authenticationGeneration: 1,
  invocationId: "action-1",
  operation: "jira.create",
  actionDigest: "a".repeat(64),
  requestedAt: 1,
  expiresAt: 2,
  state: "pending",
};
it.each(["rejected", "expired", "revoked"] as const)(
  "adds no failure line when the human decision %s ended the write",
  (state) => {
    const ended = {
      ...exchange("jira_create", { outcome: "failed", reason: "unavailable" }),
      approval: { ...APPROVAL, state },
    };
    expect(jiraToolOutcomeView(ended).failure).toBeUndefined();
  },
);
it.each(["pending", "approved", "claimed"] as const)(
  "still reports a technical failure while the approval is %s",
  (state) => {
    const failed = {
      ...exchange("jira_create", { outcome: "failed", reason: "unavailable" }),
      approval: { ...APPROVAL, state },
    };
    expect(jiraToolOutcomeView(failed).failure).toBe("chat.jira.outcome.failure.unavailable");
  },
);
