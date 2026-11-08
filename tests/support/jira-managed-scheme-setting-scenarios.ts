import { jiraManagedScenarios, type JiraManagedScenario } from "./jira-managed-scenario.js";

import { OPTION_SCHEME_MUTATION_CASES as option } from "./jira-option-scheme-fixture.js";

import { WORKFLOW_SCHEME_MUTATION_FIXTURE_CASES as workflow } from "./jira-workflow-scheme-mutation-fixture.js";

import { INSTANCE_SETTING_FIXTURE_CASES as instance } from "./jira-instance-setting-mutation-fixture.js";

import { EMAIL_TEMPLATE_NATIVE_CASES as email } from "./jira-email-template-transport-fixture.js";

type Mutation =
  | (typeof option)[number]["tool"]
  | (typeof workflow)[number]["name"]
  | (typeof instance)[number]["name"]
  | Exclude<(typeof email)[number]["tool"], "jira.email-template-pack">;

const ACTOR = "synthetic-key";

const TYPES = [
  { id: "1", name: "Task", subtask: false },
  { id: "2", name: "Bug", subtask: false },
];

const ISSUE = {
  id: "7",
  name: "Delivery types",
  description: "Reviewed types",
  issueTypes: TYPES,
  defaultIssueType: TYPES[0],
};

const PRIORITY = {
  id: 9,
  name: "Delivery priorities",
  description: "Reviewed priorities",
  optionIds: ["1", "2"],
  defaultOptionId: "1",
  defaultScheme: false,
};

const OPTIONS = {
  issueSchemes: [ISSUE],
  prioritySchemes: [PRIORITY],
  associations: ["10000"],
  writes: 1,
};

const WORKFLOW = {
  schemePresent: true,
  draftPresent: false,
  schemeName: "Delivery",
  created: false,
};

const DRAFT = {
  ...WORKFLOW,
  draftPresent: true,
  draftId: "9007199254740993",
  draftName: "Delivery",
};

