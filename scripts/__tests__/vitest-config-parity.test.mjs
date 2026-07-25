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
const MEASURING_COVERAGE_CONFIG = "vitest.coverage.packages.shard.config.ts";

// Issue #2704: the package coverage suite runs as parallel shards, each producing a blob report
// that the finalizing job merges before any floor is evaluated. The shard configuration therefore
// exists, and the ONE difference it is allowed to have from the judging configuration is the
// absence of `coverage.thresholds` — the verdict a shard must not reach on a partial view.
const GATE_SCRIPT_FLOOR = { branches: 85, functions: 90, lines: 90, statements: 90 };
const EXPECTED_GATE_SCRIPT_FLOORS = {
  "scripts/keiko-for-quality-core.mjs": GATE_SCRIPT_FLOOR,
  "scripts/keiko-for-quality-worker.mjs": GATE_SCRIPT_FLOOR,
  "scripts/check-lcov-source-mapping.mjs": GATE_SCRIPT_FLOOR,
  "scripts/check-mutation-quality.mjs": GATE_SCRIPT_FLOOR,
  "scripts/check-mutation-scope.mjs": GATE_SCRIPT_FLOOR,
  "scripts/check-sonar-pr-quality-gate.mjs": GATE_SCRIPT_FLOOR,
  "scripts/check-sonar-analysis-log.mjs": GATE_SCRIPT_FLOOR,
  "scripts/check-sonar-main-quality-gate.mjs": GATE_SCRIPT_FLOOR,
  "scripts/sonar-analysis-scope.mjs": GATE_SCRIPT_FLOOR,
  "scripts/sonar-quality-gate-contract.mjs": GATE_SCRIPT_FLOOR,
};

const CONFIGS = [
  { name: "root suite", path: "vitest.config.ts" },
  { name: "package coverage gate", path: JUDGING_COVERAGE_CONFIG },
  { name: "package coverage shard", path: MEASURING_COVERAGE_CONFIG },
  { name: "script coverage gate", path: "vitest.coverage.scripts.config.ts" },
  { name: "keiko-ui coverage gate", path: "packages/keiko-ui/vitest.coverage.config.ts" },
  { name: "keiko-ui suite", path: "packages/keiko-ui/vitest.config.ts" },
];

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
  // runners must not become a way to raise worker concurrency past the deliberate cap.
  it("keeps every package coverage shard at the same bounded worker count", async () => {
    expect(await loadMaxWorkers(MEASURING_COVERAGE_CONFIG)).toBe(2);
  });
});

describe("package coverage shard configuration (Issue #2704)", () => {
  // Scope, stated honestly: while the shard configuration derives itself by spreading the judging
  // one, most of these comparisons hold by construction. They exist for the day someone replaces
  // that derivation with a hand-written copy — which is exactly when drift becomes possible, and
  // exactly when this fails. The unconditionally load-bearing assertion is the floor pin below.
  it("differs from the judging configuration in nothing but the coverage thresholds", async () => {
    const [judging, measuring] = await Promise.all([
      loadConfig(JUDGING_COVERAGE_CONFIG),
      loadConfig(MEASURING_COVERAGE_CONFIG),
    ]);

    expect(Object.keys(measuring).sort()).toEqual(Object.keys(judging).sort());
    for (const key of Object.keys(judging).filter((entry) => entry !== "test")) {
      expect(measuring[key], `top-level key "${key}" drifted`).toEqual(judging[key]);
    }

    expect(Object.keys(measuring.test).sort()).toEqual(Object.keys(judging.test).sort());
    for (const key of Object.keys(judging.test).filter((entry) => entry !== "coverage")) {
      expect(measuring.test[key], `test.${key} drifted`).toEqual(judging.test[key]);
    }

    const judgingCoverage = judging.test.coverage;
    const measuringCoverage = measuring.test.coverage;
    expect(Object.keys(measuringCoverage).sort()).toEqual(
      Object.keys(judgingCoverage)
        .filter((key) => key !== "thresholds")
        .sort(),
    );
    for (const key of Object.keys(measuringCoverage)) {
      expect(measuringCoverage[key], `test.coverage.${key} drifted`).toEqual(judgingCoverage[key]);
    }
  });

  it("never lets a shard reach a coverage verdict on its partial view", async () => {
    const measuring = await loadConfig(MEASURING_COVERAGE_CONFIG);
    expect(measuring.test.coverage.thresholds).toBeUndefined();
  });

  // The floors themselves are the thing sharding must not touch. Pinning their numeric values here
  // means a future topology change cannot quietly drop or lower one while the diff still looks like
  // plumbing (Issue #2704 acceptance criterion "no threshold drops").
  it("keeps the judged per-file floors at their governed values", async () => {
    const judging = await loadConfig(JUDGING_COVERAGE_CONFIG);
    const { perFile, ...gateScriptFloors } = judging.test.coverage.thresholds;
    expect(perFile).toBe(true);
    expect(gateScriptFloors).toEqual(EXPECTED_GATE_SCRIPT_FLOORS);
  });
});
