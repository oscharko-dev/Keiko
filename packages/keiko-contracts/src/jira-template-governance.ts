import {
  JIRA_AVATAR_MUTATIONS,
  JIRA_AVATAR_UPLOAD_MUTATIONS,
  JIRA_IDENTITY_MUTATIONS,
  JIRA_PRIVATE_ACCOUNT_MUTATIONS,
  JIRA_GROUP_MUTATIONS,
  JIRA_MAINTENANCE_MUTATIONS,
  JIRA_DIRECTORY_ACCESS_MUTATIONS,
  JIRA_ENTITY_PROPERTY_MUTATIONS,
  JIRA_SAVED_CONFIGURATION_MUTATIONS,
  JIRA_SCREEN_CONFIGURATION_MUTATIONS,
  JIRA_BOARD_CONFIGURATION_MUTATIONS,
  JIRA_OPTION_SCHEME_MUTATIONS,
  JIRA_WORKFLOW_SCHEME_MUTATIONS,
  JIRA_INSTANCE_SETTING_MUTATIONS,
  JIRA_EMAIL_TEMPLATE_MUTATIONS,
  JIRA_PERMISSION_SCHEME_MUTATIONS,
  JIRA_ROLE_MUTATIONS,
  JIRA_VERSION_REMOTE_LINK_MUTATIONS,
  JIRA_PROJECT_CATEGORY_MUTATIONS,
  JIRA_ANONYMIZATION_UNLOCK_MUTATIONS,
  type JiraMutationOperation,
} from "./jira-tool-execution.js";

/**
 * The closed classification of every Jira mutating operation by its relation to the customer's issue
 * templates (#4354 A.7). The template gate sits below every autonomy mode; this table says which
 * operation reaches which gate, and names the reason for every operation that does not. It is a
 * `Record<JiraMutationOperation, …>` literal, so a newly registered operation that is not classified
 * is a compile error and a name classified twice fails when the module loads: an operation can never be "open at runtime"
 * because it was forgotten. `jira-template-governance.test.ts` additionally pins the named cases and
 * that every class is used.
 *
 * - `create`: strict. Needs an active template of the issue type; judged before anything is sent.
 * - `create-batch`: every row of a bulk create passes the create gate.
 * - `draft`: stages a create or edit for review; its dry run applies the same gate before the card.
 * - `edit`: the issue's state after the change is judged against its templates (no worse than before).
 * - `transition`: only a template activated for `transition:<target>` governs it.
 * - `bulk-impact`: changes no issue field itself but moves, removes or re-types many issues at once
 *   (a sprint, release, issue type, custom field, link type, project or issue deletion); guarded by the
 *   templates' bulk-reference rules.
 * - `not-governed`: no template rule applies; the closed reason says why. `issue-lifecycle`:
 *   archive, restore and subtask reordering change no template-governed field
 *   (`jira.move-subtask` reorders the subtasks of one parent and never reparents); `comment` and
 *   `participation`: owner decision, comments, watchers and votes are unchecked;
 *   `attachment-withdrawn`: Release 1 switches attachments off; `not-issue-content`: administration,
 *   project and agile structure, accounts and instance settings.
 */
export type JiraTemplateGovernance =
  | { readonly class: "create" | "create-batch" | "draft" | "edit" | "transition" | "bulk-impact" }
  | { readonly class: "not-governed"; readonly reason: JiraNotGovernedReason };

export const JIRA_NOT_GOVERNED_REASONS = [
  "issue-lifecycle",
  "comment",
  "participation",
  "attachment-withdrawn",
  "not-issue-content",
] as const;
export type JiraNotGovernedReason = (typeof JIRA_NOT_GOVERNED_REASONS)[number];

