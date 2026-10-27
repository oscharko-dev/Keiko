/** Bounded capability projection from current Jira create/edit/transition metadata (#4083). */
export const JIRA_FIELD_KINDS = [
  "text",
  "number",
  "date",
  "datetime",
  "user",
  "option",
  "strings",
  "users",
  "options",
  "unsupported",
] as const;
export type JiraFieldKind = (typeof JIRA_FIELD_KINDS)[number];
export const JIRA_MANAGED_READ_TOOLS = [
  "jira.projects",
  "jira.issue-types",
  "jira.create-fields",
  "jira.edit-fields",
  "jira.search",
  "jira.issue",
  "jira.comments",
] as const;
export type JiraManagedReadToolName = (typeof JIRA_MANAGED_READ_TOOLS)[number];
export type JiraFieldOperation = "set" | "add" | "remove";
export interface JiraFieldReference {
  readonly id?: string;
  readonly name?: string;
  readonly accountId?: string;
  /** Display only; never accepted as a mutation identity. */
  readonly label?: string;
}
export interface JiraFieldMetadata {
  readonly id: string;
  readonly name: string;
  readonly required: boolean;
  readonly hasDefaultValue: boolean;
  readonly kind: JiraFieldKind;
  readonly richText: boolean;
  readonly operations: readonly JiraFieldOperation[];
  readonly allowedValues?: readonly JiraFieldReference[];
}
export interface JiraFieldUpdate {
  readonly fieldId: string;
  readonly operation: "add" | "remove";
  readonly value: string;
}
