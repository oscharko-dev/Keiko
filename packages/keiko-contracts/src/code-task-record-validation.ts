// Code-task acceptance boundaries require plain records and closed own string/symbol keys.
// Reject non-default prototypes before field admission: own-name scans cannot see an inherited
// extra field. Scan all own names (including non-enumerable names) and symbols when closing a
// schema. This complements, and does not replace, ownField protection against global pollution.
// Keep prototype admission separate from key scanning: schema owners retain their own field reads,
// allowed keys, error paths and checks for inherited facts through the existing ownField primitive.

export function isCodeTaskRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function validateCodeTaskOwnKeys(
  errors: string[],
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): boolean {
  const unknownErrors = Object.getOwnPropertyNames(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${path}.${key} is not allowed`);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    unknownErrors.push(`${path} must not carry symbol-keyed properties`);
  }
  errors.push(...unknownErrors);
  return unknownErrors.length === 0;
}

// See acceptance's retained Codex P1 rationale: enumeration is defense in depth, not admission.
export function hasInheritedEnumerableProperty(record: Record<string, unknown>): boolean {
  for (const key in record) {
    if (!Object.hasOwn(record, key)) return true;
  }
  return false;
}

function addValidationError(errors: string[], message: string): false {
  errors.push(message);
  return false;
}

// Schema owners retain their known-value policies and diagnostics through the admitted callback.
export function validateCodeTaskTaggedFact(
  errors: string[],
  value: unknown,
  path: string,
  validateKnown: (record: Record<string, unknown>) => boolean,
): boolean {
  let valid = true;
  if (!isCodeTaskRecord(value)) {
    return addValidationError(errors, `${path} must be a tagged fact object`);
  }
  if (hasInheritedEnumerableProperty(value)) {
    return addValidationError(
      errors,
      `${path} must not resolve any field through its prototype chain`,
    );
  }
  const outcome = Object.hasOwn(value, "outcome") ? value.outcome : undefined;
  if (outcome === "known") return validateKnown(value);
  if (outcome === "unknown" || outcome === "unavailable" || outcome === "absent") {
    // KfQ 3789542365: this used to return early on an own "value" field, so unknownKeys never ran
    // and any OTHER extra own key went unreported. Collected instead, matching the "report every
    // violation" position already taken for onlyKnownKeys elsewhere in this PR.
    valid = validateCodeTaskOwnKeys(errors, value, ["outcome"], path) && valid;
    if (Object.hasOwn(value, "value")) {
      valid = addValidationError(errors, `${path} must not carry a value for outcome ${outcome}`);
    }
    return valid;
  }
  return addValidationError(
    errors,
    `${path}.outcome must be known, unknown, unavailable, or absent`,
  );
}