const CREATE: JiraTemplateGovernance = { class: "create" };
const CREATE_BATCH: JiraTemplateGovernance = { class: "create-batch" };
const DRAFT: JiraTemplateGovernance = { class: "draft" };
const EDIT: JiraTemplateGovernance = { class: "edit" };
const TRANSITION: JiraTemplateGovernance = { class: "transition" };
const BULK_IMPACT: JiraTemplateGovernance = { class: "bulk-impact" };
const LIFECYCLE: JiraTemplateGovernance = { class: "not-governed", reason: "issue-lifecycle" };
const COMMENT: JiraTemplateGovernance = { class: "not-governed", reason: "comment" };
const PARTICIPATION: JiraTemplateGovernance = { class: "not-governed", reason: "participation" };
const ATTACHMENT: JiraTemplateGovernance = {
  class: "not-governed",
  reason: "attachment-withdrawn",
};
const NOT_ISSUE_CONTENT: JiraTemplateGovernance = {
  class: "not-governed",
  reason: "not-issue-content",
};

/** Every name `classified` was given, so a name classified twice is found when the module loads. */
const CLASSIFIED: string[] = [];
/** A name classified twice would silently take the later class; this refuses it, loudly. */
export function assertEachClassifiedOnce(names: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name))
      throw new TypeError(`${name} is classified twice in the template governance table`);
    seen.add(name);
  }
}
/**
 * One class for a short list of operations. A list instead of one `"name": CLASS` line each keeps
 * the table from reading as a hundred copies of the same line, and the result type keeps every name,
 * so `satisfies` below still fails to compile for an operation nobody classified.
 */
function classified<const Names extends readonly JiraMutationOperation[]>(
  governance: JiraTemplateGovernance,
  names: Names,
): Record<Names[number], JiraTemplateGovernance> {
  CLASSIFIED.push(...names);
  return Object.fromEntries(names.map((name) => [name, governance])) as Record<
    Names[number],
    JiraTemplateGovernance
  >;
}

/**
 * Every operation of the 20 family arrays that are administration through and through (avatars and
 * their uploads, accounts, groups, schemes, roles, screens, boards, saved configuration, instance
 * settings, …) is not issue content; the avatar uploads are a subset of the avatars, so the 20 arrays
 * name fewer distinct operations than their lengths add up to. The families are the registry's own (`JIRA_MUTATION_OPERATIONS` is built from them), so a
 * new member of such a family is classified with its family, never re-listed here. A family that
 * mixes issue and administration operations is NOT taken whole: its members are classified one by
 * one below, so a new operation there fails to compile until someone decides what it is. A family
 * member that is also listed by hand is a name classified twice and fails when the module loads.
 */
function administration<const Families extends readonly (readonly JiraMutationOperation[])[]>(
  families: Families,
): Record<Families[number][number], JiraTemplateGovernance> {
  // A family may contain another's operations (the avatar uploads are avatars too).
  const names = [...new Set(families.flat())] as Families[number][number][];
  return classified(NOT_ISSUE_CONTENT, names);
}

