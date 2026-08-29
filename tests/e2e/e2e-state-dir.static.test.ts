import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { e2eStateDir } from "./support/e2e-state-dir.js";

// A Playwright config that builds its state directory from the raw `os.tmpdir()` cannot boot the UI
// server on macOS at all — the store refuses a database path inside a symlinked directory, and
// `/var` is a symlink to `/private/var`. On the Linux runners the same expression works, so sixteen
// suites were unrunnable on every developer machine while CI reported them healthy. Two of them
// (#1575, #1577) turned out to be fully red the moment they could be booted locally.
//
// The expression now lives once, in `support/e2e-state-dir.ts`. These tests are what keeps it there:
// a thirty-first copy, or a config that reaches for `tmpdir()` without resolving it, fails here
// rather than three months later on somebody's laptop.

const E2E_ROOT = resolve(import.meta.dirname);
const CONFIG_DIR = join(E2E_ROOT, "config");

function configFiles(): readonly { readonly name: string; readonly source: string }[] {
  const dirs = [E2E_ROOT, CONFIG_DIR];
  return dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith(".config.ts"))
      .map((name) => ({ name, source: readFileSync(join(dir, name), "utf8") })),
  );
}

/**
 * Configs that keep their own state-directory expression, each for a stated reason.
 *
 * This is a consolidation exemption, NOT a defect exemption: the clause below that forbids an
 * unresolved `os.tmpdir()` applies to every config including these, so the failure this branch
 * exists to remove stays closed for them too. They simply do not route through the shared helper.
 */
const CONSOLIDATION_EXCEPTIONS = [
  // A different contract entirely: its state lives beside the corpus, under KEIKO_LK_E2E_STATE_DIR.
  "playwright.local-knowledge-regression.config.ts",
  // ADR-0139 D10: both are hashed into the D12 measurement toolchain digest
  // (`scripts/d12-measurement-toolchain.mjs`), so ANY edit — including one that changes no measured
  // behaviour, as routing through this helper would not — invalidates the committed performance
  // evidence and demands a re-measurement on the pinned reference container. Both already resolve
  // the temp root correctly, so the refactor would buy tidiness at the price of re-measuring the
  // ruler. Not worth it; the clause below still holds them to the invariant that matters.
  "playwright.editor-performance.config.ts",
  "playwright.issue-2348-editor-debugging.config.ts",
  // Same trade for the workspace ruler: this file is a member of
  // `WORKSPACE_PERFORMANCE_MEASUREMENT_TOOLCHAIN_PATHS`, whose digest is bound into the committed
  // workspace performance evidence. Routing it through the helper changes no measured behaviour —
  // it already resolves the temp root exactly as the helper does — but it does move the digest,
  // which fails `perf-evidence` with "stale workspace measurement toolchain evidence" and can only
  // be answered by re-measuring on the reference environment.
  "playwright.workspace-performance.config.ts",
] as const;

/**
 * The `*StateDir` helpers exported from `tests/e2e/support` that delegate to `e2eStateDir`, and the
 * ones that do not.
 *
 * One traversal answers both guards below: which helper names a config may legitimately call, and
 * whether every exported helper still delegates. Deriving the accepted set from the declarations
 * means a config cannot mint a new one locally.
 */
