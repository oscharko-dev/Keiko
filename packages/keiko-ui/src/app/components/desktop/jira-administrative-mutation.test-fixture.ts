import type {
  JiraOptionSchemeMutation,
  JiraWorkflowSchemeMutation,
  JiraInstanceSettingMutation,
  JiraEmailTemplateMutation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { configurationExchange } from "./jira-configuration-mutation.test-fixture";

type AdministrativeOperation =
  | JiraOptionSchemeMutation
  | JiraWorkflowSchemeMutation
  | JiraInstanceSettingMutation
  | JiraEmailTemplateMutation;
interface AdministrativeCase {
  readonly operation: AdministrativeOperation;
  readonly args: CatalogJsonObject;
  readonly receipt: CatalogJsonObject;
  readonly unconfirmable?: true;
}
export const REVIEWED_ISSUE_TYPE_SCHEME = {
  id: "7",
  name: "Reviewed issue types",
  description: null,
  issueTypeIds: ["1", "2"],
  defaultIssueTypeId: "1",
};
export const REVIEWED_PRIORITY_SCHEME = {
  id: "9",
  name: "Reviewed priorities",
  description: "",
  optionIds: ["2", "1"],
  defaultOptionId: "2",
  defaultScheme: false,
};
export const REVIEWED_WORKFLOW_SCHEME = {
  id: "7",
  draft: false,
  name: "Reviewed workflow",
  description: null,
  defaultWorkflow: null,
  mappings: [],
};
export const REVIEWED_WORKFLOW_DRAFT = {
  ...REVIEWED_WORKFLOW_SCHEME,
  id: "8",
  draft: true,
  description: "",
  originalDefaultWorkflow: null,
  originalMappings: [],
};
const ACTOR = { expectedActorKey: "actor-key" };
const SCHEME = { ...ACTOR, expectedScheme: REVIEWED_ISSUE_TYPE_SCHEME };
const PRIORITY = { ...ACTOR, expectedScheme: REVIEWED_PRIORITY_SCHEME };
const BASE = { ...ACTOR, expectedScheme: REVIEWED_WORKFLOW_SCHEME };
const DRAFT = { ...BASE, expectedDraft: REVIEWED_WORKFLOW_DRAFT };
const PROJECTS = [{ id: "10000", key: "SYN", name: "Reviewed project" }];
const ASSOCIATIONS = { ...SCHEME, expectedProjects: PROJECTS, confirmUnverifiedConsequences: true };
const RECEIPT = { userKey: "actor-key", schemeId: "7", schemePresent: true };
const BASE_RECEIPT = { ...RECEIPT, workflowSchemeScope: "scheme" };
const DRAFT_RECEIPT = { ...RECEIPT, workflowSchemeScope: "draft", draftSchemeId: "8" };
export const ADMINISTRATIVE_DIGEST = "a".repeat(64);

/** Independent literal UI scenarios; completeness is compared to canonical contracts in the test. */
export const ADMINISTRATIVE_MUTATION_CASES: readonly AdministrativeCase[] = [
  {
    operation: "jira.create-issue-type-scheme",
    args: {
      ...ACTOR,
      name: "New issue types",
      description: "",
      issueTypeIds: ["1", "2"],
      defaultIssueTypeId: "1",
    },
    receipt: { ...RECEIPT, schemeId: "9007199254740993" },
  },
  {
    operation: "jira.update-issue-type-scheme",
    args: {
      ...SCHEME,
      name: "New issue types",
      description: "",
      issueTypeIds: ["2", "1"],
      defaultIssueTypeId: "2",
    },
    receipt: RECEIPT,
  },
  {
    operation: "jira.delete-issue-type-scheme",
    args: { ...SCHEME, confirmUnverifiedConsequences: true },
    receipt: { ...RECEIPT, schemePresent: false },
    unconfirmable: true,
  },
  {
    operation: "jira.add-issue-type-scheme-projects",
    args: { ...ASSOCIATIONS, projects: [{ id: "10001", key: "OTHER", name: "Other project" }] },
    receipt: {
      ...RECEIPT,
      associationChange: "add",
      projectIds: ["10001"],
      projectKeys: ["OTHER"],
    },
    unconfirmable: true,
  },
  {
    operation: "jira.set-issue-type-scheme-projects",
    args: { ...ASSOCIATIONS, projects: [] },
    receipt: { ...RECEIPT, associationChange: "replace", projectIds: [], projectKeys: [] },
    unconfirmable: true,
  },
  {
    operation: "jira.clear-issue-type-scheme-projects",
    args: { ...ASSOCIATIONS, projects: [] },
    receipt: {
      ...RECEIPT,
      associationChange: "clear",
      projectIds: ["10000"],
      projectKeys: ["SYN"],
    },
    unconfirmable: true,
  },
  {
    operation: "jira.remove-issue-type-scheme-project",
    args: { ...ASSOCIATIONS, projects: PROJECTS },
    receipt: {
      ...RECEIPT,
      associationChange: "remove",
      projectIds: ["10000"],
      projectKeys: ["SYN"],
    },
    unconfirmable: true,
  },
  {
    operation: "jira.create-priority-scheme",
    args: {
      ...ACTOR,
      name: "New priorities",
      description: "",
      optionIds: ["2", "1"],
      defaultOptionId: "2",
    },
    receipt: { ...RECEIPT, schemeId: "9007199254740993" },
  },
  {
    operation: "jira.update-priority-scheme",
    args: {
      ...PRIORITY,
      name: "New priorities",
      description: "",
      optionIds: ["1", "2"],
      defaultOptionId: "1",
    },
    receipt: { ...RECEIPT, schemeId: "9" },
  },
  {
    operation: "jira.delete-priority-scheme",
    args: { ...PRIORITY, confirmUnverifiedConsequences: true },
    receipt: { ...RECEIPT, schemeId: "9", schemePresent: false },
    unconfirmable: true,
  },
  {
    operation: "jira.create-workflow-scheme",
    args: { ...ACTOR, name: "New workflow", description: "", defaultWorkflow: null, mappings: [] },
    receipt: { ...BASE_RECEIPT, schemeId: "9007199254740993" },
  },
  {
    operation: "jira.update-workflow-scheme",
    args: { ...BASE, name: "Renamed workflow", description: "" },
    receipt: BASE_RECEIPT,
  },
  {
    operation: "jira.delete-workflow-scheme",
    args: { ...BASE, confirmUnverifiedDeletion: true },
    receipt: { ...BASE_RECEIPT, schemePresent: false },
    unconfirmable: true,
  },
  { operation: "jira.create-workflow-scheme-draft", args: BASE, receipt: DRAFT_RECEIPT },
  {
    operation: "jira.update-workflow-scheme-draft",
    args: { ...DRAFT, defaultWorkflow: null, mappings: [] },
    receipt: DRAFT_RECEIPT,
  },
  {
    operation: "jira.delete-workflow-scheme-draft",
    args: { ...DRAFT, confirmUnverifiedDeletion: true },
    receipt: { ...DRAFT_RECEIPT, schemePresent: false },
  },
  {
    operation: "jira.set-workflow-scheme-default",
    args: { ...BASE, workflowName: "Classic" },
    receipt: { ...BASE_RECEIPT, mappingPresent: true, workflowName: "Classic" },
    unconfirmable: true,
  },
  {
    operation: "jira.delete-workflow-scheme-default",
    args: BASE,
    receipt: { ...BASE_RECEIPT, mappingPresent: false },
    unconfirmable: true,
  },
  {
    operation: "jira.set-workflow-scheme-draft-default",
    args: { ...DRAFT, workflowName: "Classic" },
    receipt: { ...DRAFT_RECEIPT, mappingPresent: true, workflowName: "Classic" },
  },
  {
    operation: "jira.delete-workflow-scheme-draft-default",
    args: DRAFT,
    receipt: { ...DRAFT_RECEIPT, mappingPresent: false },
  },
  {
    operation: "jira.set-workflow-scheme-issue-type",
    args: { ...BASE, issueTypeId: "1", workflowName: "Classic" },
    receipt: { ...BASE_RECEIPT, mappingPresent: true, issueTypeId: "1", workflowName: "Classic" },
    unconfirmable: true,
  },
  {
    operation: "jira.delete-workflow-scheme-issue-type",
    args: { ...BASE, issueTypeId: "1" },
    receipt: { ...BASE_RECEIPT, mappingPresent: false, issueTypeId: "1" },
    unconfirmable: true,
  },
  {
    operation: "jira.set-workflow-scheme-draft-issue-type",
    args: { ...DRAFT, issueTypeId: "1", workflowName: "Classic" },
    receipt: { ...DRAFT_RECEIPT, mappingPresent: true, issueTypeId: "1", workflowName: "Classic" },
  },
  {
    operation: "jira.delete-workflow-scheme-draft-issue-type",
    args: { ...DRAFT, issueTypeId: "1" },
    receipt: { ...DRAFT_RECEIPT, mappingPresent: false, issueTypeId: "1" },
  },
  {
    operation: "jira.set-workflow-scheme-workflow",
    args: { ...BASE, workflowName: "Classic", issueTypeIds: [], defaultMapping: false },
    receipt: { ...BASE_RECEIPT, mappingPresent: false, workflowName: "Classic" },
    unconfirmable: true,
  },
  {
    operation: "jira.delete-workflow-scheme-workflow",
    args: { ...BASE, workflowName: "Classic" },
    receipt: { ...BASE_RECEIPT, mappingPresent: false, workflowName: "Classic" },
    unconfirmable: true,
  },
  {
    operation: "jira.set-workflow-scheme-draft-workflow",
    args: { ...DRAFT, workflowName: "Classic", issueTypeIds: [], defaultMapping: false },
    receipt: { ...DRAFT_RECEIPT, mappingPresent: false, workflowName: "Classic" },
  },
  {
    operation: "jira.delete-workflow-scheme-draft-workflow",
    args: { ...DRAFT, workflowName: "Classic" },
    receipt: { ...DRAFT_RECEIPT, mappingPresent: false, workflowName: "Classic" },
  },
  {
    operation: "jira.set-application-property",
    args: { ...ACTOR, propertyKey: "jira.clone.prefix", expectedValue: "CLONE - ", value: "" },
    receipt: {
      userKey: "actor-key",
      propertyKey: "jira.clone.prefix",
      valueDigest: ADMINISTRATIVE_DIGEST,
    },
  },
  {
    operation: "jira.set-system-columns",
    args: { ...ACTOR, expectedColumns: ["summary"], columns: ["summary", "summary"] },
    receipt: { userKey: "actor-key", columnIds: ["summary", "summary"] },
  },
  {
    operation: "jira.set-instance-base-url",
    args: {
      ...ACTOR,
      expectedBaseUrl: ["http", "://old.invalid/jira"].join(""),
      configuredBaseUrl: "https://new.invalid/jira",
      confirmInstanceWide: true,
    },
    receipt: { userKey: "actor-key", baseUrlDigest: ADMINISTRATIVE_DIGEST },
    unconfirmable: true,
  },
  {
    operation: "jira.set-read-only-mode",
    args: { ...ACTOR, expectedEnabled: true, enabled: false, confirmInstanceWide: true },
    receipt: { userKey: "actor-key", readOnlyEnabled: false },
  },
  {
    operation: "jira.upload-email-template-pack",
    args: {
      ...ACTOR,
      source: { kind: "connected-file", path: "docs/templates.zip" },
      expectedFile: { name: "templates.zip", sizeBytes: 128, sha256: ADMINISTRATIVE_DIGEST },
      acceptStagedTemplateReplacement: true,
    },
    receipt: {
      userKey: "actor-key",
      emailTemplateAction: "upload",
      uploadSha256: ADMINISTRATIVE_DIGEST,
      uploadBytes: 128,
    },
    unconfirmable: true,
  },
  {
    operation: "jira.apply-email-template-pack",
    args: {
      ...ACTOR,
      expectedActiveManifestSha256: ADMINISTRATIVE_DIGEST,
      acceptGlobalTemplateChange: true,
      acceptUnverifiedStagedPack: true,
    },
    receipt: {
      userKey: "actor-key",
      emailTemplateAction: "apply",
      priorManifestSha256: ADMINISTRATIVE_DIGEST,
      observedManifestSha256: "b".repeat(64),
    },
    unconfirmable: true,
  },
  {
    operation: "jira.revert-email-template-pack",
    args: {
      ...ACTOR,
      expectedActiveManifestSha256: ADMINISTRATIVE_DIGEST,
      acceptGlobalTemplateChange: true,
    },
    receipt: {
      userKey: "actor-key",
      emailTemplateAction: "revert",
      priorManifestSha256: ADMINISTRATIVE_DIGEST,
    },
    unconfirmable: true,
  },
];

export function administrativeCase(operation: AdministrativeOperation): AdministrativeCase {
  const selected = ADMINISTRATIVE_MUTATION_CASES.find((item) => item.operation === operation);
  if (selected === undefined) throw new TypeError("Missing administrative operation fixture");
  return selected;
}
export function administrativeExchange(
  fixture: AdministrativeCase,
  data: CatalogJsonObject = fixture.receipt,
  index = 0,
  mutationOutcome?: ChatToolExchange["mutationOutcome"],
): ChatToolExchange {
  const exchange = configurationExchange(
    fixture.operation.replace(/[.-]/gu, "_"),
    data,
    index,
    mutationOutcome,
  );
  return { ...exchange, call: { ...exchange.call, arguments: fixture.args } };
}
