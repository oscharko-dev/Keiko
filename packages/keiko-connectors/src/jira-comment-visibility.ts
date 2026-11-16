import { asRecord } from "./atlassian-sync-classify.js";
import { jiraNativeText } from "./jira-native-values.js";

export interface JiraCommentVisibility {
  readonly type: "group" | "role";
  readonly value: string;
}

/** Absence is distinct from an unrecognized restriction, which must never become public. */
export function jiraCommentVisibility(value: unknown): JiraCommentVisibility | null | undefined {
  if (value === undefined || value === null) return null;
  const raw = asRecord(value);
  return raw !== undefined &&
    Object.keys(raw).length === 2 &&
    (raw.type === "group" || raw.type === "role") &&
    jiraNativeText(raw.value, 255)
    ? { type: raw.type, value: raw.value }
    : undefined;
}

export function sameJiraCommentVisibility(
  actual: JiraCommentVisibility | null | undefined,
  expected: JiraCommentVisibility | null,
): boolean {
  return actual === null || expected === null
    ? actual === expected
    : actual?.type === expected.type && actual.value === expected.value;
}
