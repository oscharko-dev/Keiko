import type { AtlassianConnectorWriteFailureReason } from "./atlassian-connectors.js";
import type { JiraTemplateViolation } from "./jira-issue-template.js";
import { compareStrings } from "./comparators.js";

export const JIRA_AVATAR_MUTATIONS = Object.freeze([
  "jira.upload-temporary-avatar",
  "jira.crop-temporary-avatar",
  "jira.upload-issue-type-avatar",
  "jira.create-issue-type-avatar",
  "jira.upload-project-avatar",
  "jira.create-project-avatar",
  "jira.set-project-avatar",
  "jira.delete-project-avatar",
  "jira.upload-owned-avatar",
  "jira.create-owned-avatar",
  "jira.delete-owned-avatar",
  "jira.upload-user-avatar",
  "jira.create-user-avatar",
  "jira.set-user-avatar",
  "jira.delete-user-avatar",
] as const);
export type JiraAvatarMutation = (typeof JIRA_AVATAR_MUTATIONS)[number];
/** The existing immutable file review is needed for exactly these five raw image uploads. */
export const JIRA_AVATAR_UPLOAD_MUTATIONS = Object.freeze([
  "jira.upload-temporary-avatar",
  "jira.upload-issue-type-avatar",
  "jira.upload-project-avatar",
  "jira.upload-owned-avatar",
  "jira.upload-user-avatar",
] as const satisfies readonly JiraAvatarMutation[]);
export type JiraAvatarUploadMutation = (typeof JIRA_AVATAR_UPLOAD_MUTATIONS)[number];
export function isJiraAvatarUploadOperation(name: string): name is JiraAvatarUploadMutation {
  return (JIRA_AVATAR_UPLOAD_MUTATIONS as readonly string[]).includes(name);
}
export const JIRA_IDENTITY_MUTATIONS = Object.freeze([
  "jira.create-user",
  "jira.update-user",
  "jira.delete-user",
  "jira.invalidate-user-session",
  "jira.schedule-user-anonymization",
  "jira.rerun-user-anonymization",
] as const);
export type JiraIdentityMutation = (typeof JIRA_IDENTITY_MUTATIONS)[number];
/** Private human-input or owned-session actions. Validation POSTs remain separate read tools. */
export const JIRA_PRIVATE_ACCOUNT_MUTATIONS = Object.freeze([
  "jira.update-myself",
  "jira.update-my-password",
  "jira.update-user-password",
  "jira.login",
  "jira.logout",
  "jira.release-websudo",
] as const);
export type JiraPrivateAccountMutation = (typeof JIRA_PRIVATE_ACCOUNT_MUTATIONS)[number];
export const JIRA_ISSUE_LIFECYCLE_MUTATIONS = Object.freeze([
  "jira.archive-issues",
  "jira.delete-issue",
  "jira.archive-issue",
  "jira.restore-issue",
  "jira.move-subtask",
] as const);
export type JiraIssueLifecycleMutation = (typeof JIRA_ISSUE_LIFECYCLE_MUTATIONS)[number];
export const JIRA_PROJECT_LIFECYCLE_MUTATIONS = Object.freeze([
  "jira.delete-project",
  "jira.archive-project",
  "jira.restore-project",
  "jira.update-project-type",
  "jira.set-project-permission-scheme",
  "jira.set-project-priority-scheme",
  "jira.remove-project-priority-scheme",
] as const);
export type JiraProjectLifecycleMutation = (typeof JIRA_PROJECT_LIFECYCLE_MUTATIONS)[number];

export const JIRA_GROUP_MUTATIONS = Object.freeze([
  "jira.create-group",
  "jira.delete-group",
  "jira.add-group-user",
  "jira.remove-group-user",
] as const);
export type JiraGroupMutation = (typeof JIRA_GROUP_MUTATIONS)[number];

export const JIRA_ISSUE_ACTION_MUTATIONS = Object.freeze([
  "jira.pin-comment",
  "jira.notify-issue",
] as const);
export type JiraIssueActionMutation = (typeof JIRA_ISSUE_ACTION_MUTATIONS)[number];

export const JIRA_MAINTENANCE_MUTATIONS = Object.freeze([
  "jira.request-cluster-index-snapshot",
  "jira.delete-cluster-node",
  "jira.mark-cluster-node-offline",
  "jira.approve-cluster-upgrade",
  "jira.cancel-cluster-upgrade",
  "jira.retry-cluster-upgrade",
  "jira.start-cluster-upgrade",
  "jira.create-index-snapshot",
  "jira.start-reindex",
  "jira.reindex-issues",
  "jira.process-reindex-requests",
  "jira.run-upgrade",
] as const);
export type JiraMaintenanceMutation = (typeof JIRA_MAINTENANCE_MUTATIONS)[number];

export const JIRA_SCHEMA_MUTATIONS = Object.freeze([
  "jira.create-custom-field",
  "jira.delete-custom-fields",
  "jira.create-issue-type",
  "jira.update-issue-type",
  "jira.delete-issue-type",
  "jira.create-link-type",
  "jira.update-link-type",
  "jira.delete-link-type",
  "jira.reset-link-type-order",
  "jira.move-link-type",
  "jira.set-terminology",
] as const);
export type JiraSchemaMutation = (typeof JIRA_SCHEMA_MUTATIONS)[number];

