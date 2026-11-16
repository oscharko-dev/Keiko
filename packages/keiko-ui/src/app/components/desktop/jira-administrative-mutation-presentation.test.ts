import { describe, expect, it } from "vitest";
import {
  JIRA_OPTION_SCHEME_MUTATIONS,
  JIRA_WORKFLOW_SCHEME_MUTATIONS,
  JIRA_INSTANCE_SETTING_MUTATIONS,
  JIRA_EMAIL_TEMPLATE_MUTATIONS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  jiraSchemeAdministrationIdentityComplete,
  jiraSchemeAdministrationDetails,
  jiraSchemeConfirmationUnavailable,
} from "./jira-scheme-administration-presentation";
import {
  jiraInstanceAdministrationIdentityComplete,
  jiraInstanceAdministrationDetails,
} from "./jira-instance-administration-presentation";
import { jiraSchemeReviewDetails } from "./jira-scheme-review-presentation";
import { jiraToolState } from "./jira-tool-presentation";
import { jiraToolOutcomeView } from "./jira-tool-outcome";
import {
  ADMINISTRATIVE_MUTATION_CASES,
  ADMINISTRATIVE_DIGEST,
  administrativeCase,
  administrativeExchange,
  REVIEWED_ISSUE_TYPE_SCHEME,
  REVIEWED_PRIORITY_SCHEME,
  REVIEWED_WORKFLOW_SCHEME,
  REVIEWED_WORKFLOW_DRAFT,
} from "./jira-administrative-mutation.test-fixture";

