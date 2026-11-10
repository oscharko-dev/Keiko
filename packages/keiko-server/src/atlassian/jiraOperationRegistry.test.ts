import { describe, expect, it, vi } from "vitest";
import {
  createJiraProviderForCatalog,
  jiraOperationContracts,
  jiraOperationForTool,
} from "./jiraManagedProvider.js";
import { jiraMutationDeclarations } from "./jiraManagedMutationDescriptors.js";
import {
  createJiraOperationContract,
  createJiraOperationContracts,
  matchesJiraOperationBinding,
  isJiraOperationBinding,
} from "./jiraOperationRegistry.js";
import { createToolDescriptor } from "@oscharko-dev/keiko-tool-catalog";
import {
  ATLASSIAN_CONNECTOR_ACTION_CLASS,
  JIRA_MANAGED_ACTION_TYPES,
  jiraRequiredConnectorScope,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

const JIRA_MUTATION_DECLARATIONS = jiraMutationDeclarations();

describe("server-owned Jira operation contracts", () => {
  it.each([
    {
      tool: "jira.create-permission-scheme",
      identity: "POST /rest/api/2/permissionscheme",
      permissionPolicy: "instance-admin-permission-scheme-create-and-readback",
    },
    {
      tool: "jira.update-permission-scheme",
      identity: "PUT /rest/api/2/permissionscheme/{schemeId}",
      permissionPolicy: "instance-admin-permission-scheme-update-and-readback",
    },
    {
      tool: "jira.delete-permission-scheme",
      identity: "DELETE /rest/api/2/permissionscheme/{schemeId}",
      permissionPolicy: "instance-admin-permission-scheme-delete-unconfirmed",
    },
    {
      tool: "jira.add-permission-grant",
      identity: "POST /rest/api/2/permissionscheme/{schemeId}/permission",
      permissionPolicy: "instance-admin-permission-grant-add-and-readback",
    },
    {
      tool: "jira.delete-permission-grant",
      identity: "DELETE /rest/api/2/permissionscheme/{schemeId}/permission/{permissionId}",
      permissionPolicy: "instance-admin-permission-grant-delete-and-absence",
    },
    {
      tool: "jira.set-permission-scheme-attribute",
      identity: "PUT /rest/api/2/permissionscheme/{permissionSchemeId}/attribute/{key}",
      permissionPolicy: "instance-admin-permission-attribute-and-readback",
    },
    {
      tool: "jira.create-role",
      identity: "POST /rest/api/2/role",
      permissionPolicy: "instance-admin-role-create-and-readback",
    },
    {
      tool: "jira.update-role",
      identity: "POST /rest/api/2/role/{id}",
      permissionPolicy: "instance-admin-role-update-and-readback",
    },
    {
      tool: "jira.replace-role",
      identity: "PUT /rest/api/2/role/{id}",
      permissionPolicy: "instance-admin-role-replace-and-readback",
    },
    {
      tool: "jira.delete-role",
      identity: "DELETE /rest/api/2/role/{id}",
      permissionPolicy: "instance-admin-role-delete-unconfirmed",
    },
    {
      tool: "jira.add-role-default-actors",
      identity: "POST /rest/api/2/role/{id}/actors",
      permissionPolicy: "instance-admin-role-default-actors-unconfirmed",
    },
    {
      tool: "jira.delete-role-default-actor",
      identity: "DELETE /rest/api/2/role/{id}/actors",
      permissionPolicy: "instance-admin-role-default-actors-unconfirmed",
    },
    {
      tool: "jira.add-project-role-actors",
      identity: "POST /rest/api/2/project/{projectIdOrKey}/role/{id}",
      permissionPolicy: "instance-admin-project-role-actors-unconfirmed",
    },
    {
      tool: "jira.set-project-role-actors",
      identity: "PUT /rest/api/2/project/{projectIdOrKey}/role/{id}",
      permissionPolicy: "instance-admin-project-role-actors-unconfirmed",
    },
    {
      tool: "jira.delete-project-role-actor",
      identity: "DELETE /rest/api/2/project/{projectIdOrKey}/role/{id}",
      permissionPolicy: "instance-admin-project-role-actors-unconfirmed",
    },
  ] as const)(
    "binds access configuration $tool to its exact native identity and admin scope",
    ({ tool, identity, permissionPolicy }) => {
      expect(jiraOperationForTool(tool)?.definition).toMatchObject({
        kind: "native",
        identity,
        permissionPolicy,
        effects: ["remote-read", "remote-write"],
      });
      expect(jiraRequiredConnectorScope(tool)).toBe("issue-tracker.admin");
    },
  );
  it.each([
    {
      tool: "jira.create-project-category",
      identity: "POST /rest/api/2/projectCategory",
      permissionPolicy: "instance-admin-project-category-create-and-readback",
    },
    {
      tool: "jira.update-project-category",
      identity: "PUT /rest/api/2/projectCategory/{id}",
      permissionPolicy: "instance-admin-project-category-update-and-readback",
    },
    {
      tool: "jira.delete-project-category",
      identity: "DELETE /rest/api/2/projectCategory/{id}",
      permissionPolicy: "instance-admin-project-category-delete-unconfirmed",
    },
    {
      tool: "jira.upsert-version-remote-link",
      identity: "POST /rest/api/2/version/{versionId}/remotelink",
      permissionPolicy: "version-remote-link-upsert-and-readback",
    },
    {
      tool: "jira.upsert-version-remote-link-by-global-id",
      identity: "POST /rest/api/2/version/{versionId}/remotelink/{globalId}",
      permissionPolicy: "version-remote-link-upsert-and-readback",
    },
    {
      tool: "jira.delete-version-remote-link",
      identity: "DELETE /rest/api/2/version/{versionId}/remotelink/{globalId}",
      permissionPolicy: "version-remote-link-delete-and-absence",
    },
    {
      tool: "jira.delete-version-remote-links",
      identity: "DELETE /rest/api/2/version/{versionId}/remotelink",
      permissionPolicy: "version-remote-links-delete-and-absence",
    },
    {
      tool: "jira.epic-remove-issues",
      identity: "POST /rest/agile/1.0/epic/none/issue",
      permissionPolicy: "epic-removal-and-readback",
    },
    {
      tool: "jira.rank-epic",
      identity: "PUT /rest/agile/1.0/epic/{epicIdOrKey}/rank",
      permissionPolicy: "rank-and-position-uncertainty",
    },
    {
      tool: "jira.rank-issues",
      identity: "PUT /rest/agile/1.0/issue/rank",
      permissionPolicy: "rank-and-position-uncertainty",
    },
    {
      tool: "jira.set-issue-estimation",
      identity: "PUT /rest/agile/1.0/issue/{issueIdOrKey}/estimation",
      permissionPolicy: "issue-estimation-and-readback",
    },
  ] as const)(
    "binds planning/version/category $tool to its independent native identity",
    ({ tool, identity, permissionPolicy }) => {
      expect(jiraOperationForTool(tool)?.definition).toMatchObject({
        kind: "native",
        identity,
        permissionPolicy,
        effects: ["remote-read", "remote-write"],
      });
    },
  );
  it.each([
    {
      tool: "jira.add-default-screen-field",
      identity: "POST /rest/api/2/screens/addToDefault/{fieldId}",
      permissionPolicy: "instance-admin-default-screen-field-unconfirmed",
    },
    {
      tool: "jira.add-screen-tab-field",
      identity: "POST /rest/api/2/screens/{screenId}/tabs/{tabId}/fields",
      permissionPolicy: "instance-admin-screen-field-add-and-readback",
    },
    {
      tool: "jira.remove-screen-tab-field",
      identity: "DELETE /rest/api/2/screens/{screenId}/tabs/{tabId}/fields/{id}",
      permissionPolicy: "instance-admin-screen-field-delete-and-absence",
    },
    {
      tool: "jira.move-screen-tab-field",
      identity: "POST /rest/api/2/screens/{screenId}/tabs/{tabId}/fields/{id}/move",
      permissionPolicy: "instance-admin-screen-field-order-and-readback",
    },
    {
      tool: "jira.set-screen-field-show-when-empty",
      identity:
        "PUT /rest/api/2/screens/{screenId}/tabs/{tabId}/fields/{id}/updateShowWhenEmptyIndicator/{newValue}",
      permissionPolicy: "instance-admin-screen-field-display-and-readback",
    },
    {
      tool: "jira.move-screen-tab",
      identity: "POST /rest/api/2/screens/{screenId}/tabs/{tabId}/move/{pos}",
      permissionPolicy: "instance-admin-screen-tab-order-and-readback",
    },
    {
      tool: "jira.delete-board",
      identity: "DELETE /rest/agile/1.0/board/{boardId}",
      permissionPolicy: "board-delete-unconfirmed",
    },
    {
      tool: "jira.set-board-refined-velocity",
      identity: "PUT /rest/agile/1.0/board/{boardId}/settings/refined-velocity",
      permissionPolicy: "board-refined-velocity-and-readback",
    },
    {
      tool: "jira.replace-sprint",
      identity: "PUT /rest/agile/1.0/sprint/{sprintId}",
      permissionPolicy: "sprint-replace-and-readback",
    },
    {
      tool: "jira.delete-sprint",
      identity: "DELETE /rest/agile/1.0/sprint/{sprintId}",
      permissionPolicy: "sprint-delete-and-membership-uncertainty",
    },
    {
      tool: "jira.swap-sprints",
      identity: "POST /rest/agile/1.0/sprint/{sprintId}/swap",
      permissionPolicy: "sprint-swap-and-position-uncertainty",
    },
    {
      tool: "jira.unmap-sprints",
      identity: "PUT /rest/agile/1.0/sprint/unmap",
      permissionPolicy: "sprint-unmap-and-readback",
    },
    {
      tool: "jira.unmap-all-sprints",
      identity: "PUT /rest/agile/1.0/sprint/unmap-all",
      permissionPolicy: "instance-admin-sprint-unmap-all-unconfirmed",
    },
  ] as const)(
    "binds $tool to its independently expected native identity",
    ({ tool, identity, permissionPolicy }) => {
      expect(jiraOperationForTool(tool)?.definition).toMatchObject({
        kind: "native",
        identity,
        permissionPolicy,
        effects: ["remote-read", "remote-write"],
      });
    },
  );
  it.each([
    {
      tool: "jira.create-issue-type-scheme",
      identity: "POST /rest/api/2/issuetypescheme",
      permissionPolicy: "instance-admin-issue-type-scheme-config-and-readback",
    },
    {
      tool: "jira.update-issue-type-scheme",
      identity: "PUT /rest/api/2/issuetypescheme/{schemeId}",
      permissionPolicy: "instance-admin-issue-type-scheme-config-and-readback",
    },
    {
      tool: "jira.delete-issue-type-scheme",
      identity: "DELETE /rest/api/2/issuetypescheme/{schemeId}",
      permissionPolicy: "instance-admin-issue-type-scheme-delete-unconfirmed",
    },
    {
      tool: "jira.add-issue-type-scheme-projects",
      identity: "POST /rest/api/2/issuetypescheme/{schemeId}/associations",
      permissionPolicy: "instance-admin-issue-type-scheme-projects-unconfirmed",
    },
    {
      tool: "jira.set-issue-type-scheme-projects",
      identity: "PUT /rest/api/2/issuetypescheme/{schemeId}/associations",
      permissionPolicy: "instance-admin-issue-type-scheme-projects-unconfirmed",
    },
    {
      tool: "jira.clear-issue-type-scheme-projects",
      identity: "DELETE /rest/api/2/issuetypescheme/{schemeId}/associations",
      permissionPolicy: "instance-admin-issue-type-scheme-projects-unconfirmed",
    },
    {
      tool: "jira.remove-issue-type-scheme-project",
      identity: "DELETE /rest/api/2/issuetypescheme/{schemeId}/associations/{projIdOrKey}",
      permissionPolicy: "instance-admin-issue-type-scheme-projects-unconfirmed",
    },
    {
      tool: "jira.create-priority-scheme",
      identity: "POST /rest/api/2/priorityschemes",
      permissionPolicy: "instance-admin-priority-scheme-config-and-readback",
    },
    {
      tool: "jira.update-priority-scheme",
      identity: "PUT /rest/api/2/priorityschemes/{schemeId}",
      permissionPolicy: "instance-admin-priority-scheme-config-and-readback",
    },
    {
      tool: "jira.delete-priority-scheme",
      identity: "DELETE /rest/api/2/priorityschemes/{schemeId}",
      permissionPolicy: "instance-admin-priority-scheme-delete-unconfirmed",
    },
    {
      tool: "jira.create-workflow-scheme",
      identity: "POST /rest/api/2/workflowscheme",
      permissionPolicy: "instance-admin-workflow-scheme-config-and-readback",
    },
    {
      tool: "jira.update-workflow-scheme",
      identity: "PUT /rest/api/2/workflowscheme/{id}",
      permissionPolicy: "instance-admin-workflow-scheme-update-and-scope-uncertainty",
    },
    {
      tool: "jira.delete-workflow-scheme",
      identity: "DELETE /rest/api/2/workflowscheme/{id}",
      permissionPolicy: "instance-admin-workflow-scheme-delete-unconfirmed",
    },
    {
      tool: "jira.create-workflow-scheme-draft",
      identity: "POST /rest/api/2/workflowscheme/{id}/createdraft",
      permissionPolicy: "instance-admin-workflow-draft-config-and-readback",
    },
    {
      tool: "jira.update-workflow-scheme-draft",
      identity: "PUT /rest/api/2/workflowscheme/{id}/draft",
      permissionPolicy: "instance-admin-workflow-draft-config-and-readback",
    },
    {
      tool: "jira.delete-workflow-scheme-draft",
      identity: "DELETE /rest/api/2/workflowscheme/{id}/draft",
      permissionPolicy: "instance-admin-workflow-draft-delete-and-parent-readback",
    },
    {
      tool: "jira.set-workflow-scheme-default",
      identity: "PUT /rest/api/2/workflowscheme/{id}/default",
      permissionPolicy: "instance-admin-workflow-scheme-mapping-unconfirmed",
    },
    {
      tool: "jira.delete-workflow-scheme-default",
      identity: "DELETE /rest/api/2/workflowscheme/{id}/default",
      permissionPolicy: "instance-admin-workflow-scheme-mapping-unconfirmed",
    },
    {
      tool: "jira.set-workflow-scheme-draft-default",
      identity: "PUT /rest/api/2/workflowscheme/{id}/draft/default",
      permissionPolicy: "instance-admin-workflow-draft-config-and-readback",
    },
    {
      tool: "jira.delete-workflow-scheme-draft-default",
      identity: "DELETE /rest/api/2/workflowscheme/{id}/draft/default",
      permissionPolicy: "instance-admin-workflow-draft-config-and-readback",
    },
    {
      tool: "jira.set-workflow-scheme-issue-type",
      identity: "PUT /rest/api/2/workflowscheme/{id}/issuetype/{issueType}",
      permissionPolicy: "instance-admin-workflow-scheme-mapping-unconfirmed",
    },
    {
      tool: "jira.delete-workflow-scheme-issue-type",
      identity: "DELETE /rest/api/2/workflowscheme/{id}/issuetype/{issueType}",
      permissionPolicy: "instance-admin-workflow-scheme-mapping-unconfirmed",
    },
    {
      tool: "jira.set-workflow-scheme-draft-issue-type",
      identity: "PUT /rest/api/2/workflowscheme/{id}/draft/issuetype/{issueType}",
      permissionPolicy: "instance-admin-workflow-draft-config-and-readback",
    },
    {
      tool: "jira.delete-workflow-scheme-draft-issue-type",
      identity: "DELETE /rest/api/2/workflowscheme/{id}/draft/issuetype/{issueType}",
      permissionPolicy: "instance-admin-workflow-draft-config-and-readback",
    },
    {
      tool: "jira.set-workflow-scheme-workflow",
      identity: "PUT /rest/api/2/workflowscheme/{id}/workflow",
      permissionPolicy: "instance-admin-workflow-scheme-mapping-unconfirmed",
    },
    {
      tool: "jira.delete-workflow-scheme-workflow",
      identity: "DELETE /rest/api/2/workflowscheme/{id}/workflow",
      permissionPolicy: "instance-admin-workflow-scheme-mapping-unconfirmed",
    },
    {
      tool: "jira.set-workflow-scheme-draft-workflow",
      identity: "PUT /rest/api/2/workflowscheme/{id}/draft/workflow",
      permissionPolicy: "instance-admin-workflow-draft-config-and-readback",
    },
    {
      tool: "jira.delete-workflow-scheme-draft-workflow",
      identity: "DELETE /rest/api/2/workflowscheme/{id}/draft/workflow",
      permissionPolicy: "instance-admin-workflow-draft-config-and-readback",
    },
    {
      tool: "jira.set-application-property",
      identity: "PUT /rest/api/2/application-properties/{id}",
      permissionPolicy: "instance-admin-application-property-and-readback",
    },
    {
      tool: "jira.set-system-columns",
      identity: "PUT /rest/api/2/settings/columns",
      permissionPolicy: "instance-admin-system-columns-and-readback",
    },
    {
      tool: "jira.set-instance-base-url",
      identity: "PUT /rest/api/2/settings/baseUrl",
      permissionPolicy: "instance-admin-base-url-config-unconfirmed",
    },
    {
      tool: "jira.set-read-only-mode",
      identity: "PUT /rest/api/2/readonly-mode",
      permissionPolicy: "instance-admin-read-only-config-and-readback",
    },
    {
      tool: "jira.upload-email-template-pack",
      identity: "POST /rest/api/2/email-templates",
      permissionPolicy: "instance-admin-email-template-upload-unconfirmed",
    },
    {
      tool: "jira.apply-email-template-pack",
      identity: "POST /rest/api/2/email-templates/apply",
      permissionPolicy: "instance-admin-email-template-apply-unconfirmed",
    },
    {
      tool: "jira.revert-email-template-pack",
      identity: "POST /rest/api/2/email-templates/revert",
      permissionPolicy: "instance-admin-email-template-revert-unconfirmed",
    },
  ] as const)(
    "binds schema/runtime/mail $tool to its independent native identity",
    ({ tool, identity, permissionPolicy }) => {
      expect(jiraOperationForTool(tool)?.definition).toMatchObject({
        kind: "native",
        identity,
        permissionPolicy,
        effects: ["remote-read", "remote-write"],
      });
    },
  );
  it("keeps native template export under explicit administration read authority", () => {
    const contract = jiraOperationForTool("jira.email-template-pack");
    expect(jiraRequiredConnectorScope("jira.email-template-pack")).toBe("issue-tracker.admin");
    expect(contract?.declaration.risk).toBe("read");
    expect(contract?.definition).toMatchObject({
      identity: "GET /rest/api/2/email-templates",
      effects: ["remote-read"],
      permissionPolicy: "instance-admin-email-template-archive-observation",
    });
  });
  it.each([
    {
      tool: "jira.create-group",
      identity: "POST /rest/api/2/group",
      permissionPolicy: "instance-admin-group-create-and-readback",
    },
    {
      tool: "jira.delete-group",
      identity: "DELETE /rest/api/2/group",
      permissionPolicy: "instance-admin-group-delete-unconfirmed",
    },
    {
      tool: "jira.add-group-user",
      identity: "POST /rest/api/2/group/user",
      permissionPolicy: "instance-admin-group-membership-unconfirmed",
    },
    {
      tool: "jira.remove-group-user",
      identity: "DELETE /rest/api/2/group/user",
      permissionPolicy: "instance-admin-group-membership-unconfirmed",
    },
    {
      tool: "jira.pin-comment",
      identity: "PUT /rest/api/2/issue/{issueIdOrKey}/comment/{id}/pin",
      permissionPolicy: "comment-pin-and-readback",
    },
    {
      tool: "jira.notify-issue",
      identity: "POST /rest/api/2/issue/{issueIdOrKey}/notify",
      permissionPolicy: "issue-notification-unconfirmed",
    },
    {
      tool: "jira.request-cluster-index-snapshot",
      identity: "PUT /rest/api/2/cluster/index-snapshot/{nodeId}",
      permissionPolicy: "instance-admin-maintenance-request-unconfirmed",
    },
    {
      tool: "jira.delete-cluster-node",
      identity: "DELETE /rest/api/2/cluster/node/{nodeId}",
      permissionPolicy: "instance-admin-maintenance-request-unconfirmed",
    },
    {
      tool: "jira.mark-cluster-node-offline",
      identity: "PUT /rest/api/2/cluster/node/{nodeId}/offline",
      permissionPolicy: "instance-admin-maintenance-request-unconfirmed",
    },
    {
      tool: "jira.approve-cluster-upgrade",
      identity: "POST /rest/api/2/cluster/zdu/approve",
      permissionPolicy: "instance-admin-maintenance-request-unconfirmed",
    },
    {
      tool: "jira.cancel-cluster-upgrade",
      identity: "POST /rest/api/2/cluster/zdu/cancel",
      permissionPolicy: "instance-admin-maintenance-request-unconfirmed",
    },
    {
      tool: "jira.retry-cluster-upgrade",
      identity: "POST /rest/api/2/cluster/zdu/retryUpgrade",
      permissionPolicy: "instance-admin-maintenance-request-unconfirmed",
    },
    {
      tool: "jira.start-cluster-upgrade",
      identity: "POST /rest/api/2/cluster/zdu/start",
      permissionPolicy: "instance-admin-maintenance-request-unconfirmed",
    },
    {
      tool: "jira.create-index-snapshot",
      identity: "POST /rest/api/2/index-snapshot",
      permissionPolicy: "instance-admin-maintenance-request-unconfirmed",
    },
    {
      tool: "jira.start-reindex",
      identity: "POST /rest/api/2/reindex",
      permissionPolicy: "instance-admin-maintenance-request-unconfirmed",
    },
    {
      tool: "jira.reindex-issues",
      identity: "POST /rest/api/2/reindex/issue",
      permissionPolicy: "instance-admin-maintenance-request-unconfirmed",
    },
    {
      tool: "jira.process-reindex-requests",
      identity: "POST /rest/api/2/reindex/request",
      permissionPolicy: "instance-admin-maintenance-request-unconfirmed",
    },
    {
      tool: "jira.run-upgrade",
      identity: "POST /rest/api/2/upgrade",
      permissionPolicy: "instance-admin-maintenance-request-unconfirmed",
    },
    {
      tool: "jira.create-custom-field",
      identity: "POST /rest/api/2/field",
      permissionPolicy: "instance-admin-custom-field-create-unconfirmed",
    },
    {
      tool: "jira.delete-custom-fields",
      identity: "DELETE /rest/api/2/customFields",
      permissionPolicy: "instance-admin-custom-field-delete-unconfirmed",
    },
    {
      tool: "jira.create-issue-type",
      identity: "POST /rest/api/2/issuetype",
      permissionPolicy: "instance-admin-issue-type-create-unconfirmed",
    },
    {
      tool: "jira.update-issue-type",
      identity: "PUT /rest/api/2/issuetype/{id}",
      permissionPolicy: "instance-admin-issue-type-update-and-readback",
    },
    {
      tool: "jira.delete-issue-type",
      identity: "DELETE /rest/api/2/issuetype/{id}",
      permissionPolicy: "instance-admin-issue-type-delete-and-migration-unconfirmed",
    },
    {
      tool: "jira.create-link-type",
      identity: "POST /rest/api/2/issueLinkType",
      permissionPolicy: "instance-admin-link-type-create-and-readback",
    },
    {
      tool: "jira.update-link-type",
      identity: "PUT /rest/api/2/issueLinkType/{issueLinkTypeId}",
      permissionPolicy: "instance-admin-link-type-update-and-readback",
    },
    {
      tool: "jira.delete-link-type",
      identity: "DELETE /rest/api/2/issueLinkType/{issueLinkTypeId}",
      permissionPolicy: "instance-admin-link-type-delete-unconfirmed",
    },
    {
      tool: "jira.reset-link-type-order",
      identity: "PUT /rest/api/2/issueLinkType/order",
      permissionPolicy: "instance-admin-link-type-order-unconfirmed",
    },
    {
      tool: "jira.move-link-type",
      identity: "PUT /rest/api/2/issueLinkType/{issueLinkTypeId}/order",
      permissionPolicy: "instance-admin-link-type-order-unconfirmed",
    },
    {
      tool: "jira.set-terminology",
      identity: "POST /rest/api/2/terminology/entries",
      permissionPolicy: "instance-admin-terminology-and-readback",
    },
    {
      tool: "jira.set-application-role",
      identity: "PUT /rest/api/2/applicationrole/{key}",
      permissionPolicy: "instance-admin-application-role-cas-unconfirmed",
    },
    {
      tool: "jira.set-application-roles",
      identity: "PUT /rest/api/2/applicationrole",
      permissionPolicy: "instance-admin-application-role-cas-unconfirmed",
    },
    {
      tool: "jira.add-user-application",
      identity: "POST /rest/api/2/user/application",
      permissionPolicy: "instance-admin-user-application-unconfirmed",
    },
    {
      tool: "jira.remove-user-application",
      identity: "DELETE /rest/api/2/user/application",
      permissionPolicy: "instance-admin-user-application-unconfirmed",
    },
    {
      tool: "jira.set-user-columns",
      identity: "PUT /rest/api/2/user/columns",
      permissionPolicy: "instance-admin-user-columns-and-readback",
    },
    {
      tool: "jira.reset-user-columns",
      identity: "DELETE /rest/api/2/user/columns",
      permissionPolicy: "instance-admin-user-columns-reset-unconfirmed",
    },
  ] as const)(
    "binds directory/schema/maintenance/action $tool to its independent native identity",
    ({ tool, identity, permissionPolicy }) => {
      expect(jiraOperationForTool(tool)?.definition).toMatchObject({
        kind: "native",
        identity,
        permissionPolicy,
        effects: ["remote-read", "remote-write"],
      });
    },
  );
  it("binds every administration write to an explicit instance-admin permission contract", () => {
    const writes = jiraOperationContracts().filter((entry) =>
      entry.definition.effects.includes("remote-write"),
    );
    const admin = writes.filter((entry) =>
      entry.definition.permissionPolicy.startsWith("instance-admin-"),
    );
    expect(admin).toHaveLength(139);
    const established = admin.filter(
      ({ definition }) =>
        definition.tool !== "jira.set-user-property" &&
        definition.tool !== "jira.delete-user-property",
    );
    expect(established).toHaveLength(137);
    const byScope = writes.filter(
      ({ definition }) => jiraRequiredConnectorScope(definition.tool) === "issue-tracker.admin",
    );
    const byClass = writes.filter(
      ({ definition }) =>
        ATLASSIAN_CONNECTOR_ACTION_CLASS[JIRA_MANAGED_ACTION_TYPES[definition.tool]] ===
        "connector-admin",
    );
    const expected = new Set(admin.map(({ definition }) => definition.tool));
    expect(new Set(byScope.map(({ definition }) => definition.tool))).toEqual(expected);
    expect(new Set(byClass.map(({ definition }) => definition.tool))).toEqual(expected);
    for (const contract of admin) {
      expect(contract.definition.effects).toContain("remote-write");
      expect(isJiraOperationBinding(contract.binding)).toBe(true);
    }
    expect(jiraOperationForTool("jira.set-issue-property")?.definition.permissionPolicy).toBe(
      "entity-property-and-readback",
    );
  });
  it.each([
    { tool: "jira.set-user-property", identity: "PUT /rest/api/2/user/properties/{propertyKey}" },
    {
      tool: "jira.delete-user-property",
      identity: "DELETE /rest/api/2/user/properties/{propertyKey}",
    },
  ] as const)(
    "requires administration for the exact user-property identity $tool",
    ({ tool, identity }) => {
      expect(jiraOperationForTool(tool)?.definition).toMatchObject({
        kind: "native",
        identity,
        effects: ["remote-read", "remote-write"],
        permissionPolicy: "instance-admin-entity-property-and-readback",
      });
      expect(jiraRequiredConnectorScope(tool)).toBe("issue-tracker.admin");
    },
  );
  it("keeps admin diagnostic observations read-only and two POST observations outside mutation authority", () => {
    for (const tool of [
      "jira.anonymization-validation",
      "jira.anonymization-rerun-validation",
      "jira.anonymization-progress",
    ] as const) {
      const contract = jiraOperationForTool(tool);
      expect(jiraRequiredConnectorScope(tool)).toBe("issue-tracker.admin");
      expect(contract?.declaration.risk).toBe("read");
      expect(contract?.definition.effects).toEqual(["remote-read"]);
      expect(contract?.definition.permissionPolicy).toBe(
        "instance-admin-anonymization-observation",
      );
    }
    for (const tool of ["jira.search-post", "jira.worklogs-by-id"] as const) {
      const contract = jiraOperationForTool(tool);
      expect(jiraRequiredConnectorScope(tool)).toBe("issue-tracker.read");
      expect(contract?.definition).toMatchObject({ method: "POST", effects: ["remote-read"] });
      expect(contract?.declaration.risk).toBe("read");
    }
    expect(jiraOperationForTool("jira.current-session")?.definition).toMatchObject({
      identity: "GET /rest/auth/1/session",
      apiRoot: "/rest/auth/1",
      effects: ["remote-read"],
    });
  });
  it("reads a closed historical binding without granting current execution authority", () => {
    const contract = jiraOperationForTool("jira.comment");
    if (contract === undefined) throw new TypeError("Missing comment contract");
    const historical = { ...contract.binding, contractDigest: "0".repeat(64) };
    expect(isJiraOperationBinding(historical)).toBe(true);
    expect(matchesJiraOperationBinding(contract, historical)).toBe(false);
    for (const invalid of [
      { ...historical, identity: "" },
      { ...historical, identity: "a".repeat(193) },
      { ...historical, identity: "POST\n/rest/api/2/issue" },
      { ...historical, contractDigest: "x".repeat(64) },
      { ...historical, [Symbol("extra")]: true },
      Object.assign(Object.create({ inherited: true }) as object, historical),
      {
        get identity(): never {
          throw new TypeError("Accessor must not run");
        },
        contractDigest: historical.contractDigest,
      },
    ])
      expect(isJiraOperationBinding(invalid)).toBe(false);
  });
  it("keeps executable native operations distinct from local compositions", () => {
    const entries = jiraOperationContracts();
    expect(entries.filter((entry) => entry.definition.kind === "native")).toHaveLength(439);
    expect(
      entries
        .filter((entry) => entry.definition.kind === "composite")
        .map((entry) => entry.definition.tool)
        .sort(),
    ).toEqual(["jira.draft", "jira.draft-batch", "jira.draft-stage", "jira.report"]);
    expect(jiraOperationForTool("jira.discover")).toBeUndefined();
    expect(jiraOperationForTool("DELETE /rest/api/2/project")).toBeUndefined();
    expect(new Set(entries.map((entry) => entry.definition.deployment))).toEqual(
      new Set(["data-center"]),
    );
    expect(
      entries.every((entry) => Object.isFrozen(entry.binding) && Object.isFrozen(entry.definition)),
    ).toBe(true);
  });

  it("binds complete native invocation effects to the independently declared tool risk", () => {
    for (const { definition, declaration } of jiraOperationContracts()) {
      if (definition.kind !== "native") continue;
      // A native write includes its prerequisite and confirmation reads. Its primary method/path
      // remains pinned separately above, including the three read-only POST validators.
      expect(definition.effects).toEqual(
        declaration.risk === "read" ? ["remote-read"] : ["remote-read", "remote-write"],
      );
    }
  });

  it("changes the binding when typed input, result bounds or permissions change", () => {
    const original = JIRA_MUTATION_DECLARATIONS.find((item) => item.name === "jira.comment");
    if (original === undefined) throw new TypeError("Missing comment declaration");
    const contract = createJiraOperationContract(original);
    expect(createJiraOperationContract(original)).toEqual(contract);
    const { descriptorDigest: _digest, ...declaration } = original.descriptor;
    for (const change of [
      {
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      },
      { bounds: { ...declaration.bounds, maxResultBytes: declaration.bounds.maxResultBytes + 1 } },
      { policyReferences: [...declaration.policyReferences, "test.permission-policy"] },
    ]) {
      const changed = createJiraOperationContract({
        ...original,
        descriptor: createToolDescriptor({ ...declaration, ...change }),
      });
      expect(changed.binding.contractDigest).not.toBe(contract.binding.contractDigest);
      expect(changed.declaration.descriptor.descriptorDigest).not.toBe(
        contract.declaration.descriptor.descriptorDigest,
      );
      expect(matchesJiraOperationBinding(changed, contract.binding)).toBe(false);
    }
    expect(() => createJiraOperationContract({ ...original, risk: "read" })).toThrow("effect");
    expect(() => createJiraOperationContract({ ...original, name: "jira.unregistered" })).toThrow(
      "Unknown Jira operation",
    );
  });

  it("rejects foreign, stale and extended operation bindings", () => {
    const contract = jiraOperationForTool("jira.comment");
    if (contract === undefined) throw new TypeError("Missing comment contract");
    expect(matchesJiraOperationBinding(contract, structuredClone(contract.binding))).toBe(true);
    for (const binding of [
      undefined,
      null,
      [],
      {},
      { ...contract.binding, identity: "POST /rest/api/2/issue" },
      { ...contract.binding, contractDigest: "0".repeat(64) },
      { ...contract.binding, authority: "allowed" },
    ])
      expect(matchesJiraOperationBinding(contract, binding)).toBe(false);
  });

  it("invalidates the draft contract when a constituent contract changes", () => {
    const before = createJiraOperationContracts(JIRA_MUTATION_DECLARATIONS);
    const after = createJiraOperationContracts(
      JIRA_MUTATION_DECLARATIONS.map((declaration) => {
        if (declaration.name !== "jira.create") return declaration;
        const { descriptorDigest: _digest, ...descriptor } = declaration.descriptor;
        return {
          ...declaration,
          descriptor: createToolDescriptor({
            ...descriptor,
            policyReferences: [...descriptor.policyReferences, "test.changed-create-policy"],
          }),
        };
      }),
    );
    expect(
      after.find((entry) => entry.definition.tool === "jira.draft")?.binding.contractDigest,
    ).not.toBe(
      before.find((entry) => entry.definition.tool === "jira.draft")?.binding.contractDigest,
    );
    expect(
      after.find((entry) => entry.definition.tool === "jira.comment")?.binding.contractDigest,
    ).toBe(
      before.find((entry) => entry.definition.tool === "jira.comment")?.binding.contractDigest,
    );
  });

  it("keeps Cloud outside the Data Center operation path", async () => {
    const http = vi.fn();
    const provider = createJiraProviderForCatalog(
      () => ({
        deployment: "cloud",
        baseUrl: "https://jira.example.invalid",
        http,
      }),
      ["jira.projects"],
    );
    const result = await provider.tools()[0]?.execute(
      {},
      {
        invocationId: "cloud-refusal",
        correlationId: "synthetic",
        signal: new AbortController().signal,
        beforeEffect: () => true,
      },
    );
    expect(result).toMatchObject({
      isError: true,
      data: { outcome: "failed", reason: "unsupported-deployment" },
    });
    expect(http).not.toHaveBeenCalled();
  });

  it("binds catalog validation and results to the native operation contract", () => {
    const provider = createJiraProviderForCatalog(vi.fn(), ["jira.projects"]);
    const descriptor = provider.tools()[0]?.descriptor;
    expect(descriptor?.toolRef.contractVersion).toBe(3);
    expect(descriptor?.policyReferences).toContainEqual(
      expect.stringMatching(/^jira-operation-contract\.[a-f0-9]{64}$/u),
    );
    expect(descriptor?.resultSchema.required).toContain("operationBinding");
  });

  it("overwrites a provider-supplied binding with the reviewed server contract", async () => {
    const provider = createJiraProviderForCatalog(
      () => ({
        deployment: "data-center",
        baseUrl: "https://jira.example.invalid/context",
        http: vi.fn(),
      }),
      ["jira.comment"],
      vi.fn(() =>
        Promise.resolve({
          data: {
            outcome: "succeeded",
            operationBinding: {
              identity: "DELETE /rest/api/2/project",
              contractDigest: "0".repeat(64),
            },
          },
        }),
      ),
    );
    const result = await provider.tools()[0]?.execute(
      { issueKey: "SYN-1", body: "Approved" },
      {
        invocationId: "synthetic",
        correlationId: "synthetic",
        signal: new AbortController().signal,
        beforeEffect: () => true,
      },
    );
    expect(result?.data.operationBinding).toHaveProperty(
      "identity",
      "POST /rest/api/2/issue/{issueIdOrKey}/comment",
    );
    expect(result?.data.operationBinding).toHaveProperty(
      "contractDigest",
      expect.stringMatching(/^[a-f0-9]{64}$/u),
    );
    expect(result?.data.operationBinding).not.toHaveProperty("contractDigest", "0".repeat(64));
  });
});