export const JIRA_DIRECTORY_ACCESS_MUTATIONS = Object.freeze([
  "jira.set-application-role",
  "jira.set-application-roles",
  "jira.add-user-application",
  "jira.remove-user-application",
  "jira.set-user-columns",
  "jira.reset-user-columns",
] as const);
export type JiraDirectoryAccessMutation = (typeof JIRA_DIRECTORY_ACCESS_MUTATIONS)[number];

/** One immutable identity source for the uniform entity-property mutation family. */
export const JIRA_ENTITY_PROPERTY_MUTATIONS = Object.freeze([
  "jira.set-board-property",
  "jira.delete-board-property",
  "jira.set-sprint-property",
  "jira.delete-sprint-property",
  "jira.set-comment-property",
  "jira.delete-comment-property",
  "jira.set-dashboard-item-property",
  "jira.delete-dashboard-item-property",
  "jira.set-issue-property",
  "jira.delete-issue-property",
  "jira.set-issue-type-property",
  "jira.delete-issue-type-property",
  "jira.set-project-property",
  "jira.delete-project-property",
  "jira.set-user-property",
  "jira.delete-user-property",
] as const);
export type JiraEntityPropertyMutation = (typeof JIRA_ENTITY_PROPERTY_MUTATIONS)[number];

/** Closed saved-filter and current-user preference operations; no arbitrary setting writes. */
export const JIRA_SAVED_CONFIGURATION_MUTATIONS = Object.freeze([
  "jira.create-filter",
  "jira.update-filter",
  "jira.delete-filter",
  "jira.set-filter-share-scope",
  "jira.set-filter-columns",
  "jira.reset-filter-columns",
  "jira.add-filter-permission",
  "jira.delete-filter-permission",
  "jira.set-my-preference",
  "jira.delete-my-preference",
] as const);
export type JiraSavedConfigurationMutation = (typeof JIRA_SAVED_CONFIGURATION_MUTATIONS)[number];

/** Exact reviewed native relationships; remote upsert is distinct from unconditional creation. */
export const JIRA_LINK_MUTATIONS = Object.freeze([
  "jira.create-issue-link",
  "jira.delete-issue-link",
  "jira.upsert-remote-link",
  "jira.update-remote-link",
  "jira.delete-remote-link",
  "jira.delete-remote-link-by-global-id",
] as const);
export type JiraLinkMutation = (typeof JIRA_LINK_MUTATIONS)[number];

/** Project-bound version/component lifecycle changes reuse the existing mutation journal. */
export const JIRA_RELEASE_LIFECYCLE_MUTATIONS = Object.freeze([
  "jira.delete-component",
  "jira.merge-version",
  "jira.move-version",
  "jira.remove-and-swap-version",
] as const);
export type JiraReleaseLifecycleMutation = (typeof JIRA_RELEASE_LIFECYCLE_MUTATIONS)[number];

/** Fixed screen/tab/field configuration effects; no arbitrary schema mutation. */
export const JIRA_SCREEN_CONFIGURATION_MUTATIONS = Object.freeze([
  "jira.add-default-screen-field",
  "jira.add-screen-tab-field",
  "jira.remove-screen-tab-field",
  "jira.move-screen-tab-field",
  "jira.set-screen-field-show-when-empty",
  "jira.move-screen-tab",
] as const);
export type JiraScreenConfigurationMutation = (typeof JIRA_SCREEN_CONFIGURATION_MUTATIONS)[number];
export const JIRA_BOARD_CONFIGURATION_MUTATIONS = Object.freeze([
  "jira.delete-board",
  "jira.set-board-refined-velocity",
] as const);
export type JiraBoardConfigurationMutation = (typeof JIRA_BOARD_CONFIGURATION_MUTATIONS)[number];
export function isJiraBoardConfigurationMutation(
  name: string,
): name is JiraBoardConfigurationMutation {
  return (JIRA_BOARD_CONFIGURATION_MUTATIONS as readonly string[]).includes(name);
}
export const JIRA_SPRINT_LIFECYCLE_MUTATIONS = Object.freeze([
  "jira.replace-sprint",
  "jira.delete-sprint",
  "jira.swap-sprints",
  "jira.unmap-sprints",
  "jira.unmap-all-sprints",
] as const);
export type JiraSprintLifecycleMutation = (typeof JIRA_SPRINT_LIFECYCLE_MUTATIONS)[number];