describe("administration receipt and review presentation", () => {
  it("has independent argument and receipt cases for every canonical write", () => {
    expect(ADMINISTRATIVE_MUTATION_CASES.map(({ operation }) => operation).sort()).toEqual(
      [
        ...JIRA_OPTION_SCHEME_MUTATIONS,
        ...JIRA_WORKFLOW_SCHEME_MUTATIONS,
        ...JIRA_INSTANCE_SETTING_MUTATIONS,
        ...JIRA_EMAIL_TEMPLATE_MUTATIONS,
      ].sort(),
    );
    expect(ADMINISTRATIVE_MUTATION_CASES.filter(({ unconfirmable }) => unconfirmable)).toHaveLength(
      17,
    );
  });
  it.each(ADMINISTRATIVE_MUTATION_CASES)(
    "retains exact context and confirmation boundary for $operation",
    (fixture) => {
      const tool = fixture.operation.replace(/[.-]/gu, "_");
      expect(
        jiraSchemeAdministrationIdentityComplete(tool, fixture.receipt) ||
          jiraInstanceAdministrationIdentityComplete(tool, fixture.receipt),
      ).toBe(true);
      const exchange = administrativeExchange(fixture, {
        ...fixture.receipt,
        outcome: "succeeded",
      });
      expect(jiraToolState(exchange, "completed")).toBe(
        fixture.unconfirmable ? "chat.jira.write.unconfirmed" : "chat.jira.write.succeeded",
      );
      expect(jiraToolOutcomeView(exchange).items.flatMap((item) => item.labels)).toContain(
        "chat.jira.schemeWrite.configurationOnly",
      );
      const missing = Object.fromEntries(
        Object.entries(fixture.receipt).filter(([key]) => key !== "userKey"),
      );
      expect(
        jiraToolState(
          administrativeExchange(fixture, { ...missing, outcome: "succeeded" }),
          "completed",
        ),
      ).toBe("chat.jira.write.unknown");
    },
  );
  it.each([
    ["jira.create-issue-type-scheme", "schemeId"],
    ["jira.create-priority-scheme", "schemeId"],
    ["jira.create-workflow-scheme", "schemeId"],
    ["jira.create-workflow-scheme-draft", "draftSchemeId"],
  ] as const)(
    "never substitutes a requested name for a missing %s acknowledgement",
    (operation, key) => {
      const fixture = administrativeCase(operation);
      const receipt = Object.fromEntries(
        Object.entries(fixture.receipt).filter(([field]) => field !== key),
      );
      const exchange = administrativeExchange(fixture, {
        ...receipt,
        outcome: "succeeded",
        name: "Not an acknowledged ID",
      });
      expect(jiraToolState(exchange, "completed")).toBe("chat.jira.write.unknown");
      expect(jiraToolOutcomeView(exchange).items.flatMap((item) => item.labels)).toContain(
        "chat.jira.savedConfiguration.identityUnknown",
      );
    },
  );
  it.each([
    { projectIds: undefined },
    { projectKeys: undefined },
    { projectKeys: ["SYN"] },
    { projectIds: ["1", "1"], projectKeys: ["SYN", "OTHER"] },
    { projectIds: ["1", "2"], projectKeys: ["SYN", "syn"] },
    { associationChange: "clear" },
    { schemePresent: false },
    { draftSchemeId: "8" },
    { readOnlyEnabled: false },
  ])("refuses incomplete or contradictory replacement context %j", (change) => {
    const fixture = administrativeCase("jira.set-issue-type-scheme-projects");
    expect(
      jiraSchemeAdministrationIdentityComplete("jira_set_issue_type_scheme_projects", {
        ...fixture.receipt,
        ...change,
      }),
    ).toBe(false);
  });
  it("keeps intentional empty replacement distinct from an unknown population", () => {
    const { receipt } = administrativeCase("jira.set-issue-type-scheme-projects");
    const [empty] = jiraSchemeAdministrationDetails("jira_set_issue_type_scheme_projects", receipt);
    expect(empty?.facts).toContainEqual({
      label: "chat.jira.schemeWrite.projectTargetCount",
      value: "0",
    });
    const [unknown] = jiraSchemeAdministrationDetails("jira_set_issue_type_scheme_projects", {
      ...receipt,
      projectKeys: undefined,
    });
    expect(
      unknown?.facts.some(({ label }) => label === "chat.jira.schemeWrite.projectTargetCount"),
    ).toBe(false);
  });
  it("requires a nonempty addition and exactly one removal", () => {
    const add = administrativeCase("jira.add-issue-type-scheme-projects").receipt;
    expect(
      jiraSchemeAdministrationIdentityComplete("jira_add_issue_type_scheme_projects", {
        ...add,
        projectIds: [],
        projectKeys: [],
      }),
    ).toBe(false);
    const remove = administrativeCase("jira.remove-issue-type-scheme-project").receipt;
    expect(
      jiraSchemeAdministrationIdentityComplete("jira_remove_issue_type_scheme_project", {
        ...remove,
        projectIds: ["1", "2"],
        projectKeys: ["A", "B"],
      }),
    ).toBe(false);
  });
  it.each([
    { draftSchemeId: undefined },
    { workflowSchemeScope: "scheme" },
    { schemePresent: false },
    { mappingPresent: false },
    { issueTypeId: "not-an-id" },
    { workflowName: undefined },
    { columnIds: ["summary"] },
  ])("does not confirm a contradictory draft mapping %j", (change) => {
    const { receipt } = administrativeCase("jira.set-workflow-scheme-draft-issue-type");
    expect(
      jiraSchemeAdministrationIdentityComplete("jira_set_workflow_scheme_draft_issue_type", {
        ...receipt,
        ...change,
      }),
    ).toBe(false);
  });
  it("allows an explicit false workflow mapping and a confirmed draft deletion", () => {
    const mapping = administrativeCase("jira.set-workflow-scheme-draft-workflow");
    expect(
      jiraSchemeAdministrationIdentityComplete(
        "jira_set_workflow_scheme_draft_workflow",
        mapping.receipt,
      ),
    ).toBe(true);
    const deletion = administrativeCase("jira.delete-workflow-scheme-draft");
    expect(
      jiraToolState(
        administrativeExchange(deletion, { ...deletion.receipt, outcome: "succeeded" }),
        "completed",
      ),
    ).toBe("chat.jira.write.succeeded");
  });
  it("uses retained base update arguments rather than receipt alone for confirmation", () => {
    const fixture = administrativeCase("jira.update-workflow-scheme");
    expect(jiraSchemeConfirmationUnavailable("jira_update_workflow_scheme", fixture.args)).toBe(
      false,
    );
    for (const args of [
      undefined,
      {},
      { ...fixture.args, mappings: [] },
      { ...fixture.args, defaultWorkflow: null },
    ]) {
      expect(jiraSchemeConfirmationUnavailable("jira_update_workflow_scheme", args)).toBe(true);
    }
    const changed = { ...fixture, args: { ...fixture.args, mappings: [] } };
    const exchange = administrativeExchange(changed, { ...fixture.receipt, outcome: "succeeded" });
    expect(jiraToolState(exchange, "completed")).toBe("chat.jira.write.unconfirmed");
    expect(jiraToolOutcomeView(exchange).items.flatMap((item) => item.labels)).toContain(
      "chat.jira.savedConfiguration.unconfirmed",
    );
  });
  it("preserves duplicate column order and false read-only state, but rejects borrowed context", () => {
    const columns = administrativeCase("jira.set-system-columns").receipt;
    expect(jiraInstanceAdministrationIdentityComplete("jira_set_system_columns", columns)).toBe(
      true,
    );
    expect(
      jiraInstanceAdministrationDetails("jira_set_system_columns", columns)[0]?.facts.filter(
        ({ label }) => label === "chat.jira.instanceWrite.columnPosition",
      ),
    ).toEqual([
      { label: "chat.jira.instanceWrite.columnPosition", value: "1: summary" },
      { label: "chat.jira.instanceWrite.columnPosition", value: "2: summary" },
    ]);
    expect(
      jiraInstanceAdministrationIdentityComplete("jira_set_system_columns", {
        ...columns,
        columnIds: [],
      }),
    ).toBe(false);
    const mode = administrativeCase("jira.set-read-only-mode");
    expect(
      jiraInstanceAdministrationIdentityComplete("jira_set_read_only_mode", mode.receipt),
    ).toBe(true);
    expect(
      jiraInstanceAdministrationIdentityComplete("jira_set_read_only_mode", {
        ...mode.receipt,
        schemeId: "7",
      }),
    ).toBe(false);
    const unknown = administrativeExchange(
      mode,
      { ...mode.receipt, outcome: "succeeded" },
      0,
      "unknown",
    );
    expect(jiraToolState(unknown, "completed")).toBe("chat.jira.write.unknown");
    const facts = jiraToolOutcomeView(unknown).items.flatMap((item) => item.facts);
    expect(facts).toContainEqual({
      label: "chat.jira.instanceWrite.requestedReadOnly",
      value: "false",
    });
    expect(facts.some(({ label }) => label === "chat.jira.instanceWrite.observedReadOnly")).toBe(
      false,
    );
  });
  it.each([
    { emailTemplateAction: "apply" },
    { uploadBytes: 0 },
    { uploadBytes: 20 * 1024 * 1024 + 1 },
    { uploadSha256: "bad" },
    { observedManifestSha256: ADMINISTRATIVE_DIGEST },
    { schemeId: "7" },
  ])("refuses unbound or mixed email upload receipt %j", (change) => {
    const { receipt } = administrativeCase("jira.upload-email-template-pack");
    expect(
      jiraInstanceAdministrationIdentityComplete("jira_upload_email_template_pack", {
        ...receipt,
        ...change,
      }),
    ).toBe(false);
  });
  it("does not treat unknown property keys or an unavailable read-only flag as confirmation", () => {
    const property = administrativeCase("jira.set-application-property").receipt;
    expect(
      jiraInstanceAdministrationIdentityComplete("jira_set_application_property", {
        ...property,
        propertyKey: "unknown.configuration",
      }),
    ).toBe(false);
    expect(
      jiraInstanceAdministrationIdentityComplete("jira_set_application_property", {
        ...property,
        valueDigest: "raw value",
      }),
    ).toBe(false);
    expect(
      jiraInstanceAdministrationIdentityComplete("jira_set_read_only_mode", {
        userKey: "actor-key",
        readOnlyEnabled: null,
      }),
    ).toBe(false);
  });
  it.each([
    "jira.set-issue-type-scheme-projects",
    "jira.set-instance-base-url",
    "jira.set-read-only-mode",
  ] as const)(
    "uses explicit pre-effect unchanged evidence for %s, subject to the journal",
    (operation) => {
      const fixture = administrativeCase(operation);
      const receipt = {
        ...fixture.receipt,
        outcome: "rejected",
        reason: "conflict",
        unchanged: true,
      };
      expect(jiraToolState(administrativeExchange(fixture, receipt), "completed")).toBe(
        "chat.jira.write.unchanged",
      );
      const unknown = administrativeExchange(fixture, receipt, 0, "unknown");
      expect(jiraToolState(unknown, "completed")).toBe("chat.jira.write.unknown");
      expect(jiraToolOutcomeView(unknown).items.flatMap((item) => item.labels)).not.toContain(
        "chat.jira.savedConfiguration.unchanged",
      );
    },
  );
  it("never invents an email no-op or a complete empty export from missing metadata", () => {
    const fixture = administrativeCase("jira.apply-email-template-pack");
    expect(
      jiraToolState(
        administrativeExchange(fixture, {
          ...fixture.receipt,
          outcome: "rejected",
          reason: "conflict",
          unchanged: true,
        }),
        "completed",
      ),
    ).not.toBe("chat.jira.write.unchanged");
    const archive = {
      selectionScope: "complete-exported-email-template-pack",
      archiveBytes: 128,
      archiveSha256: ADMINISTRATIVE_DIGEST,
      manifestSha256: ADMINISTRATIVE_DIGEST,
      entryCount: 0,
      items: [],
    };
    expect(
      jiraInstanceAdministrationDetails("jira_email_template_pack", archive)[0]?.facts,
    ).toContainEqual({ label: "chat.jira.emailPack.entryCount", value: "0" });
    expect(
      jiraInstanceAdministrationDetails("jira_email_template_pack", {
        ...archive,
        items: undefined,
      })[0]?.labels,
    ).toContain("chat.jira.emailPack.metadataUnavailable");
  });
  it.each(["jira.create-workflow-scheme", "jira.delete-workflow-scheme-draft"] as const)(
    "does not infer unsupported no-op semantics for %s",
    (operation) => {
      const fixture = administrativeCase(operation);
      const exchange = administrativeExchange(fixture, {
        ...fixture.receipt,
        outcome: "rejected",
        reason: "conflict",
        unchanged: true,
      });
      expect(jiraToolState(exchange, "completed")).not.toBe("chat.jira.write.unchanged");
      expect(jiraToolOutcomeView(exchange).items.flatMap((item) => item.labels)).not.toContain(
        "chat.jira.savedConfiguration.unchanged",
      );
    },
  );
});

