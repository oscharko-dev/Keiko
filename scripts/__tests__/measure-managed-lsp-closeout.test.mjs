import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  budgetDisposition,
  directoryBytes,
  MANAGED_LSP_CLOSEOUT_LIMITS,
  percentile,
  runManagedLspCloseoutMeasurement,
  shouldFailBudget,
  summarizeSamples,
} from "../measure-managed-lsp-closeout.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed-LSP closeout measurement", () => {
  it("summarizes bounded p50, p95, and maximum samples", () => {
    expect(percentile([], 0.95)).toBe(0);
    expect(summarizeSamples([5, 1, 3, 2, 4])).toEqual({
      count: 5,
      p50Ms: 3,
      p95Ms: 5,
      maxMs: 5,
    });
  });

  it("measures actual nested disk bytes and treats missing roots as empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "keiko-managed-lsp-disk-test-"));
    roots.push(root);
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "first"), "12345", "utf8");
    await writeFile(join(root, "nested", "second"), "1234567", "utf8");
    expect(await directoryBytes(root)).toBe(12);
    expect(await directoryBytes(join(root, "missing"))).toBe(0);
    await expect(directoryBytes(join(root, "first"))).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("reports every resource budget independently", () => {
    const under = {
      cold: { p95Ms: 1 },
      warm: { p95Ms: 1 },
      disposal: { p95Ms: 1 },
      rssDeltaBytes: 1,
      diskBytes: 1,
    };
    expect(budgetDisposition(under)).toEqual({
      coldP95: true,
      warmP95: true,
      disposalP95: true,
      rssDelta: true,
      disk: true,
    });
    expect(
      budgetDisposition({
        cold: { p95Ms: MANAGED_LSP_CLOSEOUT_LIMITS.coldP95Ms + 1 },
        warm: { p95Ms: MANAGED_LSP_CLOSEOUT_LIMITS.warmP95Ms + 1 },
        disposal: { p95Ms: MANAGED_LSP_CLOSEOUT_LIMITS.disposalP95Ms + 1 },
        rssDeltaBytes: MANAGED_LSP_CLOSEOUT_LIMITS.rssDeltaBytes + 1,
        diskBytes: MANAGED_LSP_CLOSEOUT_LIMITS.diskBytes + 1,
      }),
    ).toEqual({
      coldP95: false,
      warmP95: false,
      disposalP95: false,
      rssDelta: false,
      disk: false,
    });
  });

  it("enforces disk everywhere and timing only in controlled contexts", () => {
    const passing = { coldP95: true, warmP95: true, disposalP95: true, rssDelta: true, disk: true };
    expect(shouldFailBudget(passing, true)).toBe(false);
    expect(shouldFailBudget({ ...passing, disk: false }, false)).toBe(true);
    expect(shouldFailBudget({ ...passing, coldP95: false }, false)).toBe(false);
    expect(shouldFailBudget({ ...passing, coldP95: false }, true)).toBe(true);
  });

  it("measures all five provider/workspace profiles with real disposal", async () => {
    const result = await runManagedLspCloseoutMeasurement({
      coldSamples: 2,
      warmSamples: 3,
      controlled: false,
    });
    expect(result.measurementMode).toBe("informational-local");
    expect(result.samplesPerProvider).toEqual({ cold: 2, warm: 3, disposal: 2 });
    expect(result.profiles.map((profile) => profile.providerId)).toEqual([
      "python-lsp",
      "go-lsp",
      "shell-lsp",
      "java-lsp",
      "rust-lsp",
    ]);
    expect(result.profiles.every((profile) => profile.disposal.count === 2)).toBe(true);
    expect(result.profiles.every((profile) => profile.diskBytes === 0)).toBe(true);
    expect(result.aggregate.providerCount).toBe(5);
    expect(result.passed).toBe(true);
  });
});
