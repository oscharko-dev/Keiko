import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// GEN-TEST-FLAKE-001: the release-blocking coverage run (vitest.coverage.packages.config.ts) and the
// required UI suites were left at vitest's 5s default testTimeout while the root suite was hardened
// to 15s. Instrumentation + forked workers make the coverage run the MOST likely to blow past 5s
// under scheduler load, so a drift here false-REDs a required gate. This test pins parity: every
// heavy/CI-gated vitest config must share the root suite's 15s per-test timeout. If a future config
// diverges, this fails and names the offender.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const EXPECTED_TIMEOUT_MS = 15_000;

const CONFIGS = [
  { name: "root suite", path: "vitest.config.ts" },
  { name: "package coverage gate", path: "vitest.coverage.packages.config.ts" },
  { name: "keiko-ui coverage gate", path: "packages/keiko-ui/vitest.coverage.config.ts" },
  { name: "keiko-ui suite", path: "packages/keiko-ui/vitest.config.ts" },
];

async function loadTestTimeout(relativePath) {
  const mod = await import(resolve(repoRoot, relativePath));
  const config = typeof mod.default === "function" ? await mod.default({}) : mod.default;
  return config?.test?.testTimeout;
}

async function loadSetupFiles(relativePath) {
  const mod = await import(resolve(repoRoot, relativePath));
  const config = typeof mod.default === "function" ? await mod.default({}) : mod.default;
  return config?.test?.setupFiles;
}

describe("vitest config timeout parity (GEN-TEST-FLAKE-001)", () => {
  for (const { name, path } of CONFIGS) {
    it(`${name} (${path}) declares the hardened 15s testTimeout`, async () => {
      const timeout = await loadTestTimeout(path);
      expect(timeout, `${path} must set test.testTimeout=${String(EXPECTED_TIMEOUT_MS)}`).toBe(
        EXPECTED_TIMEOUT_MS,
      );
    });
  }

  it("keeps every CI-gated config on the SAME timeout (no per-config drift)", async () => {
    const timeouts = await Promise.all(CONFIGS.map(({ path }) => loadTestTimeout(path)));
    expect(new Set(timeouts)).toEqual(new Set([EXPECTED_TIMEOUT_MS]));
  });
});

describe("Vitest process environment parity", () => {
  for (const path of ["vitest.config.ts", "vitest.coverage.packages.config.ts"]) {
    it(`${path} canonicalizes PATH inside Windows worker threads`, async () => {
      await expect(loadSetupFiles(path)).resolves.toContain("./tests/setup/process-environment.ts");
    });
  }
});
