/** Field-kind comparisons only; callers still prove the resource and requested field identities. */
export type JiraReadbackValueKind = "exact" | "clearable-text" | "user-name";
function emptyText(value: unknown): unknown {
  return value ?? "";
}
export function jiraReadbackValueMatches(
  kind: JiraReadbackValueKind,
  actual: unknown,
  expected: unknown,
): boolean {
  if (kind === "clearable-text") return emptyText(actual) === emptyText(expected);
  if (kind === "user-name")
    return (
      typeof actual === "string" &&
      typeof expected === "string" &&
      actual.toLowerCase() === expected.toLowerCase()
    );
  return actual === expected;
}