describe("complete observed scheme review forms", () => {
  it("preserves native null, empty description and false default flag", () => {
    const issue = jiraSchemeReviewDetails("issue-type", {
      ...REVIEWED_ISSUE_TYPE_SCHEME,
      reviewSnapshotAvailable: true,
      reviewSnapshot: REVIEWED_ISSUE_TYPE_SCHEME,
    });
    expect(issue.labels).toContain("chat.jira.structural.nativeNotProvided");
    const priority = jiraSchemeReviewDetails("priority", {
      ...REVIEWED_PRIORITY_SCHEME,
      reviewSnapshot: REVIEWED_PRIORITY_SCHEME,
    });
    expect(priority.labels).toContain("chat.jira.propertyMutation.emptyText");
    expect(priority.facts).toContainEqual({
      label: "chat.jira.schemeWrite.defaultScheme",
      value: "false",
    });
  });
  it("distinguishes draft original facts from current empty maps without claiming publication", () => {
    const details = jiraSchemeReviewDetails("workflow", {
      ...REVIEWED_WORKFLOW_DRAFT,
      reviewSnapshot: REVIEWED_WORKFLOW_DRAFT,
    });
    expect(details.labels).toContain("chat.jira.schemeWrite.draftOnly");
    expect(details.facts).toContainEqual({
      label: "chat.jira.schemeWrite.mappingCount",
      value: "0",
    });
    expect(details.facts).toContainEqual({
      label: "chat.jira.schemeWrite.originalMappings",
      value: "0",
    });
    const base = jiraSchemeReviewDetails("workflow", {
      ...REVIEWED_WORKFLOW_SCHEME,
      reviewSnapshot: {
        ...REVIEWED_WORKFLOW_SCHEME,
        originalDefaultWorkflow: null,
        originalMappings: [],
      },
    });
    expect(base.labels).toContain("chat.jira.schemeWrite.baseOnly");
    expect(base.labels).not.toContain("chat.jira.administration.published");
  });
  it.each([
    { description: undefined },
    { defaultWorkflow: undefined },
    { mappings: undefined },
    { originalMappings: undefined },
    { id: "9" },
    {
      mappings: [
        { issueTypeId: "1", workflow: "A" },
        { issueTypeId: "1", workflow: "B" },
      ],
    },
  ])("does not manufacture a complete draft from missing or contradictory facts %j", (change) => {
    const details = jiraSchemeReviewDetails("workflow", {
      ...REVIEWED_WORKFLOW_DRAFT,
      reviewSnapshot: { ...REVIEWED_WORKFLOW_DRAFT, ...change },
    });
    expect(details.labels).toContain("chat.jira.schemeWrite.reviewUnavailable");
  });
  it("preserves a producer's explicit unavailable flag even beside a stale snapshot", () => {
    expect(
      jiraSchemeReviewDetails("issue-type", {
        ...REVIEWED_ISSUE_TYPE_SCHEME,
        reviewSnapshotAvailable: false,
        reviewSnapshot: REVIEWED_ISSUE_TYPE_SCHEME,
      }).labels,
    ).toContain("chat.jira.schemeWrite.reviewUnavailable");
  });
});
