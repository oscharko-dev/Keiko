import { jiraManagedScenarios, type JiraManagedScenario } from "./jira-managed-scenario.js";

import { DIRECTORY_ACCESS_FIXTURE_CASES as directory } from "./jira-directory-access-fixture.js";

import { MAINTENANCE_MUTATION_FIXTURE_CASES as maintenance } from "./jira-maintenance-mutation-fixture.js";

import { SCHEMA_MUTATION_FIXTURE_CASES as schema } from "./jira-schema-mutation-fixture.js";

import { GROUP_MUTATION_FIXTURE_CASES as group } from "./jira-group-mutation-fixture.js";

import { ISSUE_ACTION_FIXTURE_CASES as issue } from "./jira-issue-action-fixture.js";

import {
  SCHEMA_TYPE,
  SCHEMA_ALTERNATIVE,
  SCHEMA_LINK,
  SCHEMA_OTHER_LINK,
  SCHEMA_FIELD,
  SCHEMA_TERMS,
} from "./jira-schema-mutation-fixture.js";

type Mutation =
  | (typeof directory)[number]["name"]
  | (typeof maintenance)[number]["name"]
  | (typeof schema)[number]["name"]
  | (typeof group)[number]["name"]
  | (typeof issue)[number]["name"];

const ACTOR = "synthetic-key";

const INITIAL_ROLES = [
  { key: "jira-software", groups: ["jira-users"], defaultGroups: ["jira-users"] },
  { key: "jira-core", groups: [], defaultGroups: [] },
];

const CHANGED_ROLES = [
  { key: "jira-software", groups: ["jira-users", "R&D team"], defaultGroups: ["R&D team"] },
  { key: "jira-core", groups: [], defaultGroups: [] },
];

const SCHEMA_STATE = {
  types: [SCHEMA_TYPE, SCHEMA_ALTERNATIVE],
  links: [SCHEMA_LINK, SCHEMA_OTHER_LINK],
  fields: [SCHEMA_FIELD],
  terms: SCHEMA_TERMS,
};

