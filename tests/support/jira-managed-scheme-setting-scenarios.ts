import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { OPTION_SCHEME_MUTATION_CASES as option } from "./jira-option-scheme-fixture.js";
import { WORKFLOW_SCHEME_MUTATION_FIXTURE_CASES as workflow } from "./jira-workflow-scheme-mutation-fixture.js";
import { INSTANCE_SETTING_FIXTURE_CASES as instance } from "./jira-instance-setting-mutation-fixture.js";
import { EMAIL_TEMPLATE_NATIVE_CASES as email } from "./jira-email-template-transport-fixture.js";

type Mutation = (typeof option)[number]["tool"] | (typeof workflow)[number]["name"] |
  (typeof instance)[number]["name"] | Exclude<(typeof email)[number]["tool"], "jira.email-template-pack">;
const ACTOR = "synthetic-key";
/** Independent native fixture literals, rebound only to the gateway's verified synthetic actor. */
export const SCHEME_SETTING_ARGUMENTS: Readonly<Record<Mutation, CatalogJsonObject>> = {
  "jira.create-issue-type-scheme": { ...option[0].args, expectedActorKey: ACTOR },
  "jira.update-issue-type-scheme": { ...option[1].args, expectedActorKey: ACTOR },
  "jira.delete-issue-type-scheme": { ...option[2].args, expectedActorKey: ACTOR },
  "jira.add-issue-type-scheme-projects": { ...option[3].args, expectedActorKey: ACTOR },
  "jira.set-issue-type-scheme-projects": { ...option[4].args, expectedActorKey: ACTOR },
  "jira.clear-issue-type-scheme-projects": { ...option[5].args, expectedActorKey: ACTOR },
  "jira.remove-issue-type-scheme-project": { ...option[6].args, expectedActorKey: ACTOR },
  "jira.create-priority-scheme": { ...option[7].args, expectedActorKey: ACTOR },
  "jira.update-priority-scheme": { ...option[8].args, expectedActorKey: ACTOR },
  "jira.delete-priority-scheme": { ...option[9].args, expectedActorKey: ACTOR },
  "jira.create-workflow-scheme": { ...workflow[0].args, expectedActorKey: ACTOR },
  "jira.update-workflow-scheme": { ...workflow[1].args, expectedActorKey: ACTOR },
  "jira.delete-workflow-scheme": { ...workflow[2].args, expectedActorKey: ACTOR },
  "jira.create-workflow-scheme-draft": { ...workflow[3].args, expectedActorKey: ACTOR },
  "jira.update-workflow-scheme-draft": { ...workflow[4].args, expectedActorKey: ACTOR },
  "jira.delete-workflow-scheme-draft": { ...workflow[5].args, expectedActorKey: ACTOR },
  "jira.set-workflow-scheme-default": { ...workflow[6].args, expectedActorKey: ACTOR },
  "jira.delete-workflow-scheme-default": { ...workflow[7].args, expectedActorKey: ACTOR },
  "jira.set-workflow-scheme-draft-default": { ...workflow[8].args, expectedActorKey: ACTOR },
  "jira.delete-workflow-scheme-draft-default": { ...workflow[9].args, expectedActorKey: ACTOR },
  "jira.set-workflow-scheme-issue-type": { ...workflow[10].args, expectedActorKey: ACTOR },
  "jira.delete-workflow-scheme-issue-type": { ...workflow[11].args, expectedActorKey: ACTOR },
  "jira.set-workflow-scheme-draft-issue-type": { ...workflow[12].args, expectedActorKey: ACTOR },
  "jira.delete-workflow-scheme-draft-issue-type": { ...workflow[13].args, expectedActorKey: ACTOR },
  "jira.set-workflow-scheme-workflow": { ...workflow[14].args, expectedActorKey: ACTOR },
  "jira.delete-workflow-scheme-workflow": { ...workflow[15].args, expectedActorKey: ACTOR },
  "jira.set-workflow-scheme-draft-workflow": { ...workflow[16].args, expectedActorKey: ACTOR },
  "jira.delete-workflow-scheme-draft-workflow": { ...workflow[17].args, expectedActorKey: ACTOR },
  "jira.set-application-property": { ...instance[0].args, expectedActorKey: ACTOR },
  "jira.set-system-columns": { ...instance[1].args, expectedActorKey: ACTOR },
  "jira.set-instance-base-url": { ...instance[2].args, expectedActorKey: ACTOR },
  "jira.set-read-only-mode": { ...instance[3].args, expectedActorKey: ACTOR },
  "jira.upload-email-template-pack": { ...email[1].args, expectedActorKey: ACTOR },
  "jira.apply-email-template-pack": { ...email[2].args, expectedActorKey: ACTOR },
  "jira.revert-email-template-pack": { ...email[3].args, expectedActorKey: ACTOR },
};
export const SCHEME_SETTING_RECEIPTS: Readonly<Record<Mutation, CatalogJsonObject>> = {
  "jira.create-issue-type-scheme": { ...option[0].receipt, userKey: ACTOR },
  "jira.update-issue-type-scheme": { ...option[1].receipt, userKey: ACTOR },
  "jira.delete-issue-type-scheme": { ...option[2].receipt, userKey: ACTOR },
  "jira.add-issue-type-scheme-projects": { ...option[3].receipt, userKey: ACTOR },
  "jira.set-issue-type-scheme-projects": { ...option[4].receipt, userKey: ACTOR },
  "jira.clear-issue-type-scheme-projects": { ...option[5].receipt, userKey: ACTOR },
  "jira.remove-issue-type-scheme-project": { ...option[6].receipt, userKey: ACTOR },
  "jira.create-priority-scheme": { ...option[7].receipt, userKey: ACTOR },
  "jira.update-priority-scheme": { ...option[8].receipt, userKey: ACTOR },
  "jira.delete-priority-scheme": { ...option[9].receipt, userKey: ACTOR },
  "jira.create-workflow-scheme": { ...workflow[0].receipt, userKey: ACTOR },
  "jira.update-workflow-scheme": { ...workflow[1].receipt, userKey: ACTOR },
  "jira.delete-workflow-scheme": { ...workflow[2].receipt, userKey: ACTOR },
  "jira.create-workflow-scheme-draft": { ...workflow[3].receipt, userKey: ACTOR },
  "jira.update-workflow-scheme-draft": { ...workflow[4].receipt, userKey: ACTOR },
  "jira.delete-workflow-scheme-draft": { ...workflow[5].receipt, userKey: ACTOR },
  "jira.set-workflow-scheme-default": { ...workflow[6].receipt, userKey: ACTOR },
  "jira.delete-workflow-scheme-default": { ...workflow[7].receipt, userKey: ACTOR },
  "jira.set-workflow-scheme-draft-default": { ...workflow[8].receipt, userKey: ACTOR },
  "jira.delete-workflow-scheme-draft-default": { ...workflow[9].receipt, userKey: ACTOR },
  "jira.set-workflow-scheme-issue-type": { ...workflow[10].receipt, userKey: ACTOR },
  "jira.delete-workflow-scheme-issue-type": { ...workflow[11].receipt, userKey: ACTOR },
  "jira.set-workflow-scheme-draft-issue-type": { ...workflow[12].receipt, userKey: ACTOR },
  "jira.delete-workflow-scheme-draft-issue-type": { ...workflow[13].receipt, userKey: ACTOR },
  "jira.set-workflow-scheme-workflow": { ...workflow[14].receipt, userKey: ACTOR },
  "jira.delete-workflow-scheme-workflow": { ...workflow[15].receipt, userKey: ACTOR },
  "jira.set-workflow-scheme-draft-workflow": { ...workflow[16].receipt, userKey: ACTOR },
  "jira.delete-workflow-scheme-draft-workflow": { ...workflow[17].receipt, userKey: ACTOR },
  "jira.set-application-property": { ...instance[0].receipt, userKey: ACTOR },
  "jira.set-system-columns": { ...instance[1].receipt, userKey: ACTOR },
  "jira.set-instance-base-url": { ...instance[2].receipt, userKey: ACTOR },
  "jira.set-read-only-mode": { ...instance[3].receipt, userKey: ACTOR },
  "jira.upload-email-template-pack": { ...email[1].receipt, userKey: ACTOR },
  "jira.apply-email-template-pack": { ...email[2].receipt, userKey: ACTOR },
  "jira.revert-email-template-pack": { ...email[3].receipt, userKey: ACTOR },
};
const TYPES = [{ id: "1", name: "Task", subtask: false }, { id: "2", name: "Bug", subtask: false }];
const ISSUE = { id: "7", name: "Delivery types", description: "Reviewed types", issueTypes: TYPES, defaultIssueType: TYPES[0] };
const PRIORITY = { id: 9, name: "Delivery priorities", description: "Reviewed priorities", optionIds: ["1", "2"], defaultOptionId: "1", defaultScheme: false };
const OPTIONS = { issueSchemes: [ISSUE], prioritySchemes: [PRIORITY], associations: ["10000"], writes: 1 };
const WORKFLOW = { schemePresent: true, draftPresent: false, schemeName: "Delivery", created: false };
const DRAFT = { ...WORKFLOW, draftPresent: true, draftId: "9007199254740993", draftName: "Delivery" };
const SETTINGS = { columns: ["issuekey", "summary"], baseUrl: "http://legacy.synthetic.invalid/jira", enabled: false, banner: "Existing banner", voting: "true" };
/** Literal remote poststates are not generated by calling the production mutation. */
export const SCHEME_SETTING_REMOTE_STATE: Readonly<Record<Mutation, object>> = {
  "jira.create-issue-type-scheme": { lifecycle: { ...OPTIONS, issueSchemes: [ISSUE, { id: "9007199254740993", name: "Planning types", description: "", issueTypes: [TYPES[1], TYPES[0]], defaultIssueType: TYPES[1] }] } },
  "jira.update-issue-type-scheme": { lifecycle: { ...OPTIONS, issueSchemes: [{ ...ISSUE, name: "Delivery types revised", description: "", issueTypes: [TYPES[1], TYPES[0]], defaultIssueType: TYPES[1] }] } },
  "jira.delete-issue-type-scheme": { lifecycle: { ...OPTIONS, issueSchemes: [] } },
  "jira.add-issue-type-scheme-projects": { lifecycle: { ...OPTIONS, associations: ["10000", "10001"] } },
  "jira.set-issue-type-scheme-projects": { lifecycle: { ...OPTIONS, associations: ["10001"] } },
  "jira.clear-issue-type-scheme-projects": { lifecycle: { ...OPTIONS, associations: [] } },
  "jira.remove-issue-type-scheme-project": { lifecycle: { ...OPTIONS, associations: [] } },
  "jira.create-priority-scheme": { lifecycle: { ...OPTIONS, prioritySchemes: [PRIORITY, { id: "9007199254740993", name: "Planning priorities", description: "", defaultOptionId: "2", optionIds: ["2", "1"], defaultScheme: false }] } },
  "jira.update-priority-scheme": { lifecycle: { ...OPTIONS, prioritySchemes: [{ ...PRIORITY, id: "9", name: "Delivery priorities revised", description: "", defaultOptionId: "2", optionIds: ["2", "1"] }] } },
  "jira.delete-priority-scheme": { lifecycle: { ...OPTIONS, prioritySchemes: [] } },
  "jira.create-workflow-scheme": { lifecycle: { ...WORKFLOW, created: true } },
  "jira.update-workflow-scheme": { lifecycle: { ...WORKFLOW, schemeName: "Renamed" } },
  "jira.delete-workflow-scheme": { lifecycle: { schemePresent: false, draftPresent: false, created: false } },
  "jira.create-workflow-scheme-draft": { lifecycle: DRAFT },
  "jira.update-workflow-scheme-draft": { lifecycle: DRAFT },
  "jira.delete-workflow-scheme-draft": { lifecycle: WORKFLOW },
  "jira.set-workflow-scheme-default": { lifecycle: WORKFLOW },
  "jira.delete-workflow-scheme-default": { lifecycle: WORKFLOW },
  "jira.set-workflow-scheme-draft-default": { lifecycle: DRAFT },
  "jira.delete-workflow-scheme-draft-default": { lifecycle: DRAFT },
  "jira.set-workflow-scheme-issue-type": { lifecycle: WORKFLOW },
  "jira.delete-workflow-scheme-issue-type": { lifecycle: WORKFLOW },
  "jira.set-workflow-scheme-draft-issue-type": { lifecycle: DRAFT },
  "jira.delete-workflow-scheme-draft-issue-type": { lifecycle: DRAFT },
  "jira.set-workflow-scheme-workflow": { lifecycle: WORKFLOW },
  "jira.delete-workflow-scheme-workflow": { lifecycle: WORKFLOW },
  "jira.set-workflow-scheme-draft-workflow": { lifecycle: DRAFT },
  "jira.delete-workflow-scheme-draft-workflow": { lifecycle: DRAFT },
  "jira.set-application-property": { lifecycle: { ...SETTINGS, voting: "false" } },
  "jira.set-system-columns": { lifecycle: { ...SETTINGS, columns: ["summary", "issuekey", "summary"] } },
  "jira.set-instance-base-url": { lifecycle: { ...SETTINGS, baseUrl: "https://next.synthetic.invalid/context" } },
  "jira.set-read-only-mode": { lifecycle: { ...SETTINGS, enabled: true } },
  "jira.upload-email-template-pack": { lifecycle: { writes: 1, action: "upload" } },
  "jira.apply-email-template-pack": { lifecycle: { writes: 1, action: "apply" } },
  "jira.revert-email-template-pack": { lifecycle: { writes: 1, action: "revert" } },
};
export const SCHEME_SETTING_EXPECTED_OUTCOMES = {
  "jira.create-issue-type-scheme": "succeeded", "jira.update-issue-type-scheme": "succeeded",
  "jira.delete-issue-type-scheme": "succeeded-unconfirmed", "jira.add-issue-type-scheme-projects": "succeeded-unconfirmed",
  "jira.set-issue-type-scheme-projects": "succeeded-unconfirmed", "jira.clear-issue-type-scheme-projects": "succeeded-unconfirmed",
  "jira.remove-issue-type-scheme-project": "succeeded-unconfirmed", "jira.create-priority-scheme": "succeeded",
  "jira.update-priority-scheme": "succeeded", "jira.delete-priority-scheme": "succeeded-unconfirmed",
  "jira.create-workflow-scheme": "succeeded", "jira.update-workflow-scheme": "succeeded",
  "jira.delete-workflow-scheme": "succeeded-unconfirmed", "jira.create-workflow-scheme-draft": "succeeded",
  "jira.update-workflow-scheme-draft": "succeeded", "jira.delete-workflow-scheme-draft": "succeeded",
  "jira.set-workflow-scheme-default": "succeeded-unconfirmed", "jira.delete-workflow-scheme-default": "succeeded-unconfirmed",
  "jira.set-workflow-scheme-draft-default": "succeeded", "jira.delete-workflow-scheme-draft-default": "succeeded",
  "jira.set-workflow-scheme-issue-type": "succeeded-unconfirmed", "jira.delete-workflow-scheme-issue-type": "succeeded-unconfirmed",
  "jira.set-workflow-scheme-draft-issue-type": "succeeded", "jira.delete-workflow-scheme-draft-issue-type": "succeeded",
  "jira.set-workflow-scheme-workflow": "succeeded-unconfirmed", "jira.delete-workflow-scheme-workflow": "succeeded-unconfirmed",
  "jira.set-workflow-scheme-draft-workflow": "succeeded", "jira.delete-workflow-scheme-draft-workflow": "succeeded",
  "jira.set-application-property": "succeeded", "jira.set-system-columns": "succeeded",
  "jira.set-instance-base-url": "succeeded-unconfirmed", "jira.set-read-only-mode": "succeeded",
  "jira.upload-email-template-pack": "succeeded-unconfirmed", "jira.apply-email-template-pack": "succeeded-unconfirmed",
  "jira.revert-email-template-pack": "succeeded-unconfirmed",
} as const satisfies Readonly<Record<Mutation, "succeeded" | "succeeded-unconfirmed">>;
export function expectedSchemeSettingOutcome(operation: string): "succeeded" | "succeeded-unconfirmed" | undefined {
  const outcomes: Readonly<Record<string, "succeeded" | "succeeded-unconfirmed">> = SCHEME_SETTING_EXPECTED_OUTCOMES;
  return Object.hasOwn(outcomes, operation) ? outcomes[operation] : undefined;
}
