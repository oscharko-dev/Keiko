/** Bounded capability projection from current Jira create/edit/transition metadata (#4083). */
export type JiraFieldKind =
  | "text"
  | "number"
  | "date"
  | "datetime"
  | "user"
  | "option"
  | "strings"
  | "users"
  | "options"
  | "unsupported";
export type JiraFieldOperation = "set" | "add" | "remove";
export interface JiraFieldReference {
  readonly id?: string;
  readonly name?: string;
  readonly accountId?: string;
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
