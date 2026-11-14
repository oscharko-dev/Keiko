import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CI_MAX_WORKERS, LOCAL_MAX_WORKERS, vitestMaxWorkers } from "../lib/vitest-workers.mjs";

// The worker count every capped vitest config shares (GEN-TEST-FLAKE-001/002). CI keeps the value it
// always had, a development machine gets more, and one variable chooses. The configs must take the
// number from the helper and never restate it, so the CI value cannot drift in one of them.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CAPPED_CONFIGS = [
  "vitest.config.ts",
  "vitest.coverage.packages.config.ts",
  "vitest.coverage.scripts.config.ts",
  "packages/keiko-cli/vitest.config.ts",
  "packages/keiko-activity-log/vitest.config.ts",
  "packages/keiko-local-knowledge/vitest.config.ts",
];

describe("vitestMaxWorkers", () => {
  it("keeps CI exactly at two workers, as it was before the helper existed", () => {
    // The pin the checked-in `maxWorkers: 2` literals used to be: CI behaviour does not move.
    expect(CI_MAX_WORKERS).toBe(2);
    expect(vitestMaxWorkers({ CI: "true" })).toBe(2);
    expect(vitestMaxWorkers({ CI: "1" })).toBe(2);
  });

  it("gives a development machine four workers", () => {
    expect(LOCAL_MAX_WORKERS).toBe(4);
    expect(vitestMaxWorkers({})).toBe(4);
    expect(vitestMaxWorkers({ CI: "" })).toBe(4);
  });

  it.each(["1", "2", "8", "16", " 6 "])("honours an explicit override of %j", (value) => {
    expect(vitestMaxWorkers({ KEIKO_VITEST_MAX_WORKERS: value })).toBe(Number(value));
  });

  it.each(["0", "17", "99", "-1", "2.5", "abc", "", "1e1", "0x4"])(
    "ignores the invalid override %j and uses the default",
    (value) => {
      expect(vitestMaxWorkers({ KEIKO_VITEST_MAX_WORKERS: value })).toBe(LOCAL_MAX_WORKERS);
      expect(vitestMaxWorkers({ KEIKO_VITEST_MAX_WORKERS: value, CI: "true" })).toBe(
        CI_MAX_WORKERS,
      );
    },
  );

  it("lets a valid override beat CI, so a full local run can go back to two", () => {
    expect(vitestMaxWorkers({ CI: "true", KEIKO_VITEST_MAX_WORKERS: "8" })).toBe(8);
    expect(vitestMaxWorkers({ KEIKO_VITEST_MAX_WORKERS: "2" })).toBe(2);
  });

  it("reads the process environment by default", () => {
    expect(vitestMaxWorkers()).toBe(vitestMaxWorkers(process.env));
  });
});

describe("every capped vitest config takes its worker count from the helper", () => {
  for (const path of CAPPED_CONFIGS) {
    it(`${path} resolves to the helper's count and restates no literal`, async () => {
      const mod = await import(resolve(repoRoot, path));
      const config = typeof mod.default === "function" ? await mod.default({}) : mod.default;
      expect(config.test.maxWorkers).toBe(vitestMaxWorkers(process.env));
      const source = readFileSync(resolve(repoRoot, path), "utf8");
      expect(source).toMatch(/vitestMaxWorkers\(\)/u);
      expect(source).not.toMatch(/maxWorkers:\s*\d/u);
    });
  }
});
