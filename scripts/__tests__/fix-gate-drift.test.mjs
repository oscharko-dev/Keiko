import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DRIFT_REPAIRS, changedPaths, newlyChanged, runRepairs } from "../fix-gate-drift.mjs";

// Quality-gate hardening plan 2026-11-21, P4: one command repairs every drift gate whose expected
// state is derived from the tree. It must never write a baseline, which could bless a regression.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("drift repairs", () => {
  it("runs only repository scripts that exist, after the build the generators read", () => {
    expect(DRIFT_REPAIRS.slice(0, 2).map((repair) => repair.script)).toStrictEqual([
      "scripts/check-typescript-toolchain.mjs",
      "scripts/build-packages.mjs",
    ]);
    for (const { script } of DRIFT_REPAIRS) {
      expect(existsSync(join(repoRoot, script))).toBe(true);
    }
  });

  it("runs what `npm run build:packages` runs, in the same order", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts["build:packages"]).toBe(
      "npm run check:typescript-toolchain && node scripts/build-packages.mjs",
    );
    expect(pkg.scripts["check:typescript-toolchain"]).toBe(
      "node scripts/check-typescript-toolchain.mjs",
    );
  });

  it("never writes a baseline", () => {
    for (const { script, args } of DRIFT_REPAIRS) {
      expect([script, ...args].join(" ")).not.toMatch(/baseline/iu);
    }
  });
});

describe("changed-path accounting", () => {
  it("reads modified, added, untracked and renamed paths", () => {
    expect(
      changedPaths(
        [" M docs/a.json", "A  b.ts", "?? new/c.json", "R  old.md -> moved.md", ""].join("\n"),
      ),
    ).toStrictEqual(["b.ts", "docs/a.json", "moved.md", "new/c.json"]);
  });

  it("attributes to a repair only what it changed, a restored file included", () => {
    const before = new Map([
      ["kept.json", "1"],
      ["restored.json", "2"],
      ["edited.json", "3"],
    ]);
    const after = new Map([
      ["kept.json", "1"],
      ["edited.json", "4"],
      ["new.json", "5"],
    ]);
    expect(newlyChanged(before, after)).toStrictEqual(["edited.json", "new.json", "restored.json"]);
    expect(newlyChanged(before, before)).toStrictEqual([]);
  });
});

describe("runRepairs", () => {
  it("runs every repair, names each failure and reports each repair's changes", () => {
    const x = new Map([["x.json", "1"]]);
    const xy = new Map([
      ["x.json", "1"],
      ["y.json", "2"],
    ]);
    const states = [new Map(), x, x, x, x, xy];
    const lines = [];
    const ran = [];
    const failed = runRepairs({
      repairs: [
        { label: "first", script: "one", args: [] },
        { label: "second", script: "two", args: [] },
        { label: "third", script: "three", args: [] },
      ],
      run: ({ script }) => {
        ran.push(script);
        return script === "two" ? 1 : 0;
      },
      status: () => states.shift() ?? new Map(),
      log: (line) => lines.push(line),
    });

    expect(ran).toStrictEqual(["one", "two", "three"]);
    expect(failed).toStrictEqual(["second"]);
    expect(lines).toStrictEqual([
      "fix-gate-drift: first",
      "fix-gate-drift:   changed x.json",
      "fix-gate-drift: second",
      "fix-gate-drift: third",
      "fix-gate-drift:   changed y.json",
    ]);
  });
});
