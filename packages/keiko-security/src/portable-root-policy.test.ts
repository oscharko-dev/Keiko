import { describe, expect, it } from "vitest";
import { isSystemManagedPortableRoot } from "./portable-root-policy.js";

describe("shared portable system-root policy", () => {
  it.each(["macos-arm64", "macos-x64"] as const)(
    "permits only the canonical system Applications exception for %s",
    (target) => {
      expect(isSystemManagedPortableRoot("/Applications/Keiko.app", target)).toBe(false);
      for (const root of [
        "/Applications/Other.app",
        "/Applications/Keiko.app/child",
        "/Applications",
        "/Library/Keiko",
        "/System/Keiko",
      ]) {
        expect(isSystemManagedPortableRoot(root, target)).toBe(true);
      }
      expect(isSystemManagedPortableRoot("/Users/alice/Applications/Keiko.app", target)).toBe(
        false,
      );
    },
  );
  it.each(["linux-x64", "windows-x64"] as const)(
    "does not export the macOS exception to %s",
    (target) => {
      expect(isSystemManagedPortableRoot("/Applications/Keiko.app", target)).toBe(true);
    },
  );
  it.each([
    "/usr",
    "/usr/local/Keiko",
    "/etc/Keiko",
    "/bin/Keiko",
    "//server/share",
    "D:\\Program Files\\Keiko",
    "C:\\Program Files (x86)\\Keiko",
    "C:\\ProgramData\\Keiko",
    "C:\\Windows\\Keiko",
  ])("denies protected root %s", (root) => {
    expect(isSystemManagedPortableRoot(root, "linux-x64")).toBe(true);
  });
  it.each(["/home/alice/.local/opt/Keiko", "/opt/Keiko", "/usr-local/Keiko", "D:\\Apps\\Keiko"])(
    "preserves existing user-local policy for %s",
    (root) => {
      expect(isSystemManagedPortableRoot(root, "linux-x64")).toBe(false);
    },
  );
});
