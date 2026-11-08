import { FINAL_NATIVE_SCENARIOS } from "../../../../tests/support/jira-final-native-scenarios.js";
import { projectIssueTransportController } from "../../../../tests/support/jira-project-issue-transport-fixture.js";
import { privateNativeTransportController } from "../../../../tests/support/jira-private-native-transport-fixture.js";
import { privateNativeComposition } from "../../../../tests/support/jira-private-native-composition.js";
import { systemAdministrationTransportController } from "../../../../tests/support/jira-system-administration-transport-fixture.js";
import { DIRECTORY_ACCESS_FIXTURE_CASES as DIRECTORY_CASES } from "../../../../tests/support/jira-directory-access-fixture.js";
import { MAINTENANCE_MUTATION_FIXTURE_CASES as MAINTENANCE_CASES } from "../../../../tests/support/jira-maintenance-mutation-fixture.js";
import { SCHEMA_MUTATION_FIXTURE_CASES as SCHEMA_CASES } from "../../../../tests/support/jira-schema-mutation-fixture.js";
import { GROUP_MUTATION_FIXTURE_CASES as GROUP_CASES } from "../../../../tests/support/jira-group-mutation-fixture.js";
import { ISSUE_ACTION_FIXTURE_CASES as ISSUE_CASES } from "../../../../tests/support/jira-issue-action-fixture.js";
import { PERMISSION_SCHEME_MUTATION_CASES as PERMISSION_CASES } from "../../../../tests/support/jira-permission-scheme-mutation-fixture.js";
import { ROLE_MUTATION_FIXTURE_CASES as ROLE_CASES } from "../../../../tests/support/jira-role-mutation-fixture.js";
import { permissionRoleTransportController } from "../../../../tests/support/jira-permission-role-transport-fixture.js";
import { OPTION_SCHEME_MUTATION_CASES as OPTION_CASES } from "../../../../tests/support/jira-option-scheme-fixture.js";
import { WORKFLOW_SCHEME_MUTATION_FIXTURE_CASES as WORKFLOW_CASES } from "../../../../tests/support/jira-workflow-scheme-mutation-fixture.js";
import { INSTANCE_SETTING_FIXTURE_CASES as INSTANCE_CASES } from "../../../../tests/support/jira-instance-setting-mutation-fixture.js";
import { schemeSettingTransportController } from "../../../../tests/support/jira-scheme-setting-transport-fixture.js";
import {
  EMAIL_TEMPLATE_NATIVE_CASES as EMAIL_CASES,
  emailTemplateTransportController,
  emailTemplateFixtureAdmission,
} from "../../../../tests/support/jira-email-template-transport-fixture.js";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
  JiraManagedConnection,
} from "@oscharko-dev/keiko-connectors";
import {
  FIELDS,
  LINKS_FIELD,
  REQUIRED_CUSTOM,
  fixtureRead,
  fixtureWrite,
  response,
  type SyntheticJira,
} from "../../../../tests/support/jira-managed-remote.js";
import { createJiraProviderForCatalog, jiraOperationContracts } from "./jiraManagedProvider.js";
import {
  observeNativeJiraOperation,
  assertNativeJiraPrimary,
  type Scenario,
  type Observation,
} from "../../../../tests/support/jira-operation-transport-contract.js";
import {
  propertyTransportFixture,
  PROPERTY_FIXTURE_KEY,
  REVIEWED_PROPERTY_NODES,
  REQUESTED_PROPERTY_NODES,
} from "../../../../tests/support/jira-property-transport-fixture.js";
import {
  POST_AND_IDENTITY_READ_SCENARIOS,
  POST_AND_IDENTITY_READ_TOOLS,
  postAndIdentityReadTransport,
} from "../../../../tests/support/jira-post-and-identity-read-fixture.js";
import {
  RELEASE_LIFECYCLE_FIXTURE_CASES,
  releaseLifecycleTransportFixture,
} from "../../../../tests/support/jira-release-lifecycle-fixture.js";
import {
  LINK_MUTATION_FIXTURE_CASES,
  linkMutationTransportFixture,
} from "../../../../tests/support/jira-link-mutation-fixture.js";
import {
  SCREEN_CONFIGURATION_FIXTURE_CASES as SCREEN_CONFIGURATION_CASES,
  screenConfigurationTransportFixture,
} from "../../../../tests/support/jira-screen-configuration-fixture.js";
import { VERSION_LINK_MUTATION_CASES as VERSION_LINK_CASES } from "../../../../tests/support/jira-version-link-mutation-fixture.js";
import { PROJECT_CATEGORY_FIXTURE_CASES as PROJECT_CATEGORY_CASES } from "../../../../tests/support/jira-project-category-fixture.js";
import {
  versionLinkTransportFixture,
  projectCategoryTransportFixture,
} from "../../../../tests/support/jira-reviewed-platform-transport-fixture.js";
import {
  SAVED_CONFIGURATION_ARGUMENTS,
  SAVED_CONFIGURATION_RECEIPTS,
  savedConfigurationRemoteState,
  prepareSavedConfiguration,
  nativeSavedConfigurationRead,
  nativeSavedConfigurationWrite,
} from "../../../../tests/support/jira-managed-saved-configuration-scenarios.js";

