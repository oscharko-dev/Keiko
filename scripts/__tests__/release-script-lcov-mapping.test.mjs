import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_NPM_INSTALL_TIMEOUT_MS,
  NPM_INSTALL_TIMEOUT_MS,
  WINDOWS_NPM_INSTALL_TIMEOUT_MS,
  parseArgs,
  parsePositiveTimeoutEnv,
} from "../installable-package-smoke.mjs";

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

  it("covers the package-surface TypeScript runtime tarball requirement without running npm pack", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    let seamError;
    let seamCalled = false;
    process.env.KEIKO_PACKAGE_SURFACE_COVERAGE_IMPORT_ONLY = "1";
    globalThis.__keikoPackageSurfaceCoverageSeam = (assertTypeScriptRuntimeSurface) => {
      try {
        seamCalled = true;
        assertTypeScriptRuntimeSurface(["node_modules/typescript/package.json"]);

        expect(() => {
          assertTypeScriptRuntimeSurface([]);
        }).toThrow("process.exit(1)");
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
  });

  it("covers the installable-smoke timeout contract without running the install smoke", () => {
    expect(DEFAULT_NPM_INSTALL_TIMEOUT_MS).toBe(600_000);
    expect(WINDOWS_NPM_INSTALL_TIMEOUT_MS).toBe(600_000);
    expect(NPM_INSTALL_TIMEOUT_MS).toBe(600_000);
    expect(parseArgs(["--include-optional"])).toEqual({ includeOptional: true });

    process.env.KEIKO_SMOKE_INSTALL_TIMEOUT_MS = "120000";

    expect(parsePositiveTimeoutEnv("KEIKO_SMOKE_INSTALL_TIMEOUT_MS")).toBe(120_000);
  });
});
