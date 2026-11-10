/** Text of an already-validated identifier argument; any other shape yields the empty string. */
export function jiraIdentifierText(value: unknown): string {
  if (typeof value === "string") return value;
  return typeof value === "number" ? String(value) : "";
}