export const JIRA_OPTION_SCHEME_MUTATIONS = Object.freeze([
  "jira.create-issue-type-scheme",
  "jira.update-issue-type-scheme",
  "jira.delete-issue-type-scheme",
  "jira.add-issue-type-scheme-projects",
  "jira.set-issue-type-scheme-projects",
  "jira.clear-issue-type-scheme-projects",
  "jira.remove-issue-type-scheme-project",
  "jira.create-priority-scheme",
  "jira.update-priority-scheme",
  "jira.delete-priority-scheme",
] as const);
export type JiraOptionSchemeMutation = (typeof JIRA_OPTION_SCHEME_MUTATIONS)[number];
export const JIRA_WORKFLOW_SCHEME_MUTATIONS = Object.freeze([
  "jira.create-workflow-scheme",
  "jira.update-workflow-scheme",
  "jira.delete-workflow-scheme",
  "jira.create-workflow-scheme-draft",
  "jira.update-workflow-scheme-draft",
  "jira.delete-workflow-scheme-draft",
  "jira.set-workflow-scheme-default",
  "jira.delete-workflow-scheme-default",
  "jira.set-workflow-scheme-draft-default",
  "jira.delete-workflow-scheme-draft-default",
  "jira.set-workflow-scheme-issue-type",
  "jira.delete-workflow-scheme-issue-type",
  "jira.set-workflow-scheme-draft-issue-type",
  "jira.delete-workflow-scheme-draft-issue-type",
  "jira.set-workflow-scheme-workflow",
  "jira.delete-workflow-scheme-workflow",
  "jira.set-workflow-scheme-draft-workflow",
  "jira.delete-workflow-scheme-draft-workflow",
] as const);
export type JiraWorkflowSchemeMutation = (typeof JIRA_WORKFLOW_SCHEME_MUTATIONS)[number];
export const JIRA_INSTANCE_SETTING_MUTATIONS = Object.freeze([
  "jira.set-application-property",
  "jira.set-system-columns",
  "jira.set-instance-base-url",
  "jira.set-read-only-mode",
] as const);
export type JiraInstanceSettingMutation = (typeof JIRA_INSTANCE_SETTING_MUTATIONS)[number];
export const JIRA_EMAIL_TEMPLATE_MUTATIONS = Object.freeze([
  "jira.upload-email-template-pack",
  "jira.apply-email-template-pack",
  "jira.revert-email-template-pack",
] as const);
export type JiraEmailTemplateMutation = (typeof JIRA_EMAIL_TEMPLATE_MUTATIONS)[number];

export const JIRA_PERMISSION_SCHEME_MUTATIONS = Object.freeze([
  "jira.create-permission-scheme",
  "jira.update-permission-scheme",
  "jira.delete-permission-scheme",
  "jira.add-permission-grant",
  "jira.delete-permission-grant",
  "jira.set-permission-scheme-attribute",
] as const);
export type JiraPermissionSchemeMutation = (typeof JIRA_PERMISSION_SCHEME_MUTATIONS)[number];
export const JIRA_ROLE_MUTATIONS = Object.freeze([
  "jira.create-role",
  "jira.update-role",
  "jira.replace-role",
  "jira.delete-role",
  "jira.add-role-default-actors",
  "jira.delete-role-default-actor",
  "jira.add-project-role-actors",
  "jira.set-project-role-actors",
  "jira.delete-project-role-actor",
] as const);
export type JiraRoleMutation = (typeof JIRA_ROLE_MUTATIONS)[number];

export const JIRA_AGILE_PLANNING_MUTATIONS = Object.freeze([
  "jira.epic-remove-issues",
  "jira.rank-epic",
  "jira.rank-issues",
  "jira.set-issue-estimation",
] as const);
export type JiraAgilePlanningMutation = (typeof JIRA_AGILE_PLANNING_MUTATIONS)[number];
export const JIRA_VERSION_REMOTE_LINK_MUTATIONS = Object.freeze([
  "jira.upsert-version-remote-link",
  "jira.upsert-version-remote-link-by-global-id",
  "jira.delete-version-remote-link",
  "jira.delete-version-remote-links",
] as const);
export type JiraVersionRemoteLinkMutation = (typeof JIRA_VERSION_REMOTE_LINK_MUTATIONS)[number];
export const JIRA_PROJECT_CATEGORY_MUTATIONS = Object.freeze([
  "jira.create-project-category",
  "jira.update-project-category",
  "jira.delete-project-category",
] as const);
export type JiraProjectCategoryMutation = (typeof JIRA_PROJECT_CATEGORY_MUTATIONS)[number];
export function isJiraProjectCategoryMutation(name: string): name is JiraProjectCategoryMutation {
  return (JIRA_PROJECT_CATEGORY_MUTATIONS as readonly string[]).includes(name);
}

export const JIRA_ANONYMIZATION_UNLOCK_MUTATIONS = Object.freeze([
  "jira.unlock-user-anonymization",
] as const);
export const JIRA_EXTENDED_ISSUE_CREATION_MUTATIONS = Object.freeze([
  "jira.create-issues",
  "jira.create-reciprocal-remote-link",
] as const);

