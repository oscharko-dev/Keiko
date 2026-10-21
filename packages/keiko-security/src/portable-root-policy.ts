import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";

const POSIX_SYSTEM_ROOTS = [
  "/applications",
  "/library",
  "/system",
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
] as const;

function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.at(end - 1) === "/") end -= 1;
  return value.slice(0, end);
}

/** Classifies a resolved root; callers retain filesystem and installation attestation checks. */
export function isSystemManagedPortableRoot(root: string, target: UpdatePortableTarget): boolean {
  if (root.replaceAll("\\", "/").startsWith("//") || /^\/+$/u.test(root)) return true;
  const normalized = withoutTrailingSlashes(root.replaceAll("\\", "/").toLowerCase());
  if (
    (target === "macos-arm64" || target === "macos-x64") &&
    normalized === "/applications/keiko.app"
  ) {
    return false;
  }
  return (
    POSIX_SYSTEM_ROOTS.some(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
    ) || /^[a-z]:\/(?:program files(?: \(x86\))?|programdata|windows)(?:\/|$)/u.test(normalized)
  );
}
