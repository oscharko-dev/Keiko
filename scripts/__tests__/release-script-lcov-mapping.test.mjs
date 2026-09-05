import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_NPM_INSTALL_TIMEOUT_MS,
  NPM_INSTALL_TIMEOUT_MS,
  WINDOWS_NPM_INSTALL_TIMEOUT_MS,
  npmInstallTimeoutMs,
  parseArgs,
  parsePositiveTimeoutEnv,
} from "../installable-package-smoke.mjs";
import { createStagedPublishPackage } from "../stage-publish-package.mjs";

let stagedPublishPackage;

// Building the genuine publish fixture includes every vendored workspace and is the measured cold
// cost; stage it once with a setup-only budget, then keep assertion bodies on their original limits.
beforeAll(() => {
  stagedPublishPackage = createStagedPublishPackage();
}, 180_000);

afterAll(() => {
  stagedPublishPackage?.cleanup();
});

afterEach(() => {
  delete globalThis.__keikoPackageSurfaceCoverageSeam;
  delete process.env.KEIKO_PACKAGE_SURFACE_COVERAGE_IMPORT_ONLY;
  delete process.env.KEIKO_SMOKE_INSTALL_TIMEOUT_MS;
  vi.restoreAllMocks();
});

describe("release script LCOV mapping seams", () => {
  it("maps check-version-consistency.mjs into LCOV through the real guarded source hash path", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await import("../check-version-consistency.mjs");

    expect(log).toHaveBeenCalledWith(expect.stringContaining("version-consistency: PASS"));
  });

  // The guarded module still imports and instruments the real staged package surface, so retain
  // its existing 60-second body budget independently of the one-time staging hook above.
  it("covers the package-surface runtime and vendored workspace requirements", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    let seamError;
    let seamCalled = false;
    process.env.KEIKO_PACKAGE_SURFACE_COVERAGE_IMPORT_ONLY = "1";
    globalThis.__keikoPackageSurfaceCoverageSeam = (surface) => {
      try {
        seamCalled = true;
        surface.assertTypeScriptRuntimeSurface([
          {
            name: "@oscharko-dev/keiko-server",
            files: ["package.json"],
          },
        ]);
        expect(() => {
          surface.assertTypeScriptRuntimeSurface([]);
        }).toThrow("process.exit(1)");
        const paths = stagedPublishPackage.vendorPackages.map(({ archivePath }) => archivePath);
        surface.assertVendoredPayload(paths, stagedPublishPackage.vendorPackages);
        surface.assertVendoredWorkspaceExportArtifacts(stagedPublishPackage.vendorPackages);
        surface.assertWorkflowHandoffSubpath(stagedPublishPackage.vendorPackages);
        surface.assertContractsMemorySubpath(stagedPublishPackage.vendorPackages);
        surface.assertLocalKnowledgeDistPath(stagedPublishPackage.vendorPackages);
        expect(surface.collectBuildOutputs(stagedPublishPackage.vendorPackages)).toContain(
          "packages/keiko-server/dist/index.js",
        );
        expect(() => surface.assertVendoredPayload(paths, [])).toThrow("process.exit(1)");
        expect(() => surface.assertVendoredWorkspaceExportArtifacts([])).toThrow("process.exit(1)");
        expect(() => surface.assertWorkflowHandoffSubpath([])).toThrow("process.exit(1)");
        expect(() => surface.assertContractsMemorySubpath([])).toThrow("process.exit(1)");
        expect(() =>
          surface.assertContractsMemorySubpath(stagedPublishPackage.vendorPackages, {
            types: "./src/memory.ts",
            import: "./src/memory.js",
          }),
        ).toThrow("process.exit(1)");
        expect(() =>
          surface.assertContractsMemorySubpath(stagedPublishPackage.vendorPackages, {
            types: "./dist/memory.d.ts",
            import: "./dist/memory.js",
            default: "./dist/memory.js",
          }),
        ).toThrow("process.exit(1)");
        const withoutMemoryTypes = stagedPublishPackage.vendorPackages.map((vendorPackage) =>
          vendorPackage.name === "@oscharko-dev/keiko-contracts"
            ? {
                ...vendorPackage,
                files: vendorPackage.files.filter((file) => file !== "dist/memory.d.ts"),
              }
            : vendorPackage,
        );
        expect(() => surface.assertContractsMemorySubpath(withoutMemoryTypes)).toThrow(
          "process.exit(1)",
        );
        expect(() => surface.assertLocalKnowledgeDistPath([])).toThrow("process.exit(1)");
      } catch (error_) {
        seamError = error_;
      }
    };

    await expect(import("../check-package-surface.mjs?coverage-seam")).rejects.toThrow(
      "import-only coverage seam",
    );

    expect(seamError).toBeUndefined();
    expect(seamCalled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("productive TypeScript API runtime"),
    );
  }, 60_000);

  it("covers the installable-smoke timeout contract without running the install smoke", async () => {
    expect(DEFAULT_NPM_INSTALL_TIMEOUT_MS).toBe(600_000);
    expect(WINDOWS_NPM_INSTALL_TIMEOUT_MS).toBe(600_000);
    expect(NPM_INSTALL_TIMEOUT_MS).toBe(600_000);
    expect(parseArgs(["--include-optional"])).toEqual({ includeOptional: true });

    process.env.KEIKO_SMOKE_INSTALL_TIMEOUT_MS = "120000";

    expect(parsePositiveTimeoutEnv("KEIKO_SMOKE_INSTALL_TIMEOUT_MS")).toBe(120_000);
    expect(npmInstallTimeoutMs()).toBe(120_000);
    const moduleWithEnv = await import("../installable-package-smoke.mjs?timeout-env-support");

    expect(moduleWithEnv.NPM_INSTALL_TIMEOUT_MS).toBe(120_000);

    process.env.KEIKO_SMOKE_INSTALL_TIMEOUT_MS = "not-a-number";
    const moduleWithInvalidEnv =
      await import("../installable-package-smoke.mjs?timeout-env-invalid");

    expect(moduleWithInvalidEnv.NPM_INSTALL_TIMEOUT_MS).toBe(600_000);

    process.env.KEIKO_SMOKE_INSTALL_TIMEOUT_MS = String(Number.MAX_SAFE_INTEGER + 1);
    const moduleWithUnsafeEnv = await import("../installable-package-smoke.mjs?timeout-env-unsafe");

    expect(moduleWithUnsafeEnv.NPM_INSTALL_TIMEOUT_MS).toBe(600_000);
  });
});