/** The original shared mutation executor's closed operations, in their retained catalog order. */
export const JIRA_CORE_MUTATIONS = Object.freeze([
  "jira.set-app-monitoring",
  "jira.set-ipd-monitoring",
  "jira.start-jmx-metrics",
  "jira.stop-jmx-metrics",
  "jira.create-screen-tab",
  "jira.rename-screen-tab",
  "jira.delete-screen-tab",
  "jira.create",
  "jira.create-project",
  "jira.update-project",
  "jira.create-component",
  "jira.update-component",
  "jira.create-version",
  "jira.update-version",
  "jira.board-create",
  "jira.sprint-create",
  "jira.sprint-update",
  "jira.sprint-move-issues",
  "jira.backlog-move-issues",
  "jira.epic-update",
  "jira.epic-move-issues",
  "jira.edit",
  "jira.assign",
  "jira.comment",
  "jira.update-comment",
  "jira.delete-comment",
  "jira.delete-attachment",
  "jira.delete-worklog",
  "jira.create-worklog",
  "jira.update-worklog",
  "jira.watch",
  "jira.unwatch",
  "jira.vote",
  "jira.unvote",
  "jira.transition",
  "jira.draft",
  "jira.attach",
] as const);

/** Remote effects remain separate from the enclosing MCP/catalog terminal status. */
export const JIRA_MUTATION_OPERATIONS = [
  ...JIRA_ANONYMIZATION_UNLOCK_MUTATIONS,
  ...JIRA_AVATAR_MUTATIONS,
  ...JIRA_IDENTITY_MUTATIONS,
  ...JIRA_PRIVATE_ACCOUNT_MUTATIONS,
  ...JIRA_ISSUE_LIFECYCLE_MUTATIONS,
  ...JIRA_PROJECT_LIFECYCLE_MUTATIONS,
  ...JIRA_EXTENDED_ISSUE_CREATION_MUTATIONS,
  ...JIRA_GROUP_MUTATIONS,
  ...JIRA_ISSUE_ACTION_MUTATIONS,
  ...JIRA_MAINTENANCE_MUTATIONS,
  ...JIRA_SCHEMA_MUTATIONS,
  ...JIRA_DIRECTORY_ACCESS_MUTATIONS,
  ...JIRA_OPTION_SCHEME_MUTATIONS,
  ...JIRA_WORKFLOW_SCHEME_MUTATIONS,
  ...JIRA_INSTANCE_SETTING_MUTATIONS,
  ...JIRA_EMAIL_TEMPLATE_MUTATIONS,
  ...JIRA_PERMISSION_SCHEME_MUTATIONS,
  ...JIRA_ROLE_MUTATIONS,
  ...JIRA_AGILE_PLANNING_MUTATIONS,
  ...JIRA_VERSION_REMOTE_LINK_MUTATIONS,
  ...JIRA_PROJECT_CATEGORY_MUTATIONS,
  ...JIRA_SCREEN_CONFIGURATION_MUTATIONS,
  ...JIRA_BOARD_CONFIGURATION_MUTATIONS,
  ...JIRA_SPRINT_LIFECYCLE_MUTATIONS,
  ...JIRA_LINK_MUTATIONS,
  ...JIRA_RELEASE_LIFECYCLE_MUTATIONS,
  ...JIRA_SAVED_CONFIGURATION_MUTATIONS,
  ...JIRA_ENTITY_PROPERTY_MUTATIONS,
  ...JIRA_CORE_MUTATIONS,
] as const;
export type JiraMutationOperation = (typeof JIRA_MUTATION_OPERATIONS)[number];

/**
 * A backlog draft (#4178): related issues proposed together, approved once, created in dependency
 * order. Each item runs as its own journaled `jira.create`; the draft itself is never dispatched.
 * A large draft is assembled in pages in a server-held draft session (`jira.draft-stage`) and
 * approved once as a whole.
 */
// There is no cap on the number of items. The only bound on a draft is a resource bound in bytes:
// the retained size of its items as canonical JSON, sized so that tens of thousands of ordinary
// backlog items fit. Above it staging refuses with a closed reason and fixed guidance for the
// model to offer splitting the backlog into several drafts; a draft is never truncated.
/** The retained size of one staged draft's items, measured as canonical JSON bytes. */
export const JIRA_DRAFT_STAGE_BYTES_MAX = 16 * 1024 * 1024;
/**
 * Rows one `jira.draft` result can carry: the tool catalog's array ceiling (ADR-0175). It bounds
 * the report, not the draft; a larger result is reported by counts and compact key ranges.
 */
export const JIRA_DRAFT_RESULT_ROWS_MAX = 1000;
/** Items one `jira.draft-stage` call appends; larger drafts arrive in several pages. */
export const JIRA_DRAFT_PAGE_ITEMS_MAX = 50;
/** A staged draft is addressed by an opaque server-minted id and committed to by its digest. */
export const JIRA_DRAFT_ID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
export const JIRA_DRAFT_DIGEST_PATTERN = "^[0-9a-f]{64}$";
/** Why a `jira.draft` call that names a staged draft is refused before anyone is asked. */
export const JIRA_DRAFT_REFUSALS = [
  "draft-not-found",
  "draft-changed",
  "draft-invalid",
  "connection-changed",
] as const;
export type JiraDraftRefusalReason = (typeof JIRA_DRAFT_REFUSALS)[number];
/**
 * Why a draft that resolves is still invalid, as a closed code: the person reads one localized
 * sentence per code that names what to change (#4355). The model-facing guidance sentence is its
 * own text; this code carries no draft content.
 */
