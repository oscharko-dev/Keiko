// Shared structural validation without importing domain codecs.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key} is not allowed`);
  }
  return errors;
}

export function isPhysicalArrayOf(
  value: unknown,
  checkMember: (member: unknown) => boolean,
): boolean {
  if (!Array.isArray(value)) return false;
  const entries: readonly unknown[] = value;
  const extent = entries.length;
  for (let index = 0; index < extent; index += 1) {
    if (!(index in entries)) return false;
    if (!checkMember(entries[index])) return false;
  }
  return true;
}

export function appendValidationIssues(errors: string[], ...issues: readonly string[]): boolean {
  errors.push(...issues);
  return issues.length === 0;
}

export function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  const values: readonly string[] = allowed;
  return typeof value === "string" && values.includes(value);
}

export function validateAllowedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: string[],
): boolean {
  let valid = true;
  Object.keys(record)
    .filter((key) => !allowed.includes(key))
    .forEach(
      (key) =>
        (valid = [appendValidationIssues(errors, `${path}.${key} is not allowed`), valid].every(
          Boolean,
        )),
    );

  return valid;
}

export function validatePhysicalArrayEntries(
  value: unknown,
  path: string,
  errors: string[],
  requireNonEmpty: boolean,
  missingMemberIssue: string,
  validateMember: (value: unknown, path: string, errors: string[]) => boolean,
): boolean {
  let valid = true;
  if (!Array.isArray(value)) {
    valid = [appendValidationIssues(errors, `${path} must be an array`), valid].every(Boolean);
    return valid;
  }
  if (requireNonEmpty && value.length === 0) {
    valid = [appendValidationIssues(errors, `${path} must not be empty`), valid].every(Boolean);
  }
  const extent = value.length;
  for (let index = 0; index < extent; index += 1) {
    const memberPath = `${path}[${String(index)}]`;
    if (!(index in value))
      return appendValidationIssues(errors, `${memberPath} ${missingMemberIssue}`);
    const entry: unknown = value[index];
    valid = [validateMember(entry, memberPath, errors), valid].every(Boolean);
  }
  return valid;
}

export function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
