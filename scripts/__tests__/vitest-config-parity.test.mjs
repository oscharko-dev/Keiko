import { readFileSync } from "node:fs";
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

const JUDGING_COVERAGE_CONFIG = "vitest.coverage.packages.config.ts";

const CONFIGS = [
  { name: "root suite", path: "vitest.config.ts" },
  { name: "package coverage gate", path: JUDGING_COVERAGE_CONFIG },
  { name: "script coverage gate", path: "vitest.coverage.scripts.config.ts" },
  { name: "keiko-ui coverage gate", path: "packages/keiko-ui/vitest.coverage.config.ts" },
  { name: "keiko-ui suite", path: "packages/keiko-ui/vitest.config.ts" },
  { name: "keiko-local-knowledge suite", path: "packages/keiko-local-knowledge/vitest.config.ts" },
];

function readPackageScripts() {
  return JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).scripts;
}

async function loadConfig(relativePath) {
  const mod = await import(resolve(repoRoot, relativePath));
  return typeof mod.default === "function" ? await mod.default({}) : mod.default;
}

async function loadTestTimeout(relativePath) {
  return (await loadConfig(relativePath))?.test?.testTimeout;
}

async function loadMaxWorkers(relativePath) {
  return (await loadConfig(relativePath))?.test?.maxWorkers;
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

  it("keeps package coverage worker concurrency aligned with the root suite", async () => {
    const [rootWorkers, coverageWorkers] = await Promise.all([
      loadMaxWorkers("vitest.config.ts"),
      loadMaxWorkers(JUDGING_COVERAGE_CONFIG),
    ]);
    expect(coverageWorkers).toBe(rootWorkers);
    expect(coverageWorkers).toBe(2);
  });

  // GEN-TEST-FLAKE-002 is a per-process guarantee, and a shard is a process. Sharding across
  // runners must not become a way to raise worker concurrency past the deliberate cap. Issue #2705
  // retired the separate shard configuration, so a shard inherits the pinned cap above by using the
  // one package coverage configuration — which is what this now asserts.
  it("keeps every package coverage shard at the same bounded worker count", () => {
    const scripts = readPackageScripts();
    expect(scripts["test:coverage:packages"]).toMatch(/^npm run build && /u);
    expect(scripts["test:coverage:packages:shard"]).toMatch(/^npm run build && /u);
    expect(scripts["test:coverage:packages:shard"]).toContain(
      `--config ${JUDGING_COVERAGE_CONFIG}`,
    );
    expect(scripts["test:coverage:packages:merge"]).toContain(
      `--config ${JUDGING_COVERAGE_CONFIG}`,
    );
  });
});

// Issue #2704 introduced `vitest.coverage.packages.shard.config.ts` because vitest evaluates
// `coverage.thresholds` at the end of EVERY run: a shard measuring a third of the test files would
// judge its partial view against floors describing the whole suite. Issue #2705 moved those ten
// per-file floors into the single floor store (`docs/qa/package-coverage-baseline.json`), so no
// vitest configuration judges anything any more and the derived shard configuration was retired.
//
// ADR-0157 D1's property is therefore no longer maintained by a second configuration file — it is
// structural, and this is the pin that keeps it structural. A `coverage.thresholds` block
// reappearing in any configuration re-creates both the sharding hazard and the two-engine split.
describe("no vitest configuration reaches a coverage verdict (ADR-0157 D1, ADR-0158 D1)", () => {
  for (const { name, path } of CONFIGS) {
    it(`${name} (${path}) declares no coverage thresholds`, async () => {
      const config = await loadConfig(path);
      expect(
        config?.test?.coverage?.thresholds,
        `${path} must not judge: per-file floors live in docs/qa/package-coverage-baseline.json`,
      ).toBeUndefined();
    });
  }
});