export const JIRA_DRAFT_PROBLEMS = [
  "draft-shape",
  "items-missing",
  "item-shape",
  "item-ref",
  "item-ids",
  "item-fields",
  "item-parent",
  "item-links",
  "item-requirements",
  "ref-duplicate",
  "ref-self",
  "ref-unknown",
  "ref-cycle",
] as const;
export type JiraDraftProblemCode = (typeof JIRA_DRAFT_PROBLEMS)[number];
/** A model-chosen local reference that relations between draft items use before keys exist. */
export const JIRA_DRAFT_REF_PATTERN = "^[A-Za-z][A-Za-z0-9_-]{0,31}$";
const DRAFT_REF = new RegExp(JIRA_DRAFT_REF_PATTERN, "u");
export function isJiraDraftRef(value: unknown): value is string {
  return typeof value === "string" && DRAFT_REF.test(value);
}
/**
 * created: Jira acknowledged this item's create; existing: an issue with this item's draft
 * identity already existed, so nothing was sent; failed: refused before or by Jira; uncertain:
 * sent without an authoritative outcome (never retried automatically); skipped: an item it depends
 * on did not produce a key; excluded: deselected by the human, directly or through a dependency;
 * pending: not started because the time allowed for this run ended - running the same draft again
 * reconciles what exists and continues with these.
 */
export const JIRA_DRAFT_ITEM_STATES = [
  "created",
  "existing",
  "failed",
  "uncertain",
  "skipped",
  "excluded",
  "pending",
] as const;
export type JiraDraftItemState = (typeof JIRA_DRAFT_ITEM_STATES)[number];
/**
 * Attaching a file (#4176): the bytes come from a source Keiko already governs (a file under one of
 * the Chat's connected folders), never from a host path the model names. Keiko's own ceiling is a
 * hard bound; the instance's reported upload limit can only lower it for one upload.
 */
export const JIRA_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const JIRA_ATTACHMENT_NAME_MAX_BYTES = 255;
export const JIRA_ATTACHMENT_SOURCE_KINDS = ["connected-file"] as const;
/** What the human sees before a file leaves the machine: name, size and digest, never content. */
export interface JiraAttachmentPreview {
  readonly name: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}
// eslint-disable-next-line no-control-regex -- a file name is shown to people and sent in a header.
const ATTACHMENT_NAME_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f"\\/]/u;
/** A bare file name: no separators, quotes or control characters, bounded in UTF-8 bytes. */
export function isJiraAttachmentName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !ATTACHMENT_NAME_FORBIDDEN.test(value) &&
    new TextEncoder().encode(value).length <= JIRA_ATTACHMENT_NAME_MAX_BYTES
  );
}
const SHA256_HEX = /^[0-9a-f]{64}$/u;
function isAttachmentSize(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= JIRA_ATTACHMENT_MAX_BYTES
  );
}
export function isJiraAttachmentPreview(value: unknown): value is JiraAttachmentPreview {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const digest: unknown = Reflect.get(value, "sha256");
  return (
    Object.keys(value).sort(compareStrings).join() === "name,sha256,sizeBytes" &&
    isJiraAttachmentName(Reflect.get(value, "name")) &&
    isAttachmentSize(Reflect.get(value, "sizeBytes")) &&
    typeof digest === "string" &&
    SHA256_HEX.test(digest)
  );
}
/** Rejected means a known local refusal before dispatch; non-2xx status alone remains unknown. */
export const JIRA_MUTATION_OUTCOMES = [
  "not-dispatched",
  "rejected",
  "succeeded",
  "succeeded-unconfirmed",
  "unknown",
] as const;
export type JiraMutationOutcome = (typeof JIRA_MUTATION_OUTCOMES)[number];

/** Pending means no authoritative final outcome is available, including orphaned records after
 * restart. It neither asserts an active executor nor permits takeover or another dispatch. */
export const JIRA_MUTATION_RESULT_STATES = [...JIRA_MUTATION_OUTCOMES, "pending"] as const;
export type JiraMutationResultState = (typeof JIRA_MUTATION_RESULT_STATES)[number];

/** Validated Jira identities and closed state facts; never remote bodies or headers.
 * Monitoring booleans on unknown/unconfirmed writes are requested targets, not success evidence. */
export interface JiraMutationReceipt extends Readonly<
  Partial<
    Record<
      // Native resource identities are optional until their own operation has independently bound them.
      | "propertyKey"
      | "dashboardId"
      | "selectedItemId"
      | "issueTypeId"
      | "userKey"
      | "username"
      | "screenId"
      | "tabId"
      | "projectId"
      | "projectKey"
      | "projectName"
      | "componentId"
      | "versionId"
      | "browseUrl"
      | "boardId"
      | "sprintId"
      | "epicKey"
      | "issueKey"
      | "issueId"
      | "commentId"
      | "worklogId"
      | "originBoardId"
      | "boardBrowseUrl"
      | "transitionId"
      | "attachmentId",
      string
    >
  >