export const JIRA_TEMPLATE_GOVERNANCE = Object.freeze({
  ...classified(CREATE, ["jira.create"]),
  ...classified(CREATE_BATCH, ["jira.create-issues"]),
  ...classified(DRAFT, ["jira.draft"]),
  ...classified(EDIT, [
    "jira.edit",
    "jira.assign",
    "jira.create-issue-link",
    "jira.delete-issue-link",
    "jira.upsert-remote-link",
    "jira.update-remote-link",
    "jira.delete-remote-link",
    "jira.delete-remote-link-by-global-id",
    "jira.create-reciprocal-remote-link",
    "jira.create-worklog",
    "jira.update-worklog",
    "jira.delete-worklog",
    "jira.epic-remove-issues",
    "jira.rank-epic",
    "jira.rank-issues",
    "jira.set-issue-estimation",
    "jira.sprint-move-issues",
    "jira.epic-move-issues",
    "jira.backlog-move-issues",
    "jira.epic-update",
  ]),
  ...classified(TRANSITION, ["jira.transition"]),
  ...classified(BULK_IMPACT, [
    "jira.sprint-update",
    "jira.delete-component",
    "jira.merge-version",
    "jira.remove-and-swap-version",
    "jira.delete-sprint",
    "jira.replace-sprint",
    "jira.delete-issue",
    "jira.delete-project",
    "jira.delete-custom-fields",
    "jira.delete-issue-type",
    "jira.delete-link-type",
    "jira.update-issue-type",
    "jira.update-link-type",
  ]),
  ...classified(LIFECYCLE, [
    "jira.archive-issue",
    "jira.archive-issues",
    "jira.restore-issue",
    "jira.move-subtask",
  ]),
  ...classified(COMMENT, [
    "jira.comment",
    "jira.update-comment",
    "jira.delete-comment",
    "jira.pin-comment",
    "jira.notify-issue",
  ]),
  ...classified(PARTICIPATION, ["jira.watch", "jira.unwatch", "jira.vote", "jira.unvote"]),
  ...classified(ATTACHMENT, ["jira.attach", "jira.delete-attachment"]),
  ...classified(NOT_ISSUE_CONTENT, [
    "jira.board-create",
    "jira.sprint-create",
    "jira.create-component",
    "jira.update-component",
    "jira.set-app-monitoring",
    "jira.set-ipd-monitoring",
    "jira.start-jmx-metrics",
    "jira.stop-jmx-metrics",
    "jira.archive-project",
    "jira.remove-project-priority-scheme",
    "jira.restore-project",
    "jira.set-project-permission-scheme",
    "jira.set-project-priority-scheme",
    "jira.update-project-type",
    "jira.create-project",
    "jira.update-project",
    "jira.create-custom-field",
    "jira.create-issue-type",
    "jira.create-link-type",
    "jira.move-link-type",
    "jira.reset-link-type-order",
    "jira.set-terminology",
    "jira.create-screen-tab",
    "jira.delete-screen-tab",
    "jira.rename-screen-tab",
    "jira.swap-sprints",
    "jira.unmap-all-sprints",
    "jira.unmap-sprints",
    "jira.move-version",
    "jira.create-version",
    "jira.update-version",
  ]),
  ...administration([
    JIRA_AVATAR_MUTATIONS,
    JIRA_AVATAR_UPLOAD_MUTATIONS,
    JIRA_IDENTITY_MUTATIONS,
    JIRA_PRIVATE_ACCOUNT_MUTATIONS,
    JIRA_GROUP_MUTATIONS,
    JIRA_MAINTENANCE_MUTATIONS,
    JIRA_DIRECTORY_ACCESS_MUTATIONS,
    JIRA_ENTITY_PROPERTY_MUTATIONS,
    JIRA_SAVED_CONFIGURATION_MUTATIONS,
    JIRA_SCREEN_CONFIGURATION_MUTATIONS,
    JIRA_BOARD_CONFIGURATION_MUTATIONS,
    JIRA_OPTION_SCHEME_MUTATIONS,
    JIRA_WORKFLOW_SCHEME_MUTATIONS,
    JIRA_INSTANCE_SETTING_MUTATIONS,
    JIRA_EMAIL_TEMPLATE_MUTATIONS,
    JIRA_PERMISSION_SCHEME_MUTATIONS,
    JIRA_ROLE_MUTATIONS,
    JIRA_VERSION_REMOTE_LINK_MUTATIONS,
    JIRA_PROJECT_CATEGORY_MUTATIONS,
    JIRA_ANONYMIZATION_UNLOCK_MUTATIONS,
  ]),
} satisfies Record<JiraMutationOperation, JiraTemplateGovernance>);
assertEachClassifiedOnce(CLASSIFIED);

/** The classification of one registered mutating operation, or undefined for an unregistered name. */
export function jiraTemplateGovernanceOf(operation: string): JiraTemplateGovernance | undefined {
  return Object.hasOwn(JIRA_TEMPLATE_GOVERNANCE, operation)
    ? JIRA_TEMPLATE_GOVERNANCE[operation as JiraMutationOperation]
    : undefined;
}
