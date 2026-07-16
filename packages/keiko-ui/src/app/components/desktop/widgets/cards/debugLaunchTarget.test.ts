// Epic-integration regression test (Epic #2096, ADR-0136 D4): before this fix, every debug-start call
// site unconditionally built `{ kind: "file", fileId }`, so a recognized test file could never reach
// the fully-implemented catalog-kind launch (#2343-#2345). These tests fail against the old
// unconditional-file behavior and pass once `resolveDebugLaunchTarget` prefers a trusted catalog test
// task for a recognized test file.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandTaskCatalog } from "../../../../../lib/types";

vi.mock("../../../../../lib/commands-api", () => ({
  fetchCommandCatalog: vi.fn(),
}));

import { fetchCommandCatalog } from "../../../../../lib/commands-api";
import { resolveDebugLaunchTarget } from "./debugLaunchTarget";

function catalog(tasks: CommandTaskCatalog["tasks"]): CommandTaskCatalog {
  return { schemaVersion: "1", projectId: "/workspace", tasks };
}

const TRUSTED_TEST_TASK = {
  id: "npm-script:test",
  kind: "test",
  label: "npm run test",
  executable: "npm",
  args: ["run", "test"],
  source: "package-json-script",
  trustState: "trusted",
  trustReason: "repository-authored-script",
} as const;

describe("resolveDebugLaunchTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes a recognized test file through the discovered, trusted catalog test task", async () => {
    vi.mocked(fetchCommandCatalog).mockResolvedValueOnce(catalog([TRUSTED_TEST_TASK]));

    const target = await resolveDebugLaunchTarget("/workspace", "src/foo.test.ts");

    expect(fetchCommandCatalog).toHaveBeenCalledWith("/workspace");
    expect(target).toEqual({ kind: "catalog", targetId: "npm-script:test" });
  });

  it("never inspects the catalog for an ordinary (non-test) file", async () => {
    const target = await resolveDebugLaunchTarget("/workspace", "src/foo.ts");

    expect(fetchCommandCatalog).not.toHaveBeenCalled();
    expect(target).toEqual({ kind: "file", fileId: "src/foo.ts" });
  });

  it("falls back to the file target when no catalog task is a trusted test kind", async () => {
    vi.mocked(fetchCommandCatalog).mockResolvedValueOnce(
      catalog([{ ...TRUSTED_TEST_TASK, trustState: "approval-required" }]),
    );

    const target = await resolveDebugLaunchTarget("/workspace", "src/foo.test.ts");

    expect(target).toEqual({ kind: "file", fileId: "src/foo.test.ts" });
  });

  it("falls back to the file target when catalog discovery fails", async () => {
    vi.mocked(fetchCommandCatalog).mockRejectedValueOnce(new Error("private BFF detail"));

    const target = await resolveDebugLaunchTarget("/workspace", "src/foo.spec.tsx");

    expect(target).toEqual({ kind: "file", fileId: "src/foo.spec.tsx" });
  });

  it("falls back to the file target without a workspace root, even for a test file", async () => {
    const target = await resolveDebugLaunchTarget("", "src/foo.test.ts");

    expect(fetchCommandCatalog).not.toHaveBeenCalled();
    expect(target).toEqual({ kind: "file", fileId: "src/foo.test.ts" });
  });
});
