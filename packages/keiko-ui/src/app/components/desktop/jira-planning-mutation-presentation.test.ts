import { describe, expect, it } from "vitest";
import {
  jiraPlanningIdentityComplete,
  jiraPlanningMutationDetails,
} from "./jira-planning-mutation-presentation";
import { jiraToolState } from "./jira-tool-presentation";
import { jiraToolOutcomeView } from "./jira-tool-outcome";
import { jiraRemoteVersionLinkDetails } from "./jira-remote-version-link-presentation";
import { configurationExchange as exchange } from "./jira-configuration-mutation.test-fixture";
import { PLANNING_CASES, PLANNING_VALUE } from "./jira-planning-mutation.test-fixture";
describe("planning mutation receipt presentation", () => {
  it.each(PLANNING_CASES)(
    "requires complete bound context for $operation",
    ({ operation, receipt }) => {
      const tool = operation.replace(/[.-]/gu, "_");
      expect(jiraPlanningIdentityComplete(tool, receipt)).toBe(true);
      const incomplete = Object.fromEntries(
        Object.entries(receipt).filter(([key]) => key !== "userKey"),
      );
      expect(
        jiraToolState(exchange(tool, { ...incomplete, outcome: "succeeded" }), "completed"),
      ).toBe("chat.jira.write.unknown");
      expect(jiraToolOutcomeView(exchange(tool, receipt)).items.length).toBeGreaterThan(0);
    },
  );
  it.each(["jira_rank_epic", "jira_rank_issues", "jira_delete_project_category"])(
    "never fabricates independent completion for %s",
    (tool) => {
      const fixture = PLANNING_CASES.find(
        ({ operation }) => operation.replace(/[.-]/gu, "_") === tool,
      );
      if (fixture === undefined) throw new TypeError("Missing planning fixture");
      expect(
        jiraToolState(exchange(tool, { ...fixture.receipt, outcome: "succeeded" }), "completed"),
      ).toBe("chat.jira.write.unconfirmed");
    },
  );
  it("retains a real zero in seconds and gives the durable journal precedence", () => {
    const fixture = PLANNING_CASES.find(
      ({ operation }) => operation === "jira.set-issue-estimation",
    );
    if (fixture === undefined) throw new TypeError("Missing estimate fixture");
    const result = exchange("jira_set_issue_estimation", fixture.receipt, 0, "unknown");
    const view = jiraToolOutcomeView(result);
    expect(jiraToolState(result, "completed")).toBe("chat.jira.write.unknown");
    expect(view.items.flatMap((item) => item.facts)).toContainEqual({
      label: "chat.jira.planning.requestedEstimate",
      value: "0",
    });
    expect(view.items.flatMap((item) => item.labels)).toContain("chat.jira.planning.seconds");
    expect(
      view.items
        .flatMap((item) => item.facts)
        .some((item) => item.label === "chat.jira.planning.observedEstimate"),
    ).toBe(false);
  });
  it("does not infer a unit or value from a partial estimate receipt", () => {
    const [details] = jiraPlanningMutationDetails("jira_set_issue_estimation", {
      userKey: "actor-key",
      boardId: "7",
      issueKey: "SYN-1",
    });
    expect(details?.labels).toContain("chat.jira.planning.unitUnknown");
    expect(
      details?.facts.some((fact) => fact.label === "chat.jira.planning.requestedEstimate"),
    ).toBe(false);
  });
  it.each([
    { fieldId: "timeoriginalestimate", estimationUnit: "board-number", estimationValue: 0 },
    { fieldId: "customfield_10001", estimationUnit: "seconds", estimationValue: 60 },
    { fieldId: "timeoriginalestimate", estimationUnit: "seconds", estimationValue: 0.5 },
  ])("refuses contradictory estimate unit/field evidence %j", (change) => {
    const fixture = PLANNING_CASES.find(
      ({ operation }) => operation === "jira.set-issue-estimation",
    );
    if (fixture === undefined) throw new TypeError("Missing estimate fixture");
    const receipt = { ...fixture.receipt, ...change };
    expect(jiraPlanningIdentityComplete("jira_set_issue_estimation", receipt)).toBe(false);
    const [details] = jiraPlanningMutationDetails("jira_set_issue_estimation", receipt);
    expect(details?.labels).toContain("chat.jira.planning.unitUnknown");
    expect(
      details?.facts.some((fact) => fact.label === "chat.jira.planning.observedEstimate"),
    ).toBe(false);
  });
  it.each([
    { fieldId: "summary" },
    { fieldId: "customfield_9007199254740992" },
    { anchorIssueId: "10001" },
    { anchorIssueKey: "SYN-1" },
    { issueIds: ["10001", "10003"], issueKeys: ["SYN-1", "SYN-3"] },
  ])("rejects a malformed single-epic ranking receipt %j", (change) => {
    const fixture = PLANNING_CASES.find(({ operation }) => operation === "jira.rank-epic");
    if (fixture === undefined) throw new TypeError("Missing rank fixture");
    expect(jiraPlanningIdentityComplete("jira_rank_epic", { ...fixture.receipt, ...change })).toBe(
      false,
    );
  });
  it("retains opaque collection IDs without treating them as selectable native path IDs", () => {
    const fixture = PLANNING_CASES.find(
      ({ operation }) => operation === "jira.upsert-version-remote-link",
    );
    if (fixture === undefined) throw new TypeError("Missing version fixture");
    const receipt = { ...fixture.receipt, globalId: "https://example.invalid/opaque%value" };
    expect(jiraPlanningIdentityComplete("jira_upsert_version_remote_link", receipt)).toBe(true);
    expect(
      jiraPlanningIdentityComplete("jira_upsert_version_remote_link_by_global_id", receipt),
    ).toBe(false);
    expect(
      jiraPlanningIdentityComplete("jira_delete_version_remote_link", {
        ...receipt,
        linkPresent: false,
      }),
    ).toBe(false);
    const collection = {
      versionId: receipt.versionId,
      projectId: receipt.projectId,
      projectKey: receipt.projectKey,
      userKey: receipt.userKey,
      globalIds: [receipt.globalId],
      linkPresent: false,
    };
    expect(jiraPlanningIdentityComplete("jira_delete_version_remote_links", collection)).toBe(true);
    expect(
      jiraPlanningIdentityComplete("jira_delete_version_remote_links", {
        ...collection,
        globalId: "other-link",
      }),
    ).toBe(false);
    expect(
      jiraPlanningIdentityComplete("jira_upsert_version_remote_link", {
        ...receipt,
        globalIds: [],
      }),
    ).toBe(false);
  });
  it.each(["x".repeat(256), "actor\u0000key", "actor\ud800key"])(
    "refuses malformed actor context %j",
    (userKey) => {
      const fixture = PLANNING_CASES.find(
        ({ operation }) => operation === "jira.create-project-category",
      );
      if (fixture === undefined) throw new TypeError("Missing category fixture");
      expect(
        jiraPlanningIdentityComplete("jira_create_project_category", {
          ...fixture.receipt,
          userKey,
        }),
      ).toBe(false);
    },
  );
  it("keeps row identity availability separate from readable version-link values", () => {
    const data = {
      outcome: "succeeded",
      items: [
        {
          name: "Opaque link",
          globalId: "must-not-be-inferred",
          reviewIdentityAvailable: false,
          valueAvailable: true,
          valueNodes: PLANNING_VALUE,
        },
      ],
    };
    const opaque = jiraRemoteVersionLinkDetails("jira_version_remote_links", data);
    expect(
      opaque.flatMap((item) => item.facts).some((fact) => fact.value === "must-not-be-inferred"),
    ).toBe(false);
    expect(opaque.flatMap((item) => item.labels)).toContain(
      "chat.jira.versionLinkWrite.identityUnavailable",
    );
    expect(opaque.flatMap((item) => item.labels)).toContain("chat.jira.properties.false");
    const readable = jiraRemoteVersionLinkDetails("jira_version_remote_links", {
      ...data,
      items: [{ ...data.items[0], reviewIdentityAvailable: true }],
    });
    expect(readable.flatMap((item) => item.facts)).toContainEqual({
      label: "chat.jira.issueContext.globalId",
      value: "must-not-be-inferred",
    });
  });
});
