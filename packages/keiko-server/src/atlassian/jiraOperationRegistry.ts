import {
  JIRA_MANAGED_ACTION_TYPES,
  type JiraManagedReadToolName,
  type JiraMutationOperation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
  type ToolDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import {
  createToolDescriptor,
  createToolRef,
  ToolCatalogError,
} from "@oscharko-dev/keiko-tool-catalog";

export type JiraOperationTool = JiraManagedReadToolName | JiraMutationOperation;
type CompositeTool = "jira.report" | "jira.draft-stage" | "jira.draft-batch" | "jira.draft";
type NativeTool = Exclude<JiraOperationTool, CompositeTool>;
type JiraOperationEffect = "remote-read" | "remote-write" | "local-report" | "local-draft";
type JiraPermissionPolicy =
  | "instance-admin-human-attested-anonymization-unlock"
  | "instance-admin-avatar-session-and-uncertainty"
  | "instance-admin-user-lifecycle-and-uncertainty"
  | "issue-lifecycle-and-uncertainty"
  | "bulk-current-metadata-and-uncertainty"
  | "instance-admin-configured-reciprocal-link-and-uncertainty"
  | "instance-admin-project-lifecycle-and-uncertainty"
  | "bound-protected-account-and-readback"
  | "bound-private-session-and-uncertainty"
  | "bound-protected-password-policy"
  | "instance-admin-protected-license-validation"
  | "instance-admin-group-create-and-readback"
  | "instance-admin-group-delete-unconfirmed"
  | "instance-admin-group-membership-unconfirmed"
  | "comment-pin-and-readback"
  | "issue-notification-unconfirmed"
  | "instance-admin-maintenance-request-unconfirmed"
  | "instance-admin-custom-field-create-unconfirmed"
  | "instance-admin-custom-field-delete-unconfirmed"
  | "instance-admin-issue-type-create-unconfirmed"
  | "instance-admin-issue-type-update-and-readback"
  | "instance-admin-issue-type-delete-and-migration-unconfirmed"
  | "instance-admin-link-type-create-and-readback"
  | "instance-admin-link-type-update-and-readback"
  | "instance-admin-link-type-delete-unconfirmed"
  | "instance-admin-link-type-order-unconfirmed"
  | "instance-admin-terminology-and-readback"
  | "instance-admin-application-role-cas-unconfirmed"
  | "instance-admin-user-application-unconfirmed"
  | "instance-admin-user-columns-and-readback"
  | "instance-admin-user-columns-reset-unconfirmed"
  | "instance-admin-issue-type-scheme-config-and-readback"
  | "instance-admin-issue-type-scheme-delete-unconfirmed"
  | "instance-admin-issue-type-scheme-projects-unconfirmed"
  | "instance-admin-priority-scheme-config-and-readback"
  | "instance-admin-priority-scheme-delete-unconfirmed"
  | "instance-admin-workflow-scheme-config-and-readback"
  | "instance-admin-workflow-scheme-update-and-scope-uncertainty"
  | "instance-admin-workflow-scheme-delete-unconfirmed"
  | "instance-admin-workflow-draft-config-and-readback"
  | "instance-admin-workflow-draft-delete-and-parent-readback"
  | "instance-admin-workflow-scheme-mapping-unconfirmed"
  | "instance-admin-application-property-and-readback"
  | "instance-admin-system-columns-and-readback"
  | "instance-admin-base-url-config-unconfirmed"
  | "instance-admin-read-only-config-and-readback"
  | "instance-admin-email-template-upload-unconfirmed"
  | "instance-admin-email-template-apply-unconfirmed"
  | "instance-admin-email-template-revert-unconfirmed"
  | "instance-admin-email-template-archive-observation"
  | "instance-admin-role-create-and-readback"
  | "instance-admin-role-update-and-readback"
  | "instance-admin-role-replace-and-readback"
  | "instance-admin-role-delete-unconfirmed"
  | "instance-admin-role-default-actors-unconfirmed"
  | "instance-admin-project-role-actors-unconfirmed"
  | "instance-admin-permission-scheme-create-and-readback"
  | "instance-admin-permission-scheme-update-and-readback"
  | "instance-admin-permission-scheme-delete-unconfirmed"
  | "instance-admin-permission-grant-add-and-readback"
  | "instance-admin-permission-grant-delete-and-absence"
  | "instance-admin-permission-attribute-and-readback"
  | "instance-admin-project-category-create-and-readback"
  | "instance-admin-project-category-update-and-readback"
  | "instance-admin-project-category-delete-unconfirmed"
  | "version-remote-link-upsert-and-readback"
  | "version-remote-link-delete-and-absence"
  | "version-remote-links-delete-and-absence"
  | "epic-removal-and-readback"
  | "rank-and-position-uncertainty"
  | "issue-estimation-and-readback"
  | "instance-admin-default-screen-field-unconfirmed"
  | "instance-admin-screen-field-add-and-readback"
  | "instance-admin-screen-field-delete-and-absence"
  | "instance-admin-screen-field-order-and-readback"
  | "instance-admin-screen-field-display-and-readback"
  | "instance-admin-screen-tab-order-and-readback"
  | "board-delete-unconfirmed"
  | "board-refined-velocity-and-readback"
  | "sprint-replace-and-readback"
  | "sprint-delete-and-membership-uncertainty"
  | "sprint-swap-and-position-uncertainty"
  | "sprint-unmap-and-readback"
  | "instance-admin-sprint-unmap-all-unconfirmed"
  | "issue-link-create-and-readback"
  | "issue-link-delete-and-absence"
  | "remote-link-upsert-and-readback"
  | "remote-link-update-and-readback"
  | "remote-link-delete-and-absence"
  | "component-delete-and-reference-uncertainty"
  | "version-merge-and-reference-uncertainty"
  | "version-order-and-readback"
  | "version-delete-swap-and-reference-uncertainty"
  | "native-visible-requested-worklogs"
  | "instance-admin-anonymization-observation"
  | "bound-current-session"
  | "instance-admin-filter-create-default-sharing"
  | "owned-filter-metadata-and-readback"
  | "owned-filter-delete-unconfirmed"
  | "instance-admin-default-filter-sharing"
  | "owned-filter-columns-and-readback"
  | "instance-admin-filter-permission-and-readback"
  | "current-user-preference-and-readback"
  | "current-user-preference-delete-unconfirmed"
  | "native-visible-worklog-change-window"
  | "native-version-remote-links"
  | "admin-email-template-metadata"
  | "observed-application-settings"
  | "observed-account-diagnostics"
  | "entity-property-and-readback"
  | "instance-admin-entity-property-and-readback"
  | "instance-admin-monitoring-state-and-readback"
  | "instance-admin-screen-tab-create-and-readback"
  | "instance-admin-screen-tab-rename-and-readback"
  | "instance-admin-screen-tab-delete-and-absence"
  | "observed-column-layout"
  | "observed-maintenance-status"
  | "admin-workflow-configuration"
  | "visible-custom-field-configuration"
  | "observed-terminology"
  | "visible-jql-metadata"
  | "board-issue-estimation"
  | "scoped-user-candidates"
  | "visible-directory-suggestions"
  | "visible-role-configuration"
  | "visible-priority-configuration"
  | "observed-instance-metadata"
  | "permission-definitions"
  | "current-actor-metadata"
  | "visible-issue-metadata"
  | "visible-permission-configuration"
  | "visible-security-configuration"
  | "visible-notification-configuration"
  | "visible-users"
  | "visible-groups"
  | "admin-application-roles"
  | "visible-projects"
  | "admin-workflow-schemes"
  | "admin-issue-type-schemes"
  | "visible-screen-configuration"
  | "current-project-metadata"
  | "native-project-key-validation"
  | "explicit-project-permissions"
  | "accessible-project-type"
  | "project-create-and-readback"
  | "project-update-and-readback"
  | "visible-boards"
  | "visible-sprints"
  | "visible-epics"
  | "visible-filters"
  | "board-create-and-readback"
  | "sprint-create-and-readback"
  | "sprint-update-and-readback"
  | "issue-membership-and-readback"
  | "epic-update-and-readback"
  | "visible-components"
  | "attachment-availability"
  | "visible-attachments"
  | "visible-avatars"
  | "visible-dashboards"
  | "visible-filter-permissions"
  | "authenticated-user-preferences"
  | "visible-comments"
  | "visible-link-types"
  | "visible-issue-links"
  | "visible-worklogs"
  | "visible-watchers"
  | "visible-voters"
  | "current-user-watch-and-readback"
  | "current-user-vote-and-readback"
  | "worklog-create-and-readback"
  | "worklog-update-and-readback"
  | "comment-update-and-readback"
  | "comment-delete-and-absence"
  | "attachment-delete-and-absence"
  | "worklog-delete-and-absence"
  | "visible-versions"
  | "component-create-and-readback"
  | "component-update-and-readback"
  | "version-create-and-readback"
  | "version-update-and-readback"
  | "current-create-metadata"
  | "current-edit-metadata"
  | "visible-issues"
  | "current-transitions"
  | "current-assignable-users"
  | "comment-create-and-readback"
  | "attachment-create-and-readback"
  | "composed-current-metadata";

interface OperationDefinitionBase {
  readonly tool: JiraOperationTool;
  readonly deployment: "data-center";
  readonly identity: string;
  readonly effects: readonly JiraOperationEffect[];
  /** Existing Keiko policy owner; the registry never grants permissions. */
  readonly authorityAction: (typeof JIRA_MANAGED_ACTION_TYPES)[JiraOperationTool];
  /** Existing handler metadata plus Jira's response remain the permission decision. */
  readonly permissionPolicy: JiraPermissionPolicy;
}
export type JiraOperationDefinition = OperationDefinitionBase &
  (
    | {
        readonly kind: "native";
        readonly method: "GET" | "POST" | "PUT" | "DELETE";
        readonly apiRoot: "/rest/api/2" | "/rest/agile/1.0" | "/rest/auth/1";
        readonly pathTemplate: string;
        /** Create/edit may add the already-approved bounded issue links through their owner. */
        readonly continuationPolicy: "none" | "approved-issue-links";
      }
    | { readonly kind: "composite"; readonly members: readonly JiraOperationTool[] }
  );
export interface JiraOperationBinding extends CatalogJsonObject {
  readonly identity: string;
  readonly contractDigest: string;
}
export interface JiraOperationContract {
  readonly definition: JiraOperationDefinition;
  readonly declaration: ManagedMcpToolDeclaration;
  readonly binding: JiraOperationBinding;
}

type JiraApiRoot = "/rest/api/2" | "/rest/agile/1.0" | "/rest/auth/1";
type NativeSpecification = readonly [
  "GET" | "POST" | "PUT" | "DELETE",
  "read" | "write",
  string,
  JiraPermissionPolicy,
  JiraApiRoot?,
];
type NativeGroup<K extends NativeTool> = Readonly<Record<K, NativeSpecification>>;
function reads<const K extends NativeTool>(
  permissionPolicy: JiraPermissionPolicy,
  paths: Readonly<Record<K, string>>,
  root: JiraApiRoot = "/rest/api/2",
): NativeGroup<K> {
  const result: Partial<Record<K, NativeSpecification>> = {};
  for (const tool in paths) {
    if (Object.hasOwn(paths, tool))
      result[tool] = ["GET", "read", paths[tool], permissionPolicy, root];
  }
  return result as NativeGroup<K>;
}
function writes<const K extends NativeTool>(
  permissionPolicy: JiraPermissionPolicy,
  paths: Readonly<Record<K, readonly ["POST" | "PUT" | "DELETE", string]>>,
  root: JiraApiRoot = "/rest/api/2",
): NativeGroup<K> {
  const result: Partial<Record<K, NativeSpecification>> = {};
  for (const tool in paths) {
    if (!Object.hasOwn(paths, tool)) continue;
    const [method, path] = paths[tool];
    result[tool] = [method, "write", path, permissionPolicy, root];
  }
  return result as NativeGroup<K>;
}
const NATIVE: Readonly<Record<NativeTool, NativeSpecification>> = {
  ...writes("instance-admin-human-attested-anonymization-unlock", {
    "jira.unlock-user-anonymization": ["DELETE", "/user/anonymization/unlock"],
  }),
  ...writes("instance-admin-avatar-session-and-uncertainty", {
    "jira.upload-temporary-avatar": ["POST", "/avatar/{type}/temporary"],
    "jira.crop-temporary-avatar": ["POST", "/avatar/{type}/temporaryCrop"],
    "jira.upload-issue-type-avatar": ["POST", "/issuetype/{id}/avatar/temporary"],
    "jira.create-issue-type-avatar": ["POST", "/issuetype/{id}/avatar"],
    "jira.upload-project-avatar": ["POST", "/project/{projectIdOrKey}/avatar/temporary"],
    "jira.create-project-avatar": ["POST", "/project/{projectIdOrKey}/avatar"],
    "jira.set-project-avatar": ["PUT", "/project/{projectIdOrKey}/avatar"],
    "jira.delete-project-avatar": ["DELETE", "/project/{projectIdOrKey}/avatar/{id}"],
    "jira.upload-owned-avatar": [
      "POST",
      "/universal_avatar/type/{type}/owner/{owningObjectId}/temp",
    ],
    "jira.create-owned-avatar": [
      "POST",
      "/universal_avatar/type/{type}/owner/{owningObjectId}/avatar",
    ],
    "jira.delete-owned-avatar": [
      "DELETE",
      "/universal_avatar/type/{type}/owner/{owningObjectId}/avatar/{id}",
    ],
    "jira.upload-user-avatar": ["POST", "/user/avatar/temporary"],
    "jira.create-user-avatar": ["POST", "/user/avatar"],
    "jira.set-user-avatar": ["PUT", "/user/avatar"],
    "jira.delete-user-avatar": ["DELETE", "/user/avatar/{id}"],
  }),
  ...writes("instance-admin-user-lifecycle-and-uncertainty", {
    "jira.create-user": ["POST", "/user"],
    "jira.update-user": ["PUT", "/user"],
    "jira.delete-user": ["DELETE", "/user"],
    "jira.invalidate-user-session": ["DELETE", "/user/session/{username}"],
    "jira.schedule-user-anonymization": ["POST", "/user/anonymization"],
    "jira.rerun-user-anonymization": ["POST", "/user/anonymization/rerun"],
  }),
  ...writes("issue-lifecycle-and-uncertainty", {
    "jira.archive-issues": ["POST", "/issue/archive"],
    "jira.delete-issue": ["DELETE", "/issue/{issueIdOrKey}"],
    "jira.archive-issue": ["PUT", "/issue/{issueIdOrKey}/archive"],
    "jira.restore-issue": ["PUT", "/issue/{issueIdOrKey}/restore"],
    "jira.move-subtask": ["POST", "/issue/{issueIdOrKey}/subtask/move"],
  }),
  ...writes("bulk-current-metadata-and-uncertainty", {
    "jira.create-issues": ["POST", "/issue/bulk"],
  }),
  ...writes("instance-admin-configured-reciprocal-link-and-uncertainty", {
    "jira.create-reciprocal-remote-link": ["POST", "/issue/remotelink/reciprocal"],
  }),
  ...writes("instance-admin-project-lifecycle-and-uncertainty", {
    "jira.delete-project": ["DELETE", "/project/{projectIdOrKey}"],
    "jira.archive-project": ["PUT", "/project/{projectIdOrKey}/archive"],
    "jira.restore-project": ["PUT", "/project/{projectIdOrKey}/restore"],
    "jira.update-project-type": ["PUT", "/project/{projectIdOrKey}/type/{newProjectTypeKey}"],
    "jira.set-project-permission-scheme": ["PUT", "/project/{projectKeyOrId}/permissionscheme"],
    "jira.set-project-priority-scheme": ["PUT", "/project/{projectKeyOrId}/priorityscheme"],
    "jira.remove-project-priority-scheme": [
      "DELETE",
      "/project/{projectKeyOrId}/priorityscheme/{schemeId}",
    ],
  }),
  ...writes("bound-protected-account-and-readback", {
    "jira.update-myself": ["PUT", "/myself"],
    "jira.update-my-password": ["PUT", "/myself/password"],
  }),
  ...writes("instance-admin-user-lifecycle-and-uncertainty", {
    "jira.update-user-password": ["PUT", "/user/password"],
  }),
  ...writes(
    "bound-private-session-and-uncertainty",
    {
      "jira.login": ["POST", "/session"],
      "jira.logout": ["DELETE", "/session"],
      "jira.release-websudo": ["DELETE", "/websudo"],
    },
    "/rest/auth/1",
  ),
  "jira.validate-create-user-password": [
    "POST",
    "read",
    "/password/policy/createUser",
    "bound-protected-password-policy",
    "/rest/api/2",
  ],
  "jira.validate-update-user-password": [
    "POST",
    "read",
    "/password/policy/updateUser",
    "bound-protected-password-policy",
    "/rest/api/2",
  ],
  "jira.validate-license": [
    "POST",
    "read",
    "/licenseValidator",
    "instance-admin-protected-license-validation",
    "/rest/api/2",
  ],
  ...writes("instance-admin-group-create-and-readback", {
    "jira.create-group": ["POST", "/group"],
  }),
  ...writes("instance-admin-group-delete-unconfirmed", {
    "jira.delete-group": ["DELETE", "/group"],
  }),
  ...writes("instance-admin-group-membership-unconfirmed", {
    "jira.add-group-user": ["POST", "/group/user"],
    "jira.remove-group-user": ["DELETE", "/group/user"],
  }),
  ...writes("comment-pin-and-readback", {
    "jira.pin-comment": ["PUT", "/issue/{issueIdOrKey}/comment/{id}/pin"],
  }),
  ...writes("issue-notification-unconfirmed", {
    "jira.notify-issue": ["POST", "/issue/{issueIdOrKey}/notify"],
  }),
  ...writes("instance-admin-maintenance-request-unconfirmed", {
    "jira.request-cluster-index-snapshot": ["PUT", "/cluster/index-snapshot/{nodeId}"],
    "jira.delete-cluster-node": ["DELETE", "/cluster/node/{nodeId}"],
    "jira.mark-cluster-node-offline": ["PUT", "/cluster/node/{nodeId}/offline"],
    "jira.approve-cluster-upgrade": ["POST", "/cluster/zdu/approve"],
    "jira.cancel-cluster-upgrade": ["POST", "/cluster/zdu/cancel"],
    "jira.retry-cluster-upgrade": ["POST", "/cluster/zdu/retryUpgrade"],
    "jira.start-cluster-upgrade": ["POST", "/cluster/zdu/start"],
    "jira.create-index-snapshot": ["POST", "/index-snapshot"],
    "jira.start-reindex": ["POST", "/reindex"],
    "jira.reindex-issues": ["POST", "/reindex/issue"],
    "jira.process-reindex-requests": ["POST", "/reindex/request"],
    "jira.run-upgrade": ["POST", "/upgrade"],
  }),
  ...writes("instance-admin-custom-field-create-unconfirmed", {
    "jira.create-custom-field": ["POST", "/field"],
  }),
  ...writes("instance-admin-custom-field-delete-unconfirmed", {
    "jira.delete-custom-fields": ["DELETE", "/customFields"],
  }),
  ...writes("instance-admin-issue-type-create-unconfirmed", {
    "jira.create-issue-type": ["POST", "/issuetype"],
  }),
  ...writes("instance-admin-issue-type-update-and-readback", {
    "jira.update-issue-type": ["PUT", "/issuetype/{id}"],
  }),
  ...writes("instance-admin-issue-type-delete-and-migration-unconfirmed", {
    "jira.delete-issue-type": ["DELETE", "/issuetype/{id}"],
  }),
  ...writes("instance-admin-link-type-create-and-readback", {
    "jira.create-link-type": ["POST", "/issueLinkType"],
  }),
  ...writes("instance-admin-link-type-update-and-readback", {
    "jira.update-link-type": ["PUT", "/issueLinkType/{issueLinkTypeId}"],
  }),
  ...writes("instance-admin-link-type-delete-unconfirmed", {
    "jira.delete-link-type": ["DELETE", "/issueLinkType/{issueLinkTypeId}"],
  }),
  ...writes("instance-admin-link-type-order-unconfirmed", {
    "jira.reset-link-type-order": ["PUT", "/issueLinkType/order"],
    "jira.move-link-type": ["PUT", "/issueLinkType/{issueLinkTypeId}/order"],
  }),
  ...writes("instance-admin-terminology-and-readback", {
    "jira.set-terminology": ["POST", "/terminology/entries"],
  }),
  ...writes("instance-admin-application-role-cas-unconfirmed", {
    "jira.set-application-role": ["PUT", "/applicationrole/{key}"],
    "jira.set-application-roles": ["PUT", "/applicationrole"],
  }),
  ...writes("instance-admin-user-application-unconfirmed", {
    "jira.add-user-application": ["POST", "/user/application"],
    "jira.remove-user-application": ["DELETE", "/user/application"],
  }),
  ...writes("instance-admin-user-columns-and-readback", {
    "jira.set-user-columns": ["PUT", "/user/columns"],
  }),
  ...writes("instance-admin-user-columns-reset-unconfirmed", {
    "jira.reset-user-columns": ["DELETE", "/user/columns"],
  }),
  ...writes("instance-admin-issue-type-scheme-config-and-readback", {
    "jira.create-issue-type-scheme": ["POST", "/issuetypescheme"],
    "jira.update-issue-type-scheme": ["PUT", "/issuetypescheme/{schemeId}"],
  }),
  ...writes("instance-admin-issue-type-scheme-delete-unconfirmed", {
    "jira.delete-issue-type-scheme": ["DELETE", "/issuetypescheme/{schemeId}"],
  }),
  ...writes("instance-admin-issue-type-scheme-projects-unconfirmed", {
    "jira.add-issue-type-scheme-projects": ["POST", "/issuetypescheme/{schemeId}/associations"],
    "jira.set-issue-type-scheme-projects": ["PUT", "/issuetypescheme/{schemeId}/associations"],
    "jira.clear-issue-type-scheme-projects": ["DELETE", "/issuetypescheme/{schemeId}/associations"],
    "jira.remove-issue-type-scheme-project": [
      "DELETE",
      "/issuetypescheme/{schemeId}/associations/{projIdOrKey}",
    ],
  }),
  ...writes("instance-admin-priority-scheme-config-and-readback", {
    "jira.create-priority-scheme": ["POST", "/priorityschemes"],
    "jira.update-priority-scheme": ["PUT", "/priorityschemes/{schemeId}"],
  }),
  ...writes("instance-admin-priority-scheme-delete-unconfirmed", {
    "jira.delete-priority-scheme": ["DELETE", "/priorityschemes/{schemeId}"],
  }),
  ...writes("instance-admin-workflow-scheme-config-and-readback", {
    "jira.create-workflow-scheme": ["POST", "/workflowscheme"],
  }),
  ...writes("instance-admin-workflow-scheme-update-and-scope-uncertainty", {
    "jira.update-workflow-scheme": ["PUT", "/workflowscheme/{id}"],
  }),
  ...writes("instance-admin-workflow-scheme-delete-unconfirmed", {
    "jira.delete-workflow-scheme": ["DELETE", "/workflowscheme/{id}"],
  }),
  ...writes("instance-admin-workflow-draft-config-and-readback", {
    "jira.create-workflow-scheme-draft": ["POST", "/workflowscheme/{id}/createdraft"],
    "jira.update-workflow-scheme-draft": ["PUT", "/workflowscheme/{id}/draft"],
  }),
  ...writes("instance-admin-workflow-draft-delete-and-parent-readback", {
    "jira.delete-workflow-scheme-draft": ["DELETE", "/workflowscheme/{id}/draft"],
  }),
  ...writes("instance-admin-workflow-scheme-mapping-unconfirmed", {
    "jira.set-workflow-scheme-default": ["PUT", "/workflowscheme/{id}/default"],
    "jira.delete-workflow-scheme-default": ["DELETE", "/workflowscheme/{id}/default"],
  }),
  ...writes("instance-admin-workflow-draft-config-and-readback", {
    "jira.set-workflow-scheme-draft-default": ["PUT", "/workflowscheme/{id}/draft/default"],
    "jira.delete-workflow-scheme-draft-default": ["DELETE", "/workflowscheme/{id}/draft/default"],
  }),
  ...writes("instance-admin-workflow-scheme-mapping-unconfirmed", {
    "jira.set-workflow-scheme-issue-type": ["PUT", "/workflowscheme/{id}/issuetype/{issueType}"],
    "jira.delete-workflow-scheme-issue-type": [
      "DELETE",
      "/workflowscheme/{id}/issuetype/{issueType}",
    ],
  }),
  ...writes("instance-admin-workflow-draft-config-and-readback", {
    "jira.set-workflow-scheme-draft-issue-type": [
      "PUT",
      "/workflowscheme/{id}/draft/issuetype/{issueType}",
    ],
    "jira.delete-workflow-scheme-draft-issue-type": [
      "DELETE",
      "/workflowscheme/{id}/draft/issuetype/{issueType}",
    ],
  }),
  ...writes("instance-admin-workflow-scheme-mapping-unconfirmed", {
    "jira.set-workflow-scheme-workflow": ["PUT", "/workflowscheme/{id}/workflow"],
    "jira.delete-workflow-scheme-workflow": ["DELETE", "/workflowscheme/{id}/workflow"],
  }),
  ...writes("instance-admin-workflow-draft-config-and-readback", {
    "jira.set-workflow-scheme-draft-workflow": ["PUT", "/workflowscheme/{id}/draft/workflow"],
    "jira.delete-workflow-scheme-draft-workflow": ["DELETE", "/workflowscheme/{id}/draft/workflow"],
  }),
  ...writes("instance-admin-application-property-and-readback", {
    "jira.set-application-property": ["PUT", "/application-properties/{id}"],
  }),
  ...writes("instance-admin-system-columns-and-readback", {
    "jira.set-system-columns": ["PUT", "/settings/columns"],
  }),
  ...writes("instance-admin-base-url-config-unconfirmed", {
    "jira.set-instance-base-url": ["PUT", "/settings/baseUrl"],
  }),
  ...writes("instance-admin-read-only-config-and-readback", {
    "jira.set-read-only-mode": ["PUT", "/readonly-mode"],
  }),
  ...writes("instance-admin-email-template-upload-unconfirmed", {
    "jira.upload-email-template-pack": ["POST", "/email-templates"],
  }),
  ...writes("instance-admin-email-template-apply-unconfirmed", {
    "jira.apply-email-template-pack": ["POST", "/email-templates/apply"],
  }),
  ...writes("instance-admin-email-template-revert-unconfirmed", {
    "jira.revert-email-template-pack": ["POST", "/email-templates/revert"],
  }),
  ...reads("instance-admin-email-template-archive-observation", {
    "jira.email-template-pack": "/email-templates",
  }),
  ...writes("instance-admin-permission-scheme-create-and-readback", {
    "jira.create-permission-scheme": ["POST", "/permissionscheme"],
  }),
  ...writes("instance-admin-permission-scheme-update-and-readback", {
    "jira.update-permission-scheme": ["PUT", "/permissionscheme/{schemeId}"],
  }),
  ...writes("instance-admin-permission-scheme-delete-unconfirmed", {
    "jira.delete-permission-scheme": ["DELETE", "/permissionscheme/{schemeId}"],
  }),
  ...writes("instance-admin-permission-grant-add-and-readback", {
    "jira.add-permission-grant": ["POST", "/permissionscheme/{schemeId}/permission"],
  }),
  ...writes("instance-admin-permission-grant-delete-and-absence", {
    "jira.delete-permission-grant": [
      "DELETE",
      "/permissionscheme/{schemeId}/permission/{permissionId}",
    ],
  }),
  ...writes("instance-admin-permission-attribute-and-readback", {
    "jira.set-permission-scheme-attribute": [
      "PUT",
      "/permissionscheme/{permissionSchemeId}/attribute/{key}",
    ],
  }),
  ...writes("instance-admin-role-create-and-readback", {
    "jira.create-role": ["POST", "/role"],
  }),
  ...writes("instance-admin-role-update-and-readback", {
    "jira.update-role": ["POST", "/role/{id}"],
  }),
  ...writes("instance-admin-role-replace-and-readback", {
    "jira.replace-role": ["PUT", "/role/{id}"],
  }),
  ...writes("instance-admin-role-delete-unconfirmed", {
    "jira.delete-role": ["DELETE", "/role/{id}"],
  }),
  ...writes("instance-admin-role-default-actors-unconfirmed", {
    "jira.add-role-default-actors": ["POST", "/role/{id}/actors"],
    "jira.delete-role-default-actor": ["DELETE", "/role/{id}/actors"],
  }),
  ...writes("instance-admin-project-role-actors-unconfirmed", {
    "jira.add-project-role-actors": ["POST", "/project/{projectIdOrKey}/role/{id}"],
    "jira.set-project-role-actors": ["PUT", "/project/{projectIdOrKey}/role/{id}"],
    "jira.delete-project-role-actor": ["DELETE", "/project/{projectIdOrKey}/role/{id}"],
  }),
  ...writes("instance-admin-project-category-create-and-readback", {
    "jira.create-project-category": ["POST", "/projectCategory"],
  }),
  ...writes("instance-admin-project-category-update-and-readback", {
    "jira.update-project-category": ["PUT", "/projectCategory/{id}"],
  }),
  ...writes("instance-admin-project-category-delete-unconfirmed", {
    "jira.delete-project-category": ["DELETE", "/projectCategory/{id}"],
  }),
  ...writes("version-remote-link-upsert-and-readback", {
    "jira.upsert-version-remote-link": ["POST", "/version/{versionId}/remotelink"],
    "jira.upsert-version-remote-link-by-global-id": [
      "POST",
      "/version/{versionId}/remotelink/{globalId}",
    ],
  }),
  ...writes("version-remote-link-delete-and-absence", {
    "jira.delete-version-remote-link": ["DELETE", "/version/{versionId}/remotelink/{globalId}"],
  }),
  ...writes("version-remote-links-delete-and-absence", {
    "jira.delete-version-remote-links": ["DELETE", "/version/{versionId}/remotelink"],
  }),
  ...writes(
    "epic-removal-and-readback",
    {
      "jira.epic-remove-issues": ["POST", "/epic/none/issue"],
    },
    "/rest/agile/1.0",
  ),
  ...writes(
    "rank-and-position-uncertainty",
    {
      "jira.rank-epic": ["PUT", "/epic/{epicIdOrKey}/rank"],
      "jira.rank-issues": ["PUT", "/issue/rank"],
    },
    "/rest/agile/1.0",
  ),
  ...writes(
    "issue-estimation-and-readback",
    {
      "jira.set-issue-estimation": ["PUT", "/issue/{issueIdOrKey}/estimation"],
    },
    "/rest/agile/1.0",
  ),
  ...writes("instance-admin-default-screen-field-unconfirmed", {
    "jira.add-default-screen-field": ["POST", "/screens/addToDefault/{fieldId}"],
  }),
  ...writes("instance-admin-screen-field-add-and-readback", {
    "jira.add-screen-tab-field": ["POST", "/screens/{screenId}/tabs/{tabId}/fields"],
  }),
  ...writes("instance-admin-screen-field-delete-and-absence", {
    "jira.remove-screen-tab-field": ["DELETE", "/screens/{screenId}/tabs/{tabId}/fields/{id}"],
  }),
  ...writes("instance-admin-screen-field-order-and-readback", {
    "jira.move-screen-tab-field": ["POST", "/screens/{screenId}/tabs/{tabId}/fields/{id}/move"],
  }),
  ...writes("instance-admin-screen-field-display-and-readback", {
    "jira.set-screen-field-show-when-empty": [
      "PUT",
      "/screens/{screenId}/tabs/{tabId}/fields/{id}/updateShowWhenEmptyIndicator/{newValue}",
    ],
  }),
  ...writes("instance-admin-screen-tab-order-and-readback", {
    "jira.move-screen-tab": ["POST", "/screens/{screenId}/tabs/{tabId}/move/{pos}"],
  }),
  ...writes(
    "board-delete-unconfirmed",
    {
      "jira.delete-board": ["DELETE", "/board/{boardId}"],
    },
    "/rest/agile/1.0",
  ),
  ...writes(
    "board-refined-velocity-and-readback",
    {
      "jira.set-board-refined-velocity": ["PUT", "/board/{boardId}/settings/refined-velocity"],
    },
    "/rest/agile/1.0",
  ),
  ...writes(
    "sprint-replace-and-readback",
    {
      "jira.replace-sprint": ["PUT", "/sprint/{sprintId}"],
    },
    "/rest/agile/1.0",
  ),
  ...writes(
    "sprint-delete-and-membership-uncertainty",
    {
      "jira.delete-sprint": ["DELETE", "/sprint/{sprintId}"],
    },
    "/rest/agile/1.0",
  ),
  ...writes(
    "sprint-swap-and-position-uncertainty",
    {
      "jira.swap-sprints": ["POST", "/sprint/{sprintId}/swap"],
    },
    "/rest/agile/1.0",
  ),
  ...writes(
    "sprint-unmap-and-readback",
    {
      "jira.unmap-sprints": ["PUT", "/sprint/unmap"],
    },
    "/rest/agile/1.0",
  ),
  ...writes(
    "instance-admin-sprint-unmap-all-unconfirmed",
    {
      "jira.unmap-all-sprints": ["PUT", "/sprint/unmap-all"],
    },
    "/rest/agile/1.0",
  ),
  ...writes("issue-link-create-and-readback", {
    "jira.create-issue-link": ["POST", "/issueLink"],
  }),
  ...writes("issue-link-delete-and-absence", {
    "jira.delete-issue-link": ["DELETE", "/issueLink/{linkId}"],
  }),
  ...writes("remote-link-upsert-and-readback", {
    "jira.upsert-remote-link": ["POST", "/issue/{issueIdOrKey}/remotelink"],
  }),
  ...writes("remote-link-update-and-readback", {
    "jira.update-remote-link": ["PUT", "/issue/{issueIdOrKey}/remotelink/{linkId}"],
  }),
  ...writes("remote-link-delete-and-absence", {
    "jira.delete-remote-link": ["DELETE", "/issue/{issueIdOrKey}/remotelink/{linkId}"],
    "jira.delete-remote-link-by-global-id": ["DELETE", "/issue/{issueIdOrKey}/remotelink"],
  }),
  ...writes("component-delete-and-reference-uncertainty", {
    "jira.delete-component": ["DELETE", "/component/{id}"],
  }),
  ...writes("version-merge-and-reference-uncertainty", {
    "jira.merge-version": ["PUT", "/version/{id}/mergeto/{moveIssuesTo}"],
  }),
  ...writes("version-order-and-readback", {
    "jira.move-version": ["POST", "/version/{id}/move"],
  }),
  ...writes("version-delete-swap-and-reference-uncertainty", {
    "jira.remove-and-swap-version": ["POST", "/version/{id}/removeAndSwap"],
  }),
  "jira.search-post": ["POST", "read", "/search", "visible-issues"],
  "jira.worklogs-by-id": ["POST", "read", "/worklog/list", "native-visible-requested-worklogs"],
  ...reads("instance-admin-anonymization-observation", {
    "jira.anonymization-validation": "/user/anonymization",
    "jira.anonymization-rerun-validation": "/user/anonymization/rerun",
    "jira.anonymization-progress": "/user/anonymization/progress",
  }),
  ...reads("bound-current-session", { "jira.current-session": "/session" }, "/rest/auth/1"),
  ...writes("instance-admin-filter-create-default-sharing", {
    "jira.create-filter": ["POST", "/filter"],
  }),
  ...writes("owned-filter-metadata-and-readback", {
    "jira.update-filter": ["PUT", "/filter/{id}"],
  }),
  ...writes("owned-filter-delete-unconfirmed", {
    "jira.delete-filter": ["DELETE", "/filter/{id}"],
  }),
  ...writes("instance-admin-default-filter-sharing", {
    "jira.set-filter-share-scope": ["PUT", "/filter/defaultShareScope"],
  }),
  ...writes("owned-filter-columns-and-readback", {
    "jira.set-filter-columns": ["PUT", "/filter/{id}/columns"],
    "jira.reset-filter-columns": ["DELETE", "/filter/{id}/columns"],
  }),
  ...writes("instance-admin-filter-permission-and-readback", {
    "jira.add-filter-permission": ["POST", "/filter/{id}/permission"],
    "jira.delete-filter-permission": ["DELETE", "/filter/{id}/permission/{permission-id}"],
  }),
  ...writes("current-user-preference-and-readback", {
    "jira.set-my-preference": ["PUT", "/mypreferences"],
  }),
  ...writes("current-user-preference-delete-unconfirmed", {
    "jira.delete-my-preference": ["DELETE", "/mypreferences"],
  }),
  ...reads("native-visible-worklog-change-window", {
    "jira.deleted-worklogs": "/worklog/deleted",
    "jira.updated-worklogs": "/worklog/updated",
  }),
  ...reads("native-version-remote-links", {
    "jira.remote-version-links": "/version/remotelink",
    "jira.version-remote-links": "/version/{versionId}/remotelink",
    "jira.version-remote-link": "/version/{versionId}/remotelink/{globalId}",
  }),
  ...reads("visible-permission-configuration", {
    "jira.permission-scheme-attribute":
      "/permissionscheme/{permissionSchemeId}/attribute/{attributeKey}",
  }),
  ...reads("admin-email-template-metadata", {
    "jira.email-template-types": "/email-templates/types",
  }),
  ...reads("observed-application-settings", {
    "jira.application-properties": "/application-properties",
    "jira.advanced-settings": "/application-properties/advanced-settings",
    "jira.my-preference": "/mypreferences",
  }),
  ...reads("observed-account-diagnostics", {
    "jira.password-policy": "/password/policy",
    "jira.duplicate-user-count": "/user/duplicated/count",
    "jira.duplicate-users": "/user/duplicated/list",
    "jira.search-error": "/search/error/lookup",
  }),
  ...writes(
    "entity-property-and-readback",
    {
      "jira.set-board-property": ["PUT", "/board/{boardId}/properties/{propertyKey}"],
      "jira.delete-board-property": ["DELETE", "/board/{boardId}/properties/{propertyKey}"],
      "jira.set-sprint-property": ["PUT", "/sprint/{sprintId}/properties/{propertyKey}"],
      "jira.delete-sprint-property": ["DELETE", "/sprint/{sprintId}/properties/{propertyKey}"],
    },
    "/rest/agile/1.0",
  ),
  ...writes("entity-property-and-readback", {
    "jira.set-comment-property": ["PUT", "/comment/{commentId}/properties/{propertyKey}"],
    "jira.delete-comment-property": ["DELETE", "/comment/{commentId}/properties/{propertyKey}"],
    "jira.set-dashboard-item-property": [
      "PUT",
      "/dashboard/{dashboardId}/items/{itemId}/properties/{propertyKey}",
    ],
    "jira.delete-dashboard-item-property": [
      "DELETE",
      "/dashboard/{dashboardId}/items/{itemId}/properties/{propertyKey}",
    ],
    "jira.set-issue-property": ["PUT", "/issue/{issueIdOrKey}/properties/{propertyKey}"],
    "jira.delete-issue-property": ["DELETE", "/issue/{issueIdOrKey}/properties/{propertyKey}"],
    "jira.set-project-property": ["PUT", "/project/{projectIdOrKey}/properties/{propertyKey}"],
    "jira.delete-project-property": [
      "DELETE",
      "/project/{projectIdOrKey}/properties/{propertyKey}",
    ],
    "jira.set-user-property": ["PUT", "/user/properties/{propertyKey}"],
    "jira.delete-user-property": ["DELETE", "/user/properties/{propertyKey}"],
  }),
  ...writes("instance-admin-entity-property-and-readback", {
    "jira.set-issue-type-property": ["PUT", "/issuetype/{issueTypeId}/properties/{propertyKey}"],
    "jira.delete-issue-type-property": [
      "DELETE",
      "/issuetype/{issueTypeId}/properties/{propertyKey}",
    ],
  }),
  ...writes("instance-admin-monitoring-state-and-readback", {
    "jira.set-app-monitoring": ["POST", "/monitoring/app"],
    "jira.set-ipd-monitoring": ["POST", "/monitoring/ipd"],
    "jira.start-jmx-metrics": ["POST", "/monitoring/jmx/startExposing"],
    "jira.stop-jmx-metrics": ["POST", "/monitoring/jmx/stopExposing"],
  }),
  ...writes("instance-admin-screen-tab-create-and-readback", {
    "jira.create-screen-tab": ["POST", "/screens/{screenId}/tabs"],
  }),
  ...writes("instance-admin-screen-tab-rename-and-readback", {
    "jira.rename-screen-tab": ["PUT", "/screens/{screenId}/tabs/{tabId}"],
  }),
  ...writes("instance-admin-screen-tab-delete-and-absence", {
    "jira.delete-screen-tab": ["DELETE", "/screens/{screenId}/tabs/{tabId}"],
  }),
  ...reads("observed-column-layout", {
    "jira.system-columns": "/settings/columns",
    "jira.user-columns": "/user/columns",
    "jira.filter-columns": "/filter/{id}/columns",
  }),
  ...reads("observed-maintenance-status", {
    "jira.reindex-status": "/reindex",
    "jira.reindex-progress": "/reindex/progress",
    "jira.reindex-request": "/reindex/request/{requestId}",
    "jira.reindex-requests": "/reindex/request/bulk",
    "jira.upgrade-result": "/upgrade",
    "jira.index-snapshots": "/index-snapshot",
    "jira.app-monitoring": "/monitoring/app",
    "jira.ipd-monitoring": "/monitoring/ipd",
    "jira.jmx-metrics": "/monitoring/jmx/getAvailableMetrics",
    "jira.cluster-nodes": "/cluster/nodes",
    "jira.cluster-upgrade-state": "/cluster/zdu/state",
    "jira.index-snapshot-status": "/index-snapshot/isRunning",
    "jira.index-summary": "/index/summary",
  }),
  ...reads("admin-workflow-configuration", { "jira.workflows": "/workflow" }),
  ...reads("visible-custom-field-configuration", {
    "jira.custom-fields": "/customFields",
    "jira.custom-field-options": "/customFields/{customFieldId}/options",
  }),
  ...reads("observed-terminology", {
    "jira.terminology": "/terminology/entries",
    "jira.terminology-entry": "/terminology/entries/{originalName}",
  }),
  ...reads("visible-jql-metadata", {
    "jira.jql-autocomplete": "/jql/autocompletedata",
    "jira.jql-suggestions": "/jql/autocompletedata/suggestions",
  }),
  ...reads("scoped-user-candidates", {
    "jira.multi-project-assignable-users": "/user/assignable/multiProjectSearch",
    "jira.permission-users": "/user/permission/search",
    "jira.browse-permission-users": "/user/viewissue/search",
  }),
  ...reads("visible-directory-suggestions", {
    "jira.group-user-picker": "/groupuserpicker",
  }),
  ...reads("visible-role-configuration", {
    "jira.roles": "/role",
    "jira.role": "/role/{id}",
    "jira.role-default-actors": "/role/{id}/actors",
    "jira.project-roles": "/project/{projectIdOrKey}/role",
    "jira.project-role": "/project/{projectIdOrKey}/role/{id}",
  }),
  ...reads("visible-priority-configuration", {
    "jira.priority-schemes": "/priorityschemes",
    "jira.priority-scheme": "/priorityschemes/{schemeId}",
  }),
  ...reads("observed-instance-metadata", {
    "jira.jmx-metrics-exposed": "/monitoring/jmx/areMetricsExposed",
    "jira.search-max-aggregation-buckets": "/searchLimits/maxAggregationBuckets",
    "jira.search-max-result-window": "/searchLimits/maxResultWindow",
    "jira.read-only-mode": "/readonly-mode",
    "jira.server-info": "/serverInfo",
    "jira.instance-configuration": "/configuration",
  }),
  ...reads("permission-definitions", { "jira.permission-definitions": "/permissions" }),
  ...reads("current-actor-metadata", { "jira.myself": "/myself" }),
  ...reads("visible-issue-metadata", {
    "jira.issue-type-property-keys": "/issuetype/{issueTypeId}/properties",
    "jira.issue-type-property": "/issuetype/{issueTypeId}/properties/{propertyKey}",
    "jira.fields": "/field",
    "jira.custom-field-option": "/customFieldOption/{id}",
    "jira.global-issue-types": "/issuetype",
    "jira.issue-type": "/issuetype/{id}",
    "jira.issue-type-page": "/issuetype/page",
    "jira.issue-type-alternatives": "/issuetype/{id}/alternatives",
    "jira.priorities": "/priority",
    "jira.priority": "/priority/{id}",
    "jira.priority-page": "/priority/page",
    "jira.resolutions": "/resolution",
    "jira.resolution": "/resolution/{id}",
    "jira.resolution-page": "/resolution/page",
    "jira.statuses": "/status",
    "jira.status": "/status/{idOrName}",
    "jira.status-page": "/status/page",
    "jira.status-categories": "/statuscategory",
    "jira.status-category": "/statuscategory/{idOrKey}",
  }),
  ...reads("visible-permission-configuration", {
    "jira.project-permission-scheme": "/project/{projectKeyOrId}/permissionscheme",
    "jira.permission-schemes": "/permissionscheme",
    "jira.permission-scheme": "/permissionscheme/{schemeId}",
    "jira.permission-grants": "/permissionscheme/{schemeId}/permission",
    "jira.permission-grant": "/permissionscheme/{schemeId}/permission/{permissionId}",
  }),
  ...reads("visible-security-configuration", {
    "jira.project-issue-security-scheme": "/project/{projectKeyOrId}/issuesecuritylevelscheme",
    "jira.project-security-levels": "/project/{projectKeyOrId}/securitylevel",
    "jira.issue-security-schemes": "/issuesecurityschemes",
    "jira.issue-security-scheme": "/issuesecurityschemes/{id}",
    "jira.security-level": "/securitylevel/{id}",
  }),
  ...reads("visible-notification-configuration", {
    "jira.notification-schemes": "/notificationscheme",
    "jira.notification-scheme": "/notificationscheme/{id}",
    "jira.project-notification-scheme": "/project/{projectKeyOrId}/notificationscheme",
  }),
  ...reads("visible-users", {
    "jira.user-property-keys": "/user/properties",
    "jira.user-property": "/user/properties/{propertyKey}",
    "jira.user": "/user",
    "jira.users": "/user/search",
    "jira.user-directory": "/user/list",
    "jira.user-picker": "/user/picker",
  }),
  ...reads("visible-groups", {
    "jira.group-members": "/group/member",
    "jira.groups": "/groups/picker",
  }),
  ...reads("admin-application-roles", {
    "jira.application-roles": "/applicationrole",
    "jira.application-role": "/applicationrole/{key}",
  }),
  ...reads("admin-issue-type-schemes", {
    "jira.issue-type-schemes": "/issuetypescheme",
    "jira.issue-type-scheme": "/issuetypescheme/{schemeId}",
    "jira.issue-type-scheme-projects": "/issuetypescheme/{schemeId}/associations",
  }),
  ...reads("admin-workflow-schemes", {
    "jira.workflow-scheme": "/workflowscheme/{id}",
    "jira.workflow-scheme-default": "/workflowscheme/{id}/default",
    "jira.workflow-scheme-draft": "/workflowscheme/{id}/draft",
    "jira.workflow-scheme-draft-default": "/workflowscheme/{id}/draft/default",
    "jira.workflow-scheme-issue-type": "/workflowscheme/{id}/issuetype/{issueType}",
    "jira.workflow-scheme-draft-issue-type": "/workflowscheme/{id}/draft/issuetype/{issueType}",
    "jira.workflow-scheme-workflows": "/workflowscheme/{id}/workflow",
    "jira.workflow-scheme-draft-workflows": "/workflowscheme/{id}/draft/workflow",
  }),
  ...reads("visible-screen-configuration", {
    "jira.screens": "/screens",
    "jira.screen-tabs": "/screens/{screenId}/tabs",
    "jira.screen-tab-fields": "/screens/{screenId}/tabs/{tabId}/fields",
    "jira.screen-available-fields": "/screens/{screenId}/availableFields",
  }),
  ...reads("visible-watchers", { "jira.watchers": "/issue/{issueIdOrKey}/watchers" }),
  ...reads("visible-voters", { "jira.votes": "/issue/{issueIdOrKey}/votes" }),
  ...reads("attachment-availability", { "jira.attachment-settings": "/attachment/meta" }),
  ...reads("visible-attachments", {
    "jira.attachment": "/attachment/{id}",
    "jira.attachment-archive": "/attachment/{id}/expand/raw",
    "jira.attachment-archive-summary": "/attachment/{id}/expand/human",
  }),
  ...reads("visible-avatars", {
    "jira.system-avatars": "/avatar/{type}/system",
    "jira.project-avatars": "/project/{projectIdOrKey}/avatars",
    "jira.user-avatars": "/user/avatars",
    "jira.avatars": "/universal_avatar/type/{type}/owner/{owningObjectId}",
  }),
  ...reads("visible-dashboards", {
    "jira.dashboards": "/dashboard",
    "jira.dashboard": "/dashboard/{id}",
    "jira.dashboard-item-property-keys": "/dashboard/{dashboardId}/items/{itemId}/properties",
    "jira.dashboard-item-property":
      "/dashboard/{dashboardId}/items/{itemId}/properties/{propertyKey}",
  }),
  ...reads("authenticated-user-preferences", {
    "jira.filter-share-scope": "/filter/defaultShareScope",
    "jira.accessibility-settings": "/user/a11y/personal-settings",
  }),
  ...reads("visible-filter-permissions", {
    "jira.filter-permissions": "/filter/{id}/permission",
    "jira.filter-permission": "/filter/{id}/permission/{permissionId}",
  }),
  ...reads("visible-comments", {
    "jira.pinned-comments": "/issue/{issueIdOrKey}/pinned-comments",
    "jira.get-comment": "/issue/{issueIdOrKey}/comment/{id}",
    "jira.comment-property-keys": "/comment/{commentId}/properties",
    "jira.comment-property": "/comment/{commentId}/properties/{propertyKey}",
  }),
  ...reads("visible-link-types", {
    "jira.link-types": "/issueLinkType",
    "jira.link-type": "/issueLinkType/{issueLinkTypeId}",
  }),
  ...reads("visible-issue-links", {
    "jira.issue-link": "/issueLink/{linkId}",
    "jira.remote-links": "/issue/{issueIdOrKey}/remotelink",
    "jira.remote-link": "/issue/{issueIdOrKey}/remotelink/{linkId}",
  }),
  ...reads("visible-worklogs", {
    "jira.worklogs": "/issue/{issueIdOrKey}/worklog",
    "jira.worklog": "/issue/{issueIdOrKey}/worklog/{id}",
  }),
  ...reads("visible-components", {
    "jira.component-page": "/component/page",
    "jira.components": "/project/{projectIdOrKey}/components",
    "jira.component": "/component/{id}",
    "jira.component-related-issue-counts": "/component/{id}/relatedIssueCounts",
  }),
  ...reads("visible-versions", {
    "jira.global-version-page": "/version",
    "jira.versions": "/project/{projectIdOrKey}/versions",
    "jira.version": "/version/{id}",
    "jira.version-related-issue-counts": "/version/{id}/relatedIssueCounts",
    "jira.version-unresolved-issue-count": "/version/{id}/unresolvedIssueCount",
    "jira.project-version-page": "/project/{projectIdOrKey}/version",
  }),
  ...reads(
    "visible-boards",
    {
      "jira.board-property-keys": "/board/{boardId}/properties",
      "jira.board-property": "/board/{boardId}/properties/{propertyKey}",
      "jira.boards": "/board",
      "jira.board": "/board/{boardId}",
      "jira.board-configuration": "/board/{boardId}/configuration",
      "jira.board-refined-velocity": "/board/{boardId}/settings/refined-velocity",
    },
    "/rest/agile/1.0",
  ),
  ...reads(
    "visible-issues",
    {
      "jira.board-backlog": "/board/{boardId}/backlog",
      "jira.board-issues": "/board/{boardId}/issue",
      "jira.epic-issues": "/epic/{epicIdOrKey}/issue",
      "jira.sprint-issues": "/sprint/{sprintId}/issue",
      "jira.board-epicless-issues": "/board/{boardId}/epic/none/issue",
      "jira.board-epic-issues": "/board/{boardId}/epic/{epicId}/issue",
      "jira.board-sprint-issues": "/board/{boardId}/sprint/{sprintId}/issue",
      "jira.epicless-issues": "/epic/none/issue",
      "jira.agile-issue": "/issue/{issueIdOrKey}",
    },
    "/rest/agile/1.0",
  ),
  ...reads(
    "visible-projects",
    {
      "jira.board-projects": "/board/{boardId}/project",
    },
    "/rest/agile/1.0",
  ),
  ...reads(
    "visible-versions",
    {
      "jira.board-versions": "/board/{boardId}/version",
    },
    "/rest/agile/1.0",
  ),
  ...reads(
    "board-issue-estimation",
    {
      "jira.issue-estimation": "/issue/{issueIdOrKey}/estimation",
    },
    "/rest/agile/1.0",
  ),
  ...reads(
    "visible-epics",
    {
      "jira.board-epics": "/board/{boardId}/epic",
      "jira.epic": "/epic/{epicIdOrKey}",
    },
    "/rest/agile/1.0",
  ),
  ...reads(
    "visible-sprints",
    {
      "jira.sprint-property-keys": "/sprint/{sprintId}/properties",
      "jira.sprint-property": "/sprint/{sprintId}/properties/{propertyKey}",
      "jira.sprints": "/board/{boardId}/sprint",
      "jira.sprint": "/sprint/{sprintId}",
    },
    "/rest/agile/1.0",
  ),
  ...reads("visible-filters", {
    "jira.filter": "/filter/{id}",
    "jira.favourite-filters": "/filter/favourite",
  }),
  ...reads("visible-projects", {
    "jira.projects": "/project",
    "jira.project-property-keys": "/project/{projectIdOrKey}/properties",
    "jira.project-property": "/project/{projectIdOrKey}/properties/{propertyKey}",
    "jira.project-picker": "/projects/picker",
  }),
  ...reads("current-project-metadata", {
    "jira.project-categories": "/projectCategory",
    "jira.project-category": "/projectCategory/{id}",
    "jira.project-statuses": "/project/{projectIdOrKey}/statuses",
    "jira.project-types": "/project/type",
    "jira.project-type-definition": "/project/type/{projectTypeKey}",
    "jira.project": "/project/{projectIdOrKey}",
    "jira.project-workflow-scheme": "/project/{projectKeyOrId}/workflowscheme",
    "jira.project-priority-scheme": "/project/{projectKeyOrId}/priorityscheme",
  }),
  ...reads("native-project-key-validation", {
    "jira.validate-project-key": "/projectvalidate/key",
  }),
  ...reads("explicit-project-permissions", { "jira.project-permissions": "/mypermissions" }),
  ...reads("accessible-project-type", {
    "jira.project-type": "/project/type/{projectTypeKey}/accessible",
  }),
  ...reads("current-create-metadata", {
    "jira.issue-types": "/issue/createmeta/{projectIdOrKey}/issuetypes",
    "jira.create-fields": "/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}",
  }),
  ...reads("current-edit-metadata", { "jira.edit-fields": "/issue/{issueIdOrKey}/editmeta" }),
  ...reads("visible-issues", {
    "jira.issue-picker": "/issue/picker",
    "jira.subtasks": "/issue/{issueIdOrKey}/subtask",
    "jira.subtask-move-availability": "/issue/{issueIdOrKey}/subtask/move",
    "jira.search": "/search",
    "jira.issue-property-keys": "/issue/{issueIdOrKey}/properties",
    "jira.issue-property": "/issue/{issueIdOrKey}/properties/{propertyKey}",
    "jira.issue": "/issue/{issueIdOrKey}",
    "jira.comments": "/issue/{issueIdOrKey}/comment",
  }),
  ...reads("current-transitions", { "jira.transitions": "/issue/{issueIdOrKey}/transitions" }),
  ...reads("current-assignable-users", { "jira.assignable-users": "/user/assignable/search" }),
  ...writes("current-user-watch-and-readback", {
    "jira.watch": ["POST", "/issue/{issueIdOrKey}/watchers"],
    "jira.unwatch": ["DELETE", "/issue/{issueIdOrKey}/watchers"],
  }),
  ...writes("current-user-vote-and-readback", {
    "jira.vote": ["POST", "/issue/{issueIdOrKey}/votes"],
    "jira.unvote": ["DELETE", "/issue/{issueIdOrKey}/votes"],
  }),
  ...writes("worklog-create-and-readback", {
    "jira.create-worklog": ["POST", "/issue/{issueIdOrKey}/worklog"],
  }),
  ...writes("worklog-update-and-readback", {
    "jira.update-worklog": ["PUT", "/issue/{issueIdOrKey}/worklog/{id}"],
  }),
  ...writes("worklog-delete-and-absence", {
    "jira.delete-worklog": ["DELETE", "/issue/{issueIdOrKey}/worklog/{id}"],
  }),
  ...writes("attachment-delete-and-absence", {
    "jira.delete-attachment": ["DELETE", "/attachment/{id}"],
  }),
  ...writes("comment-update-and-readback", {
    "jira.update-comment": ["PUT", "/issue/{issueIdOrKey}/comment/{id}"],
  }),
  ...writes("comment-delete-and-absence", {
    "jira.delete-comment": ["DELETE", "/issue/{issueIdOrKey}/comment/{id}"],
  }),
  ...writes("component-create-and-readback", { "jira.create-component": ["POST", "/component"] }),
  ...writes("component-update-and-readback", {
    "jira.update-component": ["PUT", "/component/{id}"],
  }),
  ...writes("version-create-and-readback", { "jira.create-version": ["POST", "/version"] }),
  ...writes("version-update-and-readback", { "jira.update-version": ["PUT", "/version/{id}"] }),
  ...writes(
    "board-create-and-readback",
    { "jira.board-create": ["POST", "/board"] },
    "/rest/agile/1.0",
  ),
  ...writes(
    "sprint-create-and-readback",
    { "jira.sprint-create": ["POST", "/sprint"] },
    "/rest/agile/1.0",
  ),
  ...writes(
    "sprint-update-and-readback",
    { "jira.sprint-update": ["POST", "/sprint/{sprintId}"] },
    "/rest/agile/1.0",
  ),
  ...writes(
    "issue-membership-and-readback",
    {
      "jira.sprint-move-issues": ["POST", "/sprint/{sprintId}/issue"],
      "jira.backlog-move-issues": ["POST", "/backlog/issue"],
      "jira.epic-move-issues": ["POST", "/epic/{epicIdOrKey}/issue"],
    },
    "/rest/agile/1.0",
  ),
  ...writes(
    "epic-update-and-readback",
    { "jira.epic-update": ["POST", "/epic/{epicIdOrKey}"] },
    "/rest/agile/1.0",
  ),
  ...writes("project-create-and-readback", { "jira.create-project": ["POST", "/project"] }),
  ...writes("project-update-and-readback", {
    "jira.update-project": ["PUT", "/project/{projectIdOrKey}"],
  }),
  ...writes("current-create-metadata", { "jira.create": ["POST", "/issue"] }),
  ...writes("current-edit-metadata", { "jira.edit": ["PUT", "/issue/{issueIdOrKey}"] }),
  ...writes("current-assignable-users", {
    "jira.assign": ["PUT", "/issue/{issueIdOrKey}/assignee"],
  }),
  ...writes("comment-create-and-readback", {
    "jira.comment": ["POST", "/issue/{issueIdOrKey}/comment"],
  }),
  ...writes("current-transitions", {
    "jira.transition": ["POST", "/issue/{issueIdOrKey}/transitions"],
  }),
  ...writes("attachment-create-and-readback", {
    "jira.attach": ["POST", "/issue/{issueIdOrKey}/attachments"],
  }),
};
const COMPOSITES: Readonly<
  Record<
    CompositeTool,
    { readonly members: readonly JiraOperationTool[]; readonly local: JiraOperationEffect }
  >
> = {
  "jira.report": {
    members: ["jira.search", "jira.issue-types", "jira.create-fields"],
    local: "local-report",
  },
  "jira.draft-stage": { members: ["jira.create-fields"], local: "local-draft" },
  // Pages the Chat's Knowledge requirements through the same local staging as jira.draft-stage.
  "jira.draft-batch": { members: ["jira.create-fields"], local: "local-draft" },
  "jira.draft": { members: ["jira.create", "jira.edit"], local: "local-draft" },
};

function definitionFor(tool: string): JiraOperationDefinition {
  if (Object.hasOwn(NATIVE, tool)) {
    const name = tool as NativeTool;
    const [method, effect, pathTemplate, permissionPolicy, apiRoot = "/rest/api/2"] = NATIVE[name];
    return {
      tool: name,
      kind: "native",
      deployment: "data-center",
      identity: `${method} ${apiRoot}${pathTemplate}`,
      method,
      apiRoot,
      pathTemplate,
      effects: effect === "read" ? ["remote-read"] : ["remote-read", "remote-write"],
      authorityAction: JIRA_MANAGED_ACTION_TYPES[name],
      permissionPolicy,
      continuationPolicy:
        name === "jira.create" || name === "jira.edit" ? "approved-issue-links" : "none",
    };
  }
  if (!Object.hasOwn(COMPOSITES, tool)) throw new TypeError("Unknown Jira operation");
  const name = tool as CompositeTool;
  const composite = COMPOSITES[name];
  return {
    tool: name,
    kind: "composite",
    deployment: "data-center",
    identity: `composite:${name}`,
    members: composite.members,
    effects:
      name === "jira.draft"
        ? ["remote-read", "remote-write", composite.local]
        : ["remote-read", composite.local],
    authorityAction: JIRA_MANAGED_ACTION_TYPES[name],
    permissionPolicy: "composed-current-metadata",
  };
}

const OPERATION_DEFINITIONS = deepFreeze([
  ...Object.keys(NATIVE).map(definitionFor),
  ...Object.keys(COMPOSITES).map(definitionFor),
]);

/** Discovery metadata only; selected declarations own schema compilation and contract binding. */
export function jiraOperationDefinitions(): readonly JiraOperationDefinition[] {
  return OPERATION_DEFINITIONS;
}

const BINDING_SCHEMA = {
  type: "object",
  properties: {
    identity: { type: "string", maxLength: 192 },
    contractDigest: { type: "string", pattern: "^[a-f0-9]{64}$", maxLength: 64 },
  },
  required: ["identity", "contractDigest"],
  additionalProperties: false,
};
// Native identities contain ASCII only. Existing ceiling-sized producers already reserve 4 KiB.
const BINDING_RESULT_BYTES = 384;

function schemaObject(value: CatalogJsonValue | undefined): value is CatalogJsonObject {
  return (
    value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
  );
}
function schemaRequired(value: CatalogJsonValue | undefined): value is readonly string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function boundResultSchema(schema: CatalogJsonObject): CatalogJsonObject {
  const { properties, required } = schema;
  if (schema.type === "object" && schemaObject(properties) && schemaRequired(required)) {
    return {
      ...schema,
      properties: { ...properties, operationBinding: BINDING_SCHEMA },
      required: [...required, "operationBinding"],
    };
  }
  // A disjunction is still a closed object result: bind each alternative at the same level
  // as its own additionalProperties:false. An outer allOf would leave every branch closed
  // against the new field; lifting properties would erase the branch-specific requirements.
  const keyword = schema.anyOf === undefined ? "oneOf" : "anyOf";
  const alternatives = schema[keyword];
  const allowed = new Set(["$schema", "description", "type", keyword]);
  if (
    (schema.type !== undefined && schema.type !== "object") ||
    !Array.isArray(alternatives) ||
    alternatives.length === 0 ||
    !Object.keys(schema).every((key) => allowed.has(key))
  )
    throw new ToolCatalogError("invalid-schema");
  return {
    ...schema,
    type: "object",
    [keyword]: alternatives.map((alternative: CatalogJsonValue) => {
      if (!schemaObject(alternative)) throw new ToolCatalogError("invalid-schema");
      return boundResultSchema(alternative);
    }),
  };
}

function resultDescriptor(descriptor: ToolDescriptor): ToolDescriptor {
  const { descriptorDigest: _digest, ...original } = descriptor;
  return createToolDescriptor({
    ...original,
    toolRef: createToolRef(descriptor.toolRef.canonicalId, descriptor.toolRef.contractVersion + 1),
    resultSchema: boundResultSchema(descriptor.resultSchema),
    bounds: {
      ...descriptor.bounds,
      maxResultBytes: Math.min(
        TOOL_CATALOG_LIMITS.maxResultBytes,
        descriptor.bounds.maxResultBytes + BINDING_RESULT_BYTES,
      ),
    },
  });
}

/** Pure authoring: existing typed schemas, effects and bounds remain owned by their declarations. */
export function createJiraOperationContract(
  declaration: ManagedMcpToolDeclaration,
  memberContract?: (tool: JiraOperationTool) => JiraOperationContract | undefined,
): JiraOperationContract {
  const definition = definitionFor(declaration.name);
  if (declaration.risk !== (definition.effects.includes("remote-write") ? "write" : "read"))
    throw new TypeError("Jira operation effect disagrees with its declaration");
  const projection = resultDescriptor(declaration.descriptor);
  const members =
    definition.kind === "native"
      ? []
      : definition.members.map((tool) => {
          const member = memberContract?.(tool);
          if (member?.definition.tool !== tool)
            throw new TypeError("Missing Jira composite member");
          return member.binding;
        });
  const binding = {
    identity: definition.identity,
    contractDigest: sha256Hex(
      canonicalise({
        domain: "keiko.jira-operation-contract.v1",
        definition,
        members,
        descriptorDigest: projection.descriptorDigest,
      }),
    ),
  };
  const { descriptorDigest: _digest, ...projected } = projection;
  const descriptor = createToolDescriptor({
    ...projected,
    policyReferences: [
      ...projection.policyReferences,
      `jira-operation-contract.${binding.contractDigest}`,
    ],
  });
  return deepFreeze({ definition, binding, declaration: { ...declaration, descriptor } });
}

/** Native contracts are bound first so a composite also pins its constituents' typed contracts. */
export function createJiraOperationContracts(
  declarations: readonly ManagedMcpToolDeclaration[],
): readonly JiraOperationContract[] {
  if (new Set(declarations.map((item) => item.name)).size !== declarations.length)
    throw new TypeError("Duplicate Jira operation declaration");
  const entries = new Map<string, JiraOperationContract>();
  for (const declaration of declarations) {
    if (definitionFor(declaration.name).kind === "native")
      entries.set(declaration.name, createJiraOperationContract(declaration));
  }
  for (const declaration of declarations) {
    if (definitionFor(declaration.name).kind === "composite")
      entries.set(
        declaration.name,
        createJiraOperationContract(declaration, (tool) => entries.get(tool)),
      );
  }
  return Object.freeze(
    declarations.map((declaration) => {
      const entry = entries.get(declaration.name);
      if (entry === undefined) throw new TypeError("Missing Jira operation contract");
      return entry;
    }),
  );
}

function bindingObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === 2 && keys.every((key) => key === "identity" || key === "contractDigest");
}

