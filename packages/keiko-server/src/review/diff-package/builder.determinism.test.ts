// Determinism and repository-configuration independence of the review diff package (Issue #4134,
// AC1). The package is computed from objects, so a checkout's working tree, its attributes and
// its diff presentation settings cannot change it, and nothing the repository configures runs.

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitEnv } from "@oscharko-dev/keiko-git";
import { DiffFixtureRepository } from "./diffFixtures.test-support.js";
import { numbered, packaged } from "./diffPackageAssertions.test-support.js";

let fixture: DiffFixtureRepository;

beforeEach(() => {
  fixture = new DiffFixtureRepository();
});

afterEach(() => {
  fixture.cleanup();
});

function changeSet(): { readonly base: string; readonly head: string } {
  const source = (value: string): string =>
    `export function run(): number {\n${numbered(12, "  // step")}\n  return ${value};\n}\n${numbered(30, "// tail")}`;
  const base = fixture.commit([
    { path: "src/run.ts", content: source("1") },
    { path: "src/résumé.ts", content: "a\n\nb\n" },
    { path: "src/old.ts", content: numbered(30, "moved") },
    { path: "notes.txt", content: "one\n\n\ntwo\n" },
  ]);
  const head = fixture.commit([
    { path: "src/run.ts", content: source("2").replace("// tail 20", "// tail twenty") },
    { path: "src/résumé.ts", content: "a\n\nB\n" },
    { path: "src/new.ts", content: numbered(30, "moved").replace("moved 3\n", "moved three\n") },
    { path: "notes.txt", content: "one\n\n\nTWO\n" },
    { path: "add.ts", content: "export const added = true;\n" },
  ]);
  return { base, head };
}

describe("deterministic package (AC1)", () => {
  it("is byte-identical across runs", async () => {
    const { base, head } = changeSet();
    const first = JSON.stringify(await packaged(fixture, base, head));
    const second = JSON.stringify(await packaged(fixture, base, head));
    expect(second).toBe(first);
  });

  it("ignores the repository's diff presentation configuration and runs none of its commands", async () => {
    const { base, head } = changeSet();
    const clean = JSON.stringify(await packaged(fixture, base, head));
    const marker = join(fixture.root, "executed");
    const command = `sh -c 'touch "${marker}"'`;
    const settings: readonly (readonly [string, string])[] = [
      ["core.quotePath", "false"],
      ["diff.suppressBlankEmpty", "true"],
      ["diff.noprefix", "true"],
      ["diff.mnemonicPrefix", "true"],
      ["diff.algorithm", "patience"],
      ["diff.context", "0"],
      ["diff.interHunkContext", "40"],
      ["diff.indentHeuristic", "false"],
      ["diff.renames", "false"],
      ["diff.renameLimit", "1"],
      ["color.ui", "always"],
      ["color.diff", "always"],
      ["diff.external", command],
      ["diff.evil.textconv", command],
      ["diff.evil.command", command],
      ["core.pager", command],
      ["core.fsmonitor", command],
    ];
    for (const [key, value] of settings) fixture.git(["config", key, value]);
    // A checked-out tree's attributes (the head's, in a review worktree) must not apply either.
    writeFileSync(join(fixture.repo, ".gitattributes"), "* diff=evil\n*.ts -diff\n*.txt binary\n");
    const hostile = JSON.stringify(await packaged(fixture, base, head));
    expect(hostile).toBe(clean);
    expect(existsSync(marker)).toBe(false);
  });

  it("is the same from a second clone of the same objects", async () => {
    const { base, head } = changeSet();
    const original = JSON.stringify(await packaged(fixture, base, head));
    const clone = join(fixture.root, "clone.git");
    fixture.git(["update-ref", "refs/heads/review-base", base]);
    fixture.git(["update-ref", "refs/heads/review-head", head]);
    execFileSync("git", ["clone", "-q", "--bare", "--no-local", fixture.repo, clone], {
      env: { ...gitEnv(), GIT_ALLOW_PROTOCOL: "file" },
      stdio: "ignore",
    });
    const other = { repo: clone } as DiffFixtureRepository;
    expect(JSON.stringify(await packaged(other, base, head))).toBe(original);
  });
});
