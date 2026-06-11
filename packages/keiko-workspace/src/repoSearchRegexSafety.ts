const MAX_REGEX_LENGTH = 200;
const DANGEROUS_GROUP_OR_CLASS_REPETITION = /\([^)]*\)[+*{]|\[[^\]]*\][+*{]/;
const ADJACENT_QUANTIFIED_ATOMS = /(?:\\.|[^\\()[\]{}+*?|])(?:[+*]|\{\d+(?:,\d*)?\})(?:\\.|[^\\()[\]{}+*?|])(?:[+*]|\{\d+(?:,\d*)?\})/;

export function regexSafetyIssue(source: string): string | undefined {
  if (source.length > MAX_REGEX_LENGTH) {
    return `regex too long: ${String(source.length)} > ${String(MAX_REGEX_LENGTH)}`;
  }
  if (DANGEROUS_GROUP_OR_CLASS_REPETITION.test(source)) {
    return "regex contains repetition over a group or character class (potential catastrophic backtracking)";
  }
  if (ADJACENT_QUANTIFIED_ATOMS.test(source)) {
    return "regex contains adjacent quantified atoms (potential catastrophic backtracking)";
  }
  return undefined;
}