/** Closed persisted snapshot shape; this does not admit execution against the current contract. */
export function isJiraOperationBinding(value: unknown): value is JiraOperationBinding {
  if (!bindingObject(value)) return false;
  const identity: unknown = Object.getOwnPropertyDescriptor(value, "identity")?.value;
  const digest: unknown = Object.getOwnPropertyDescriptor(value, "contractDigest")?.value;
  return (
    typeof identity === "string" &&
    /^[\u0020-\u007e]{1,192}$/u.test(identity) &&
    typeof digest === "string" &&
    /^[a-f0-9]{64}$/u.test(digest)
  );
}

/** The optional snapshot preserves historical transcript hashes; it never grants execution. */
export function jiraOperationActionDigest(
  operation: JiraMutationOperation,
  argumentsDigest: string,
  operationBinding?: JiraOperationBinding,
  sourceDigest?: string,
  humanInputRevision?: string,
): string {
  return sha256Hex(
    canonicalise({
      operation,
      argumentsDigest,
      ...(operationBinding === undefined ? {} : { operationBinding }),
      ...(sourceDigest === undefined ? {} : { sourceDigest }),
      ...(humanInputRevision === undefined ? {} : { humanInputRevision }),
    }),
  );
}

/** Exact server snapshot; callers cannot supply URLs, extra authority fields or an old digest. */
export function matchesJiraOperationBinding(
  contract: JiraOperationContract,
  value: unknown,
): value is JiraOperationBinding {
  return (
    isJiraOperationBinding(value) &&
    value.identity === contract.binding.identity &&
    value.contractDigest === contract.binding.contractDigest
  );
}
