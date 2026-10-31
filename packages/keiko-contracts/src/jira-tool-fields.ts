export const JIRA_FIELD_READ_MAX = 20;
export const JIRA_FIELD_ID_PATTERN = String.raw`^(?:[a-zA-Z][a-zA-Z0-9]*|customfield_\d{1,16})$`;
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
  /** A single issue reference (`{ key }` or `{ id }`), e.g. the system `parent` field (#4176). */
  "issue",
  /** A field whose value shape Jira's metadata does not describe beyond its schema type; a bounded
   * JSON value is forwarded and Jira's own validation is authoritative (#4176). */
  "opaque",
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
  "jira.transitions",
  "jira.assignable-users",
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
  /** Jira's declared schema type (`string`, `array:string`, `any`, …) so a caller can shape an
   * opaque value; metadata only, never a mutation identity. */
  readonly schemaType?: string;
}
export interface JiraFieldUpdate {
  readonly fieldId: string;
  readonly operation: "add" | "remove";
  readonly value: string;
}