const NEW_LINK = { name: "Requires", inward: "is required by", outward: "requires" };
const SCENARIOS = {
  "jira.set-application-role": {
    ...directory[0],
    receiptActor: "actorUserKey",
    remoteState: {
      lifecycle: {
        effects: 1,
        roles: CHANGED_ROLES,
        columns: ["summary", "status", "summary"],
        access: undefined,
      },
    },
    outcome: "succeeded-unconfirmed",
  },
  "jira.set-application-roles": {
    ...directory[1],
    receiptActor: "actorUserKey",
    remoteState: {
      lifecycle: {
        effects: 1,
        roles: CHANGED_ROLES,
        columns: ["summary", "status", "summary"],
        access: undefined,
      },
    },
    outcome: "succeeded-unconfirmed",
  },
  "jira.add-user-application": {
    ...directory[2],
    receiptActor: "actorUserKey",
    remoteState: {
      lifecycle: {
        effects: 1,
        roles: INITIAL_ROLES,
        columns: ["summary", "status", "summary"],
        access: true,
      },
    },
    outcome: "succeeded-unconfirmed",
  },
  "jira.remove-user-application": {
    ...directory[3],
    receiptActor: "actorUserKey",
    remoteState: {
      lifecycle: {
        effects: 1,
        roles: INITIAL_ROLES,
        columns: ["summary", "status", "summary"],
        access: false,
      },
    },
    outcome: "succeeded-unconfirmed",
  },
  "jira.set-user-columns": {
    ...directory[4],
    receiptActor: "actorUserKey",
    remoteState: {
      lifecycle: {
        effects: 1,
        roles: INITIAL_ROLES,
        columns: ["status", "summary", "status"],
        access: undefined,
      },
    },
    outcome: "succeeded",
  },
  "jira.reset-user-columns": {
    ...directory[5],
    receiptActor: "actorUserKey",
    remoteState: {
      lifecycle: {
        effects: 1,
        roles: INITIAL_ROLES,
        columns: ["summary", "status"],
        access: undefined,
      },
    },
    outcome: "succeeded-unconfirmed",
  },
  "jira.request-cluster-index-snapshot": {
    ...maintenance[0],
    receiptActor: "userKey",
    remoteState: { lifecycle: { effects: 1, nodeCount: 1 } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.delete-cluster-node": {
    ...maintenance[1],
    receiptActor: "userKey",
    remoteState: { lifecycle: { effects: 1, nodeCount: 0 } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.mark-cluster-node-offline": {
    ...maintenance[2],
    receiptActor: "userKey",
    remoteState: { lifecycle: { effects: 1, nodeCount: 1 } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.approve-cluster-upgrade": {
    ...maintenance[3],
    receiptActor: "userKey",
    remoteState: { lifecycle: { effects: 1, nodeCount: 1 } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.cancel-cluster-upgrade": {
    ...maintenance[4],
    receiptActor: "userKey",
    remoteState: { lifecycle: { effects: 1, nodeCount: 1 } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.retry-cluster-upgrade": {
    ...maintenance[5],
    receiptActor: "userKey",
    remoteState: { lifecycle: { effects: 1, nodeCount: 1 } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.start-cluster-upgrade": {
    ...maintenance[6],
    receiptActor: "userKey",
    remoteState: { lifecycle: { effects: 1, nodeCount: 1 } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.create-index-snapshot": {
    ...maintenance[7],
    receiptActor: "userKey",
    remoteState: { lifecycle: { effects: 1, nodeCount: 1 } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.start-reindex": {
    ...maintenance[8],
    receiptActor: "userKey",
    remoteState: { lifecycle: { effects: 1, nodeCount: 1 } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.reindex-issues": {
    ...maintenance[9],
    receiptActor: "userKey",
    remoteState: { lifecycle: { effects: 1, nodeCount: 1 } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.process-reindex-requests": {
    ...maintenance[10],
    receiptActor: "userKey",
    remoteState: { lifecycle: { effects: 1, nodeCount: 1 } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.run-upgrade": {
    ...maintenance[11],
    receiptActor: "userKey",
    remoteState: { lifecycle: { effects: 1, nodeCount: 1 } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.create-custom-field": {
    ...schema[0],
    receiptActor: "userKey",
    remoteState: {
      lifecycle: {
        ...SCHEMA_STATE,
        fields: [
          SCHEMA_FIELD,
          { id: "customfield_9007199254740993", name: "New evidence", custom: true },
        ],
      },
    },
    outcome: "succeeded-unconfirmed",
  },
  "jira.delete-custom-fields": {
    ...schema[1],
    receiptActor: "userKey",
    remoteState: { lifecycle: { ...SCHEMA_STATE, fields: [] } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.create-issue-type": {
    ...schema[2],
    receiptActor: "userKey",
    remoteState: {
      lifecycle: {
        ...SCHEMA_STATE,
        types: [
          SCHEMA_TYPE,
          SCHEMA_ALTERNATIVE,
          { id: "9007199254740993", name: "New type", description: "", subtask: false },
        ],
      },
    },
    outcome: "succeeded-unconfirmed",
  },
  "jira.update-issue-type": {
    ...schema[3],
    receiptActor: "userKey",
    remoteState: {
      lifecycle: {
        ...SCHEMA_STATE,
        types: [{ ...SCHEMA_TYPE, description: "" }, SCHEMA_ALTERNATIVE],
      },
    },
    outcome: "succeeded",
  },
  "jira.delete-issue-type": {
    ...schema[4],
    receiptActor: "userKey",
    remoteState: { lifecycle: { ...SCHEMA_STATE, types: [SCHEMA_ALTERNATIVE] } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.create-link-type": {
    ...schema[5],
    receiptActor: "userKey",
    remoteState: {
      lifecycle: {
        ...SCHEMA_STATE,
        links: [SCHEMA_LINK, SCHEMA_OTHER_LINK, { ...NEW_LINK, id: "9007199254740993" }],
      },
    },
    outcome: "succeeded",
  },
  "jira.update-link-type": {
    ...schema[6],
    receiptActor: "userKey",
    remoteState: {
      lifecycle: { ...SCHEMA_STATE, links: [{ ...SCHEMA_LINK, ...NEW_LINK }, SCHEMA_OTHER_LINK] },
    },
    outcome: "succeeded",
  },
  "jira.delete-link-type": {
    ...schema[7],
    receiptActor: "userKey",
    remoteState: { lifecycle: { ...SCHEMA_STATE, links: [SCHEMA_OTHER_LINK] } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.reset-link-type-order": {
    ...schema[8],
    receiptActor: "userKey",
    remoteState: { lifecycle: SCHEMA_STATE },
    outcome: "succeeded-unconfirmed",
  },
  "jira.move-link-type": {
    ...schema[9],
    receiptActor: "userKey",
    remoteState: { lifecycle: SCHEMA_STATE },
    outcome: "succeeded-unconfirmed",
  },
  "jira.set-terminology": {
    ...schema[10],
    receiptActor: "userKey",
    remoteState: {
      lifecycle: {
        ...SCHEMA_STATE,
        terms: [
          {
            originalName: "epic",
            originalNamePlural: "epics",
            newName: "initiative",
            newNamePlural: "initiatives",
            isDefault: false,
          },
          SCHEMA_TERMS[1],
        ],
      },
    },
    outcome: "succeeded",
  },
  "jira.create-group": {
    ...group[0],
    receiptActor: "userKey",
    remoteState: { lifecycle: { groups: ["R&D team", "Replacement", "New & Group"], members: [] } },
    outcome: "succeeded",
  },
  "jira.delete-group": {
    ...group[1],
    receiptActor: "userKey",
    remoteState: { lifecycle: { groups: ["Replacement"], members: [] } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.add-group-user": {
    ...group[2],
    receiptActor: "userKey",
    remoteState: {
      lifecycle: {
        groups: ["R&D team", "Replacement"],
        members: [{ key: "target-key", name: "Target User" }],
      },
    },
    outcome: "succeeded-unconfirmed",
  },
  "jira.remove-group-user": {
    ...group[3],
    receiptActor: "userKey",
    remoteState: { lifecycle: { groups: ["R&D team", "Replacement"], members: [] } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.pin-comment": {
    ...issue[0],
    receiptActor: "userKey",
    remoteState: { lifecycle: { effects: 1, pinned: true } },
    outcome: "succeeded",
  },
  "jira.notify-issue": {
    ...issue[1],
    receiptActor: "userKey",
    remoteState: { lifecycle: { effects: 1, pinned: false } },
    outcome: "succeeded-unconfirmed",
  },
} satisfies Readonly<Record<Mutation, JiraManagedScenario>>;
export const {
  arguments: SYSTEM_ADMINISTRATION_ARGUMENTS,
  receipts: SYSTEM_ADMINISTRATION_RECEIPTS,
  remoteState: SYSTEM_ADMINISTRATION_REMOTE_STATE,
  outcomes: SYSTEM_ADMINISTRATION_EXPECTED_OUTCOMES,
  expectedOutcome: expectedSystemAdministrationOutcome,
} = jiraManagedScenarios(SCENARIOS, ACTOR);