> {
  readonly avatarType?: "user" | "project" | "issuetype";
  readonly avatarId?: string;
  readonly avatarPresent?: boolean;
  readonly avatarSelected?: boolean;
  readonly temporaryAvatar?: true;
  /** Native acknowledgement metadata, not image persistence or independent content evidence. */
  readonly temporaryCrop?: {
    readonly cropperOffsetX: number;
    readonly cropperOffsetY: number;
    readonly cropperWidth: number;
  };
  readonly temporaryNeedsCropping?: boolean;
  readonly userPresent?: boolean;
  readonly userActive?: boolean;
  readonly userSessionInvalidationRequested?: true;
  /** Present only after the private custody owner proves the same cookie-session actor. */
  readonly sessionEstablished?: true;
  readonly executingNode?: string;
  readonly anonymizationSubmittedTime?: string;
  readonly anonymizationRequested?: true;
  readonly anonymizationRerunRequested?: true;
  readonly newOwnerUserKey?: string;
  readonly issueArchivedRequested?: boolean;
  readonly issuePresent?: false;
  readonly subtaskIds?: readonly string[];
  readonly originalPosition?: number;
  readonly currentPosition?: number;
  readonly requestedIssueCount?: number;
  readonly bulkFailedElementNumbers?: readonly number[];
  readonly bulkFailureStatuses?: readonly number[];
  readonly applicationLinkId?: string;
  readonly applicationLinkDestinationDigest?: string;
  readonly selectedRemoteIssueId?: string;
  readonly delegatedEffectRequested?: true;
  readonly projectPresent?: false;
  readonly projectArchivedRequested?: boolean;
  readonly projectTypeKey?: string;
  readonly previousSchemeId?: string;
  readonly projectSchemeAssigned?: boolean;
  readonly actorUserKey?: string;
  readonly applicationRoleKeys?: readonly string[];
  readonly applicationAccessRequested?: boolean;
  readonly columnsResetRequested?: true;
  readonly replacementIssueTypeId?: string;
  readonly issueTypePresent?: boolean;
  readonly fieldIds?: readonly string[];
  readonly linkTypeIds?: readonly string[];
  readonly linkTypePresent?: boolean;
  readonly terminologyNames?: readonly ("epic" | "sprint")[];
  readonly groupName?: string;
  readonly groupPresent?: boolean;
  readonly targetUserKey?: string;
  readonly requestedDirectMembership?: boolean;
  readonly swapGroupName?: string;
  readonly commentPinned?: true;
  readonly notificationDigest?: string;
  readonly recipientUserKeys?: readonly string[];
  readonly nodeId?: string;
  readonly reindexRequestIds?: readonly string[];
  readonly projectIds?: readonly string[];
  readonly projectKeys?: readonly string[];
  readonly associationChange?: "add" | "replace" | "clear" | "remove";
  readonly draftSchemeId?: string;
  readonly workflowSchemeScope?: "scheme" | "draft";
  /** Base-update input included default/mapping configuration; never deployment evidence. */
  readonly workflowMappingChanged?: boolean;
  readonly workflowName?: string;
  readonly mappingPresent?: boolean;
  readonly valueDigest?: string;
  readonly columnIds?: readonly string[];
  readonly baseUrlDigest?: string;
  readonly readOnlyEnabled?: boolean;
  readonly emailTemplateAction?: "upload" | "apply" | "revert";
  readonly uploadSha256?: string;
  readonly uploadBytes?: number;
  readonly priorManifestSha256?: string;
  readonly observedManifestSha256?: string;
  readonly roleId?: string;
  readonly rolePresent?: boolean;
  readonly swapRoleId?: string;
  readonly roleActorsScope?: "role-defaults" | "project-membership";
  readonly actorChange?: "add" | "replace" | "remove";
  readonly actorUserKeys?: readonly string[];
  readonly actorGroupNames?: readonly string[];
  readonly schemeId?: string;
  readonly schemePresent?: boolean;
  readonly grantPresent?: boolean;
  readonly attributeKey?: string;
  readonly attributeEnabled?: boolean;
  readonly categoryId?: string;
  readonly categoryPresent?: boolean;
  readonly globalId?: string;
  readonly globalIds?: readonly string[];
  readonly issueIds?: readonly string[];
  readonly anchorIssueId?: string;
  readonly anchorIssueKey?: string;
  readonly rankDirection?: "before" | "after";
  readonly estimationValue?: number;
  readonly estimationUnit?: "seconds" | "board-number";
  readonly epicPresent?: boolean;
  readonly fieldId?: string;
  /** Requested presence until independent native layout readback succeeds. */
  readonly fieldPresent?: boolean;
  readonly showWhenEmpty?: boolean;
  readonly boardPresent?: boolean;
  readonly refinedVelocityEnabled?: boolean;
  readonly sprintIds?: readonly string[];
  readonly swapSprintId?: string;
  readonly sprintSynced?: boolean;
  readonly sprintPresent?: boolean;
  readonly allSprints?: true;
  readonly linkId?: string;
  readonly linkTypeId?: string;
  readonly linkedIssueId?: string;
  readonly linkedIssueKey?: string;
  /** Requested presence until the complete independently bound relation is confirmed. */
  readonly linkPresent?: boolean;
  readonly replacementComponentId?: string;
  readonly targetVersionId?: string;
  readonly replacementVersionIds?: readonly string[];
  readonly filterId?: string;
  readonly permissionId?: string;
  readonly preferenceKey?: string;
  /** Requested target only until an independent native read confirms it. */
  readonly preferencePresent?: boolean;
  /** The native filter-create API never atomically binds its default-sharing observation. */
  readonly defaultSharingAtomic?: false;
  readonly observedShareScope?: "PRIVATE" | "AUTHENTICATED" | "GLOBAL";
  /** Requested target on unknown/unconfirmed writes; success requires independent readback. */
  readonly propertyPresent?: boolean;
  readonly monitoringEnabled?: boolean;
  readonly jmxMetricsExposed?: boolean;
  readonly issueKeys?: readonly string[];
  readonly isWatching?: boolean;
  readonly hasVoted?: boolean;
}
/** Why Keiko's own metadata validation refused a field before dispatch (#4176). */
export const JIRA_FIELD_VALIDATION_FAILURES = [
  "required-field",
  "unsupported-field",
  "invalid-field",
  "invalid-operation",
  "bounds-exceeded",
  /** An Epic Link whose target the instance does not know as an Epic (#4354). */
  "invalid-epic-link",
] as const;
export type JiraFieldValidationFailure = (typeof JIRA_FIELD_VALIDATION_FAILURES)[number];
export const JIRA_MUTATION_DETAIL_LIMITS = Object.freeze({
  fieldErrors: 8,
  messages: 3,
  messageChars: 200,
  /** UTF-8 bytes of one message's JSON encoding, so escapes and non-ASCII text stay bounded. */
  messageBytes: 200,
});
export interface JiraMutationFieldError {
  readonly fieldId: string;
  /** The field's display name when the request's current metadata knows it (#4176). */
  readonly fieldName?: string;
  readonly message: string;
}
/**
 * What the caller needs to correct a refused write: the refused field and Keiko's closed reason, or
 * Jira's own bounded field errors and messages. Returned to the model only, never logged (#4176).
 */
