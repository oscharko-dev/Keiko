import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DRIFT_REPAIRS,
  changedPaths,
  contentDigest,
  newlyChanged,
  runRepairs,
} from "../fix-gate-drift.mjs";

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
  it("reads modified, added, untracked, renamed and copied paths, skipping each origin", () => {
    expect(
      changedPaths(
        [
          " M docs/a.json",
          "A  b.ts",
          "?? new/c.json",
          "R  moved.md",
          "old.md",
          "C  copy.ts",
          "b.ts",
          "",
        ].join("\0"),
      ),
    ).toStrictEqual(["b.ts", "copy.ts", "docs/a.json", "moved.md", "new/c.json"]);
  });

  // CodeRabbit on #4513: line-based porcelain quotes such names, and the quoted path then read as
  // deleted, so a repair's edit to it went unreported.
  it("reads the names git would quote exactly as they are on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-drift-git-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: root });
      for (const name of ["café.json", "tab\tname.json", 'quote".json']) {
        writeFileSync(join(root, name), "{}\n");
      }
      const status = spawnSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
        cwd: root,
        encoding: "utf8",
      });
      const paths = changedPaths(status.stdout);
      expect(paths).toStrictEqual(["café.json", 'quote".json', "tab\tname.json"]);
      for (const path of paths) expect(contentDigest(root, path)).not.toBe("deleted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("digests a symbolic link to a directory by its target instead of failing to read it", () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-drift-link-"));
    try {
      mkdirSync(join(root, "target"));
      symlinkSync("target", join(root, "link"), "dir");
      writeFileSync(join(root, "file.json"), "{}\n");
      expect(contentDigest(root, "link")).toMatch(/^link:[0-9a-f]{64}$/u);
      expect(contentDigest(root, "target")).toBe("directory");
      expect(contentDigest(root, "file.json")).toMatch(/^[0-9a-f]{64}$/u);
      expect(contentDigest(root, "absent.json")).toBe("deleted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