function delegatingSupportHelpers(): {
  readonly delegating: ReadonlySet<string>;
  readonly offenders: readonly string[];
} {
  const supportDir = join(E2E_ROOT, "support");
  const delegating = new Set<string>(["e2eStateDir"]);
  const offenders: string[] = [];
  for (const name of readdirSync(supportDir).filter(
    (entry) => entry.endsWith(".ts") && entry !== "e2e-state-dir.ts",
  )) {
    const source = readFileSync(join(supportDir, name), "utf8");
    for (const match of source.matchAll(
      /export function ([A-Za-z]+StateDir)\(\)[^{]*\{([\s\S]*?)\n\}/gu,
    )) {
      const helper = match[1] ?? "";
      if ((match[2] ?? "").includes("return e2eStateDir(")) delegating.add(helper);
      else offenders.push(`${name}: ${helper}`);
    }
  }
  return { delegating, offenders };
}

/** Whether the config's `const stateDir = …` calls a helper proven to delegate. */
function usesADelegatingHelper(source: string, delegating: ReadonlySet<string>): boolean {
  const call = /const stateDir = ([A-Za-z][A-Za-z0-9]*)\(/u.exec(source);
  return call !== null && delegating.has(call[1] ?? "");
}

describe("E2E state directory (#2955 follow-up)", () => {
  const originalOverride = process.env.KEIKO_E2E_STATE_DIR;

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.KEIKO_E2E_STATE_DIR;
    else process.env.KEIKO_E2E_STATE_DIR = originalOverride;
  });

  // Deliberately NOT `expect(dir).toBe(join(realpathSync(tmpdir()), …))`. That restates the
  // production formula, and on Linux — the only platform this suite runs on in CI —
  // `tmpdir() === realpathSync(tmpdir())`, so deleting the `realpathSync` call from the subject
  // would leave it green on every required check. The proof therefore needs a temp root that IS a
  // symlink on every platform, built here rather than borrowed from the OS.
  it("resolves a symlinked temp root, on every platform", () => {
    delete process.env.KEIKO_E2E_STATE_DIR;
    const real = mkdtempSync(join(realpathSync(tmpdir()), "keiko-state-dir-real-"));
    const link = `${real}-link`;
    symlinkSync(real, link, "dir");
    try {
      // The link and its target are genuinely different paths on every platform, which is what
      // makes this proof portable where a comparison against the OS temp root is not.
      expect(realpathSync(link)).toBe(real);
      expect(link).not.toBe(real);
      // Handed the LINK, the subject must return a path under its TARGET. Delete the
      // `realpathSync` from the subject and this is the assertion that goes red — on Linux too.
      expect(e2eStateDir("unit-fixture", link)).toBe(join(real, "keiko-e2e", "unit-fixture"));
      expect(e2eStateDir("unit-fixture", link).startsWith(link)).toBe(false);
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { force: true, recursive: true });
    }
  });

  it("honours a non-empty override and ignores an empty one", () => {
    process.env.KEIKO_E2E_STATE_DIR = "/tmp/keiko-explicit";
    expect(e2eStateDir("unit-fixture")).toBe("/tmp/keiko-explicit");
    // The `??` form the configs used before resolved an empty override to a RELATIVE path inside
    // the checkout, which is where the suite's SQLite store would then have been written.
    process.env.KEIKO_E2E_STATE_DIR = "";
    expect(e2eStateDir("unit-fixture")).toBe(
      join(realpathSync(tmpdir()), "keiko-e2e", "unit-fixture"),
    );
  });

  it("leaves no Playwright config building its own state directory", () => {
    // A config either calls the shared helper, or a named per-suite helper RESOLVED to its
    // declaration and proven to delegate — anything else is a config constructing the path itself,
    // which is the drift this consolidation ended. Matching the NAME alone was a hole: a config
    // declaring its own local `fooStateDir` around `join(tmpdir(), …)` satisfied the shape while
    // reintroducing exactly the macOS symlink failure this migration removed.
    const delegating = delegatingSupportHelpers().delegating;
    const offenders = configFiles()
      .filter(({ source }) => /const stateDir\s*=/u.test(source))
      .filter(({ source }) => !usesADelegatingHelper(source, delegating))
      .map(({ name }) => name)
      .sort((left, right) => left.localeCompare(right));
    expect(offenders).toEqual([...CONSOLIDATION_EXCEPTIONS].sort((l, r) => l.localeCompare(r)));
  });

  // …and the named helpers the clause above resolves against must themselves delegate, or that
  // clause would accept a support helper that had stopped delegating. Discovered by shape, so a
  // fifth code-task helper is covered the day it is written.
  it("routes every per-suite state-dir helper through the shared one", () => {
    expect(delegatingSupportHelpers().offenders).toEqual([]);
  });

  // Scoped to the configs on purpose. A spec's `mkdtempSync(join(tmpdir(), …))` fixture root is a
  // different thing: it is a scratch directory, not the store path the UI refuses to open under a
  // symlink. The defect class this guards is a CONFIG reaching for the temp root itself.
  it("leaves no Playwright config reaching for an unresolved os.tmpdir()", () => {
    const offenders = configFiles().flatMap(({ name, source }) =>
      [...source.matchAll(/(\w+\()?\s*tmpdir\(\)/gu)]
        .filter((match) => match[1] !== "realpathSync(")
        .map(() => name),
    );
    expect(offenders).toEqual([]);
  });
});
