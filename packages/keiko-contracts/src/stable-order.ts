export function sortedStrings(values: Iterable<string>): readonly string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}
