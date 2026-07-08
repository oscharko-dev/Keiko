import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ADR-0118 D4 (docs/adr/ADR-0118-native-file-dialog-boundary.md) states the in-app pickers —
// including the shared `LocalFileBrowserDialog` — were deleted as part of Epic #1941. A prior
// audit found that claim false: the component and its test survived as orphaned dead code with
// zero remaining importers once its three call sites (RunLauncher, capsule-actions,
// source-rebind-control) switched to the native dialog. This pins the ADR's claim to reality so
// it cannot silently drift false again.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const localFilesDir = join(
  repoRoot,
  "packages",
  "keiko-ui",
  "src",
  "app",
  "components",
  "desktop",
  "local-files",
);

describe("ADR-0118 in-app picker deletion claim", () => {
  it("LocalFileBrowserDialog and its test are actually deleted, not just documented as deleted", () => {
    expect(existsSync(join(localFilesDir, "LocalFileBrowserDialog.tsx"))).toBe(false);
    expect(existsSync(join(localFilesDir, "LocalFileBrowserDialog.test.tsx"))).toBe(false);
  });

  it("the local-files directory itself no longer exists (nothing else was added to it)", () => {
    expect(existsSync(localFilesDir)).toBe(false);
  });
});