export interface JiraMutationFailureDetail {
  /** The adapter independently observed the requested state before any effect. */
  readonly unchanged?: true;
  /**
   * Jira's own error document: set only where Keiko parses a refusal Jira sent. A closed fact about
   * who refused, so the instruction a model reads never guesses it from the detail's shape (#4357).
   * Never sent to the model.
   */
  readonly fromJira?: true;
  readonly fieldId?: string;
  readonly validation?: JiraFieldValidationFailure;
  readonly fieldErrors?: readonly JiraMutationFieldError[];
  readonly messages?: readonly string[];
}
/** Most issue links one create/edit request may ask for (#4176). */
export const JIRA_MUTATION_LINKS_MAX = 20;
/** One requested link, as the caller named it: the link type, the side and the other issue. */
export interface JiraMutationLinkRef {
  readonly type: string;
  readonly direction: "inward" | "outward";
  readonly issueKey: string;
}
/**
 * What happened to the requested links (#4176). Jira takes one `issuelinks` operation per request, so
 * every further link is its own call after the issue exists and can fail on its own. `created` counts
 * the requested links present on the issue afterwards; `missing` names the rest; `unconfirmed` says
 * the issue's links could not be read back, so a missing link may still exist.
 */
export interface JiraMutationLinkAccount {
  readonly requested: number;
  readonly created: number;
  readonly missing: readonly JiraMutationLinkRef[];
  readonly unconfirmed: boolean;
}
export type JiraMutationAttempt =
  | {
      readonly ok: true;
      readonly receipt: JiraMutationReceipt;
      readonly links?: JiraMutationLinkAccount;
      /** Internal bounded serializer evidence; omitted from model results and remote receipts. */
      readonly descriptionConvertedHeadingCount?: number;
      readonly descriptionProjection?: "supported-markdown";
      /**
       * Template rules the issue already broke in fields this edit did not touch. They did not block
       * the write; the person is told (#4354).
       */
      readonly templateNotices?: readonly JiraTemplateViolation[];
    }
  | {
      readonly ok: false;
      readonly reason: AtlassianConnectorWriteFailureReason;
      readonly detail?: JiraMutationFailureDetail;
      /** Set only when the issue itself exists although the attempt did not finish (partial effect). */
      readonly receipt?: JiraMutationReceipt;
      readonly links?: JiraMutationLinkAccount;
      /** Only an issue-template refusal (`field-validation`) carries violations (#4177). */
      readonly violations?: readonly JiraTemplateViolation[];
      /** A prepared description is evidence even when the provider refuses the subsequent write. */
      readonly descriptionConvertedHeadingCount?: number;
      readonly descriptionProjection?: "supported-markdown";
    };

