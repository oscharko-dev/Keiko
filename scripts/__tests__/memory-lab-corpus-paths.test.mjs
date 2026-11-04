import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../testing/coding-workbench-lab/lab-common.mjs";
import { assertOutsideCheckout } from "../testing/memory-lab/corpus/paths.mjs";
import { percentLimit } from "../testing/memory-lab/rhythm.mjs";

describe("memory lab corpus path guard", () => {
  const dotted = join(REPO_ROOT, "..cache-memory-lab-test");
  let outside;
  afterEach(() => {
    rmSync(dotted, { recursive: true, force: true });
    if (outside) rmSync(outside, { recursive: true, force: true });
    outside = undefined;
  });

  it("refuses a child of the checkout whose name starts with two dots", () => {
    mkdirSync(dotted, { recursive: true });
    expect(() => assertOutsideCheckout(join(dotted, "holdout.json"), "--out")).toThrow(
      /outside the checkout/u,
    );
    expect(() => assertOutsideCheckout(join(REPO_ROOT, "lab-out"), "--out")).toThrow(
      /outside the checkout/u,
    );
  });

  it("is the one guard the anchor tooling uses, so the main checkout is refused as well", () => {
    // The failure this pins: the corpus tools had a guard of their own that knew this worktree
    // only, so the main checkout of the repository was accepted for `seal --out` and `--key-file`.
    expect(() =>
      assertOutsideCheckout(join(REPO_ROOT, "..", "memory-lab-sibling"), "--out"),
    ).toThrow(/outside (the checkout|every git work tree)/u);
  });

  it("accepts a directory outside every work tree and returns it resolved", () => {
    outside = mkdtempSync(join(tmpdir(), "memory-lab-paths-"));
    // Resolved through links: on macOS the temporary directory itself is reached through one.
    expect(assertOutsideCheckout(join(outside, "holdout"), "--out")).toBe(
      resolve(join(realpathSync(outside), "holdout")),
    );
  });
});

describe("memory lab headroom limits", () => {
  it("accepts percentages and refuses everything else", () => {
    expect(percentLimit("70", "--max-cpu")).toBe(70);
    expect(percentLimit("0", "--max-cpu")).toBe(0);
    for (const bad of ["seventy", "", " ", "-1", "101", "NaN"])
      expect(() => percentLimit(bad, "--max-cpu")).toThrow(/percentage/u);
  });
});
