// The bug-fix scope guard's path predicates (ADR-0009 D6). A bug fix legitimately edits production
// source, so #8's test-files-only guard does NOT apply. Instead this module provides two pure
// predicates that bound prompt-injection blast radius WITHOUT modifying #6:
//   - isSensitivePath: reject traversal/absolute (fail-closed), .github/, .husky/, and lockfiles —
//     paths #6's deny-list does NOT cover but that a prompt-injected "fix" must never touch.
//   - isElevatedReviewPath: manifest/config edits are ALLOWED but surfaced for elevated review.
// The change-budget half of D6 is enforced via the #6 PatchLimits override seam (in model-loop.ts).
//
// SECURITY (CodeQL js/polynomial-redos): ALL checks use plain string ops (split, startsWith,
// equality, toLowerCase) — ZERO regex — so there is no ReDoS surface. Checks 2-4 are case-
// insensitive (matching #6 isDenied) so a case-only variant cannot bypass the guard on
// case-insensitive filesystems (macOS/Windows); the traversal check is case-invariant by nature.

const LOCKFILE_BASENAMES: readonly string[] = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
];

const SENSITIVE_DIRS: readonly string[] = [".github", ".husky"];

function toPosix(relPath: string): string {
  return relPath.split("\\").join("/");
}

// Copies #8's isTraversal logic EXACTLY: an absolute leading slash or any `..` segment can resolve
// to a file OUTSIDE the apparent location after #6 resolveWithinWorkspace collapses it. Rejected
// fail-closed BEFORE the case-folded checks so the guarded path matches what #6 would write.
function isTraversal(posixPath: string): boolean {
  return posixPath.startsWith("/") || posixPath.split("/").includes("..");
}

function basename(posixPath: string): string {
  const slash = posixPath.lastIndexOf("/");
  return slash === -1 ? posixPath : posixPath.slice(slash + 1);
}

function underSensitiveDir(lower: string): boolean {
  return SENSITIVE_DIRS.some((dir) => lower === dir || lower.startsWith(`${dir}/`));
}

// Drops `.` and empty ("//") segments so the guard sees the SAME form #6 resolveWithinWorkspace
// collapses to. Without this, `./.husky/pre-commit` and `.//.github/x` slip past the dir/basename
// checks (they don't literally start with `.github/`/`.husky/`) yet #6 writes the real protected
// file (security fix C1). Run only AFTER isTraversal has fail-closed `..`/leading-`/` on the raw
// path. Pure string ops — no regex.
function normalizePosix(posixPath: string): string {
  return posixPath
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

// The sensitive-path guard (D6 bound 2). Returns true when the path must be rejected as
// out-of-scope. Manifest/config edits are NOT sensitive (see isElevatedReviewPath).
export function isSensitivePath(relPath: string): boolean {
  const posixPath = toPosix(relPath);
  if (isTraversal(posixPath)) {
    return true;
  }
  const lower = normalizePosix(posixPath).toLowerCase();
  if (underSensitiveDir(lower)) {
    return true;
  }
  return LOCKFILE_BASENAMES.includes(basename(lower));
}

// Manifest/config edits a fix may legitimately need. ALLOWED, but flagged so the report surfaces
// them as an elevated-review item. A pure basename predicate (case-insensitive). Normalizes `./`
// and `//` segments first so a `./package.json` form is flagged identically to `package.json`.
export function isElevatedReviewPath(relPath: string): boolean {
  const base = basename(normalizePosix(toPosix(relPath)).toLowerCase());
  if (base === "package.json") {
    return true;
  }
  return base.startsWith("tsconfig") && base.endsWith(".json");
}