const ISSUE_PARAMETERS = { issueIdOrKey: "SYN-1" };
const PAGING = { startAt: "0", maxResults: "25" };
const CREATE = {
  projectId: "10000",
  issueTypeId: "10001",
  fields: { summary: "After", customfield_10000: "Required" },
};
function postAndIdentityScenario(tool: Scenario["tool"]): Scenario {
  const scenario = POST_AND_IDENTITY_READ_SCENARIOS.find((item) => item.tool === tool);
  if (scenario === undefined) throw new TypeError("Missing POST or identity fixture");
  return scenario;
}
// Inputs and selected resource identities are independent fixtures, not generated from the registry.
const SCENARIOS: readonly Scenario[] = [
  ...FINAL_NATIVE_SCENARIOS,
  {
    tool: "jira.set-application-role",
    args: DIRECTORY_CASES[0].args,
    parameters: { key: "jira-software" },
    expectedReceipt: DIRECTORY_CASES[0].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.set-application-roles",
    args: DIRECTORY_CASES[1].args,
    expectedReceipt: DIRECTORY_CASES[1].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.add-user-application",
    args: DIRECTORY_CASES[2].args,
    query: { username: "Target User", applicationKey: "jira-software" },
    expectedReceipt: DIRECTORY_CASES[2].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.remove-user-application",
    args: DIRECTORY_CASES[3].args,
    query: { username: "Target User", applicationKey: "jira-software" },
    expectedReceipt: DIRECTORY_CASES[3].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.set-user-columns",
    args: DIRECTORY_CASES[4].args,
    expectedReceipt: DIRECTORY_CASES[4].receipt,
  },
  {
    tool: "jira.reset-user-columns",
    args: DIRECTORY_CASES[5].args,
    query: { username: "Target User" },
    expectedReceipt: DIRECTORY_CASES[5].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.request-cluster-index-snapshot",
    args: MAINTENANCE_CASES[0].args,
    parameters: { nodeId: "node-a" },
    expectedReceipt: MAINTENANCE_CASES[0].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.delete-cluster-node",
    args: MAINTENANCE_CASES[1].args,
    parameters: { nodeId: "node-a" },
    expectedReceipt: MAINTENANCE_CASES[1].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.mark-cluster-node-offline",
    args: MAINTENANCE_CASES[2].args,
    parameters: { nodeId: "node-a" },
    expectedReceipt: MAINTENANCE_CASES[2].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.approve-cluster-upgrade",
    args: MAINTENANCE_CASES[3].args,
    expectedReceipt: MAINTENANCE_CASES[3].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.cancel-cluster-upgrade",
    args: MAINTENANCE_CASES[4].args,
    expectedReceipt: MAINTENANCE_CASES[4].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.retry-cluster-upgrade",
    args: MAINTENANCE_CASES[5].args,
    expectedReceipt: MAINTENANCE_CASES[5].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.start-cluster-upgrade",
    args: MAINTENANCE_CASES[6].args,
    expectedReceipt: MAINTENANCE_CASES[6].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.create-index-snapshot",
    args: MAINTENANCE_CASES[7].args,
    expectedReceipt: MAINTENANCE_CASES[7].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.start-reindex",
    args: MAINTENANCE_CASES[8].args,
    query: {
      type: "BACKGROUND_PREFERRED",
      indexComments: "false",
      indexChangeHistory: "true",
      indexWorklogs: "false",
    },
    expectedReceipt: MAINTENANCE_CASES[8].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.reindex-issues",
    args: MAINTENANCE_CASES[9].args,
    query: {
      issueId: "9223372036854775807",
      indexComments: "false",
      indexChangeHistory: "true",
      indexWorklogs: "false",
    },
    expectedReceipt: MAINTENANCE_CASES[9].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.process-reindex-requests",
    args: MAINTENANCE_CASES[10].args,
    expectedReceipt: MAINTENANCE_CASES[10].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.run-upgrade",
    args: MAINTENANCE_CASES[11].args,
    expectedReceipt: MAINTENANCE_CASES[11].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.create-custom-field",
    args: SCHEMA_CASES[0].args,
    expectedReceipt: SCHEMA_CASES[0].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.delete-custom-fields",
    args: SCHEMA_CASES[1].args,
    query: { ids: "customfield_12" },
    expectedReceipt: SCHEMA_CASES[1].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.create-issue-type",
    args: SCHEMA_CASES[2].args,
    expectedReceipt: SCHEMA_CASES[2].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.update-issue-type",
    args: SCHEMA_CASES[3].args,
    parameters: { id: "1" },
    expectedReceipt: SCHEMA_CASES[3].receipt,
  },
  {
    tool: "jira.delete-issue-type",
    args: SCHEMA_CASES[4].args,
    parameters: { id: "1" },
    query: { alternativeIssueTypeId: "2" },
    expectedReceipt: SCHEMA_CASES[4].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.create-link-type",
    args: SCHEMA_CASES[5].args,
    expectedReceipt: SCHEMA_CASES[5].receipt,
  },
  {
    tool: "jira.update-link-type",
    args: SCHEMA_CASES[6].args,
    parameters: { issueLinkTypeId: "7" },
    expectedReceipt: SCHEMA_CASES[6].receipt,
  },
  {
    tool: "jira.delete-link-type",
    args: SCHEMA_CASES[7].args,
    parameters: { issueLinkTypeId: "7" },
    expectedReceipt: SCHEMA_CASES[7].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.reset-link-type-order",
    args: SCHEMA_CASES[8].args,
    expectedReceipt: SCHEMA_CASES[8].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.move-link-type",
    args: SCHEMA_CASES[9].args,
    parameters: { issueLinkTypeId: "8" },
    expectedReceipt: SCHEMA_CASES[9].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.set-terminology",
    args: SCHEMA_CASES[10].args,
    expectedReceipt: SCHEMA_CASES[10].receipt,
  },
  { tool: "jira.create-group", args: GROUP_CASES[0].args, expectedReceipt: GROUP_CASES[0].receipt },
  {
    tool: "jira.delete-group",
    args: GROUP_CASES[1].args,
    query: { groupname: "R&D team", swapGroup: "Replacement" },
    expectedReceipt: GROUP_CASES[1].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.add-group-user",
    args: GROUP_CASES[2].args,
    query: { groupname: "R&D team" },
    expectedReceipt: GROUP_CASES[2].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.remove-group-user",
    args: GROUP_CASES[3].args,
    query: { groupname: "R&D team", username: "Target User" },
    expectedReceipt: GROUP_CASES[3].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.pin-comment",
    args: ISSUE_CASES[0].args,
    parameters: { issueIdOrKey: "10001", id: "9007199254740993" },
    expectedReceipt: ISSUE_CASES[0].receipt,
  },
  {
    tool: "jira.notify-issue",
    args: ISSUE_CASES[1].args,
    parameters: { issueIdOrKey: "10001" },
    expectedReceipt: ISSUE_CASES[1].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },

  {
    tool: "jira.create-issue-type-scheme",
    args: OPTION_CASES[0].args,
    expectedReceipt: OPTION_CASES[0].receipt,
  },
  {
    tool: "jira.update-issue-type-scheme",
    args: OPTION_CASES[1].args,
    parameters: { schemeId: "7" },
    expectedReceipt: OPTION_CASES[1].receipt,
  },
  {
    tool: "jira.delete-issue-type-scheme",
    args: OPTION_CASES[2].args,
    parameters: { schemeId: "7" },
    expectedReceipt: OPTION_CASES[2].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.add-issue-type-scheme-projects",
    args: OPTION_CASES[3].args,
    parameters: { schemeId: "7" },
    expectedReceipt: OPTION_CASES[3].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.set-issue-type-scheme-projects",
    args: OPTION_CASES[4].args,
    parameters: { schemeId: "7" },
    expectedReceipt: OPTION_CASES[4].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.clear-issue-type-scheme-projects",
    args: OPTION_CASES[5].args,
    parameters: { schemeId: "7" },
    expectedReceipt: OPTION_CASES[5].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.remove-issue-type-scheme-project",
    args: OPTION_CASES[6].args,
    parameters: { schemeId: "7", projIdOrKey: "10000" },
    expectedReceipt: OPTION_CASES[6].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.create-priority-scheme",
    args: OPTION_CASES[7].args,
    expectedReceipt: OPTION_CASES[7].receipt,
  },
  {
    tool: "jira.update-priority-scheme",
    args: OPTION_CASES[8].args,
    parameters: { schemeId: "9" },
    expectedReceipt: OPTION_CASES[8].receipt,
  },
  {
    tool: "jira.delete-priority-scheme",
    args: OPTION_CASES[9].args,
    parameters: { schemeId: "9" },
    expectedReceipt: OPTION_CASES[9].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.create-workflow-scheme",
    args: WORKFLOW_CASES[0].args,
    expectedReceipt: WORKFLOW_CASES[0].receipt,
  },
  {
    tool: "jira.update-workflow-scheme",
    args: WORKFLOW_CASES[1].args,
    parameters: { id: "37" },
    expectedReceipt: WORKFLOW_CASES[1].receipt,
  },
  {
    tool: "jira.delete-workflow-scheme",
    args: WORKFLOW_CASES[2].args,
    parameters: { id: "37" },
    expectedReceipt: WORKFLOW_CASES[2].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.create-workflow-scheme-draft",
    args: WORKFLOW_CASES[3].args,
    parameters: { id: "37" },
    expectedReceipt: WORKFLOW_CASES[3].receipt,
  },
  {
    tool: "jira.update-workflow-scheme-draft",
    args: WORKFLOW_CASES[4].args,
    parameters: { id: "37" },
    expectedReceipt: WORKFLOW_CASES[4].receipt,
  },
  {
    tool: "jira.delete-workflow-scheme-draft",
    args: WORKFLOW_CASES[5].args,
    parameters: { id: "37" },
    expectedReceipt: WORKFLOW_CASES[5].receipt,
  },
  {
    tool: "jira.set-workflow-scheme-default",
    args: WORKFLOW_CASES[6].args,
    parameters: { id: "37" },
    expectedReceipt: WORKFLOW_CASES[6].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.delete-workflow-scheme-default",
    args: WORKFLOW_CASES[7].args,
    parameters: { id: "37" },
    query: { updateDraftIfNeeded: "false" },
    expectedReceipt: WORKFLOW_CASES[7].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.set-workflow-scheme-draft-default",
    args: WORKFLOW_CASES[8].args,
    parameters: { id: "37" },
    expectedReceipt: WORKFLOW_CASES[8].receipt,
  },
  {
    tool: "jira.delete-workflow-scheme-draft-default",
    args: WORKFLOW_CASES[9].args,
    parameters: { id: "37" },
    expectedReceipt: WORKFLOW_CASES[9].receipt,
  },
  {
    tool: "jira.set-workflow-scheme-issue-type",
    args: WORKFLOW_CASES[10].args,
    parameters: { id: "37", issueType: "1" },
    expectedReceipt: WORKFLOW_CASES[10].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.delete-workflow-scheme-issue-type",
    args: WORKFLOW_CASES[11].args,
    parameters: { id: "37", issueType: "1" },
    query: { updateDraftIfNeeded: "false" },
    expectedReceipt: WORKFLOW_CASES[11].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.set-workflow-scheme-draft-issue-type",
    args: WORKFLOW_CASES[12].args,
    parameters: { id: "37", issueType: "1" },
    expectedReceipt: WORKFLOW_CASES[12].receipt,
  },
  {
    tool: "jira.delete-workflow-scheme-draft-issue-type",
    args: WORKFLOW_CASES[13].args,
    parameters: { id: "37", issueType: "1" },
    expectedReceipt: WORKFLOW_CASES[13].receipt,
  },
  {
    tool: "jira.set-workflow-scheme-workflow",
    args: WORKFLOW_CASES[14].args,
    parameters: { id: "37" },
    query: { workflowName: "Flow" },
    expectedReceipt: WORKFLOW_CASES[14].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.delete-workflow-scheme-workflow",
    args: WORKFLOW_CASES[15].args,
    parameters: { id: "37" },
    query: { workflowName: "Flow", updateDraftIfNeeded: "false" },
    expectedReceipt: WORKFLOW_CASES[15].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.set-workflow-scheme-draft-workflow",
    args: WORKFLOW_CASES[16].args,
    parameters: { id: "37" },
    query: { workflowName: "Flow" },
    expectedReceipt: WORKFLOW_CASES[16].receipt,
  },
  {
    tool: "jira.delete-workflow-scheme-draft-workflow",
    args: WORKFLOW_CASES[17].args,
    parameters: { id: "37" },
    query: { workflowName: "Flow" },
    expectedReceipt: WORKFLOW_CASES[17].receipt,
  },
  {
    tool: "jira.set-application-property",
    args: INSTANCE_CASES[0].args,
    parameters: { id: "jira.option.voting" },
    expectedReceipt: INSTANCE_CASES[0].receipt,
  },
  {
    tool: "jira.set-system-columns",
    args: INSTANCE_CASES[1].args,
    expectedReceipt: INSTANCE_CASES[1].receipt,
  },
  {
    tool: "jira.set-instance-base-url",
    args: INSTANCE_CASES[2].args,
    expectedReceipt: INSTANCE_CASES[2].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.set-read-only-mode",
    args: INSTANCE_CASES[3].args,
    expectedReceipt: INSTANCE_CASES[3].receipt,
  },
  { tool: "jira.email-template-pack", args: EMAIL_CASES[0].args },
  {
    tool: "jira.upload-email-template-pack",
    args: EMAIL_CASES[1].args,
    expectedReceipt: EMAIL_CASES[1].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.apply-email-template-pack",
    args: EMAIL_CASES[2].args,
    expectedReceipt: EMAIL_CASES[2].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.revert-email-template-pack",
    args: EMAIL_CASES[3].args,
    expectedReceipt: EMAIL_CASES[3].receipt,
    expectedOutcome: "succeeded-unconfirmed",
  },
  {
    tool: "jira.create-permission-scheme",
    args: PERMISSION_CASES[0].args,
    expectedReceipt: {
      userKey: "synthetic-actor",
      schemeId: "9007199254740993",
      schemePresent: true,
    },
  },
  {
    tool: "jira.update-permission-scheme",
    args: PERMISSION_CASES[1].args,
    parameters: { schemeId: "7" },
    expectedReceipt: { userKey: "synthetic-actor", schemeId: "7", schemePresent: true },
  },
  {
    tool: "jira.delete-permission-scheme",
    args: PERMISSION_CASES[2].args,
    parameters: { schemeId: "7" },
    expectedOutcome: "succeeded-unconfirmed",
    expectedReceipt: { userKey: "synthetic-actor", schemeId: "7", schemePresent: false },
  },
  {
    tool: "jira.add-permission-grant",
    args: PERMISSION_CASES[3].args,
    parameters: { schemeId: "7" },
    expectedReceipt: {
      userKey: "synthetic-actor",
      schemeId: "7",
      permissionId: "23",
      grantPresent: true,
    },
  },
  {
    tool: "jira.delete-permission-grant",
    args: PERMISSION_CASES[4].args,
    parameters: { schemeId: "7", permissionId: "21" },
    expectedReceipt: {
      userKey: "synthetic-actor",
      schemeId: "7",
      permissionId: "21",
      grantPresent: false,
    },
  },
  {
    tool: "jira.set-permission-scheme-attribute",
    args: PERMISSION_CASES[5].args,
    parameters: { permissionSchemeId: "7", key: "ADMINISTER_PROJECTS.extended.enabled" },
    expectedReceipt: {
      userKey: "synthetic-actor",
      schemeId: "7",
      attributeKey: "ADMINISTER_PROJECTS.extended.enabled",
      attributeEnabled: false,
    },
  },
  {
    tool: "jira.create-role",
    args: ROLE_CASES[0].args,
    expectedReceipt: { userKey: "synthetic-actor", roleId: "9007199254740993", rolePresent: true },
  },
  {
    tool: "jira.update-role",
    args: ROLE_CASES[1].args,
    parameters: { id: "7" },
    expectedReceipt: { userKey: "synthetic-actor", roleId: "7", rolePresent: true },
  },
  {
    tool: "jira.replace-role",
    args: ROLE_CASES[2].args,
    parameters: { id: "7" },
    expectedReceipt: { userKey: "synthetic-actor", roleId: "7", rolePresent: true },
  },
  {
    tool: "jira.delete-role",
    args: ROLE_CASES[3].args,
    parameters: { id: "7" },
    query: { swap: "9" },
    expectedOutcome: "succeeded-unconfirmed",
    expectedReceipt: {
      userKey: "synthetic-actor",
      roleId: "7",
      rolePresent: false,
      swapRoleId: "9",
    },
  },
  {
    tool: "jira.add-role-default-actors",
    args: ROLE_CASES[4].args,
    parameters: { id: "7" },
    expectedOutcome: "succeeded-unconfirmed",
    expectedReceipt: {
      userKey: "synthetic-actor",
      roleId: "7",
      rolePresent: true,
      roleActorsScope: "role-defaults",
      actorChange: "add",
      actorUserKeys: ["next-key"],
      actorGroupNames: [],
    },
  },
  {
    tool: "jira.delete-role-default-actor",
    args: ROLE_CASES[5].args,
    parameters: { id: "7" },
    query: { group: "current-group" },
    expectedOutcome: "succeeded-unconfirmed",
    expectedReceipt: {
      userKey: "synthetic-actor",
      roleId: "7",
      rolePresent: true,
      roleActorsScope: "role-defaults",
      actorChange: "remove",
      actorUserKeys: [],
      actorGroupNames: ["current-group"],
    },
  },
  {
    tool: "jira.add-project-role-actors",
    args: ROLE_CASES[6].args,
    parameters: { projectIdOrKey: "10000", id: "7" },
    expectedOutcome: "succeeded-unconfirmed",
    expectedReceipt: {
      userKey: "synthetic-actor",
      roleId: "7",
      rolePresent: true,
      projectId: "10000",
      projectKey: "SYN",
      roleActorsScope: "project-membership",
      actorChange: "add",
      actorUserKeys: ["next-key"],
      actorGroupNames: [],
    },
  },
  {
    tool: "jira.set-project-role-actors",
    args: ROLE_CASES[7].args,
    parameters: { projectIdOrKey: "10000", id: "7" },
    expectedOutcome: "succeeded-unconfirmed",
    expectedReceipt: {
      userKey: "synthetic-actor",
      roleId: "7",
      rolePresent: true,
      projectId: "10000",
      projectKey: "SYN",
      roleActorsScope: "project-membership",
      actorChange: "replace",
      actorUserKeys: [],
      actorGroupNames: ["next-group"],
    },
  },
  {
    tool: "jira.delete-project-role-actor",
    args: ROLE_CASES[8].args,
    parameters: { projectIdOrKey: "10000", id: "7" },
    query: { user: "current-user" },
    expectedOutcome: "succeeded-unconfirmed",
    expectedReceipt: {
      userKey: "synthetic-actor",
      roleId: "7",
      rolePresent: true,
      projectId: "10000",
      projectKey: "SYN",
      roleActorsScope: "project-membership",
      actorChange: "remove",
      actorUserKeys: ["current-key"],
      actorGroupNames: [],
    },
  },
  {
    tool: "jira.upsert-version-remote-link",
    args: VERSION_LINK_CASES[0].args,
    parameters: { versionId: "81" },
    expectedReceipt: {
      versionId: "81",
      projectId: "10000",
      projectKey: "SYN",
      userKey: "synthetic-actor",
      globalId: "release:link",
      linkPresent: true,
    },
  },
  {
    tool: "jira.upsert-version-remote-link-by-global-id",
    args: VERSION_LINK_CASES[1].args,
    parameters: { versionId: "81", globalId: "release:link" },
    expectedReceipt: {
      versionId: "81",
      projectId: "10000",
      projectKey: "SYN",
      userKey: "synthetic-actor",
      globalId: "release:link",
      linkPresent: true,
    },
  },
  {
    tool: "jira.delete-version-remote-link",
    args: VERSION_LINK_CASES[2].args,
    parameters: { versionId: "81", globalId: "release:link" },
    expectedReceipt: {
      versionId: "81",
      projectId: "10000",
      projectKey: "SYN",
      userKey: "synthetic-actor",
      globalId: "release:link",
      linkPresent: false,
    },
  },
  {
    tool: "jira.delete-version-remote-links",
    args: VERSION_LINK_CASES[3].args,
    parameters: { versionId: "81" },
    expectedReceipt: {
      versionId: "81",
      projectId: "10000",
      projectKey: "SYN",
      userKey: "synthetic-actor",
      globalIds: ["release:link", "other:link"],
      linkPresent: false,
    },
  },
  {
    tool: "jira.create-project-category",
    args: PROJECT_CATEGORY_CASES[0].args,
    expectedReceipt: {
      categoryId: "9007199254740993",
      userKey: "synthetic-actor",
      categoryPresent: true,
    },
  },
  {
    tool: "jira.update-project-category",
    args: PROJECT_CATEGORY_CASES[1].args,
    parameters: { id: "7" },
    expectedReceipt: { categoryId: "7", userKey: "synthetic-actor", categoryPresent: true },
  },
  {
    tool: "jira.delete-project-category",
    args: PROJECT_CATEGORY_CASES[2].args,
    parameters: { id: "7" },
    expectedOutcome: "succeeded-unconfirmed",
    expectedReceipt: { categoryId: "7", userKey: "synthetic-actor", categoryPresent: false },
  },
  {
    tool: "jira.add-default-screen-field",
    args: SCREEN_CONFIGURATION_CASES[0].args,
    parameters: { fieldId: "customfield_10001" },
    expectedOutcome: "succeeded-unconfirmed",
    expectedReceipt: { fieldId: "customfield_10001", fieldPresent: true },
  },
  {
    tool: "jira.add-screen-tab-field",
    args: SCREEN_CONFIGURATION_CASES[1].args,
    parameters: { screenId: "11", tabId: "21" },
    expectedReceipt: {
      screenId: "11",
      tabId: "21",
      fieldId: "customfield_10001",
      fieldPresent: true,
    },
  },
  {
    tool: "jira.remove-screen-tab-field",
    args: SCREEN_CONFIGURATION_CASES[2].args,
    parameters: { screenId: "11", tabId: "21", id: "description" },
    expectedReceipt: { screenId: "11", tabId: "21", fieldId: "description", fieldPresent: false },
  },
  {
    tool: "jira.move-screen-tab-field",
    args: SCREEN_CONFIGURATION_CASES[3].args,
    parameters: { screenId: "11", tabId: "21", id: "summary" },
    expectedReceipt: { screenId: "11", tabId: "21", fieldId: "summary" },
  },
  {
    tool: "jira.set-screen-field-show-when-empty",
    args: SCREEN_CONFIGURATION_CASES[4].args,
    parameters: { screenId: "11", tabId: "21", id: "summary", newValue: "true" },
    expectedReceipt: { screenId: "11", tabId: "21", fieldId: "summary", showWhenEmpty: true },
  },
  {
    tool: "jira.move-screen-tab",
    args: SCREEN_CONFIGURATION_CASES[5].args,
    parameters: { screenId: "11", tabId: "21", pos: "1" },
    expectedReceipt: { screenId: "11", tabId: "21" },
  },
  {
    ...postAndIdentityScenario("jira.search-post"),
    expectedPrimary: { method: "POST", apiRoot: "/rest/api/2", path: "search" },
  },
  {
    ...postAndIdentityScenario("jira.worklogs-by-id"),
    expectedPrimary: { method: "POST", apiRoot: "/rest/api/2", path: "worklog/list" },
  },
  {
    ...postAndIdentityScenario("jira.anonymization-validation"),
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "user/anonymization?userKey=USER1",
    },
  },
  {
    ...postAndIdentityScenario("jira.anonymization-rerun-validation"),
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "user/anonymization/rerun?userKey=USER1&oldUserKey=OLD1",
    },
  },
  {
    ...postAndIdentityScenario("jira.anonymization-progress"),
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "user/anonymization/progress?taskId=7",
    },
  },
  {
    ...postAndIdentityScenario("jira.current-session"),
    expectedPrimary: { method: "GET", apiRoot: "/rest/auth/1", path: "session" },
  },
  {
    tool: "jira.delete-component",
    args: RELEASE_LIFECYCLE_FIXTURE_CASES[0].args,
    parameters: { id: "71" },
    query: { moveIssuesTo: "72" },
    expectedOutcome: "succeeded-unconfirmed",
    expectedReceipt: {
      componentId: "71",
      replacementComponentId: "72",
      projectId: "10000",
      projectKey: "SYN",
      userKey: "synthetic-actor",
    },
  },
  {
    tool: "jira.merge-version",
    args: RELEASE_LIFECYCLE_FIXTURE_CASES[1].args,
    parameters: { id: "81", moveIssuesTo: "82" },
    expectedOutcome: "succeeded-unconfirmed",
    expectedReceipt: {
      versionId: "81",
      targetVersionId: "82",
      projectId: "10000",
      projectKey: "SYN",
      userKey: "synthetic-actor",
    },
  },
  {
    tool: "jira.move-version",
    args: RELEASE_LIFECYCLE_FIXTURE_CASES[2].args,
    parameters: { id: "81" },
    expectedReceipt: {
      versionId: "81",
      projectId: "10000",
      projectKey: "SYN",
      userKey: "synthetic-actor",
    },
  },
  {
    tool: "jira.remove-and-swap-version",
    args: RELEASE_LIFECYCLE_FIXTURE_CASES[3].args,
    parameters: { id: "81" },
    expectedOutcome: "succeeded-unconfirmed",
    expectedReceipt: {
      versionId: "81",
      replacementVersionIds: ["82"],
      projectId: "10000",
      projectKey: "SYN",
      userKey: "synthetic-actor",
    },
  },
  {
    tool: "jira.create-issue-link",
    args: LINK_MUTATION_FIXTURE_CASES[0].args,
    expectedReceipt: {
      issueId: "10001",
      issueKey: "SYN-1",
      linkedIssueId: "10002",
      linkedIssueKey: "SYN-2",
      linkTypeId: "9",
      linkId: "71",
      userKey: "synthetic-actor",
      linkPresent: true,
    },
  },
  {
    tool: "jira.delete-issue-link",
    args: LINK_MUTATION_FIXTURE_CASES[1].args,
    parameters: { linkId: "71" },
    expectedReceipt: {
      issueId: "10001",
      issueKey: "SYN-1",
      linkedIssueId: "10002",
      linkedIssueKey: "SYN-2",
      linkTypeId: "9",
      linkId: "71",
      userKey: "synthetic-actor",
      linkPresent: false,
    },
  },
  {
    tool: "jira.upsert-remote-link",
    args: LINK_MUTATION_FIXTURE_CASES[2].args,
    parameters: { issueIdOrKey: "10001" },
    expectedReceipt: {
      issueId: "10001",
      issueKey: "SYN-1",
      linkId: "72",
      userKey: "synthetic-actor",
      linkPresent: true,
    },
  },
  {
    tool: "jira.update-remote-link",
    args: LINK_MUTATION_FIXTURE_CASES[3].args,
    parameters: { issueIdOrKey: "10001", linkId: "72" },
    expectedReceipt: {
      issueId: "10001",
      issueKey: "SYN-1",
      linkId: "72",
      userKey: "synthetic-actor",
      linkPresent: true,
    },
  },
  {
    tool: "jira.delete-remote-link",
    args: LINK_MUTATION_FIXTURE_CASES[4].args,
    parameters: { issueIdOrKey: "10001", linkId: "72" },
    expectedReceipt: {
      issueId: "10001",
      issueKey: "SYN-1",
      linkId: "72",
      userKey: "synthetic-actor",
      linkPresent: false,
    },
  },
  {
    tool: "jira.delete-remote-link-by-global-id",
    args: LINK_MUTATION_FIXTURE_CASES[5].args,
    parameters: { issueIdOrKey: "10001" },
    query: { globalId: "synthetic:42&part=1" },
    expectedReceipt: {
      issueId: "10001",
      issueKey: "SYN-1",
      linkId: "72",
      userKey: "synthetic-actor",
      linkPresent: false,
    },
  },
  {
    tool: "jira.create-filter",
    expectedPrimary: { method: "POST", apiRoot: "/rest/api/2", path: "filter" },
    args: SAVED_CONFIGURATION_ARGUMENTS["jira.create-filter"],
  },
  {
    tool: "jira.update-filter",
    expectedPrimary: { method: "PUT", apiRoot: "/rest/api/2", path: "filter/37" },
    args: SAVED_CONFIGURATION_ARGUMENTS["jira.update-filter"],
    parameters: { id: "37" },
  },
  {
    tool: "jira.delete-filter",
    expectedPrimary: { method: "DELETE", apiRoot: "/rest/api/2", path: "filter/37" },
    args: SAVED_CONFIGURATION_ARGUMENTS["jira.delete-filter"],
    parameters: { id: "37" },
    expectedOutcome: "succeeded-unconfirmed",
    expectedReceipt: SAVED_CONFIGURATION_RECEIPTS["jira.delete-filter"],
  },
  {
    tool: "jira.set-filter-share-scope",
    expectedPrimary: { method: "PUT", apiRoot: "/rest/api/2", path: "filter/defaultShareScope" },
    args: SAVED_CONFIGURATION_ARGUMENTS["jira.set-filter-share-scope"],
  },
  {
    tool: "jira.set-filter-columns",
    expectedPrimary: { method: "PUT", apiRoot: "/rest/api/2", path: "filter/37/columns" },
    args: SAVED_CONFIGURATION_ARGUMENTS["jira.set-filter-columns"],
    parameters: { id: "37" },
  },
  {
    tool: "jira.reset-filter-columns",
    expectedPrimary: { method: "DELETE", apiRoot: "/rest/api/2", path: "filter/37/columns" },
    args: SAVED_CONFIGURATION_ARGUMENTS["jira.reset-filter-columns"],
    parameters: { id: "37" },
  },
  {
    tool: "jira.add-filter-permission",
    expectedPrimary: { method: "POST", apiRoot: "/rest/api/2", path: "filter/37/permission" },
    args: SAVED_CONFIGURATION_ARGUMENTS["jira.add-filter-permission"],
    parameters: { id: "37" },
  },
  {
    tool: "jira.delete-filter-permission",
    expectedPrimary: { method: "DELETE", apiRoot: "/rest/api/2", path: "filter/37/permission/51" },
    args: SAVED_CONFIGURATION_ARGUMENTS["jira.delete-filter-permission"],
    parameters: { id: "37", "permission-id": "51" },
  },
  {
    tool: "jira.set-my-preference",
    expectedPrimary: {
      method: "PUT",
      apiRoot: "/rest/api/2",
      path: "mypreferences?key=user.notify.own.changes",
    },
    args: SAVED_CONFIGURATION_ARGUMENTS["jira.set-my-preference"],
    query: { key: "user.notify.own.changes" },
  },
  {
    tool: "jira.delete-my-preference",
    expectedPrimary: {
      method: "DELETE",
      apiRoot: "/rest/api/2",
      path: "mypreferences?key=user.notify.own.changes",
    },
    args: SAVED_CONFIGURATION_ARGUMENTS["jira.delete-my-preference"],
    query: { key: "user.notify.own.changes" },
    expectedOutcome: "succeeded-unconfirmed",
    expectedReceipt: SAVED_CONFIGURATION_RECEIPTS["jira.delete-my-preference"],
  },
  {
    tool: "jira.set-comment-property",
    expectedPrimary: {
      method: "PUT",
      apiRoot: "/rest/api/2",
      path: "comment/10002/properties/view%20~settings",
    },
    args: {
      issueIdOrKey: "SYN-1",
      commentId: "10002",
      propertyKey: PROPERTY_FIXTURE_KEY,
      expectedValueNodes: REVIEWED_PROPERTY_NODES,
      valueNodes: REQUESTED_PROPERTY_NODES,
    },
    parameters: { commentId: "10002", propertyKey: PROPERTY_FIXTURE_KEY },
  },
  {
    tool: "jira.delete-comment-property",
    expectedPrimary: {
      method: "DELETE",
      apiRoot: "/rest/api/2",
      path: "comment/10002/properties/view%20~settings",
    },
    args: {
      issueIdOrKey: "SYN-1",
      commentId: "10002",
      propertyKey: PROPERTY_FIXTURE_KEY,
      expectedValueNodes: REVIEWED_PROPERTY_NODES,
    },
    parameters: { commentId: "10002", propertyKey: PROPERTY_FIXTURE_KEY },
  },
  {
    tool: "jira.set-dashboard-item-property",
    expectedPrimary: {
      method: "PUT",
      apiRoot: "/rest/api/2",
      path: "dashboard/71/items/81/properties/view%20~settings",
    },
    args: {
      dashboardId: "71",
      itemId: "81",
      propertyKey: PROPERTY_FIXTURE_KEY,
      expectedValueNodes: REVIEWED_PROPERTY_NODES,
      valueNodes: REQUESTED_PROPERTY_NODES,
    },
    parameters: { dashboardId: "71", itemId: "81", propertyKey: PROPERTY_FIXTURE_KEY },
  },
  {
    tool: "jira.delete-dashboard-item-property",
    expectedPrimary: {
      method: "DELETE",
      apiRoot: "/rest/api/2",
      path: "dashboard/71/items/81/properties/view%20~settings",
    },
    args: {
      dashboardId: "71",
      itemId: "81",
      propertyKey: PROPERTY_FIXTURE_KEY,
      expectedValueNodes: REVIEWED_PROPERTY_NODES,
    },
    parameters: { dashboardId: "71", itemId: "81", propertyKey: PROPERTY_FIXTURE_KEY },
  },
  {
    tool: "jira.set-issue-property",
    expectedPrimary: {
      method: "PUT",
      apiRoot: "/rest/api/2",
      path: "issue/10001/properties/view%20~settings",
    },
    args: {
      issueIdOrKey: "SYN-1",
      propertyKey: PROPERTY_FIXTURE_KEY,
      expectedValueNodes: REVIEWED_PROPERTY_NODES,
      valueNodes: REQUESTED_PROPERTY_NODES,
    },
    parameters: { issueIdOrKey: "10001", propertyKey: PROPERTY_FIXTURE_KEY },
  },
  {
    tool: "jira.delete-issue-property",
    expectedPrimary: {
      method: "DELETE",
      apiRoot: "/rest/api/2",
      path: "issue/10001/properties/view%20~settings",
    },
    args: {
      issueIdOrKey: "SYN-1",
      propertyKey: PROPERTY_FIXTURE_KEY,
      expectedValueNodes: REVIEWED_PROPERTY_NODES,
    },
    parameters: { issueIdOrKey: "10001", propertyKey: PROPERTY_FIXTURE_KEY },
  },
  {
    tool: "jira.set-issue-type-property",
    expectedPrimary: {
      method: "PUT",
      apiRoot: "/rest/api/2",
      path: "issuetype/10001/properties/view%20~settings",
    },
    args: {
      issueTypeId: "10001",
      propertyKey: PROPERTY_FIXTURE_KEY,
      expectedValueNodes: REVIEWED_PROPERTY_NODES,
      valueNodes: REQUESTED_PROPERTY_NODES,
    },
    parameters: { issueTypeId: "10001", propertyKey: PROPERTY_FIXTURE_KEY },
  },
  {
    tool: "jira.delete-issue-type-property",
    expectedPrimary: {
      method: "DELETE",
      apiRoot: "/rest/api/2",
      path: "issuetype/10001/properties/view%20~settings",
    },
    args: {
      issueTypeId: "10001",
      propertyKey: PROPERTY_FIXTURE_KEY,
      expectedValueNodes: REVIEWED_PROPERTY_NODES,
    },
    parameters: { issueTypeId: "10001", propertyKey: PROPERTY_FIXTURE_KEY },
  },
  {
    tool: "jira.set-project-property",
    expectedPrimary: {
      method: "PUT",
      apiRoot: "/rest/api/2",
      path: "project/10000/properties/view%20~settings",
    },
    args: {
      projectIdOrKey: "SYN",
      propertyKey: PROPERTY_FIXTURE_KEY,
      expectedValueNodes: REVIEWED_PROPERTY_NODES,
      valueNodes: REQUESTED_PROPERTY_NODES,
    },
    parameters: { projectIdOrKey: "10000", propertyKey: PROPERTY_FIXTURE_KEY },
  },
  {
    tool: "jira.delete-project-property",
    expectedPrimary: {
      method: "DELETE",
      apiRoot: "/rest/api/2",
      path: "project/10000/properties/view%20~settings",
    },
    args: {
      projectIdOrKey: "SYN",
      propertyKey: PROPERTY_FIXTURE_KEY,
      expectedValueNodes: REVIEWED_PROPERTY_NODES,
    },
    parameters: { projectIdOrKey: "10000", propertyKey: PROPERTY_FIXTURE_KEY },
  },
  {
    tool: "jira.set-user-property",
    expectedPrimary: {
      method: "PUT",
      apiRoot: "/rest/api/2",
      path: "user/properties/view%20~settings?userKey=JIRAUSER10100",
    },
    args: {
      username: "synthetic-user",
      propertyKey: PROPERTY_FIXTURE_KEY,
      expectedValueNodes: REVIEWED_PROPERTY_NODES,
      valueNodes: REQUESTED_PROPERTY_NODES,
    },
    parameters: { propertyKey: PROPERTY_FIXTURE_KEY },
    query: { userKey: "JIRAUSER10100" },
  },
  {
    tool: "jira.delete-user-property",
    expectedPrimary: {
      method: "DELETE",
      apiRoot: "/rest/api/2",
      path: "user/properties/view%20~settings?userKey=JIRAUSER10100",
    },
    args: {
      username: "synthetic-user",
      propertyKey: PROPERTY_FIXTURE_KEY,
      expectedValueNodes: REVIEWED_PROPERTY_NODES,
    },
    parameters: { propertyKey: PROPERTY_FIXTURE_KEY },
    query: { userKey: "JIRAUSER10100" },
  },
  {
    tool: "jira.set-app-monitoring",
    expectedPrimary: { method: "POST", apiRoot: "/rest/api/2", path: "monitoring/app" },
    args: { expectedEnabled: false, enabled: true },
  },
  {
    tool: "jira.set-ipd-monitoring",
    expectedPrimary: { method: "POST", apiRoot: "/rest/api/2", path: "monitoring/ipd" },
    args: { expectedEnabled: true, enabled: false },
  },
  {
    tool: "jira.start-jmx-metrics",
    expectedPrimary: {
      method: "POST",
      apiRoot: "/rest/api/2",
      path: "monitoring/jmx/startExposing",
    },
    args: { expectedEnabled: false },
  },
  {
    tool: "jira.stop-jmx-metrics",
    expectedPrimary: {
      method: "POST",
      apiRoot: "/rest/api/2",
      path: "monitoring/jmx/stopExposing",
    },
    args: { expectedEnabled: true },
  },
  {
    tool: "jira.issue-picker",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "issue/picker?query=Plan+%26+QA&showSubTasks=false&showSubTaskParent=true&currentIssueKey=SYN-1&currentProjectId=10000",
    },
    args: {
      query: "Plan & QA",
      currentIssueKey: "SYN-1",
      currentProjectId: "10000",
      showSubTasks: false,
      showSubTaskParent: true,
    },
    query: {
      query: "Plan & QA",
      currentIssueKey: "SYN-1",
      currentProjectId: "10000",
      showSubTasks: "false",
      showSubTaskParent: "true",
    },
    primaryMethodIndex: 2,
  },
  {
    tool: "jira.pinned-comments",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issue/10001/pinned-comments" },
    args: { issueIdOrKey: "SYN-1", startAt: 0, maxResults: 1 },
    parameters: { issueIdOrKey: "10001" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.subtasks",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issue/10001/subtask" },
    args: { issueIdOrKey: "SYN-1", startAt: 0, maxResults: 1 },
    parameters: { issueIdOrKey: "10001" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.subtask-move-availability",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issue/10001/subtask/move" },
    args: { issueIdOrKey: "SYN-1" },
    parameters: { issueIdOrKey: "10001" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.remote-links",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issue/10001/remotelink" },
    args: { issueIdOrKey: "SYN-1", startAt: 0, maxResults: 1 },
    parameters: { issueIdOrKey: "10001" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.remote-link",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issue/10001/remotelink/71" },
    args: { issueIdOrKey: "SYN-1", linkId: "71" },
    parameters: { issueIdOrKey: "10001", linkId: "71" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.create-screen-tab",
    expectedPrimary: { method: "POST", apiRoot: "/rest/api/2", path: "screens/71/tabs" },
    args: { screenId: "71", expectedScreenName: "Details & QA", name: "After" },
    parameters: { screenId: "71" },
  },
  {
    tool: "jira.rename-screen-tab",
    expectedPrimary: { method: "PUT", apiRoot: "/rest/api/2", path: "screens/71/tabs/81" },
    args: {
      screenId: "71",
      expectedScreenName: "Details & QA",
      tabId: "81",
      expectedName: "Details",
      name: "After",
    },
    parameters: { screenId: "71", tabId: "81" },
  },
  {
    tool: "jira.delete-screen-tab",
    expectedPrimary: { method: "DELETE", apiRoot: "/rest/api/2", path: "screens/71/tabs/81" },
    args: {
      screenId: "71",
      expectedScreenName: "Details & QA",
      tabId: "81",
      expectedName: "Details",
      expectedFieldIds: ["summary"],
    },
    parameters: { screenId: "71", tabId: "81" },
  },
  {
    tool: "jira.comment-property-keys",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "comment/10002/properties" },
    args: { issueIdOrKey: "SYN-1", commentId: "10002" },
    parameters: { commentId: "10002" },
    primaryMethodIndex: 2,
  },
  {
    tool: "jira.comment-property",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "comment/10002/properties/view%20~settings",
    },
    args: { issueIdOrKey: "SYN-1", commentId: "10002", propertyKey: "view ~settings" },
    parameters: { commentId: "10002", propertyKey: "view ~settings" },
    primaryMethodIndex: 2,
  },
  {
    tool: "jira.dashboard-item-property-keys",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "dashboard/71/items/81/properties",
    },
    args: { dashboardId: "71", itemId: "81" },
    parameters: { dashboardId: "71", itemId: "81" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.dashboard-item-property",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "dashboard/71/items/81/properties/view%20~settings",
    },
    args: { dashboardId: "71", itemId: "81", propertyKey: "view ~settings" },
    parameters: { dashboardId: "71", itemId: "81", propertyKey: "view ~settings" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.issue-property-keys",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issue/10001/properties" },
    args: { issueIdOrKey: "SYN-1" },
    parameters: { issueIdOrKey: "10001" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.issue-property",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "issue/10001/properties/view%20~settings",
    },
    args: { issueIdOrKey: "SYN-1", propertyKey: "view ~settings" },
    parameters: { issueIdOrKey: "10001", propertyKey: "view ~settings" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.issue-type-property-keys",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issuetype/10001/properties" },
    args: { issueTypeId: "10001" },
    parameters: { issueTypeId: "10001" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.issue-type-property",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "issuetype/10001/properties/view%20~settings",
    },
    args: { issueTypeId: "10001", propertyKey: "view ~settings" },
    parameters: { issueTypeId: "10001", propertyKey: "view ~settings" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.project-property-keys",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "project/10000/properties" },
    args: { projectIdOrKey: "SYN" },
    parameters: { projectIdOrKey: "10000" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.project-property",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "project/10000/properties/view%20~settings",
    },
    args: { projectIdOrKey: "SYN", propertyKey: "view ~settings" },
    parameters: { projectIdOrKey: "10000", propertyKey: "view ~settings" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.user-property-keys",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "user/properties?userKey=JIRAUSER10100",
    },
    args: { username: "synthetic-user" },
    query: { userKey: "JIRAUSER10100" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.user-property",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "user/properties/view%20~settings?userKey=JIRAUSER10100",
    },
    args: { username: "synthetic-user", propertyKey: "view ~settings" },
    parameters: { propertyKey: "view ~settings" },
    query: { userKey: "JIRAUSER10100" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.reindex-status",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "reindex" },
    args: {},
  },
  {
    tool: "jira.password-policy",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "password/policy?hasOldPassword=true",
    },
    args: { hasOldPassword: true, maxResults: 1 },
    query: { hasOldPassword: "true" },
  },
  {
    tool: "jira.duplicate-user-count",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "user/duplicated/count?flush=false",
    },
    args: {},
    query: { flush: "false" },
  },
  {
    tool: "jira.duplicate-users",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "user/duplicated/list?flush=false",
    },
    args: { maxResults: 1 },
    query: { flush: "false" },
  },
  {
    tool: "jira.search-error",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "search/error/lookup" },
    args: {},
  },
  {
    tool: "jira.remote-version-links",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "version/remotelink?globalId=app%3Dsynthetic%26id%3D1",
    },
    args: { globalId: "app=synthetic&id=1", maxResults: 1 },
    query: { globalId: "app=synthetic&id=1" },
  },
  {
    tool: "jira.version-remote-links",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "version/81/remotelink" },
    args: { versionId: "81", maxResults: 1 },
    parameters: { versionId: "81" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.version-remote-link",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "version/81/remotelink/sample~state",
    },
    args: { versionId: "81", globalId: "sample~state" },
    parameters: { versionId: "81", globalId: "sample~state" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.deleted-worklogs",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "worklog/deleted?since=0" },
    args: { since: "0" },
    query: { since: "0" },
  },
  {
    tool: "jira.updated-worklogs",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "worklog/updated?since=0" },
    args: { since: "0" },
    query: { since: "0" },
  },
  {
    tool: "jira.permission-scheme-attribute",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "permissionscheme/37/attribute/review%20~state",
    },
    args: { schemeId: "37", attributeKey: "review ~state" },
    parameters: { permissionSchemeId: "37", attributeKey: "review ~state" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.email-template-types",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "email-templates/types" },
    args: { maxResults: 1 },
  },
  {
    tool: "jira.application-properties",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "application-properties?key=jira.option.voting",
    },
    args: { key: "jira.option.voting" },
    query: { key: "jira.option.voting" },
  },
  {
    tool: "jira.advanced-settings",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "application-properties/advanced-settings",
    },
    args: { maxResults: 1 },
  },
  {
    tool: "jira.my-preference",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "mypreferences?key=user.issues.per.page",
    },
    args: { key: "user.issues.per.page" },
    query: { key: "user.issues.per.page" },
  },
  {
    tool: "jira.reindex-progress",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "reindex/progress?taskId=9223372036854775807",
    },
    args: { taskId: "9223372036854775807" },
    query: { taskId: "9223372036854775807" },
  },
  {
    tool: "jira.reindex-request",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "reindex/request/7" },
    args: { requestId: "7" },
    parameters: { requestId: "7" },
  },
  {
    tool: "jira.reindex-requests",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "reindex/request/bulk?requestId=7",
    },
    args: { requestIds: ["7"], startAt: 0, maxResults: 1 },
    query: { requestId: "7" },
  },
  {
    tool: "jira.upgrade-result",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "upgrade" },
    args: {},
  },
  {
    tool: "jira.index-snapshots",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "index-snapshot" },
    args: { startAt: 0, maxResults: 1 },
  },
  {
    tool: "jira.app-monitoring",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "monitoring/app" },
    args: {},
  },
  {
    tool: "jira.ipd-monitoring",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "monitoring/ipd" },
    args: {},
  },
  {
    tool: "jira.jmx-metrics",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "monitoring/jmx/getAvailableMetrics",
    },
    args: {},
  },
  {
    tool: "jira.global-version-page",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "version?startAt=0&maxResults=1&query=Next+%26+later&projectIds=10000",
    },
    args: { startAt: 0, maxResults: 1, query: "Next & later", projectIds: ["10000"] },
    query: { startAt: "0", maxResults: "1", query: "Next & later", projectIds: "10000" },
  },
  {
    tool: "jira.component-page",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "component/page?startAt=0&maxResults=1&query=&projectIds=10000",
    },
    args: { startAt: 0, maxResults: 1, query: "", projectIds: ["10000"] },
    query: { startAt: "0", maxResults: "1", query: "", projectIds: "10000" },
  },
  {
    tool: "jira.link-type",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issueLinkType/31" },
    args: { linkTypeId: "31" },
    parameters: { issueLinkTypeId: "31" },
  },
  {
    tool: "jira.accessibility-settings",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "user/a11y/personal-settings" },
    args: { startAt: 0, maxResults: 1 },
  },
  {
    tool: "jira.system-columns",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "settings/columns" },
    args: { startAt: 0, maxResults: 1 },
  },
  {
    tool: "jira.user-columns",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "user/columns?username=Review+%2B+QA",
    },
    args: { username: "Review + QA", startAt: 0, maxResults: 1 },
    query: { username: "Review + QA" },
  },
  {
    tool: "jira.filter-columns",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "filter/42/columns" },
    args: { filterId: "42", startAt: 0, maxResults: 1 },
    parameters: { id: "42" },
  },
  {
    tool: "jira.cluster-nodes",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "cluster/nodes" },
    args: { startAt: 0, maxResults: 1 },
  },
  {
    tool: "jira.cluster-upgrade-state",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "cluster/zdu/state" },
    args: {},
  },
  {
    tool: "jira.index-snapshot-status",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "index-snapshot/isRunning" },
    args: {},
  },
  {
    tool: "jira.index-summary",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "index/summary" },
    args: {},
  },
  {
    tool: "jira.jmx-metrics-exposed",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "monitoring/jmx/areMetricsExposed",
    },
    args: {},
  },
  {
    tool: "jira.search-max-aggregation-buckets",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "searchLimits/maxAggregationBuckets",
    },
    args: {},
  },
  {
    tool: "jira.search-max-result-window",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "searchLimits/maxResultWindow",
    },
    args: {},
  },
  {
    tool: "jira.screens",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "screens?startAt=0&maxResults=1&search=Details+%26+QA",
    },
    args: { startAt: 0, maxResults: 1, search: "Details & QA" },
    query: { startAt: "0", maxResults: "1", search: "Details & QA" },
  },
  {
    tool: "jira.workflows",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "workflow?workflowName=Review+%26+QA",
    },
    args: { workflowName: "Review & QA" },
    query: { workflowName: "Review & QA" },
  },
  {
    tool: "jira.custom-fields",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "customFields?startAt=0&maxResults=1&search=Delivery",
    },
    args: { startAt: 0, maxResults: 1, search: "Delivery" },
    query: { startAt: "0", maxResults: "1", search: "Delivery" },
  },
  {
    tool: "jira.custom-field-options",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "customFields/10001/options?page=2&maxResults=1&query=&useAllContexts=false&sortByOptionName=true&projectIds=10000&issueTypeIds=10001",
    },
    args: {
      customFieldId: "10001",
      page: 2,
      maxResults: 1,
      query: "",
      useAllContexts: false,
      sortByOptionName: true,
      projectIds: ["10000"],
      issueTypeIds: ["10001"],
    },
    parameters: { customFieldId: "10001" },
    query: {
      page: "2",
      maxResults: "1",
      query: "",
      useAllContexts: "false",
      sortByOptionName: "true",
      projectIds: "10000",
      issueTypeIds: "10001",
    },
  },
  {
    tool: "jira.terminology",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "terminology/entries" },
    args: { startAt: 0, maxResults: 1 },
  },
  {
    tool: "jira.terminology-entry",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "terminology/entries/epic" },
    args: { originalName: "epic" },
    parameters: { originalName: "epic" },
  },
  {
    tool: "jira.read-only-mode",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "readonly-mode" },
    args: {},
  },
  {
    tool: "jira.jql-autocomplete",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "jql/autocompletedata" },
    args: { category: "fields", startAt: 0, maxResults: 1 },
  },
  {
    tool: "jira.jql-suggestions",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "jql/autocompletedata/suggestions?fieldName=project+%26+team&fieldValue=%22Ac%22&predicateName=from&predicateValue=Old+%26+new",
    },
    args: {
      fieldName: "project & team",
      fieldValue: '"Ac"',
      predicateName: "from",
      predicateValue: "Old & new",
      startAt: 0,
      maxResults: 1,
    },
    query: {
      fieldName: "project & team",
      fieldValue: '"Ac"',
      predicateName: "from",
      predicateValue: "Old & new",
    },
  },
  {
    tool: "jira.multi-project-assignable-users",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "user/assignable/multiProjectSearch?maxResults=1&username=Synthetic+%2B+QA&projectKeys=SYN%2COTHER",
    },
    args: { projectKeys: ["SYN", "OTHER"], query: "Synthetic + QA", maxResults: 1 },
    query: { maxResults: "1", username: "Synthetic + QA", projectKeys: "SYN,OTHER" },
  },
  {
    tool: "jira.permission-users",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "user/permission/search?maxResults=1&username=Synthetic&issueKey=SYN-1&permissions=BROWSE_PROJECTS%2CASSIGN_ISSUES&startAt=0",
    },
    args: {
      permissions: ["BROWSE_PROJECTS", "ASSIGN_ISSUES"],
      issueKey: "SYN-1",
      query: "Synthetic",
      startAt: 0,
      maxResults: 1,
    },
    query: {
      maxResults: "1",
      username: "Synthetic",
      issueKey: "SYN-1",
      permissions: "BROWSE_PROJECTS,ASSIGN_ISSUES",
      startAt: "0",
    },
  },
  {
    tool: "jira.browse-permission-users",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "user/viewissue/search?maxResults=1&username=Synthetic&projectKey=SYN",
    },
    args: { projectKey: "SYN", query: "Synthetic", maxResults: 1 },
    query: { maxResults: "1", username: "Synthetic", projectKey: "SYN" },
  },
  {
    tool: "jira.group-user-picker",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "groupuserpicker?maxResults=1&query=Synthetic&showAvatar=false&fieldId=customfield_10001&projectId=9223372036854775807&issueTypeId=10001",
    },
    args: {
      query: "Synthetic",
      maxResults: 1,
      fieldId: "customfield_10001",
      projectId: "9223372036854775807",
      issueTypeId: "10001",
    },
    query: {
      maxResults: "1",
      query: "Synthetic",
      showAvatar: "false",
      fieldId: "customfield_10001",
      projectId: "9223372036854775807",
      issueTypeId: "10001",
    },
  },
  {
    tool: "jira.project-picker",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "projects/picker?maxResults=1&query=Syn&allowEmptyQuery=false",
    },
    args: { query: "Syn", maxResults: 1, allowEmptyQuery: false },
    query: { maxResults: "1", query: "Syn", allowEmptyQuery: "false" },
  },
  {
    tool: "jira.fields",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "field" },
    args: { startAt: 0, maxResults: 1 },
  },
  {
    tool: "jira.custom-field-option",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "customFieldOption/91" },
    args: { optionId: "91" },
    parameters: { id: "91" },
  },
  {
    tool: "jira.component-related-issue-counts",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "component/71/relatedIssueCounts",
    },
    args: { componentId: "71" },
    parameters: { id: "71" },
  },
  {
    tool: "jira.version-related-issue-counts",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "version/81/relatedIssueCounts",
    },
    args: { versionId: "81" },
    parameters: { id: "81" },
  },
  {
    tool: "jira.version-unresolved-issue-count",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "version/81/unresolvedIssueCount",
    },
    args: { versionId: "81" },
    parameters: { id: "81" },
  },
  {
    tool: "jira.project-version-page",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "project/10000/version?startAt=0&maxResults=1&orderBy=%2Bname",
    },
    args: { projectIdOrKey: "SYN", startAt: 0, maxResults: 1, orderBy: "+name" },
    parameters: { projectIdOrKey: "10000" },
    primaryMethodIndex: 1,
    query: { startAt: "0", maxResults: "1", orderBy: "+name" },
  },
  {
    tool: "jira.roles",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "role" },
    args: { startAt: 0, maxResults: 1 },
  },
  {
    tool: "jira.role",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "role/37" },
    args: { roleId: "37" },
    parameters: { id: "37" },
  },
  {
    tool: "jira.role-default-actors",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "role/37/actors" },
    args: { roleId: "37", startAt: 0, maxResults: 1 },
    parameters: { id: "37" },
  },
  {
    tool: "jira.project-roles",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "project/10000/role" },
    args: { projectIdOrKey: "SYN", startAt: 0, maxResults: 1 },
    parameters: { projectIdOrKey: "10000" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.project-role",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "project/10000/role/37" },
    args: { projectIdOrKey: "SYN", roleId: "37" },
    parameters: { projectIdOrKey: "10000", id: "37" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.priority-schemes",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "priorityschemes?startAt=0&maxResults=1",
    },
    args: { startAt: 0, maxResults: 1 },
    query: { startAt: "0", maxResults: "1" },
  },
  {
    tool: "jira.priority-scheme",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "priorityschemes/49" },
    args: { schemeId: "49" },
    parameters: { schemeId: "49" },
  },
  {
    tool: "jira.server-info",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "serverInfo" },
    args: {},
  },
  {
    tool: "jira.instance-configuration",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "configuration" },
    args: {},
  },
  {
    tool: "jira.permission-definitions",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "permissions" },
    args: { startAt: 0, maxResults: 1 },
  },
  {
    tool: "jira.myself",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "myself" },
    args: {},
  },
  {
    tool: "jira.global-issue-types",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issuetype" },
    args: { startAt: 0, maxResults: 1 },
  },
  {
    tool: "jira.issue-type",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issuetype/10001" },
    args: { issueTypeId: "10001" },
    parameters: { id: "10001" },
  },
  {
    tool: "jira.issue-type-page",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "issuetype/page?startAt=0&maxResults=1&query=Story+%2B+QA&projectIds=9223372036854775807",
    },
    args: { startAt: 0, maxResults: 1, query: "Story + QA", projectIds: ["9223372036854775807"] },
    query: {
      startAt: "0",
      maxResults: "1",
      query: "Story + QA",
      projectIds: "9223372036854775807",
    },
  },
  {
    tool: "jira.issue-type-alternatives",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "issuetype/10001/alternatives",
    },
    args: { issueTypeId: "10001", startAt: 0, maxResults: 1 },
    parameters: { id: "10001" },
  },
  {
    tool: "jira.priorities",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "priority" },
    args: { startAt: 0, maxResults: 1 },
  },
  {
    tool: "jira.priority",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "priority/3" },
    args: { priorityId: "3" },
    parameters: { id: "3" },
  },
  {
    tool: "jira.priority-page",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "priority/page?startAt=0&maxResults=1&query=Normal&projectIds=10000",
    },
    args: { startAt: 0, maxResults: 1, query: "Normal", projectIds: ["10000"] },
    query: { startAt: "0", maxResults: "1", query: "Normal", projectIds: "10000" },
  },
  {
    tool: "jira.resolutions",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "resolution" },
    args: { startAt: 0, maxResults: 1 },
  },
  {
    tool: "jira.resolution",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "resolution/41" },
    args: { resolutionId: "41" },
    parameters: { id: "41" },
  },
  {
    tool: "jira.resolution-page",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "resolution/page?startAt=0&maxResults=1&query=Fixed",
    },
    args: { startAt: 0, maxResults: 1, query: "Fixed" },
    query: { startAt: "0", maxResults: "1", query: "Fixed" },
  },
  {
    tool: "jira.statuses",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "status" },
    args: { startAt: 0, maxResults: 1 },
  },
  {
    tool: "jira.status",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "status/In%20Progress%20%2B%20QA",
    },
    args: { statusIdOrName: "In Progress + QA" },
    parameters: { idOrName: "In Progress + QA" },
  },
  {
    tool: "jira.status-page",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "status/page?startAt=0&maxResults=1&query=In+Progress&projectIds=10000&issueTypeIds=10001",
    },
    args: {
      startAt: 0,
      maxResults: 1,
      query: "In Progress",
      projectIds: ["10000"],
      issueTypeIds: ["10001"],
    },
    query: {
      startAt: "0",
      maxResults: "1",
      query: "In Progress",
      projectIds: "10000",
      issueTypeIds: "10001",
    },
  },
  {
    tool: "jira.status-categories",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "statuscategory" },
    args: { startAt: 0, maxResults: 1 },
  },
  {
    tool: "jira.status-category",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "statuscategory/indeterminate",
    },
    args: { statusCategoryIdOrKey: "indeterminate" },
    parameters: { idOrKey: "indeterminate" },
  },
  {
    tool: "jira.project-categories",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "projectCategory" },
    args: { startAt: 0, maxResults: 1 },
  },
  {
    tool: "jira.project-category",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "projectCategory/51" },
    args: { projectCategoryId: "51" },
    parameters: { id: "51" },
  },
  {
    tool: "jira.project-statuses",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "project/10000/statuses" },
    args: { projectIdOrKey: "SYN", startAt: 0, maxResults: 1 },
    parameters: { projectIdOrKey: "10000" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.project-types",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "project/type" },
    args: { startAt: 0, maxResults: 1 },
  },
  {
    tool: "jira.project-type-definition",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "project/type/software" },
    args: { projectTypeKey: "software" },
    parameters: { projectTypeKey: "software" },
  },
  {
    tool: "jira.project-permission-scheme",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "project/10000/permissionscheme",
    },
    args: { projectIdOrKey: "SYN" },
    parameters: { projectKeyOrId: "10000" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.project-issue-security-scheme",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "project/10000/issuesecuritylevelscheme",
    },
    args: { projectIdOrKey: "SYN" },
    parameters: { projectKeyOrId: "10000" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.project-security-levels",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "project/10000/securitylevel" },
    args: { projectIdOrKey: "SYN", startAt: 0, maxResults: 1 },
    parameters: { projectKeyOrId: "10000" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.project-workflow-scheme",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "project/10000/workflowscheme",
    },
    args: { projectIdOrKey: "SYN", startAt: 0, maxResults: 1 },
    parameters: { projectKeyOrId: "10000" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.project-priority-scheme",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "project/10000/priorityscheme",
    },
    args: { projectIdOrKey: "SYN" },
    parameters: { projectKeyOrId: "10000" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.permission-schemes",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "permissionscheme?expand=permissions",
    },
    args: { startAt: 0, maxResults: 1, includePermissions: true },
    query: { expand: "permissions" },
  },
  {
    tool: "jira.permission-scheme",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "permissionscheme/37?expand=permissions",
    },
    args: { schemeId: "37", includePermissions: true },
    parameters: { schemeId: "37" },
    query: { expand: "permissions" },
  },
  {
    tool: "jira.permission-grants",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "permissionscheme/37/permission",
    },
    args: { schemeId: "37", startAt: 0, maxResults: 1 },
    parameters: { schemeId: "37" },
  },
  {
    tool: "jira.permission-grant",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "permissionscheme/37/permission/81",
    },
    args: { schemeId: "37", permissionId: "81" },
    parameters: { schemeId: "37", permissionId: "81" },
  },
  {
    tool: "jira.issue-security-schemes",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issuesecurityschemes" },
    args: { startAt: 0, maxResults: 1 },
  },
  {
    tool: "jira.issue-security-scheme",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issuesecurityschemes/38" },
    args: { schemeId: "38" },
    parameters: { id: "38" },
  },
  {
    tool: "jira.security-level",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "securitylevel/91" },
    args: { levelId: "91" },
    parameters: { id: "91" },
  },
  {
    tool: "jira.notification-schemes",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "notificationscheme?startAt=0&maxResults=1&expand=notificationSchemeEvents%2Cuser%2Cgroup%2CprojectRole%2Cfield",
    },
    args: { startAt: 0, maxResults: 1, includeEvents: true },
    query: {
      startAt: "0",
      maxResults: "1",
      expand: "notificationSchemeEvents,user,group,projectRole,field",
    },
  },
  {
    tool: "jira.notification-scheme",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "notificationscheme/47?expand=notificationSchemeEvents%2Cuser%2Cgroup%2CprojectRole%2Cfield",
    },
    args: { schemeId: "47", includeEvents: true },
    parameters: { id: "47" },
    query: { expand: "notificationSchemeEvents,user,group,projectRole,field" },
  },
  {
    tool: "jira.project-notification-scheme",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "project/10000/notificationscheme",
    },
    args: { projectIdOrKey: "SYN", includeEvents: false },
    parameters: { projectKeyOrId: "10000" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.user",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "user?key=JIRAUSER10100&includeDeleted=true",
    },
    args: { userKey: "JIRAUSER10100", includeDeleted: true },
    query: { key: "JIRAUSER10100", includeDeleted: "true" },
  },
  {
    tool: "jira.users",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "user/search?maxResults=2&username=Synthetic+%2B+QA&includeActive=true&includeInactive=false&startAt=0",
    },
    args: {
      query: "Synthetic + QA",
      startAt: 0,
      maxResults: 2,
      includeActive: true,
      includeInactive: false,
    },
    query: {
      username: "Synthetic + QA",
      startAt: "0",
      maxResults: "2",
      includeActive: "true",
      includeInactive: "false",
    },
  },
  {
    tool: "jira.user-directory",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "user/list?maxResults=2&cursor=-9223372036854775808",
    },
    args: { cursor: "-9223372036854775808", maxResults: 2 },
    query: { cursor: "-9223372036854775808", maxResults: "2" },
  },
  {
    tool: "jira.user-picker",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "user/picker?maxResults=2&query=Synthetic+%2B+QA&showAvatar=false",
    },
    args: { query: "Synthetic + QA", maxResults: 2 },
    query: { query: "Synthetic + QA", maxResults: "2", showAvatar: "false" },
  },
  {
    tool: "jira.group-members",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "group/member?maxResults=2&groupname=R%26D+team&startAt=0&includeInactiveUsers=true",
    },
    args: { groupName: "R&D team", startAt: 0, maxResults: 2, includeInactiveUsers: true },
    query: { groupname: "R&D team", startAt: "0", maxResults: "2", includeInactiveUsers: "true" },
  },
  {
    tool: "jira.groups",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "groups/picker?maxResults=2&query=R%26D",
    },
    args: { query: "R&D", maxResults: 2 },
    query: { query: "R&D", maxResults: "2" },
  },
  {
    tool: "jira.application-roles",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "applicationrole" },
    args: { startAt: 0, maxResults: 2 },
  },
  {
    tool: "jira.application-role",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "applicationrole/jira-software",
    },
    args: { applicationRoleKey: "jira-software" },
    parameters: { key: "jira-software" },
  },
  {
    tool: "jira.workflow-scheme",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "workflowscheme/37?returnDraftIfExists=true",
    },
    args: { schemeId: "37", returnDraftIfExists: true },
    parameters: { id: "37" },
    query: { returnDraftIfExists: "true" },
  },
  {
    tool: "jira.workflow-scheme-draft",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "workflowscheme/37/draft" },
    args: { schemeId: "37" },
    parameters: { id: "37" },
  },
  {
    tool: "jira.workflow-scheme-default",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "workflowscheme/37/default?returnDraftIfExists=false",
    },
    args: { schemeId: "37", returnDraftIfExists: false },
    parameters: { id: "37" },
    query: { returnDraftIfExists: "false" },
  },
  {
    tool: "jira.workflow-scheme-draft-default",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "workflowscheme/37/draft/default",
    },
    args: { schemeId: "37" },
    parameters: { id: "37" },
  },
  {
    tool: "jira.workflow-scheme-issue-type",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "workflowscheme/37/issuetype/1?returnDraftIfExists=true",
    },
    args: { schemeId: "37", issueTypeId: "1", returnDraftIfExists: true },
    parameters: { id: "37", issueType: "1" },
    query: { returnDraftIfExists: "true" },
  },
  {
    tool: "jira.workflow-scheme-draft-issue-type",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "workflowscheme/37/draft/issuetype/1",
    },
    args: { schemeId: "37", issueTypeId: "1" },
    parameters: { id: "37", issueType: "1" },
  },
  {
    tool: "jira.workflow-scheme-workflows",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "workflowscheme/37/workflow?returnDraftIfExists=false",
    },
    args: { schemeId: "37", returnDraftIfExists: false },
    parameters: { id: "37" },
    query: { returnDraftIfExists: "false" },
  },
  {
    tool: "jira.workflow-scheme-draft-workflows",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "workflowscheme/37/draft/workflow?workflowName=In+Progress+%2B+QA",
    },
    args: { schemeId: "37", workflowName: "In Progress + QA" },
    parameters: { id: "37" },
    query: { workflowName: "In Progress + QA" },
  },
  {
    tool: "jira.issue-type-schemes",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "issuetypescheme?expand=schemes.issueTypes%2Cschemes.defaultIssueType",
    },
    args: { startAt: 0, maxResults: 1, includeIssueTypes: true, includeDefaultIssueType: true },
    query: { expand: "schemes.issueTypes,schemes.defaultIssueType" },
  },
  {
    tool: "jira.issue-type-scheme",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issuetypescheme/37" },
    args: { schemeId: "37" },
    parameters: { schemeId: "37" },
  },
  {
    tool: "jira.issue-type-scheme-projects",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "issuetypescheme/37/associations",
    },
    args: { schemeId: "37", startAt: 0, maxResults: 1 },
    parameters: { schemeId: "37" },
  },
  {
    tool: "jira.screen-tabs",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "screens/71/tabs?projectKey=SYN",
    },
    args: { screenId: "71", projectKey: "SYN", startAt: 0, maxResults: 1 },
    parameters: { screenId: "71" },
    query: { projectKey: "SYN" },
  },
  {
    tool: "jira.screen-tab-fields",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "screens/71/tabs/81/fields?projectKey=SYN",
    },
    args: { screenId: "71", tabId: "81", projectKey: "SYN" },
    parameters: { screenId: "71", tabId: "81" },
    query: { projectKey: "SYN" },
  },
  {
    tool: "jira.screen-available-fields",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "screens/71/availableFields" },
    args: { screenId: "71" },
    parameters: { screenId: "71" },
  },
  {
    tool: "jira.create-worklog",
    expectedPrimary: {
      method: "POST",
      apiRoot: "/rest/api/2",
      path: "issue/10001/worklog?adjustEstimate=leave",
    },
    args: {
      issueKey: "SYN-1",
      timeSpentSeconds: 1200,
      started: "2026-11-07T10:00:00Z",
      comment: "Investigated",
    },
    parameters: { issueIdOrKey: "10001" },
    query: { adjustEstimate: "leave" },
  },
  {
    tool: "jira.update-worklog",
    expectedPrimary: {
      method: "PUT",
      apiRoot: "/rest/api/2",
      path: "issue/10001/worklog/101?adjustEstimate=leave",
    },
    args: { issueKey: "SYN-1", worklogId: "101", comment: "Updated" },
    parameters: { issueIdOrKey: "10001", id: "101" },
    query: { adjustEstimate: "leave" },
  },
  {
    tool: "jira.delete-worklog",
    expectedPrimary: {
      method: "DELETE",
      apiRoot: "/rest/api/2",
      path: "issue/10001/worklog/101?adjustEstimate=leave",
    },
    args: {
      issueKey: "SYN-1",
      worklogId: "101",
      timeSpentSeconds: 3600,
      started: "2026-11-07T09:00:00.000+0000",
      comment: "Original",
      visibility: null,
    },
    parameters: { issueIdOrKey: "10001", id: "101" },
    query: { adjustEstimate: "leave" },
  },
  {
    tool: "jira.watchers",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issue/10001/watchers" },
    args: { issueKey: "SYN-1", startAt: 0, maxResults: 25 },
    parameters: { issueIdOrKey: "10001" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.votes",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issue/10001/votes" },
    args: { issueKey: "SYN-1", startAt: 0, maxResults: 25 },
    parameters: { issueIdOrKey: "10001" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.watch",
    expectedPrimary: { method: "POST", apiRoot: "/rest/api/2", path: "issue/10001/watchers" },
    args: { issueKey: "SYN-1" },
    parameters: { issueIdOrKey: "10001" },
  },
  {
    tool: "jira.unwatch",
    expectedPrimary: {
      method: "DELETE",
      apiRoot: "/rest/api/2",
      path: "issue/10001/watchers?username=synthetic-user",
    },
    args: { issueKey: "SYN-1" },
    parameters: { issueIdOrKey: "10001" },
    query: { username: "synthetic-user" },
  },
  {
    tool: "jira.vote",
    expectedPrimary: { method: "POST", apiRoot: "/rest/api/2", path: "issue/10001/votes" },
    args: { issueKey: "SYN-1" },
    parameters: { issueIdOrKey: "10001" },
  },
  {
    tool: "jira.unvote",
    expectedPrimary: { method: "DELETE", apiRoot: "/rest/api/2", path: "issue/10001/votes" },
    args: { issueKey: "SYN-1" },
    parameters: { issueIdOrKey: "10001" },
  },
  {
    tool: "jira.attachment-settings",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "attachment/meta" },
    args: {},
  },
  {
    tool: "jira.attachment",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "attachment/71" },
    args: { attachmentId: "71" },
    parameters: { id: "71" },
  },
  {
    tool: "jira.delete-attachment",
    expectedPrimary: { method: "DELETE", apiRoot: "/rest/api/2", path: "attachment/71" },
    args: { issueKey: "SYN-1", attachmentId: "71", filename: "note.txt", size: 14 },
    parameters: { id: "71" },
  },
  {
    tool: "jira.attachment-archive",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "attachment/71/expand/raw" },
    args: { attachmentId: "71", startAt: 0, maxResults: 1 },
    parameters: { id: "71" },
  },
  {
    tool: "jira.attachment-archive-summary",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "attachment/71/expand/human" },
    args: { attachmentId: "71" },
    parameters: { id: "71" },
  },
  {
    tool: "jira.system-avatars",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "avatar/user/system" },
    args: { avatarType: "user" },
    parameters: { type: "user" },
  },
  {
    tool: "jira.project-avatars",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "project/SYN/avatars" },
    args: { projectIdOrKey: "SYN" },
    parameters: { projectIdOrKey: "SYN" },
  },
  {
    tool: "jira.user-avatars",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "user/avatars?username=User+name%2Btag",
    },
    args: { username: "User name+tag" },
    query: { username: "User name+tag" },
  },
  {
    tool: "jira.avatars",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "universal_avatar/type/project/owner/10000",
    },
    args: { avatarType: "project", owningObjectId: "10000" },
    parameters: { type: "project", owningObjectId: "10000" },
  },
  {
    tool: "jira.dashboards",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "dashboard?startAt=0&maxResults=25",
    },
    args: { startAt: 0, maxResults: 25 },
    query: PAGING,
  },
  {
    tool: "jira.dashboard",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "dashboard/71" },
    args: { dashboardId: "71" },
    parameters: { id: "71" },
  },
  {
    tool: "jira.filter-share-scope",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "filter/defaultShareScope" },
    args: {},
  },
  {
    tool: "jira.filter-permissions",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "filter/37/permission" },
    args: { filterId: "37", startAt: 0, maxResults: 25 },
    parameters: { id: "37" },
  },
  {
    tool: "jira.filter-permission",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "filter/37/permission/81" },
    args: { filterId: "37", permissionId: "81" },
    parameters: { id: "37", permissionId: "81" },
  },
  {
    tool: "jira.get-comment",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issue/10001/comment/10002" },
    args: { issueKey: "SYN-1", commentId: "10002" },
    parameters: { issueIdOrKey: "10001", id: "10002" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.update-comment",
    expectedPrimary: { method: "PUT", apiRoot: "/rest/api/2", path: "issue/10001/comment/10002" },
    args: { issueKey: "SYN-1", commentId: "10002", body: "Updated comment" },
    parameters: { issueIdOrKey: "10001", id: "10002" },
  },
  {
    tool: "jira.delete-comment",
    expectedPrimary: {
      method: "DELETE",
      apiRoot: "/rest/api/2",
      path: "issue/10001/comment/10002",
    },
    args: { issueKey: "SYN-1", commentId: "10002", expectedBody: "Reviewed comment" },
    parameters: { issueIdOrKey: "10001", id: "10002" },
  },
  {
    tool: "jira.link-types",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issueLinkType" },
    args: { startAt: 0, maxResults: 1 },
  },
  {
    tool: "jira.issue-link",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issueLink/21" },
    args: { linkId: "21" },
    parameters: { linkId: "21" },
  },
  {
    tool: "jira.worklogs",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issue/10001/worklog" },
    args: { issueKey: "SYN-1", startAt: 0, maxResults: 25 },
    parameters: { issueIdOrKey: "10001" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.worklog",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issue/10001/worklog/101" },
    args: { issueKey: "SYN-1", worklogId: "101" },
    parameters: { issueIdOrKey: "10001", id: "101" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.projects",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "project" },
    args: {},
  },
  {
    tool: "jira.filter",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "filter/37" },
    args: { filterId: "37" },
    parameters: { id: "37" },
  },
  {
    tool: "jira.favourite-filters",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "filter/favourite" },
    args: { startAt: 0, maxResults: 25 },
  },
  {
    tool: "jira.components",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "project/10000/components" },
    args: { projectIdOrKey: "SYN" },
    parameters: { projectIdOrKey: "10000" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.component",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "component/71" },
    args: { componentId: "71" },
    parameters: { id: "71" },
  },
  {
    tool: "jira.versions",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "project/10000/versions" },
    args: { projectIdOrKey: "SYN" },
    parameters: { projectIdOrKey: "10000" },
    primaryMethodIndex: 1,
  },
  {
    tool: "jira.version",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "version/81" },
    args: { versionId: "81" },
    parameters: { id: "81" },
  },
  {
    tool: "jira.create-component",
    expectedPrimary: { method: "POST", apiRoot: "/rest/api/2", path: "component" },
    args: { projectIdOrKey: "SYN", name: "After" },
  },
  {
    tool: "jira.update-component",
    expectedPrimary: { method: "PUT", apiRoot: "/rest/api/2", path: "component/71" },
    args: { componentId: "71", name: "After" },
    parameters: { id: "71" },
  },
  {
    tool: "jira.create-version",
    expectedPrimary: { method: "POST", apiRoot: "/rest/api/2", path: "version" },
    args: { projectId: "10000", name: "After" },
  },
  {
    tool: "jira.update-version",
    expectedPrimary: { method: "PUT", apiRoot: "/rest/api/2", path: "version/81" },
    args: { versionId: "81", name: "After" },
    parameters: { id: "81" },
  },
  {
    tool: "jira.project",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "project/SYN" },
    args: { projectIdOrKey: "SYN" },
    parameters: { projectIdOrKey: "SYN" },
  },
  {
    tool: "jira.validate-project-key",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "projectvalidate/key?key=SYN" },
    args: { key: "SYN" },
    query: { key: "SYN" },
  },
  {
    tool: "jira.project-permissions",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "mypermissions?projectId=10000",
    },
    args: { projectIdOrKey: "10000" },
    query: { projectId: "10000" },
  },
  {
    tool: "jira.project-type",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "project/type/software/accessible",
    },
    args: { projectTypeKey: "software" },
    parameters: { projectTypeKey: "software" },
  },
  {
    tool: "jira.create-project",
    expectedPrimary: { method: "POST", apiRoot: "/rest/api/2", path: "project" },
    args: { key: "SYN", name: "After", lead: "synthetic-user", projectTypeKey: "software" },
  },
  {
    tool: "jira.update-project",
    expectedPrimary: { method: "PUT", apiRoot: "/rest/api/2", path: "project/10000" },
    args: { projectIdOrKey: "SYN", name: "After" },
    parameters: { projectIdOrKey: "10000" },
  },
  {
    tool: "jira.issue-types",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "issue/createmeta/SYN/issuetypes?startAt=0&maxResults=25",
    },
    args: { projectKey: "SYN" },
    parameters: { projectIdOrKey: "SYN" },
    query: PAGING,
  },
  {
    tool: "jira.create-fields",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "issue/createmeta/SYN/issuetypes/10001?startAt=0&maxResults=100",
    },
    args: { projectKey: "SYN", issueTypeId: "10001", maxResults: 100 },
    parameters: { projectIdOrKey: "SYN", issueTypeId: "10001" },
    query: { ...PAGING, maxResults: "100" },
  },
  {
    tool: "jira.edit-fields",
    expectedPrimary: { method: "GET", apiRoot: "/rest/api/2", path: "issue/SYN-1/editmeta" },
    args: { issueKey: "SYN-1" },
    parameters: ISSUE_PARAMETERS,
  },
  {
    tool: "jira.search",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "search?jql=project+%3D+SYN&startAt=0&maxResults=50&fields=summary%2Cstatus%2Cissuetype%2Cproject%2Cassignee%2Cpriority%2Clabels%2Ccreated%2Cupdated",
    },
    args: { jql: "project = SYN", maxResults: 50 },
    query: {
      ...PAGING,
      jql: "project = SYN",
      maxResults: "50",
      fields: "summary,status,issuetype,project,assignee,priority,labels,created,updated",
    },
  },
  {
    tool: "jira.issue",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "issue/SYN-1?fields=summary,description,status,issuetype,project,assignee,reporter,priority,labels,duedate,created,updated",
    },
    args: { issueKey: "SYN-1" },
    parameters: ISSUE_PARAMETERS,
    query: {
      fields:
        "summary,description,status,issuetype,project,assignee,reporter,priority,labels,duedate,created,updated",
    },
  },
  {
    tool: "jira.comments",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "issue/SYN-1/comment?startAt=0&maxResults=25",
    },
    args: { issueKey: "SYN-1" },
    parameters: ISSUE_PARAMETERS,
    query: PAGING,
  },
  {
    tool: "jira.transitions",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "issue/SYN-1/transitions?expand=transitions.fields",
    },
    args: { issueKey: "SYN-1" },
    parameters: ISSUE_PARAMETERS,
    query: { expand: "transitions.fields" },
  },
  {
    tool: "jira.assignable-users",
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/api/2",
      path: "user/assignable/search?issueKey=SYN-1&username=synthetic&startAt=0&maxResults=25",
    },
    args: { issueKey: "SYN-1", query: "synthetic" },
    query: { ...PAGING, issueKey: "SYN-1", username: "synthetic" },
  },
  {
    tool: "jira.create",
    expectedPrimary: { method: "POST", apiRoot: "/rest/api/2", path: "issue" },
    args: CREATE,
  },
  {
    tool: "jira.edit",
    expectedPrimary: { method: "PUT", apiRoot: "/rest/api/2", path: "issue/SYN-1" },
    args: { issueKey: "SYN-1", fields: { summary: "After" } },
    parameters: ISSUE_PARAMETERS,
  },
  {
    tool: "jira.assign",
    expectedPrimary: { method: "PUT", apiRoot: "/rest/api/2", path: "issue/SYN-1/assignee" },
    args: { issueKey: "SYN-1", assigneeName: "synthetic-user" },
    parameters: ISSUE_PARAMETERS,
  },
  {
    tool: "jira.comment",
    expectedPrimary: { method: "POST", apiRoot: "/rest/api/2", path: "issue/SYN-1/comment" },
    args: { issueKey: "SYN-1", body: "Approved comment" },
    parameters: ISSUE_PARAMETERS,
  },
  {
    tool: "jira.transition",
    expectedPrimary: { method: "POST", apiRoot: "/rest/api/2", path: "issue/SYN-1/transitions" },
    args: { issueKey: "SYN-1", transitionId: "31", fields: { customfield_10000: "Required" } },
    parameters: ISSUE_PARAMETERS,
  },
  {
    tool: "jira.attach",
    expectedPrimary: { method: "POST", apiRoot: "/rest/api/2", path: "issue/SYN-1/attachments" },
    args: { issueKey: "SYN-1", source: { kind: "connected-file", path: "note.txt" } },
    parameters: ISSUE_PARAMETERS,
  },
];
// Reuse independently authored fixture routes; no method or target comes from the registry.
const NAMED_PRIMARY_CASES = [
  ...DIRECTORY_CASES,
  ...MAINTENANCE_CASES,
  ...SCHEMA_CASES,
  ...GROUP_CASES,
  ...ISSUE_CASES,
  ...ROLE_CASES,
  ...WORKFLOW_CASES,
  ...PROJECT_CATEGORY_CASES,
  ...INSTANCE_CASES.map((item) => ({ ...item, method: "PUT" as const })),
];
const TOOL_PRIMARY_CASES = [
  ...PERMISSION_CASES,
  ...OPTION_CASES,
  ...EMAIL_CASES,
  ...VERSION_LINK_CASES,
  ...SCREEN_CONFIGURATION_CASES,
  ...RELEASE_LIFECYCLE_FIXTURE_CASES,
  ...LINK_MUTATION_FIXTURE_CASES,
];
function independentPrimary(scenario: Scenario): Scenario["expectedPrimary"] {
  if (scenario.expectedPrimary !== undefined) return scenario.expectedPrimary;
  const named = NAMED_PRIMARY_CASES.find((item) => item.name === scenario.tool);
  const selected = named ?? TOOL_PRIMARY_CASES.find((item) => item.tool === scenario.tool);
  if (selected === undefined) return undefined;
  const path = selected.path.replace(/^\/rest\/api\/2\//u, "").replace(/^\//u, "");
  return {
    method: selected.method,
    apiRoot: "/rest/api/2",
    path: path + ("query" in selected ? selected.query : ""),
  };
}
function assertPrimary(observation: Observation, scenario: Scenario): void {
  const expectedPrimary = independentPrimary(scenario);
  if (expectedPrimary === undefined)
    throw new TypeError(`Missing independent native primary fixture for ${scenario.tool}`);
  assertNativeJiraPrimary(observation, { ...scenario, expectedPrimary });
}
interface RemoteState extends SyntheticJira {
  monitoring: { app: boolean; ipd: boolean; jmx: boolean } | undefined;
  screenTabs: readonly Record<string, unknown>[] | undefined;
  worklog: Record<string, unknown>;
  worklogDeleted: boolean;
  commentDeleted: boolean;
  attachmentDeleted: boolean;
  isWatching: boolean;
  hasVoted: boolean;
  project: Record<string, unknown>;
  component: Record<string, unknown>;
  version: Record<string, unknown>;
}
const MONITORING_WRITES = new Set([
  "jira.set-app-monitoring",
  "jira.set-ipd-monitoring",
  "jira.start-jmx-metrics",
  "jira.stop-jmx-metrics",
]);
function monitoringRead(path: string, state: RemoteState): AtlassianHttpBodyResult | undefined {
  const current = state.monitoring;
  if (current === undefined) return undefined;
  if (path === "monitoring/jmx/areMetricsExposed") return response(current.jmx);
  if (path === "monitoring/app") return response({ enabled: current.app });
  return path === "monitoring/ipd" ? response({ enabled: current.ipd }) : undefined;
}
function monitoringWrite(
  path: string,
  request: AtlassianHttpBodyRequest,
  state: RemoteState,
): AtlassianHttpBodyResult | undefined {
  const current = state.monitoring;
  if (current === undefined || !path.startsWith("monitoring/")) return undefined;
  expect(request.method).toBe("POST");
  if (path === "monitoring/app" || path === "monitoring/ipd") {
    const enabled = path === "monitoring/app";
    expect(JSON.parse(request.bodyJson ?? "null")).toEqual({ enabled });
    current[enabled ? "app" : "ipd"] = enabled;
  } else {
    expect(new Set(["monitoring/jmx/startExposing", "monitoring/jmx/stopExposing"]).has(path)).toBe(
      true,
    );
    expect(request.bodyJson).toBeUndefined();
    current.jmx = path === "monitoring/jmx/startExposing";
  }
  return response({}, 204);
}
const SCREEN_TAB_WRITES = new Set([
  "jira.create-screen-tab",
  "jira.rename-screen-tab",
  "jira.delete-screen-tab",
]);
function screenTabRead(path: string, state: RemoteState): AtlassianHttpBodyResult | undefined {
  return state.screenTabs !== undefined && path === "screens/71/tabs"
    ? response(state.screenTabs)
    : undefined;
}
function screenTabWrite(
  path: string,
  request: AtlassianHttpBodyRequest,
  state: RemoteState,
): AtlassianHttpBodyResult | undefined {
  const tabs = state.screenTabs;
  if (tabs === undefined) return undefined;
  if (path === "screens/71/tabs" && request.method === "POST") {
    expect(JSON.parse(request.bodyJson ?? "null")).toEqual({ name: "After" });
    state.screenTabs = [...tabs, { id: 83, name: "After" }];
    return response({ id: 83, name: "After" }, 201);
  }
  if (path !== "screens/71/tabs/81") return undefined;
  if (request.method === "PUT") {
    expect(JSON.parse(request.bodyJson ?? "null")).toEqual({ name: "After" });
    state.screenTabs = tabs.map((tab) => (tab.id === 81 ? { ...tab, name: "After" } : tab));
    return response(undefined, 204);
  }
  if (request.method !== "DELETE") return undefined;
  expect(request.bodyJson).toBeUndefined();
  state.screenTabs = tabs.filter((tab) => tab.id !== 81);
  return response(undefined, 204);
}
function collaborationRead(path: string, state: RemoteState): AtlassianHttpBodyResult | undefined {
  const type = { id: "11", name: "Relates", inward: "relates to", outward: "relates to" };
  const worklog = state.worklog;
  if (path === `issue/10001/worklog/${String(worklog.id)}`)
    return state.worklogDeleted ? response({}, 404) : response(worklog);
  if (path === "issue/10001/comment/10002" && state.commentDeleted) return response({}, 404);
  const comment = {
    id: "10002",
    body: state.comment,
    self: "https://jira.example.invalid/context/rest/api/2/issue/10001/comment/10002",
  };
  const comments = state.commentDeleted ? [] : [comment];
  const worklogs = state.worklogDeleted ? [] : [worklog];
  const bodies: Readonly<Record<string, unknown>> = {
    "issue/10001/comment/10002": comment,
    "issue/10001/comment": { startAt: 0, maxResults: 1, total: comments.length, comments },
    issueLinkType: { issueLinkTypes: [type] },
    "issueLink/21": {
      id: "21",
      type,
      inwardIssue: { key: "SYN-1" },
      outwardIssue: { key: "SYN-2" },
    },
    "issue/10001/worklog": { startAt: 0, maxResults: 1, total: worklogs.length, worklogs },
    "issue/10001/worklog/101": worklog,
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function collaborationWrite(
  path: string,
  request: AtlassianHttpBodyRequest,
  state: RemoteState,
): AtlassianHttpBodyResult | undefined {
  if (path !== "issue/10001/comment/10002") return undefined;
  if (request.method === "DELETE") {
    state.commentDeleted = true;
    return response(undefined, 204);
  }
  const body = JSON.parse(request.bodyJson ?? "{}") as Record<string, unknown>;
  if (request.method !== "PUT" || typeof body.body !== "string")
    throw new TypeError("Expected the selected comment update");
  state.comment = body.body;
  return response({ id: "10002", body: state.comment });
}
function worklogWrite(
  path: string,
  request: AtlassianHttpBodyRequest,
  state: RemoteState,
): AtlassianHttpBodyResult | undefined {
  if (path !== "issue/10001/worklog" && path !== "issue/10001/worklog/101") return undefined;
  if (request.method === "DELETE") {
    expect(path).toBe("issue/10001/worklog/101");
    state.worklogDeleted = true;
    return response(undefined, 204);
  }
  const create = path.endsWith("/worklog");
  const body = JSON.parse(request.bodyJson ?? "{}") as Record<string, unknown>;
  state.worklog = {
    ...(create ? {} : state.worklog),
    ...body,
    id: create ? "102" : "101",
    issueId: "10001",
  };
  return response(state.worklog, create ? 201 : 200);
}
function participationRead(path: string, state: RemoteState): AtlassianHttpBodyResult | undefined {
  const person = { key: "synthetic-key", name: "synthetic-user", active: true };
  if (path === "myself") return response(person);
  if (path === "issue/10001/watchers")
    return response({
      isWatching: state.isWatching,
      watchCount: state.isWatching ? 1 : 0,
      watchers: state.isWatching ? [person] : [],
    });
  if (path === "issue/10001/votes")
    return response({
      hasVoted: state.hasVoted,
      votes: state.hasVoted ? 1 : 0,
      voters: state.hasVoted ? [person] : [],
    });
  return undefined;
}
function participationWrite(
  path: string,
  method: string,
  state: RemoteState,
): AtlassianHttpBodyResult | undefined {
  if (path === "issue/10001/watchers") state.isWatching = method === "POST";
  else if (path === "issue/10001/votes") state.hasVoted = method === "POST";
  else return undefined;
  return response(undefined, 204);
}
function structureRead(path: string, state: RemoteState): AtlassianHttpBodyResult | undefined {
  if (path === "component/71") return response(state.component);
  if (path === "version/81") return response(state.version);
  if (path === "project/10000/components") return response([state.component]);
  if (path === "project/10000/versions") return response([state.version]);
  return releaseRead(path);
}
function releaseRead(path: string): AtlassianHttpBodyResult | undefined {
  const bodies: Readonly<Record<string, unknown>> = {
    "component/71/relatedIssueCounts": { issueCount: 0 },
    "version/81/relatedIssueCounts": {
      issuesAffectedCount: 8,
      issuesFixedCount: 4,
      issueCountWithCustomFieldsShowingVersion: 2,
      customFieldNames: [
        { customFieldId: 10001, fieldName: "Delivery", issueCountWithVersionInCustomField: 0 },
        { customFieldId: "9223372036854775807", fieldName: "Audit" },
      ],
    },
    "version/81/unresolvedIssueCount": { issuesUnresolvedCount: 0 },
    "project/10000/version": {
      startAt: 0,
      maxResults: 1,
      isLast: false,
      values: [
        {
          id: "81",
          projectId: 10000,
          name: "Release",
          released: false,
          archived: false,
          releaseDate: "2026-11-07",
        },
      ],
    },
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function structureWrite(
  path: string,
  request: AtlassianHttpBodyRequest,
  state: RemoteState,
): AtlassianHttpBodyResult | undefined {
  const body = JSON.parse(request.bodyJson ?? "{}") as Record<string, unknown>;
  if (path === "component" || path === "component/71") {
    state.component = { ...state.component, ...body };
    return response(state.component, request.method === "POST" ? 201 : 200);
  }
  if (path === "version" || path === "version/81") {
    state.version = { ...state.version, ...body };
    return response(state.version, request.method === "POST" ? 201 : 200);
  }
  return undefined;
}
function projectRead(path: string, state: RemoteState): AtlassianHttpBodyResult | undefined {
  if (path === "project") return response([state.project]);
  if (path === "project/SYN" || path === "project/10000") return response(state.project);
  if (path === "projectvalidate/key") return response({ errors: {}, errorMessages: [] });
  if (path === "mypermissions")
    return response({ permissions: { ADMINISTER: { havePermission: true } } });
  if (path === "project/type/software/accessible")
    return response({ key: "software", formattedKey: "Software" });
  return undefined;
}
function filterRead(path: string): AtlassianHttpBodyResult | undefined {
  const filter = {
    id: "37",
    name: "Scoped",
    jql: "project=SYN",
    owner: { name: "synthetic-user" },
    sharePermissions: [],
  };
  if (path === "filter/37") return response(filter);
  if (path === "filter/favourite") return response([filter]);
  return undefined;
}
function savedViewRead(path: string): AtlassianHttpBodyResult | undefined {
  const dashboard = { id: "71", name: "Delivery" };
  const permission = { id: 81, type: "group", group: { name: "delivery" }, view: true };
  const bodies: Readonly<Record<string, unknown>> = {
    dashboard: { startAt: 0, maxResults: 25, total: 1, dashboards: [dashboard] },
    "dashboard/71": dashboard,
    "filter/defaultShareScope": { scope: "PRIVATE" },
    "filter/37/permission": [permission],
    "filter/37/permission/81": permission,
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function assetRead(path: string, state: RemoteState): AtlassianHttpBodyResult | undefined {
  if (path === "attachment/71" && state.attachmentDeleted) return response({}, 404);
  const avatars = { system: [{ id: "91", selected: true }], custom: [] };
  const bodies: Readonly<Record<string, unknown>> = {
    "attachment/71": { id: "71", filename: "note.txt", size: 14, mimeType: "text/plain" },
    "attachment/71/expand/raw": {
      totalEntryCount: 1,
      entries: [{ entryIndex: 0, name: "note.txt", size: 14, mediaType: "text/plain" }],
    },
    "attachment/71/expand/human": {
      id: 71,
      name: "notes.zip",
      mediaType: "application/zip",
      totalEntryCount: 1,
    },
    "avatar/user/system": avatars,
    "project/SYN/avatars": avatars,
    "user/avatars": avatars,
    "universal_avatar/type/project/owner/10000": avatars,
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function assetWrite(
  path: string,
  request: AtlassianHttpBodyRequest,
  state: RemoteState,
): AtlassianHttpBodyResult | undefined {
  if (path !== "attachment/71" || request.method !== "DELETE") return undefined;
  state.attachmentDeleted = true;
  state.fields.attachment = [];
  return response(undefined, 204);
}
function administrationRead(
  path: string,
  absoluteUrl: string,
): AtlassianHttpBodyResult | undefined {
  const directory =
    directoryRead(path) ??
    accessRead(path) ??
    coreMetadataRead(path) ??
    instanceRead(path) ??
    roleRead(path) ??
    configurationRead(path, absoluteUrl) ??
    viewConfigurationRead(path);
  if (directory !== undefined) return directory;
  const type = { id: "1", name: "Task", subtask: false };
  const scheme = { id: "37", name: "Delivery", issueTypes: [type], defaultIssueType: type };
  const workflowScheme = {
    id: 37,
    name: "Delivery",
    draft: false,
    defaultWorkflow: "Default",
    issueTypeMappings: { "1": "In Progress + QA" },
  };
  const workflow = { workflow: "In Progress + QA", issueTypes: ["1"], defaultMapping: false };
  const bodies: Readonly<Record<string, unknown>> = {
    issuetypescheme: { schemes: [scheme] },
    "issuetypescheme/37": scheme,
    "issuetypescheme/37/associations": [
      { id: "10000", key: "SYN", name: "Delivery", archived: false },
    ],
    "workflowscheme/37": workflowScheme,
    "workflowscheme/37/draft": { ...workflowScheme, id: 38, draft: true },
    "workflowscheme/37/default": { workflow: "Default" },
    "workflowscheme/37/draft/default": { workflow: "Default Draft" },
    "workflowscheme/37/issuetype/1": { issueType: "1", workflow: "In Progress + QA" },
    "workflowscheme/37/draft/issuetype/1": { issueType: "1", workflow: "In Progress + QA" },
    "workflowscheme/37/workflow": [workflow],
    "workflowscheme/37/draft/workflow": new URL(absoluteUrl).searchParams.has("workflowName")
      ? workflow
      : [workflow],
    "screens/71/tabs": [{ id: 81, name: "Details" }],
    "screens/71/tabs/81/fields": [{ id: "summary", name: "Summary", showWhenEmpty: false }],
    "screens/71/availableFields": [{ id: "description", name: "Description" }],
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function configurationRead(path: string, absoluteUrl: string): AtlassianHttpBodyResult | undefined {
  const workflow = {
    name: "Review & QA",
    description: "Native workflow",
    steps: 0,
    isDefault: false,
    lastModifiedDate: "07/Nov/26",
  };
  const terminology = {
    originalName: "Epic",
    originalNamePlural: "Epics",
    newName: "Initiative",
    newNamePlural: "Initiatives",
    isDefault: false,
  };
  const bodies: Readonly<Record<string, unknown>> = {
    screens: {
      screens: [{ id: 71, name: "Details & QA", deletable: false }],
      startAt: 0,
      maxResults: 1,
      total: 1,
    },
    workflow: new URL(absoluteUrl).searchParams.has("workflowName") ? workflow : [workflow],
    customFields: {
      values: [
        {
          id: "customfield_10001",
          numericId: 10001,
          name: "Delivery",
          isLocked: false,
          projectIds: [],
          issuesWithValue: 0,
        },
      ],
      startAt: 0,
      maxResults: 1,
      total: 1,
    },
    "customFields/10001/options": {
      options: [{ id: 91, value: "", disabled: false, childrenIds: [] }],
      total: 3,
    },
    "terminology/entries": [terminology, { originalName: "Sprint", isDefault: true }],
    "terminology/entries/epic": terminology,
    "readonly-mode": {
      enabled: false,
      message: "",
      endTime: "07/Nov/26 21:30",
      timeZone: "Europe/Berlin",
    },
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function viewConfigurationRead(path: string): AtlassianHttpBodyResult | undefined {
  const columns = [
    { value: "summary", label: "Summary" },
    { value: "status", label: "Status" },
  ];
  const bodies: Readonly<Record<string, unknown>> = {
    version: {
      startAt: 0,
      maxResults: 1,
      isLast: false,
      values: [{ id: "81", name: "Next release", projectId: 10000, released: false }],
    },
    "component/page": {
      startAt: 0,
      maxResults: 1,
      isLast: false,
      values: [
        { id: "71", name: "Delivery module", project: "SYN", projectId: 10000, deleted: false },
      ],
    },
    "issueLinkType/31": { id: "31", name: "Blocks", inward: "is blocked by", outward: "blocks" },
    "user/a11y/personal-settings": [
      { key: "underline-links", enabled: false },
      { key: "keyboard-settings" },
    ],
    "settings/columns": columns,
    "user/columns": columns,
    "filter/42/columns": {
      columnConfig: "EXPLICIT",
      columnLayoutItems: [
        { id: "summary", position: -1, columnHeadingKey: "native.summary" },
        { id: "summary", position: 1 },
      ],
    },
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function directoryRead(path: string): AtlassianHttpBodyResult | undefined {
  const user = {
    key: "JIRAUSER10100",
    name: "Synthetic-User",
    displayName: "Synthetic User",
    active: false,
    deleted: false,
    emailAddress: "private@example.invalid",
    self: "https://untrusted.invalid/user",
  };
  const role = {
    key: "jira-software",
    name: "Jira Software",
    groups: ["R&D team"],
    defaultGroups: [],
    hasUnlimitedSeats: true,
    numberOfSeats: -1,
    remainingSeats: -7,
    userCount: 12,
  };
  const bodies: Readonly<Record<string, unknown>> = {
    user,
    "user/search": [user],
    "user/list": {
      values: [user],
      maxResults: 2,
      isLast: false,
      nextCursor: "9223372036854775807",
    },
    "user/picker": { users: [user], total: 3, header: "Untrusted header", html: "<b>ignored</b>" },
    "group/member": { values: [user], startAt: 0, maxResults: 2, total: 1, isLast: true },
    "groups/picker": { groups: [{ name: "R&D team", html: "<b>ignored</b>" }], total: 2 },
    applicationrole: [role],
    "applicationrole/jira-software": role,
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : scopedDirectoryRead(path, user);
}
function scopedDirectoryRead(
  path: string,
  user: Readonly<Record<string, unknown>>,
): AtlassianHttpBodyResult | undefined {
  const bodies: Readonly<Record<string, unknown>> = {
    "user/assignable/multiProjectSearch": [user],
    "user/permission/search": [user],
    "user/viewissue/search": [user],
    groupuserpicker: { users: { users: [user], total: 3 }, groups: { groups: [], total: 0 } },
    "projects/picker": { projects: [{ id: "10000", key: "SYN", name: "Synthetic" }], total: 2 },
    field: [
      {
        id: "customfield_10001",
        name: "Delivery",
        custom: true,
        searchable: false,
        clauseNames: ["cf[10001]", "Delivery"],
        schema: { type: "array", items: "string", custom: "synthetic:metadata", customId: 10001 },
      },
    ],
    "customFieldOption/91": { id: 91, value: "", disabled: false, childrenIds: [] },
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function roleRead(path: string): AtlassianHttpBodyResult | undefined {
  const actor = {
    id: 71,
    name: "review-team",
    displayName: "Review team",
    type: "atlassian-group-role-actor",
  };
  const role = { id: 37, name: "Reviewers", description: "Configured reviewers", actors: [actor] };
  const scheme = {
    id: 49,
    name: "Priorities",
    defaultScheme: false,
    defaultOptionId: "3",
    optionIds: ["1", "3"],
  };
  const bodies: Readonly<Record<string, unknown>> = {
    role: [role],
    "role/37": role,
    "role/37/actors": { actors: [actor] },
    "project/10000/role": { Reviewers: "https://untrusted.invalid/project/10000/role/37" },
    "project/10000/role/37": role,
    priorityschemes: { schemes: [scheme], startAt: 0, maxResults: 1, total: 2 },
    "priorityschemes/49": scheme,
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function instanceRead(path: string): AtlassianHttpBodyResult | undefined {
  const bodies: Readonly<Record<string, unknown>> = {
    "cluster/nodes": [
      {
        nodeId: "node-A",
        state: "PASSIVE",
        alive: false,
        nodeBuildNumber: 0,
        lastStateChangeTimestamp: 0,
        ip: "192.0.2.10",
        cacheListenerPort: 40001,
      },
    ],
    "cluster/zdu/state": {
      state: "READY_TO_UPGRADE",
      build: { buildNumber: 0, version: "11.3.0" },
    },
    "index-snapshot/isRunning": { running: false },
    "index/summary": {
      nodeId: "node-A",
      reportTime: "2026-11-07T22:00:00+01:00",
      issueIndex: { indexReadable: false, countInIndex: 0 },
      replicationQueues: {},
      externalPlatformIndexReplay: {
        "node-B": {
          queueSize: 0,
          lastConsumedOperation: { id: -1, journalWriteTime: "Journal at 21:00" },
        },
      },
    },
    "monitoring/jmx/areMetricsExposed": false,
    "searchLimits/maxAggregationBuckets": 0,
    "searchLimits/maxResultWindow": -1,
    serverInfo: {
      version: "11.3.13",
      versionNumbers: [11, 3, 13],
      deploymentType: "Data Center",
      serverTitle: "Synthetic Jira",
      buildNumber: 11030013,
      databaseBuildNumber: "9007199254740993",
    },
    configuration: {
      attachmentsEnabled: true,
      watchingEnabled: false,
      votingEnabled: true,
      timeTrackingConfiguration: {
        workingHoursPerDay: 0,
        workingDaysPerWeek: 4.5,
        defaultUnit: "hour",
      },
    },
    permissions: {
      permissions: {
        EDIT_ISSUE: {
          id: "12",
          key: "EDIT_ISSUES",
          name: "Edit issues",
          type: "PROJECT",
          havePermission: true,
        },
      },
    },
    myself: { key: "U1", name: "Synthetic", displayName: "Synthetic User", active: true },
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function jobObservationRead(path: string): AtlassianHttpBodyResult | undefined {
  const bodies: Readonly<Record<string, unknown>> = {
    reindex: { currentProgress: 0, success: false, type: "BACKGROUND" },
    "reindex/progress": { currentProgress: -1, currentSubTask: "Native step", success: false },
    "reindex/request/7": { id: 7, status: "COMPLETE", type: "BACKGROUND" },
    "reindex/request/bulk": [{ id: 7, status: "PENDING" }],
    upgrade: { outcome: "FAILED", duration: 0, message: "Synthetic upgrade result" },
    "index-snapshot": [{ absolutePath: "/server/snapshots/synthetic.zip", timestamp: 0 }],
    "monitoring/app": { enabled: false },
    "monitoring/ipd": {},
    "monitoring/jmx/getAvailableMetrics": "metric.one\nmetric.two",
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function ancillaryNativeRead(path: string): AtlassianHttpBodyResult | undefined {
  const remoteLink = {
    name: "External reference",
    link: JSON.stringify({ "a/b~c": [false, 0, null, ""] }),
  };
  const bodies: Readonly<Record<string, unknown>> = {
    "version/remotelink": { links: [remoteLink] },
    "version/81/remotelink": { links: [remoteLink] },
    "version/81/remotelink/sample~state": remoteLink,
    "worklog/deleted": {
      since: 0,
      until: 10,
      lastPage: false,
      values: [{ worklogId: 71, updatedTime: 10 }],
      nextPage: "https://jira.example.invalid/context/rest/api/2/worklog/deleted?since=10",
    },
    "worklog/updated": {
      since: 0,
      until: 10,
      lastPage: true,
      values: [{ worklogId: 72, updatedTime: 10 }],
    },
    "permissionscheme/37/attribute/review%20~state": { key: "review ~state", value: "" },
    "email-templates/types": {
      userEmailAddress: "discarded@example.invalid",
      emailTypes: [
        {
          id: 1,
          eventName: "Issue created",
          templateName: "issuecreated.vm",
          active: false,
          batchedNotification: false,
          html: true,
          text: false,
        },
      ],
    },
    "application-properties": { key: "jira.option.voting", value: "false", example: "discarded" },
    "application-properties/advanced-settings": [{ key: "jira.clone.prefix", value: "" }],
    mypreferences: "0",
    "password/policy": ["Use at least eight characters."],
    "user/duplicated/count": { count: 0 },
    "user/duplicated/list": {
      sample: [
        { directoryId: "9223372036854775807", directoryName: "Local directory", userActive: false },
      ],
    },
    "search/error/lookup": { errorStringI18n: "The query could not be evaluated." },
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function entityPropertyRead(path: string): AtlassianHttpBodyResult | undefined {
  const roots = new Set([
    "comment/10002/properties",
    "dashboard/71/items/81/properties",
    "issue/10001/properties",
    "issuetype/10001/properties",
    "project/10000/properties",
    "user/properties",
  ]);
  if (roots.has(path))
    return response({
      keys: [
        { key: "view ~settings", self: "https://untrusted.invalid/property" },
        { key: "a/b%" },
      ],
    });
  const selected = "/view%20~settings";
  return path.endsWith(selected) && roots.has(path.slice(0, -selected.length))
    ? response({ key: "view ~settings", value: { "a/b~c": [null, {}, [], false, 0, ""] } })
    : undefined;
}
function coreMetadataRead(path: string): AtlassianHttpBodyResult | undefined {
  const type = {
    id: "10001",
    name: "Story",
    description: "Story metadata",
    subtask: false,
    avatarId: 71,
  };
  const priority = { id: "3", name: "Normal", statusColor: "#123456" };
  const resolution = { id: "41", name: "Fixed", description: "Resolution metadata" };
  const category = { id: 4, key: "indeterminate", name: "In progress", colorName: "yellow" };
  const status = { id: "5", name: "In Progress + QA", statusCategory: category };
  const projectCategory = { id: "51", name: "Engineering" };
  const projectType = {
    key: "software",
    formattedKey: "Software",
    descriptionI18nKey: "project.type.software.description",
  };
  const page = (item: unknown): Record<string, unknown> => ({
    values: [item],
    startAt: 0,
    maxResults: 1,
    isLast: false,
  });
  const bodies: Readonly<Record<string, unknown>> = {
    issuetype: [type],
    "issuetype/10001": type,
    "issuetype/page": page(type),
    "jql/autocompletedata": {
      visibleFieldNames: [
        {
          value: "assignee",
          auto: "true",
          orderable: "false",
          operators: ["=", "was in"],
          types: ["User"],
          displayName: "<b>Assignee</b>",
        },
      ],
      visibleFunctionNames: [{ value: "currentUser()", types: ["User"] }],
      jqlReservedWords: ["empty"],
    },
    "jql/autocompletedata/suggestions": {
      results: [{ value: "Atlassian Connect", displayName: "<b>AC</b> Connect" }],
    },
    "issuetype/10001/alternatives": [{ id: "10002", name: "Task", subtask: false }],
    priority: [priority],
    "priority/3": priority,
    "priority/page": page(priority),
    resolution: [resolution],
    "resolution/41": resolution,
    "resolution/page": page(resolution),
    status: [status],
    "status/In%20Progress%20%2B%20QA": status,
    "status/page": page(status),
    statuscategory: [category],
    "statuscategory/indeterminate": category,
    projectCategory: [projectCategory],
    "projectCategory/51": projectCategory,
    "project/10000/statuses": [{ id: "10001", name: "Story", subtask: false, statuses: [status] }],
    "project/type": [projectType],
    "project/type/software": projectType,
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function accessRead(path: string): AtlassianHttpBodyResult | undefined {
  const grant = {
    id: 81,
    permission: "BROWSE_PROJECTS",
    holder: { type: "group", parameter: "Developers" },
  };
  const permissionScheme = { id: 37, name: "Engineering access", permissions: [grant] };
  const level = { id: 91, name: "Restricted", description: "Configured level" };
  const securityScheme = {
    id: 38,
    name: "Engineering security",
    defaultSecurityLevelId: 91,
    levels: [level],
  };
  const notificationScheme = {
    id: 47,
    name: "Notifications",
    notificationSchemeEvents: [
      {
        event: { id: 1, name: "Issue updated", templateEvent: { id: 2, name: "Template" } },
        notifications: [{ id: 61, notificationType: "CurrentAssignee" }],
      },
    ],
  };
  const bodies: Readonly<Record<string, unknown>> = {
    permissionscheme: { permissionSchemes: [permissionScheme] },
    "permissionscheme/37": permissionScheme,
    "permissionscheme/37/permission": { permissions: [grant] },
    "permissionscheme/37/permission/81": grant,
    issuesecurityschemes: { issueSecuritySchemes: [securityScheme] },
    "issuesecurityschemes/38": securityScheme,
    "securitylevel/91": level,
    notificationscheme: {
      startAt: 0,
      maxResults: 1,
      total: 2,
      isLast: false,
      values: [notificationScheme],
    },
    "notificationscheme/47": notificationScheme,
    "project/10000/notificationscheme": notificationScheme,
    "project/10000/permissionscheme": permissionScheme,
    "project/10000/issuesecuritylevelscheme": securityScheme,
    "project/10000/securitylevel": { levels: [level] },
    "project/10000/workflowscheme": {
      id: 48,
      name: "Project workflow",
      draft: false,
      defaultWorkflow: "Default workflow",
      issueTypeMappings: { "10001": "Story workflow", "10002": "Task workflow" },
      originalIssueTypeMappings: { "10001": "Original story workflow" },
    },
    "project/10000/priorityscheme": {
      id: 49,
      name: "Project priorities",
      defaultScheme: false,
      defaultOptionId: "3",
      optionIds: ["1", "3"],
    },
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function issueMetadata(path: string, state: RemoteState): AtlassianHttpBodyResult | undefined {
  // The resolved numeric identity reads the same existing issue fixture, including current members.
  if (path === "issue/10001") return fixtureRead("/issue/SYN-1", state);
  if (path.endsWith("/issuetypes"))
    return response({
      values: [{ id: "10001", name: "Story", subtask: false }],
      start: 0,
      size: 1,
      last: true,
      total: 1,
    });
  if (path.includes("createmeta"))
    return response({
      values: [...FIELDS, LINKS_FIELD],
      start: 0,
      size: 100,
      last: true,
      total: FIELDS.length + 1,
    });
  if (path.endsWith("/transitions"))
    return response({
      transitions: [
        {
          id: "31",
          name: "Done",
          to: { id: "3", name: "Done" },
          fields: { customfield_10000: REQUIRED_CUSTOM },
        },
      ],
    });
  if (path === "user/assignable/search")
    return response([{ name: "synthetic-user", displayName: "Synthetic", active: true }]);
  if (path === "issue/SYN-1/comment")
    return response({ comments: [], startAt: 0, maxResults: 25, total: 0 });
  return undefined;
}
function issueContextRead(path: string, absoluteUrl: string): AtlassianHttpBodyResult | undefined {
  const link = {
    id: 71,
    globalId: "app=synthetic&id=1",
    application: { type: "synthetic", name: "Reference app" },
    relationship: "references",
    self: "https://jira.example.invalid/context/rest/api/2/issue/10001/remotelink/71",
    object: {
      title: "Remote reference",
      summary: "Plain remote description",
      url: "https://untrusted.invalid/target",
      status: { resolved: false },
    },
  };
  if (path === "issue/10001/remotelink")
    return response(new URL(absoluteUrl).searchParams.has("globalId") ? link : [link]);
  const bodies: Readonly<Record<string, unknown>> = {
    "issue/picker": {
      sections: [
        {
          id: "history",
          label: "Recent issues",
          issues: [
            { key: "SYN-2", summaryText: "Plain suggestion", summary: "<b>Discarded HTML</b>" },
          ],
        },
      ],
    },
    "issue/10001/pinned-comments": [
      {
        comment: {
          id: "10002",
          body: "Pinned native text",
          created: "2026-11-07T09:00:00.000+0000",
          author: { name: "synthetic-user", displayName: "Synthetic author" },
          self: "https://jira.example.invalid/context/rest/api/2/issue/10001/comment/10002",
        },
        pinnedBy: "synthetic-user",
        pinnedDate: "2026-11-07T10:00:00.000+0000",
      },
    ],
    "issue/10001/subtask": [
      {
        id: "10002",
        key: "SYN-2",
        fields: {
          summary: "Observed subtask",
          status: { name: "Open" },
          parent: { id: "10001", key: "SYN-1" },
        },
      },
    ],
    "issue/10001/subtask/move": false,
    "issue/10001/remotelink/71": link,
  };
  return Object.hasOwn(bodies, path) ? response(bodies[path]) : undefined;
}
function projectWrite(
  request: AtlassianHttpBodyRequest,
  state: RemoteState,
): AtlassianHttpBodyResult {
  const body = JSON.parse(request.bodyJson ?? "{}") as Record<string, unknown>;
  state.project = {
    ...state.project,
    ...body,
    ...(typeof body.lead === "string" ? { lead: { name: body.lead } } : {}),
  };
  return request.method === "POST"
    ? response({ id: 10000, key: "SYN" }, 201)
    : response(state.project);
}
function firstDefined<T>(observations: readonly (() => T | undefined)[]): T | undefined {
  for (const observe of observations) {
    const result = observe();
    if (result !== undefined) return result;
  }
  return undefined;
}
function remoteRead(
  path: string,
  absolute: string,
  state: RemoteState,
  absoluteUrl: string,
): AtlassianHttpBodyResult {
  return (
    firstDefined<AtlassianHttpBodyResult>([
      (): AtlassianHttpBodyResult | undefined => monitoringRead(path, state),
      (): AtlassianHttpBodyResult | undefined => screenTabRead(path, state),
      (): AtlassianHttpBodyResult | undefined => projectRead(path, state),
      (): AtlassianHttpBodyResult | undefined => structureRead(path, state),
      (): AtlassianHttpBodyResult | undefined => collaborationRead(path, state),
      (): AtlassianHttpBodyResult | undefined => participationRead(path, state),
      (): AtlassianHttpBodyResult | undefined => filterRead(path),
      (): AtlassianHttpBodyResult | undefined => savedViewRead(path),
      (): AtlassianHttpBodyResult | undefined => assetRead(path, state),
      (): AtlassianHttpBodyResult | undefined => administrationRead(path, absoluteUrl),
      (): AtlassianHttpBodyResult | undefined => jobObservationRead(path),
      (): AtlassianHttpBodyResult | undefined => ancillaryNativeRead(path),
      (): AtlassianHttpBodyResult | undefined => entityPropertyRead(path),
      (): AtlassianHttpBodyResult | undefined => issueContextRead(path, absoluteUrl),
      (): AtlassianHttpBodyResult | undefined => issueMetadata(path, state),
    ]) ?? fixtureRead(absolute, state)
  );
}
const PROPERTY_WRITE_ROOTS: Readonly<Record<string, string>> = {
  "jira.set-comment-property": "comment/10002/properties",
  "jira.delete-comment-property": "comment/10002/properties",
  "jira.set-dashboard-item-property": "dashboard/71/items/81/properties",
  "jira.delete-dashboard-item-property": "dashboard/71/items/81/properties",
  "jira.set-issue-property": "issue/10001/properties",
  "jira.delete-issue-property": "issue/10001/properties",
  "jira.set-issue-type-property": "issuetype/10001/properties",
  "jira.delete-issue-type-property": "issuetype/10001/properties",
  "jira.set-project-property": "project/10000/properties",
  "jira.delete-project-property": "project/10000/properties",
  "jira.set-user-property": "user/properties",
  "jira.delete-user-property": "user/properties",
};
function initialRemoteState(tool: string | undefined): RemoteState {
  return {
    monitoring: MONITORING_WRITES.has(tool ?? "")
      ? { app: false, ipd: true, jmx: tool === "jira.stop-jmx-metrics" }
      : undefined,
    screenTabs: SCREEN_TAB_WRITES.has(tool ?? "")
      ? [
          { id: 81, name: "Details" },
          { id: 82, name: "Other" },
        ]
      : undefined,
    fields: {
      summary: "Before",
      assignee: { name: "previous-user" },
      status: { id: "1" },
      labels: [],
      issuelinks: [],
      attachment:
        tool === "jira.delete-attachment" ? [{ id: "71", filename: "note.txt", size: 14 }] : [],
    },
    comment: tool === "jira.delete-comment" ? "Reviewed comment" : "",
    commentDeleted: false,
    worklogDeleted: false,
    attachmentDeleted: false,
    worklog: {
      id: "101",
      issueId: "10001",
      timeSpentSeconds: 3600,
      started: "2026-11-07T09:00:00.000+0000",
      comment: "Original",
    },
    isWatching: tool === "jira.unwatch",
    hasVoted: tool === "jira.unvote",
    component: { id: "71", project: "SYN", name: "Before" },
    version: { id: "81", projectId: 10000, name: "Before" },
    project: {
      id: "10000",
      key: "SYN",
      name: "Before",
      lead: { name: "synthetic-user" },
      projectTypeKey: "software",
    },
  };
}
function remoteWrite(
  path: string,
  absolute: string,
  request: AtlassianHttpBodyRequest,
  state: RemoteState,
): AtlassianHttpBodyResult {
  if (path === "project" || path === "project/10000") return projectWrite(request, state);
  return (
    firstDefined<AtlassianHttpBodyResult>([
      (): AtlassianHttpBodyResult | undefined => monitoringWrite(path, request, state),
      (): AtlassianHttpBodyResult | undefined => screenTabWrite(path, request, state),
      (): AtlassianHttpBodyResult | undefined => participationWrite(path, request.method, state),
      (): AtlassianHttpBodyResult | undefined => assetWrite(path, request, state),
      (): AtlassianHttpBodyResult | undefined => worklogWrite(path, request, state),
      (): AtlassianHttpBodyResult | undefined => collaborationWrite(path, request, state),
      (): AtlassianHttpBodyResult | undefined => structureWrite(path, request, state),
    ]) ?? fixtureWrite(absolute, request.bodyJson, state, request.upload)
  );
}
function remote(
  tool?: string,
  initiallyPresent = true,
): ReturnType<typeof vi.fn<AtlassianHttpBodyPort>> {
  const lifecycle = lifecycleRemote(tool);
  if (lifecycle !== undefined) return lifecycle;
  if (POST_AND_IDENTITY_READ_TOOLS.has(tool ?? "")) return vi.fn(postAndIdentityReadTransport);
  if (tool !== undefined && Object.hasOwn(SAVED_CONFIGURATION_ARGUMENTS, tool))
    return savedConfigurationRemote(tool);
  const propertyRoot = PROPERTY_WRITE_ROOTS[tool ?? ""];
  const property = propertyTransportFixture(
    propertyRoot === undefined ? undefined : `/context/rest/api/2/${propertyRoot}`,
    initiallyPresent,
  );
  const state = initialRemoteState(tool);
  return vi.fn<AtlassianHttpBodyPort>((request) => {
    const absolute = new URL(request.url).pathname;
    const path = absolute.replace("/context/rest/api/2/", "");
    if (request.method === "GET")
      return Promise.resolve(
        property.read(request) ?? remoteRead(path, absolute, state, request.url),
      );
    return Promise.resolve(property.write(request) ?? remoteWrite(path, absolute, request, state));
  });
}
type LifecycleFixture = NonNullable<ReturnType<typeof schemeSettingTransportController>>;
function reviewedPlatformFixture(tool: string | undefined): LifecycleFixture | undefined {
  const selectedVersion = VERSION_LINK_CASES.find((item) => item.tool === tool);
  if (selectedVersion !== undefined)
    return versionLinkTransportFixture("/context/rest/api/2", selectedVersion);
  const selectedCategory = PROJECT_CATEGORY_CASES.find((item) => item.name === tool);
  return selectedCategory === undefined
    ? undefined
    : projectCategoryTransportFixture("/context/rest/api/2", selectedCategory);
}
function lifecycleRemote(
  tool: string | undefined,
): ReturnType<typeof vi.fn<AtlassianHttpBodyPort>> | undefined {
  const projectIssue = projectIssueTransportController(
    tool,
    "synthetic-key",
    "https://jira.example.invalid/context",
  );
  if (projectIssue !== undefined)
    return vi.fn(async (request) => {
      const result = await (request.method === "GET"
        ? projectIssue.read(request)
        : projectIssue.write(request));
      if (result === undefined)
        throw new TypeError("Unexpected independent project/issue native route");
      return result;
    });
  const selectedScreen = SCREEN_CONFIGURATION_CASES.find((item) => item.tool === tool);
  const selectedLink = LINK_MUTATION_FIXTURE_CASES.find((item) => item.tool === tool);
  const release = RELEASE_LIFECYCLE_FIXTURE_CASES.some((item) => item.tool === tool);
  const related =
    selectedLink === undefined
      ? release
        ? releaseLifecycleTransportFixture("/context/rest/api/2")
        : undefined
      : linkMutationTransportFixture("/context/rest/api/2", selectedLink);
  const fixture = firstDefined<LifecycleFixture>([
    (): LifecycleFixture | undefined => systemAdministrationTransportController(tool),
    (): LifecycleFixture | undefined => schemeSettingTransportController(tool),
    (): LifecycleFixture | undefined => emailTemplateTransportController(tool),
    (): LifecycleFixture | undefined => permissionRoleTransportController(tool),
    (): LifecycleFixture | undefined => reviewedPlatformFixture(tool),
    (): LifecycleFixture | undefined =>
      selectedScreen === undefined
        ? related
        : screenConfigurationTransportFixture("/context/rest/api/2", selectedScreen),
  ]);
  if (fixture === undefined) return undefined;
  return vi.fn<AtlassianHttpBodyPort>(async (request) => {
    const url = new URL(request.url);
    expect(url.origin).toBe("https://jira.example.invalid");
    expect(url.pathname.startsWith("/context/rest/api/2/")).toBe(true);
    const result = await (request.method === "GET"
      ? fixture.read(request)
      : fixture.write(request));
    if (result === undefined)
      throw new TypeError(`Unexpected lifecycle native route: ${url.pathname}${url.search}`);
    return result;
  });
}
function savedConfigurationRemote(tool: string): ReturnType<typeof vi.fn<AtlassianHttpBodyPort>> {
  const state = savedConfigurationRemoteState();
  prepareSavedConfiguration(state, tool);
  return vi.fn<AtlassianHttpBodyPort>(async (request) => {
    const url = new URL(request.url);
    expect(url.origin).toBe("https://jira.example.invalid");
    expect(url.pathname.startsWith("/context/rest/api/2/")).toBe(true);
    if (request.method === "GET") {
      if (url.pathname === "/context/rest/api/2/myself")
        return response({ key: "synthetic-key", name: "synthetic-user" });
      const read = nativeSavedConfigurationRead(url.pathname, state);
      if (read === undefined)
        throw new TypeError("Unexpected saved configuration prerequisite/readback");
      return read;
    }
    const write = await nativeSavedConfigurationWrite(
      new Request(request.url, {
        method: request.method,
        ...(request.bodyJson === undefined ? {} : { body: request.bodyJson }),
        headers: { "content-type": "application/json" },
      }),
      state,
    );
    if (write === undefined) throw new TypeError("Unexpected saved configuration mutation route");
    return write;
  });
}
function connection(http: AtlassianHttpBodyPort): JiraManagedConnection {
  const bytes = new TextEncoder().encode("Governed attachment fixture");
  return {
    deployment: "data-center",
    baseUrl: "https://jira.example.invalid/context",
    http,
    emailTemplates: emailTemplateFixtureAdmission(),
    attachmentSource: () =>
      Promise.resolve({
        ok: true,
        content: {
          name: "note.txt",
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      }),
  };
}
async function observe(scenario: Scenario): Promise<Observation> {
  const native = privateNativeTransportController(scenario.tool);
  if (native !== undefined) {
    const composition = privateNativeComposition(
      scenario.tool,
      "https://jira.example.invalid/context",
      async (input, init) => native.handle(new Request(input, init)),
    );
    if (composition === undefined) throw new TypeError("Missing real private corpus composition");
    const privateRequests: AtlassianHttpBodyRequest[] = [];
    try {
      const context = {
        invocationId: "transport-contract",
        correlationId: "transport-contract",
        signal: new AbortController().signal,
        beforeEffect: (): boolean => true,
      };
      const privatePorts = await composition.ports(context, scenario.args, {
        beforeDispatch: (request) => {
          if ("maxBodyBytes" in request) privateRequests.push(request);
          return true;
        },
      });
      return await observeNativeJiraOperation(
        scenario,
        { ...connection(composition.http()), ...privatePorts },
        privateRequests,
      );
    } finally {
      composition.close();
    }
  }
  return observeNativeJiraOperation(scenario, connection(remote(scenario.tool)));
}

describe("native Jira registry and real connector transport agreement", () => {
  it("covers every current platform and authentication native operation exactly once", () => {
    const platformRoots = new Set(["/rest/api/2", "/rest/auth/1"]);
    const native = jiraOperationContracts().filter(
      ({ definition }) => definition.kind === "native" && platformRoots.has(definition.apiRoot),
    );
    expect(native).toHaveLength(393);
    expect(SCENARIOS).toHaveLength(native.length);
    expect(new Set(SCENARIOS.map(({ tool }) => tool))).toEqual(
      new Set(native.map(({ definition }) => definition.tool)),
    );
    for (const scenario of SCENARIOS)
      expect(independentPrimary(scenario), scenario.tool).toBeDefined();
  });
  it.each(SCENARIOS)("binds $tool to its actual primary HTTP request", async (scenario) => {
    const observed = await observe(scenario);
    assertPrimary(observed, scenario);
    const writes = observed.requests.filter((request) => request.method !== "GET");
    expect(writes).toHaveLength(observed.definition.method === "GET" ? 0 : 1);
    if (scenario.expectedReceipt !== undefined)
      expect(observed.result.data).toMatchObject(scenario.expectedReceipt);
  });
  it("uses fixed binary ZIP reads and a single raw upload without leaking archive bytes into results", async () => {
    const read = SCENARIOS.find(({ tool }) => tool === "jira.email-template-pack");
    const upload = SCENARIOS.find(({ tool }) => tool === "jira.upload-email-template-pack");
    if (read === undefined || upload === undefined)
      throw new TypeError("Missing email native scenarios");
    const observedRead = await observe(read);
    expect(observedRead.requests).toHaveLength(1);
    expect(observedRead.requests[0]).toMatchObject({
      method: "GET",
      jiraEmailTemplateArchive: true,
    });
    expect(observedRead.result.data).toMatchObject({ outcome: "succeeded", entryCount: 2 });
    expect(observedRead.result.data).not.toHaveProperty("bytes");
    expect(JSON.stringify(observedRead.result.data)).not.toContain("$issue.summary");
    const observedUpload = await observe(upload);
    const writes = observedUpload.requests.filter(({ method }) => method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: "POST",
      jiraEmailTemplateArchive: true,
      upload: { contentType: "application/zip" },
    });
    expect(writes[0]?.bodyJson).toBeUndefined();
    expect(observedUpload.result.data).toMatchObject({
      outcome: "succeeded-unconfirmed",
      emailTemplateAction: "upload",
    });
  });
  it("uses only the closed attribute port for literal false and independently rereads the same scheme", async () => {
    const scenario = SCENARIOS.find(({ tool }) => tool === "jira.set-permission-scheme-attribute");
    if (scenario === undefined) throw new TypeError("Missing permission attribute fixture");
    const observed = await observe(scenario);
    const effects = observed.requests.filter(({ method }) => method !== "GET");
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      method: "PUT",
      jiraPermissionAttribute: true,
      url: "https://jira.example.invalid/context/rest/api/2/permissionscheme/7/attribute/ADMINISTER_PROJECTS.extended.enabled",
      bodyJson: "false",
    });
    expect(effects[0]).not.toHaveProperty("upload");
    expect(observed.result.data).toMatchObject({
      outcome: "succeeded",
      schemeId: "7",
      attributeEnabled: false,
    });
    expect(observed.requests.at(-1)).toMatchObject({
      method: "GET",
      url: "https://jira.example.invalid/context/rest/api/2/permissionscheme/7/attribute/ADMINISTER_PROJECTS.extended.enabled",
    });
    expect(
      observed.requests
        .filter(({ method }) => method === "GET")
        .every((request) => request.jiraPermissionAttribute === undefined),
    ).toBe(true);
  });
  it.each([
    ["jira.create-permission-scheme", "schemeId"],
    ["jira.create-role", "roleId"],
  ] as const)("retains the exact native creation ID for %s", async (tool, identity) => {
    const scenario = SCENARIOS.find((item) => item.tool === tool);
    if (scenario === undefined) throw new TypeError("Missing administration creation fixture");
    const observed = await observe(scenario);
    expect(observed.result.data).toMatchObject({
      outcome: "succeeded",
      [identity]: "9007199254740993",
    });
    expect(observed.requests.filter(({ method }) => method !== "GET")).toHaveLength(1);
  });
  it("keeps replacement actor namespaces and numeric role identity explicit in the native PUT", async () => {
    const scenario = SCENARIOS.find(({ tool }) => tool === "jira.set-project-role-actors");
    if (scenario === undefined) throw new TypeError("Missing project actor replacement fixture");
    const observed = await observe(scenario);
    expect(observed.requests.filter(({ method }) => method === "PUT")).toEqual([
      expect.objectContaining({
        url: "https://jira.example.invalid/context/rest/api/2/project/10000/role/7",
        bodyJson:
          '{"id":7,"categorisedActors":{"atlassian-user-role-actor":[],"atlassian-group-role-actor":["next-group"]}}',
      }),
    ]);
    expect(observed.result).toMatchObject({
      isError: true,
      data: {
        outcome: "succeeded-unconfirmed",
        actorChange: "replace",
        actorGroupNames: ["next-group"],
      },
    });
  });
  it("sends a version link's false JSON value without wrapping it and confirms the complete native set", async () => {
    const scenario = SCENARIOS.find(
      ({ tool }) => tool === "jira.upsert-version-remote-link-by-global-id",
    );
    if (scenario === undefined) throw new TypeError("Missing version-link scalar fixture");
    const observed = await observe(scenario);
    const effects = observed.requests.filter(({ method }) => method !== "GET");
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      method: "POST",
      url: "https://jira.example.invalid/context/rest/api/2/version/81/remotelink/release%3Alink",
      bodyJson: "false",
    });
    expect(observed.result).toMatchObject({
      data: { outcome: "succeeded", globalId: "release:link", linkPresent: true },
    });
    const completeReads = observed.requests.filter(
      ({ method, url }) => method === "GET" && url.endsWith("/version/81/remotelink"),
    );
    expect(completeReads).toHaveLength(2);
    expect(
      observed.requests.every(({ url }) => new URL(url).origin === "https://jira.example.invalid"),
    ).toBe(true);
  });
  it("keeps a newly acknowledged category ID exact through independent readback", async () => {
    const scenario = SCENARIOS.find(({ tool }) => tool === "jira.create-project-category");
    if (scenario === undefined) throw new TypeError("Missing category creation fixture");
    const observed = await observe(scenario);
    expect(observed.result.data).toMatchObject({
      outcome: "succeeded",
      categoryId: "9007199254740993",
      categoryPresent: true,
    });
    expect(observed.requests.at(-1)).toMatchObject({
      method: "GET",
      url: "https://jira.example.invalid/context/rest/api/2/projectCategory/9007199254740993",
    });
  });
  it("does not claim every category deletion effect from an empty visible collection", async () => {
    const scenario = SCENARIOS.find(({ tool }) => tool === "jira.delete-project-category");
    if (scenario === undefined) throw new TypeError("Missing category deletion fixture");
    const observed = await observe(scenario);
    expect(observed.result).toMatchObject({
      isError: true,
      data: {
        outcome: "succeeded-unconfirmed",
        categoryId: "7",
        categoryPresent: false,
      },
    });
    expect(observed.requests.filter(({ method }) => method === "DELETE")).toHaveLength(1);
    expect(observed.requests.at(-1)).toMatchObject({
      method: "GET",
      url: "https://jira.example.invalid/context/rest/api/2/projectCategory",
    });
  });
  it("retains default-screen addition as unconfirmed without a guessed screen or tab identity", async () => {
    const scenario = SCENARIOS.find(({ tool }) => tool === "jira.add-default-screen-field");
    if (scenario === undefined) throw new TypeError("Missing default screen fixture");
    const observed = await observe(scenario);
    expect(observed.result).toMatchObject({
      isError: true,
      data: {
        outcome: "succeeded-unconfirmed",
        fieldId: "customfield_10001",
        fieldPresent: true,
      },
    });
    expect(observed.result.data).not.toHaveProperty("screenId");
    expect(observed.result.data).not.toHaveProperty("tabId");
    expect(observed.requests.map(({ method, url }) => [method, url])).toEqual([
      ["GET", "https://jira.example.invalid/context/rest/api/2/field"],
      [
        "POST",
        "https://jira.example.invalid/context/rest/api/2/screens/addToDefault/customfield_10001",
      ],
    ]);
  });
  it("mints the version-move after URI only from the bound context and confirms the complete native order", async () => {
    const scenario = SCENARIOS.find(({ tool }) => tool === "jira.move-version");
    if (scenario === undefined) throw new TypeError("Missing version move fixture");
    const observed = await observe(scenario);
    const writes = observed.requests.filter(({ method }) => method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: "POST",
      url: "https://jira.example.invalid/context/rest/api/2/version/81/move",
      bodyJson: '{"after":"https://jira.example.invalid/context/rest/api/2/version/82"}',
    });
    expect(observed.requests.at(-1)?.url).toBe(
      "https://jira.example.invalid/context/rest/api/2/project/10000/versions",
    );
    expect(observed.result.data).toMatchObject({ outcome: "succeeded", versionId: "81" });
  });
  it.each(["jira.delete-component", "jira.merge-version", "jira.remove-and-swap-version"] as const)(
    "retains %s as unconfirmed despite same-parent absence because issue references are not fully observed",
    async (tool) => {
      const scenario = SCENARIOS.find((candidate) => candidate.tool === tool);
      if (scenario === undefined)
        throw new TypeError("Missing aggregate-reference lifecycle fixture");
      expect(scenario.expectedOutcome).toBe("succeeded-unconfirmed");
      const observed = await observe(scenario);
      expect(observed.result).toMatchObject({
        isError: true,
        data: {
          outcome: "succeeded-unconfirmed",
          reason: "unavailable",
          ...scenario.expectedReceipt,
        },
      });
      expect(observed.requests.filter(({ method }) => method !== "GET")).toHaveLength(1);
      expect(observed.requests.at(-1)?.method).toBe("GET");
    },
  );
  it("serializes a typed false preference as a native JSON string, not a JSON boolean", async () => {
    const scenario = SCENARIOS.find(({ tool }) => tool === "jira.set-my-preference");
    if (scenario === undefined) throw new TypeError("Missing preference transport fixture");
    const observed = await observe(scenario);
    const writes = observed.requests.filter(({ method }) => method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: "PUT",
      url: "https://jira.example.invalid/context/rest/api/2/mypreferences?key=user.notify.own.changes",
      bodyJson: '"false"',
    });
    expect(writes[0]?.upload).toBeUndefined();
    expect(observed.requests.at(-1)?.method).toBe("GET");
    expect(observed.result.data).toMatchObject({
      outcome: "succeeded",
      preferencePresent: true,
      preferenceKey: "user.notify.own.changes",
    });
  });
  it("uses the published JSON ColumnsBean overload through the existing bounded HTTP port", async () => {
    const scenario = SCENARIOS.find(({ tool }) => tool === "jira.set-filter-columns");
    if (scenario === undefined) throw new TypeError("Missing columns transport fixture");
    const observed = await observe(scenario);
    const writes = observed.requests.filter(({ method }) => method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: "PUT",
      url: "https://jira.example.invalid/context/rest/api/2/filter/37/columns",
      bodyJson: '{"columns":["summary","status"]}',
    });
    expect(writes[0]?.upload).toBeUndefined();
    expect(observed.requests.at(-1)?.url).toBe(
      "https://jira.example.invalid/context/rest/api/2/filter/37/columns",
    );
  });
  it.each(["jira.delete-filter", "jira.delete-my-preference"] as const)(
    "retains explicit uncertainty for %s while preserving its known reviewed identity",
    async (tool) => {
      const scenario = SCENARIOS.find((candidate) => candidate.tool === tool);
      if (scenario === undefined) throw new TypeError("Missing unconfirmed deletion fixture");
      expect(scenario.expectedOutcome).toBe("succeeded-unconfirmed");
      const observed = await observe(scenario);
      assertPrimary(observed, scenario);
      expect(observed.result).toMatchObject({
        isError: true,
        data: {
          outcome: "succeeded-unconfirmed",
          reason: "unavailable",
          ...SAVED_CONFIGURATION_RECEIPTS[tool],
        },
      });
      const writes = observed.requests.filter(({ method }) => method !== "GET");
      expect(writes).toHaveLength(1);
      expect(writes[0]?.method).toBe("DELETE");
      expect(writes[0]?.bodyJson).toBeUndefined();
      expect(observed.requests.at(-1)?.method).toBe("GET");
    },
  );
  it.each(["jira.set-issue-property", "jira.delete-issue-property"] as const)(
    "rebinds the canonical parent and reads keys/value after exactly one %s effect",
    async (tool) => {
      const scenario = SCENARIOS.find((entry) => entry.tool === tool);
      if (scenario === undefined) throw new TypeError("Missing property write fixture");
      const observed = await observe(scenario);
      const requests = observed.requests.map(({ method, url }) => [method, new URL(url).pathname]);
      const property = "/context/rest/api/2/issue/10001/properties";
      expect(requests).toEqual([
        ["GET", "/context/rest/api/2/issue/SYN-1"],
        ["GET", property],
        ["GET", `${property}/view%20~settings`],
        [tool === "jira.set-issue-property" ? "PUT" : "DELETE", `${property}/view%20~settings`],
        ["GET", "/context/rest/api/2/issue/10001"],
        ["GET", property],
        ["GET", `${property}/view%20~settings`],
      ]);
      expect(observed.result.data).toMatchObject({
        issueId: "10001",
        issueKey: "SYN-1",
        propertyKey: PROPERTY_FIXTURE_KEY,
        propertyPresent: tool === "jira.set-issue-property",
      });
      const write = observed.requests.find(({ method }) => method !== "GET");
      expect(write?.bodyJson).toBe(tool === "jira.set-issue-property" ? "false" : undefined);
    },
  );
  it("sends JSON null as a literal value after independently reviewed absence", async () => {
    const scenario: Scenario = {
      tool: "jira.set-user-property",
      expectedPrimary: {
        method: "PUT",
        apiRoot: "/rest/api/2",
        path: "user/properties/view%20~settings?userKey=JIRAUSER10100",
      },
      args: {
        username: "synthetic-user",
        propertyKey: PROPERTY_FIXTURE_KEY,
        expectAbsent: true,
        valueNodes: REVIEWED_PROPERTY_NODES,
      },
      parameters: { propertyKey: PROPERTY_FIXTURE_KEY },
      query: { userKey: "JIRAUSER10100" },
    };
    const observed = await observeNativeJiraOperation(
      scenario,
      connection(remote(scenario.tool, false)),
    );
    assertPrimary(observed, scenario);
    expect(observed.requests.find(({ method }) => method === "PUT")?.bodyJson).toBe("null");
    expect(observed.result.data).toMatchObject({
      userKey: "JIRAUSER10100",
      username: "Synthetic-User",
      propertyPresent: true,
    });
  });
  it.each([
    ["jira.set-app-monitoring", "monitoringEnabled", true],
    ["jira.set-ipd-monitoring", "monitoringEnabled", false],
    ["jira.start-jmx-metrics", "jmxMetricsExposed", true],
    ["jira.stop-jmx-metrics", "jmxMetricsExposed", false],
  ] as const)(
    "confirms %s through its independent original state endpoint",
    async (tool, field, target) => {
      const scenario = SCENARIOS.find((candidate) => candidate.tool === tool);
      if (scenario === undefined) throw new TypeError("Missing monitoring fixture");
      const observed = await observe(scenario);
      expect(observed.requests.map(({ method }) => method)).toEqual(["GET", "POST", "GET"]);
      expect(observed.requests[0]?.url).toBe(observed.requests[2]?.url);
      expect(observed.requests[0]?.bodyJson).toBeUndefined();
      expect(observed.requests[2]?.bodyJson).toBeUndefined();
      expect(observed.result.data).toMatchObject({ outcome: "succeeded", [field]: target });
    },
  );
  it("keeps a false native reorder observation and binds its parent without authorizing a write", async () => {
    const observed = await observe({
      tool: "jira.subtask-move-availability",
      args: { issueIdOrKey: "SYN-1" },
    });
    expect(observed.requests).toHaveLength(2);
    expect(observed.requests[1]?.bodyJson).toBeUndefined();
    expect(observed.requests.every(({ method }) => method === "GET")).toBe(true);
    expect(observed.result.data).toMatchObject({
      issueId: "10001",
      issueKey: "SYN-1",
      canReorderSubtasks: false,
    });
  });
  it("binds a global remote-link selector to one native object without following its URL", async () => {
    const scenario: Scenario = {
      tool: "jira.remote-links",
      expectedPrimary: {
        method: "GET",
        apiRoot: "/rest/api/2",
        path: "issue/10001/remotelink?globalId=app%3Dsynthetic%26id%3D1",
      },
      args: { issueIdOrKey: "SYN-1", globalId: "app=synthetic&id=1" },
      parameters: { issueIdOrKey: "10001" },
      query: { globalId: "app=synthetic&id=1" },
      primaryMethodIndex: 1,
    };
    const observed = await observe(scenario);
    assertPrimary(observed, scenario);
    expect(observed.requests).toHaveLength(2);
    expect(observed.requests[1]?.method).toBe("GET");
    expect(observed.requests[1]?.bodyJson).toBeUndefined();
    expect(observed.result.data).toMatchObject({
      issueId: "10001",
      issueKey: "SYN-1",
      id: "71",
      resolved: false,
    });
    expect(observed.result.data).not.toHaveProperty("items");
    expect(observed.result.data).not.toHaveProperty("self");
    expect(observed.result.data).toHaveProperty(
      "reviewSnapshot.url",
      "https://untrusted.invalid/target",
    );
    expect(
      observed.requests.every(
        (request) => new URL(request.url).origin === "https://jira.example.invalid",
      ),
    ).toBe(true);
  });
  it("keeps picker contexts bound while returning only plain suggestions and trusted browse URLs", async () => {
    const scenario = SCENARIOS.find(({ tool }) => tool === "jira.issue-picker");
    if (scenario === undefined) throw new TypeError("Missing issue picker fixture");
    const observed = await observe(scenario);
    expect(observed.requests).toHaveLength(3);
    expect(observed.result.data).toMatchObject({
      suggestionsScope: "native-suggestions",
      sections: [
        {
          id: "history",
          label: "Recent issues",
          issues: [
            {
              key: "SYN-2",
              summary: "Plain suggestion",
              browseUrl: "https://jira.example.invalid/context/browse/SYN-2",
            },
          ],
        },
      ],
    });
    expect(observed.result.data).not.toHaveProperty("total");
    expect(JSON.stringify(observed.result.data)).not.toContain("Discarded HTML");
  });
  it("keeps repeated metadata filters lossless on the native status page", async () => {
    const observed = await observe({
      tool: "jira.status-page",
      args: {
        startAt: 0,
        maxResults: 1,
        projectIds: ["10000", "9223372036854775807"],
        issueTypeIds: ["10001", "9007199254740993"],
      },
    });
    const request = observed.requests[0];
    if (request === undefined) throw new TypeError("Missing metadata page request");
    expect([request.method, request.url]).toEqual([
      "GET",
      "https://jira.example.invalid/context/rest/api/2/status/page?startAt=0&maxResults=1&projectIds=10000&projectIds=9223372036854775807&issueTypeIds=10001&issueTypeIds=9007199254740993",
    ]);
    const url = new URL(request.url);
    expect(url.pathname).toBe("/context/rest/api/2/status/page");
    expect(url.searchParams.getAll("projectIds")).toEqual(["10000", "9223372036854775807"]);
    expect(url.searchParams.getAll("issueTypeIds")).toEqual(["10001", "9007199254740993"]);
    expect(observed.requests).toHaveLength(1);
  });
  it("keeps repeated option context IDs lossless and native page numbering unchanged", async () => {
    const observed = await observe({
      tool: "jira.custom-field-options",
      args: {
        customFieldId: "10001",
        page: 2,
        maxResults: 1,
        projectIds: ["10000", "9223372036854775807"],
        issueTypeIds: ["10001", "9007199254740993"],
      },
    });
    const request = observed.requests[0];
    if (request === undefined) throw new TypeError("Missing native option request");
    expect([request.method, request.url]).toEqual([
      "GET",
      "https://jira.example.invalid/context/rest/api/2/customFields/10001/options?page=2&maxResults=1&projectIds=10000&projectIds=9223372036854775807&issueTypeIds=10001&issueTypeIds=9007199254740993",
    ]);
    const url = new URL(request.url);
    expect(url.pathname).toBe("/context/rest/api/2/customFields/10001/options");
    expect(url.searchParams.getAll("projectIds")).toEqual(["10000", "9223372036854775807"]);
    expect(url.searchParams.getAll("issueTypeIds")).toEqual(["10001", "9007199254740993"]);
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.has("startAt")).toBe(false);
    expect(observed.result.data).toMatchObject({
      page: 2,
      nextPage: 3,
      total: 3,
      optionsScope: "native-context-options",
    });
    expect(observed.result.data).not.toHaveProperty("startAt");
    expect(observed.requests).toHaveLength(1);
  });
  it.each([
    ["jira.jmx-metrics-exposed", "monitoring/jmx/areMetricsExposed", false, { exposed: false }],
    ["jira.search-max-aggregation-buckets", "searchLimits/maxAggregationBuckets", 0, { limit: 0 }],
    ["jira.search-max-result-window", "searchLimits/maxResultWindow", -1, { limit: -1 }],
  ] as const)(
    "preserves %s's scalar native body without a wrapper or sentinel interpretation",
    async (tool, path, scalar, projection) => {
      const body = instanceRead(path);
      expect(body).toMatchObject({
        kind: "response",
        status: 200,
        bodyText: JSON.stringify(scalar),
      });
      const observed = await observe({ tool, args: {} });
      expect(observed.result.data).toMatchObject(projection);
      expect(observed.requests.map(({ method, url }) => [method, url])).toEqual([
        ["GET", `https://jira.example.invalid/context/rest/api/2/${path}`],
      ]);
    },
  );
  it("keeps node addresses private and maintenance observations independent", async () => {
    const nodes = await observe({
      tool: "jira.cluster-nodes",
      args: { startAt: 0, maxResults: 1 },
    });
    expect(nodes.result.data).toMatchObject({
      items: [{ nodeId: "node-A", alive: false, lastStateChangeTimestamp: 0 }],
    });
    expect(JSON.stringify(nodes.result.data)).not.toMatch(/192\.0\.2\.10|40001/u);
    const snapshot = await observe({ tool: "jira.index-snapshot-status", args: {} });
    expect(snapshot.result.data).toMatchObject({ running: false });
    expect(instanceRead("index-snapshot/isRunning")).toMatchObject({
      bodyText: '{"running":false}',
    });
    const summary = await observe({ tool: "jira.index-summary", args: {} });
    expect(summary.result.data).toMatchObject({
      issueIndex: { indexReadable: false, countInIndex: 0 },
      replicationQueues: [],
      externalPlatformIndexReplay: [
        {
          nodeId: "node-B",
          queueSize: 0,
          lastConsumedOperation: { id: -1, journalWriteTime: "Journal at 21:00" },
        },
      ],
    });
    expect(summary.result.data.issueIndex).not.toHaveProperty("countInArchive");
    expect(summary.result.data.issueIndex).not.toHaveProperty("lastUpdatedInIndex");
  });
  it.each(["jira.global-version-page", "jira.component-page"] as const)(
    "keeps %s project filters lossless and an omitted total unknown",
    async (tool) => {
      const observed = await observe({
        tool,
        args: { startAt: 0, maxResults: 1, projectIds: ["10000", "9223372036854775807"] },
      });
      const request = observed.requests[0];
      if (request === undefined) throw new TypeError("Missing native metadata page request");
      expect(new URL(request.url).searchParams.getAll("projectIds")).toEqual([
        "10000",
        "9223372036854775807",
      ]);
      expect(observed.result.data).not.toHaveProperty("total");
      expect(observed.result.data).toMatchObject({ nextStartAt: 1 });
    },
  );
  it.each([
    [
      [{ value: "summary", label: "Summary" }],
      { columnsAvailable: true, items: [{ value: "summary", label: "Summary" }], total: 1 },
    ],
    [{ columnConfig: "NONE" }, { columnsAvailable: false, columnConfig: "NONE" }],
  ] as const)(
    "accepts the published filter layout form without retry or fabricated columns",
    async (native, expected) => {
      const observed = await observeNativeJiraOperation(
        { tool: "jira.filter-columns", args: { filterId: "42" } },
        connection(() => Promise.resolve(response(native))),
      );
      expect(observed.result.data).toMatchObject({
        layoutScope: "filter",
        selectedFilterId: "42",
        ...expected,
      });
      if (!expected.columnsAvailable) {
        expect(observed.result.data).not.toHaveProperty("items");
        expect(observed.result.data).not.toHaveProperty("total");
      }
      expect(observed.requests).toHaveLength(1);
    },
  );
  it("keeps selected reindex IDs exact and distinguishes unreturned IDs from an empty task population", async () => {
    const observed = await observe({
      tool: "jira.reindex-requests",
      args: {
        requestIds: ["7", "9223372036854775807"],
        startAt: 0,
        maxResults: 1,
      },
    });
    const request = observed.requests[0];
    if (request === undefined) throw new TypeError("Missing native reindex request");
    expect(new URL(request.url).searchParams.getAll("requestId")).toEqual([
      "7",
      "9223372036854775807",
    ]);
    expect(observed.result.data).toMatchObject({
      total: 1,
      requestScope: "selected-requests",
      requestedRequestIds: ["7", "9223372036854775807"],
      unreturnedRequestIds: ["9223372036854775807"],
      items: [{ id: "7", status: "PENDING" }],
    });
    expect(observed.requests).toHaveLength(1);
  });
  it("keeps native progress, monitoring flags and scalar metric descriptions independent", async () => {
    expect((await observe({ tool: "jira.reindex-status", args: {} })).result.data).toMatchObject({
      taskSelection: "active-or-latest",
      currentProgress: 0,
      success: false,
    });
    expect((await observe({ tool: "jira.app-monitoring", args: {} })).result.data).toMatchObject({
      enabled: false,
    });
    expect(
      (await observe({ tool: "jira.ipd-monitoring", args: {} })).result.data,
    ).not.toHaveProperty("enabled");
    const metrics = await observe({ tool: "jira.jmx-metrics", args: {} });
    expect(metrics.result.data).toMatchObject({ metricsText: "metric.one\nmetric.two" });
    expect(metrics.requests).toHaveLength(1);
    expect(metrics.requests[0]?.method).toBe("GET");
  });
  it.each([
    [303, "running"],
    [404, "no-prior-result"],
  ] as const)(
    "represents the native upgrade response %s without following or starting a job",
    async (status, upgradeState) => {
      const observed = await observeNativeJiraOperation(
        { tool: "jira.upgrade-result", args: {} },
        connection(() => Promise.resolve(response({}, status))),
      );
      expect(observed.result.data).toMatchObject({ outcome: "succeeded", upgradeState });
      expect(observed.requests).toHaveLength(1);
      expect(observed.requests[0]?.method).toBe("GET");
    },
  );
  it("binds native issue property identity before returning typed values without following key links", async () => {
    const observed = await observe({
      tool: "jira.issue-property",
      args: { issueIdOrKey: "SYN-1", propertyKey: "view ~settings" },
    });
    expect(observed.requests.map(({ method, url }) => [method, new URL(url).pathname])).toEqual([
      ["GET", "/context/rest/api/2/issue/SYN-1"],
      ["GET", "/context/rest/api/2/issue/10001/properties/view%20~settings"],
    ]);
    expect(observed.result.data).toMatchObject({
      issueId: "10001",
      issueKey: "SYN-1",
      propertyKey: "view ~settings",
      items: expect.arrayContaining([
        { path: "", kind: "object", childCount: 1 },
        { path: "/a~1b~0c/0", kind: "null" },
        { path: "/a~1b~0c/1", kind: "object", childCount: 0 },
        { path: "/a~1b~0c/2", kind: "array", childCount: 0 },
      ]) as unknown,
    });
    const keys = await observe({
      tool: "jira.issue-property-keys",
      args: { issueIdOrKey: "SYN-1" },
    });
    expect(keys.result.data.items).toEqual([{ key: "view ~settings" }, { key: "a/b%" }]);
    expect(keys.requests).toHaveLength(2);
    expect(JSON.stringify(keys.result.data)).not.toContain("untrusted.invalid");
  });
  it.each(["/", "\\", "%2f", ".", ".."])(
    "rejects unaddressable property selection %j before the real HTTP port",
    async (propertyKey) => {
      const http = remote();
      const provider = createJiraProviderForCatalog(
        () => connection(http),
        ["jira.issue-property"],
      );
      const tool = provider.tools()[0];
      if (tool === undefined) throw new TypeError("Missing issue property fixture tool");
      const result = await tool.execute(
        { issueIdOrKey: "SYN-1", propertyKey },
        {
          invocationId: "property-refusal",
          correlationId: "property-refusal",
          signal: new AbortController().signal,
          beforeEffect: (): boolean => true,
        },
      );
      expect(result.data).toMatchObject({ outcome: "failed", reason: "invalid-input" });
      expect(http).not.toHaveBeenCalled();
    },
  );
  it.each(["jira.create-screen-tab", "jira.rename-screen-tab", "jira.delete-screen-tab"] as const)(
    "confirms %s through the same reviewed screen and complete native tabs after exactly one write",
    async (tool) => {
      const scenario = SCENARIOS.find((candidate) => candidate.tool === tool);
      if (scenario === undefined) throw new TypeError("Missing screen tab fixture");
      const observed = await observe(scenario);
      const writeIndex = observed.requests.findIndex((request) => request.method !== "GET");
      expect(writeIndex).toBeGreaterThan(0);
      expect(observed.requests.filter((request) => request.method !== "GET")).toHaveLength(1);
      const readback = observed.requests.slice(writeIndex + 1);
      expect(readback.map(({ method, url }) => [method, new URL(url).pathname])).toEqual([
        ["GET", "/context/rest/api/2/screens"],
        ["GET", "/context/rest/api/2/screens/71/tabs"],
      ]);
      const firstReadback = readback[0];
      if (firstReadback === undefined) throw new TypeError("Missing screen readback");
      expect(new URL(firstReadback.url).searchParams.get("search")).toBe("Details & QA");
      expect(observed.result.data).toMatchObject({
        outcome: "succeeded",
        screenId: "71",
        tabId: tool === "jira.create-screen-tab" ? "83" : "81",
      });
      if (tool === "jira.delete-screen-tab")
        expect(
          observed.requests
            .slice(0, writeIndex)
            .some(
              ({ url }) =>
                new URL(url).pathname === "/context/rest/api/2/screens/71/tabs/81/fields",
            ),
        ).toBe(true);
    },
  );
  it.each(["jira.create", "jira.edit"] as const)(
    "keeps %s's approved link continuation on POST issueLink",
    async (tool) => {
      const original = SCENARIOS.find((scenario) => scenario.tool === tool);
      if (original === undefined) throw new TypeError("Missing linked mutation fixture");
      const scenario = {
        ...original,
        args: {
          ...original.args,
          links: [
            { type: "Relates", direction: "outward", issueKey: "SYN-2" },
            { type: "Relates", direction: "outward", issueKey: "SYN-3" },
          ],
        },
      };
      const observed = await observe(scenario);
      assertPrimary(observed, scenario);
      expect(observed.definition.continuationPolicy).toBe("approved-issue-links");
      const writes = observed.requests.filter((request) => request.method !== "GET");
      expect(writes).toHaveLength(2);
      const continuation = writes[1];
      expect([continuation?.method, continuation?.url]).toEqual([
        "POST",
        "https://jira.example.invalid/context/rest/api/2/issueLink",
      ]);
      expect(JSON.parse(continuation?.bodyJson ?? "{}")).toEqual({
        type: { name: "Relates" },
        inwardIssue: { key: "SYN-1" },
        outwardIssue: { key: "SYN-3" },
      });
    },
  );
});

async function systemScenario(tool: Scenario["tool"]): Promise<Observation> {
  const scenario = SCENARIOS.find((item) => item.tool === tool);
  if (scenario === undefined) throw new TypeError("Missing administrative native scenario");
  const observed = await observe(scenario);
  assertPrimary(observed, scenario);
  return observed;
}
it.each(["jira.set-application-role", "jira.set-application-roles"] as const)(
  "keeps the native CAS version private for %s",
  async (tool) => {
    const observed = await systemScenario(tool);
    const writes = observed.requests.filter((request) => request.method === "PUT");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.jiraApplicationRole).toEqual({ ifMatch: '"native-role-version"' });
    expect(JSON.stringify(observed.result)).not.toContain("native-role-version");
    expect(observed.result.data).toMatchObject({
      outcome: "succeeded-unconfirmed",
      applicationRoleKeys: ["jira-software"],
    });
  },
);
it("preserves the exact named-user form, ordered duplicate columns and independent readback", async () => {
  const observed = await systemScenario("jira.set-user-columns");
  const write = observed.requests.find((request) => request.method === "PUT");
  expect(write).toMatchObject({
    jiraUserColumns: true,
    bodyJson: "username=Target+User&columns=status&columns=summary&columns=status",
  });
  expect(observed.requests.filter((request) => request.method !== "GET")).toHaveLength(1);
  expect(observed.requests.at(-1)?.method).toBe("GET");
  expect(observed.result.data).toMatchObject({
    outcome: "succeeded",
    columnIds: ["status", "summary", "status"],
  });
});
it.each(["jira.add-user-application", "jira.remove-user-application"] as const)(
  "uses the fixed experimental query-only request for %s",
  async (tool) => {
    const observed = await systemScenario(tool);
    const writes = observed.requests.filter((request) => request.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.jiraUserApplication).toBe(true);
    expect(writes[0]?.jiraExperimental).toBeUndefined();
    expect(writes[0]?.bodyJson).toBeUndefined();
    expect(observed.result.data).toMatchObject({
      outcome: "succeeded-unconfirmed",
      applicationAccessRequested: tool === "jira.add-user-application",
    });
  },
);
it("retains repeated exact reindex issue IDs and array ACK IDs without declaring job completion", async () => {
  const issues = await systemScenario("jira.reindex-issues");
  const write = issues.requests.find((request) => request.method === "POST");
  if (write === undefined) throw new TypeError("Missing reindex request");
  expect(new URL(write.url).searchParams.getAll("issueId")).toEqual([
    "10001",
    "9223372036854775807",
  ]);
  expect(write.bodyJson).toBeUndefined();
  const requests = await systemScenario("jira.process-reindex-requests");
  expect(requests.result.data).toMatchObject({
    outcome: "succeeded-unconfirmed",
    reindexRequestIds: ["7", "9223372036854775807"],
  });
});
