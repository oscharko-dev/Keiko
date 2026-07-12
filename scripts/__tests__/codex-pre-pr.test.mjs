import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commandText, createPrePrSteps, runPrePrGate } from "../codex-pre-pr.mjs";

const REQUIRED_LINUX_COMMANDS = [
  "npm run typecheck",
  "npm run lint",
  "npm run format:check",
  "npm run typecheck --workspace @oscharko-dev/keiko-ui",
  "npm run lint --workspace @oscharko-dev/keiko-ui",
  "npm test",
  "npm run test:coverage:quality",
  "npm run check:lcov-source-mapping",
  "npm run arch:check",
  "npm run arch:check:negative",
  "npm run check:adr-index",
  "npm run check:dependency-hygiene",
  "npm run clean",
  "npm run build",
  "npm run prepare:bin",
  "npm run build:ui",
  "npm run check:editor-release-evidence",
  "npm run prune:package-build-artifacts",
  "npm run check:package-surface",
  "npm run check:editor-bundle-size -- --require-static-export",
  "npm run test:e2e:smoke",
];

describe("codex pre-PR gate", () => {
  it("pins the local-first command order used before push, PR updates, and merge", () => {
    const commands = createPrePrSteps({ env: {}, platform: "linux" }).map((step) =>
      commandText(step),
    );

    expect(commands).toEqual(REQUIRED_LINUX_COMMANDS);
  });

  it("keeps Linux-authoritative editor release evidence explicit on non-Linux hosts", () => {
    const evidence = createPrePrSteps({ env: {}, platform: "darwin" }).find(
      (step) => step.id === "editor-release-evidence",
    );

    expect(evidence?.required).toBe(false);
    expect(evidence?.skipReason).toContain("Linux-authoritative");
  });

  it("supports a dry run that writes the planned local gate report without running commands", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "keiko-codex-pre-pr-"));
    const reportPath = join(tempDir, "report.json");

    try {
      const report = await runPrePrGate({
        dryRun: true,
        env: {},
        platform: "darwin",
        reportPath,
      });
      const persisted = JSON.parse(await readFile(reportPath, "utf8"));

      expect(report.summary.failed).toBe(0);
      expect(report.summary.planned).toBeGreaterThan(0);
      expect(report.summary.skipped).toBe(1);
      expect(persisted.results.map((result) => result.id)).toEqual(
        createPrePrSteps({ env: {}, platform: "darwin" }).map((step) => step.id),
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
