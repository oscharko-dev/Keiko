// Quality Intelligence — path-safety predicates (Epic #270, Issue #284).
//
// Pure synchronous predicates that reject obviously-dangerous relative paths
// BEFORE they cross any IO seam (Workspace, Evidence, Connector). The package
// itself performs no IO; these helpers exist so adjacent leaves can reject
// adversarial inputs at the contract boundary with byte-stable, cross-platform
// semantics. No `node:path` import: rule is intentionally `path.sep`-agnostic
// so the same predicate accepts/rejects identical strings on POSIX and Windows.
//
// Structurally inspired by Test Intelligence reference (TI) path-guard rules,
// rewritten against the Keiko contracts surface.

/** Maximum permitted UTF-16 length of a safe relative path. */
export const MAX_SAFE_RELATIVE_PATH_LENGTH = 256;

const FORBIDDEN_DOTDOT_SEGMENT = /(^|[\\/])\.\.([\\/]|$)/u;

const containsControlOrNullByte = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    // C0 control range (includes NUL 0x00), DEL, and C1 control range.
    if (code <= 0x1f) return true;
    if (code === 0x7f) return true;
    if (code >= 0x80 && code <= 0x9f) return true;
  }
  return false;
};

/**
 * Predicate: returns `true` when the supplied string is a syntactically safe
 * relative path acceptable for use as a contract field (Quality Intelligence
 * evidence reference, source-mix planning key, etc.).
 *
 * Rejects when ANY of the following hold:
 *   - empty string
 *   - contains a `..` path segment (POSIX or Windows separator)
 *   - contains a null byte or any C0/DEL control char
 *   - starts with `/` (POSIX absolute) or `\` (Windows root)
 *   - contains `:` (Windows drive letter, NTFS ADS, scheme prefix)
 *   - exceeds {@link MAX_SAFE_RELATIVE_PATH_LENGTH} UTF-16 code units
 *
 * Pure: no IO, no clock, no randomness, no `node:path`.
 */
export const isSafeRelativePath = (candidate: string): boolean => {
  if (typeof candidate !== "string") return false;
  if (candidate.length === 0) return false;
  if (candidate.length > MAX_SAFE_RELATIVE_PATH_LENGTH) return false;
  if (candidate.startsWith("/")) return false;
  if (candidate.startsWith("\\")) return false;
  if (candidate.includes(":")) return false;
  if (containsControlOrNullByte(candidate)) return false;
  if (FORBIDDEN_DOTDOT_SEGMENT.test(candidate)) return false;
  return true;
};