const SETTINGS = {
  columns: ["issuekey", "summary"],
  baseUrl: "http://legacy.synthetic.invalid/jira",
  enabled: false,
  banner: "Existing banner",
  voting: "true",
};
const SCENARIOS = {
  "jira.create-issue-type-scheme": {
    ...option[0],
    receiptActor: "userKey",
    remoteState: {
      lifecycle: {
        ...OPTIONS,
        issueSchemes: [
          ISSUE,
          {
            id: "9007199254740993",
            name: "Planning types",
            description: "",
            issueTypes: [TYPES[1], TYPES[0]],
            defaultIssueType: TYPES[1],
          },
        ],
      },
    },
    outcome: "succeeded",
  },
  "jira.update-issue-type-scheme": {
    ...option[1],
    receiptActor: "userKey",
    remoteState: {
      lifecycle: {
        ...OPTIONS,
        issueSchemes: [
          {
            ...ISSUE,
            name: "Delivery types revised",
            description: "",
            issueTypes: [TYPES[1], TYPES[0]],
            defaultIssueType: TYPES[1],
          },
        ],
      },
    },
    outcome: "succeeded",
  },
  "jira.delete-issue-type-scheme": {
    ...option[2],
    receiptActor: "userKey",
    remoteState: { lifecycle: { ...OPTIONS, issueSchemes: [] } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.add-issue-type-scheme-projects": {
    ...option[3],
    receiptActor: "userKey",
    remoteState: { lifecycle: { ...OPTIONS, associations: ["10000", "10001"] } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.set-issue-type-scheme-projects": {
    ...option[4],
    receiptActor: "userKey",
    remoteState: { lifecycle: { ...OPTIONS, associations: ["10001"] } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.clear-issue-type-scheme-projects": {
    ...option[5],
    receiptActor: "userKey",
    remoteState: { lifecycle: { ...OPTIONS, associations: [] } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.remove-issue-type-scheme-project": {
    ...option[6],
    receiptActor: "userKey",
    remoteState: { lifecycle: { ...OPTIONS, associations: [] } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.create-priority-scheme": {
    ...option[7],
    receiptActor: "userKey",
    remoteState: {
      lifecycle: {
        ...OPTIONS,
        prioritySchemes: [
          PRIORITY,
          {
            id: "9007199254740993",
            name: "Planning priorities",
            description: "",
            defaultOptionId: "2",
            optionIds: ["2", "1"],
            defaultScheme: false,
          },
        ],
      },
    },
    outcome: "succeeded",
  },
  "jira.update-priority-scheme": {
    ...option[8],
    receiptActor: "userKey",
    remoteState: {
      lifecycle: {
        ...OPTIONS,
        prioritySchemes: [
          {
            ...PRIORITY,
            id: "9",
            name: "Delivery priorities revised",
            description: "",
            defaultOptionId: "2",
            optionIds: ["2", "1"],
          },
        ],
      },
    },
    outcome: "succeeded",
  },
  "jira.delete-priority-scheme": {
    ...option[9],
    receiptActor: "userKey",
    remoteState: { lifecycle: { ...OPTIONS, prioritySchemes: [] } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.create-workflow-scheme": {
    ...workflow[0],
    receiptActor: "userKey",
    remoteState: { lifecycle: { ...WORKFLOW, created: true } },
    outcome: "succeeded",
  },
  "jira.update-workflow-scheme": {
    ...workflow[1],
    receiptActor: "userKey",
    remoteState: { lifecycle: { ...WORKFLOW, schemeName: "Renamed" } },
    outcome: "succeeded",
  },
  "jira.delete-workflow-scheme": {
    ...workflow[2],
    receiptActor: "userKey",
    remoteState: { lifecycle: { schemePresent: false, draftPresent: false, created: false } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.create-workflow-scheme-draft": {
    ...workflow[3],
    receiptActor: "userKey",
    remoteState: { lifecycle: DRAFT },
    outcome: "succeeded",
  },
  "jira.update-workflow-scheme-draft": {
    ...workflow[4],
    receiptActor: "userKey",
    remoteState: { lifecycle: DRAFT },
    outcome: "succeeded",
  },
  "jira.delete-workflow-scheme-draft": {
    ...workflow[5],
    receiptActor: "userKey",
    remoteState: { lifecycle: WORKFLOW },
    outcome: "succeeded",
  },
  "jira.set-workflow-scheme-default": {
    ...workflow[6],
    receiptActor: "userKey",
    remoteState: { lifecycle: WORKFLOW },
    outcome: "succeeded-unconfirmed",
  },
  "jira.delete-workflow-scheme-default": {
    ...workflow[7],
    receiptActor: "userKey",
    remoteState: { lifecycle: WORKFLOW },
    outcome: "succeeded-unconfirmed",
  },
  "jira.set-workflow-scheme-draft-default": {
    ...workflow[8],
    receiptActor: "userKey",
    remoteState: { lifecycle: DRAFT },
    outcome: "succeeded",
  },
  "jira.delete-workflow-scheme-draft-default": {
    ...workflow[9],
    receiptActor: "userKey",
    remoteState: { lifecycle: DRAFT },
    outcome: "succeeded",
  },
  "jira.set-workflow-scheme-issue-type": {
    ...workflow[10],
    receiptActor: "userKey",
    remoteState: { lifecycle: WORKFLOW },
    outcome: "succeeded-unconfirmed",
  },
  "jira.delete-workflow-scheme-issue-type": {
    ...workflow[11],
    receiptActor: "userKey",
    remoteState: { lifecycle: WORKFLOW },
    outcome: "succeeded-unconfirmed",
  },
  "jira.set-workflow-scheme-draft-issue-type": {
    ...workflow[12],
    receiptActor: "userKey",
    remoteState: { lifecycle: DRAFT },
    outcome: "succeeded",
  },
  "jira.delete-workflow-scheme-draft-issue-type": {
    ...workflow[13],
    receiptActor: "userKey",
    remoteState: { lifecycle: DRAFT },
    outcome: "succeeded",
  },
  "jira.set-workflow-scheme-workflow": {
    ...workflow[14],
    receiptActor: "userKey",
    remoteState: { lifecycle: WORKFLOW },
    outcome: "succeeded-unconfirmed",
  },
  "jira.delete-workflow-scheme-workflow": {
    ...workflow[15],
    receiptActor: "userKey",
    remoteState: { lifecycle: WORKFLOW },
    outcome: "succeeded-unconfirmed",
  },
  "jira.set-workflow-scheme-draft-workflow": {
    ...workflow[16],
    receiptActor: "userKey",
    remoteState: { lifecycle: DRAFT },
    outcome: "succeeded",
  },
  "jira.delete-workflow-scheme-draft-workflow": {
    ...workflow[17],
    receiptActor: "userKey",
    remoteState: { lifecycle: DRAFT },
    outcome: "succeeded",
  },
  "jira.set-application-property": {
    ...instance[0],
    receiptActor: "userKey",
    remoteState: { lifecycle: { ...SETTINGS, voting: "false" } },
    outcome: "succeeded",
  },
  "jira.set-system-columns": {
    ...instance[1],
    receiptActor: "userKey",
    remoteState: { lifecycle: { ...SETTINGS, columns: ["summary", "issuekey", "summary"] } },
    outcome: "succeeded",
  },
  "jira.set-instance-base-url": {
    ...instance[2],
    receiptActor: "userKey",
    remoteState: { lifecycle: { ...SETTINGS, baseUrl: "https://next.synthetic.invalid/context" } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.set-read-only-mode": {
    ...instance[3],
    receiptActor: "userKey",
    remoteState: { lifecycle: { ...SETTINGS, enabled: true } },
    outcome: "succeeded",
  },
  "jira.upload-email-template-pack": {
    ...email[1],
    receiptActor: "userKey",
    remoteState: { lifecycle: { writes: 1, action: "upload" } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.apply-email-template-pack": {
    ...email[2],
    receiptActor: "userKey",
    remoteState: { lifecycle: { writes: 1, action: "apply" } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.revert-email-template-pack": {
    ...email[3],
    receiptActor: "userKey",
    remoteState: { lifecycle: { writes: 1, action: "revert" } },
    outcome: "succeeded-unconfirmed",
  },
} satisfies Readonly<Record<Mutation, JiraManagedScenario>>;
export const {
  arguments: SCHEME_SETTING_ARGUMENTS,
  receipts: SCHEME_SETTING_RECEIPTS,
  remoteState: SCHEME_SETTING_REMOTE_STATE,
  outcomes: SCHEME_SETTING_EXPECTED_OUTCOMES,
  expectedOutcome: expectedSchemeSettingOutcome,
} = jiraManagedScenarios(SCENARIOS, ACTOR);