// eslint-disable-next-line no-control-regex -- remote text is shown to a model, not a terminal.
const DETAIL_CONTROL = /[\u0000-\u001f\u007f-\u009f]+/gu;
const DETAIL_FIELD_ID = /^(?:[a-zA-Z][a-zA-Z0-9]{0,63}|customfield_\d{1,16})$/u;
function detailText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(DETAIL_CONTROL, " ").trim();
  if (text.length === 0) return undefined;
  return boundedDetailText(text);
}
const DETAIL_ENCODER = new TextEncoder();
const DETAIL_ELLIPSIS = "…";
function encodedBytes(text: string): number {
  return DETAIL_ENCODER.encode(JSON.stringify(text)).length - 2;
}
/** Cuts on code-point boundaries until the JSON-encoded text fits its byte bound. */
function boundedDetailText(text: string): string {
  const limit = JIRA_MUTATION_DETAIL_LIMITS.messageBytes;
  if (encodedBytes(text) <= limit) return text;
  const budget = limit - encodedBytes(DETAIL_ELLIPSIS);
  let used = 0;
  let kept = "";
  for (const point of text) {
    used += encodedBytes(point);
    if (used > budget) break;
    kept += point;
  }
  return `${kept}${DETAIL_ELLIPSIS}`;
}
function detailFieldId(value: unknown): value is string {
  return typeof value === "string" && DETAIL_FIELD_ID.test(value);
}
function detailFieldErrors(value: unknown): readonly JiraMutationFieldError[] {
  if (!Array.isArray(value)) return [];
  const errors: JiraMutationFieldError[] = [];
  for (const entry of value.slice(0, JIRA_MUTATION_DETAIL_LIMITS.fieldErrors) as unknown[]) {
    const record = typeof entry === "object" && entry !== null ? entry : {};
    const fieldId: unknown = Reflect.get(record, "fieldId");
    const message = detailText(Reflect.get(record, "message"));
    const fieldName = detailText(Reflect.get(record, "fieldName"));
    if (detailFieldId(fieldId) && message !== undefined)
      errors.push({ fieldId, ...(fieldName === undefined ? {} : { fieldName }), message });
  }
  return errors;
}
function detailMessages(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[])
    .map(detailText)
    .filter((text): text is string => text !== undefined)
    .slice(0, JIRA_MUTATION_DETAIL_LIMITS.messages);
}
const VALIDATION_FAILURES: ReadonlySet<unknown> = new Set(JIRA_FIELD_VALIDATION_FAILURES);
/** One bounded, control-free projection, applied wherever a detail crosses a boundary. */
export function sanitizeJiraMutationFailureDetail(
  value: unknown,
): JiraMutationFailureDetail | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fieldId: unknown = Reflect.get(value, "fieldId");
  const validation: unknown = Reflect.get(value, "validation");
  const fieldErrors = detailFieldErrors(Reflect.get(value, "fieldErrors"));
  const messages = detailMessages(Reflect.get(value, "messages"));
  const detail: JiraMutationFailureDetail = {
    ...(Reflect.get(value, "unchanged") === true ? { unchanged: true } : {}),
    ...(Reflect.get(value, "fromJira") === true ? { fromJira: true } : {}),
    ...(detailFieldId(fieldId) ? { fieldId } : {}),
    ...(VALIDATION_FAILURES.has(validation)
      ? { validation: validation as JiraFieldValidationFailure }
      : {}),
    ...(fieldErrors.length === 0 ? {} : { fieldErrors }),
    ...(messages.length === 0 ? {} : { messages }),
  };
  // The fact about who refused explains nothing by itself: without a field error or a message there
  // is no detail at all, as before.
  return Object.keys(detail).every((key) => key === "fromJira") ? undefined : detail;
}

// eslint-disable-next-line no-control-regex -- a link type name is a single-line identifier.
const LINK_TYPE_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const LINK_ISSUE_KEY = /^[A-Za-z]\w{0,254}-[1-9]\d{0,17}$/u;
function linkTypeName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    !LINK_TYPE_CONTROL.test(value)
  );
}
function linkRef(value: unknown): JiraMutationLinkRef | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const type: unknown = Reflect.get(value, "type");
  const direction: unknown = Reflect.get(value, "direction");
  const issueKey: unknown = Reflect.get(value, "issueKey");
  if (!linkTypeName(type) || (direction !== "inward" && direction !== "outward")) return undefined;
  return typeof issueKey === "string" && LINK_ISSUE_KEY.test(issueKey)
    ? { type, direction, issueKey }
    : undefined;
}
function linkCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= JIRA_MUTATION_LINKS_MAX
  );
}
/** One bounded projection of a link account, applied wherever an account crosses a boundary. */
export function sanitizeJiraMutationLinkAccount(
  value: unknown,
): JiraMutationLinkAccount | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const requested: unknown = Reflect.get(value, "requested");
  const created: unknown = Reflect.get(value, "created");
  const unconfirmed: unknown = Reflect.get(value, "unconfirmed");
  const listed: unknown = Reflect.get(value, "missing");
  if (!linkCount(requested) || !linkCount(created) || created > requested) return undefined;
  if (typeof unconfirmed !== "boolean" || !Array.isArray(listed)) return undefined;
  const missing: (JiraMutationLinkRef | undefined)[] = (listed as unknown[]).map(linkRef);
  if (missing.length > requested) return undefined;
  const refs = missing.filter((link): link is JiraMutationLinkRef => link !== undefined);
  return refs.length === missing.length
    ? { requested, created, missing: refs, unconfirmed }
    : undefined;
}
