import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

function isContained(root, candidate) {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function assertContained(root, candidate) {
  if (!isContained(root, candidate)) {
    throw new Error("UI static root must stay inside the repository");
  }
}

export async function resolveUiStaticRoot(repoRoot, candidate) {
  const absoluteRepoRoot = resolve(repoRoot);
  const absoluteCandidate = resolve(candidate);
  assertContained(absoluteRepoRoot, absoluteCandidate);

  const [canonicalRepoRoot, canonicalCandidate] = await Promise.all([
    realpath(absoluteRepoRoot),
    realpath(absoluteCandidate),
  ]);
  assertContained(canonicalRepoRoot, canonicalCandidate);
  return canonicalCandidate;
}

export function rejectUiStaticRootCliOverride(override) {
  if (override !== undefined) {
    throw new Error("UI static root CLI overrides are not supported");
  }
}

export function rejectUiStaticSymlink(entry) {
  if (entry.isSymbolicLink()) {
    throw new Error("UI static trees must not contain symbolic links");
  }
}
