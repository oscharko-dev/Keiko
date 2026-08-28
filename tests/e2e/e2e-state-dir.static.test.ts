import { realpathSync } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { e2eStateDir } from "./support/e2e-state-dir.js";

// A Playwright config that builds its state directory from the raw `os.tmpdir()` cannot boot the UI
// server on macOS at all — the store refuses a database path inside a symlinked directory, and
// `/var` is a symlink to `/private/var`. On the Linux runners the same expression works, so twelve
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

describe("E2E state directory (#2955 follow-up)", () => {
  const originalOverride = process.env.KEIKO_E2E_STATE_DIR;

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.KEIKO_E2E_STATE_DIR;
    else process.env.KEIKO_E2E_STATE_DIR = originalOverride;
  });

  it("resolves the temp root through its symlinks", () => {
    delete process.env.KEIKO_E2E_STATE_DIR;
    const dir = e2eStateDir("unit-fixture");
    expect(dir).toBe(join(realpathSync(tmpdir()), "keiko-e2e", "unit-fixture"));
    // The whole point: the resolved parent must not itself resolve to something else.
    expect(realpathSync(join(realpathSync(tmpdir())))).toBe(realpathSync(tmpdir()));
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
    // A config either calls the shared helper, or a named per-suite helper that does — anything
    // else is a config constructing the path itself, which is the drift this consolidation ended.
    const viaHelper = /const stateDir = (e2eStateDir|[A-Za-z]+StateDir)\(/u;
    const offenders = configFiles()
      .filter(({ source }) => /const stateDir\s*=/u.test(source))
      .filter(({ source }) => !viaHelper.test(source))
      .map(({ name }) => name);
    // playwright.local-knowledge-regression.config.ts owns a different contract (its state lives
    // beside the corpus, under KEIKO_LK_E2E_STATE_DIR), so it is the one deliberate exception.
    expect(offenders).toEqual(["playwright.local-knowledge-regression.config.ts"]);
  });

  // …and the named helpers the clause above accepts must themselves delegate, or that clause would
  // be a hole rather than a check. Discovered by shape, so a fifth code-task helper is covered the
  // day it is written.
  it("routes every per-suite state-dir helper through the shared one", () => {
    const supportDir = join(E2E_ROOT, "support");
    const offenders = readdirSync(supportDir)
      .filter((name) => name.endsWith(".ts") && name !== "e2e-state-dir.ts")
      .flatMap((name) => {
        const source = readFileSync(join(supportDir, name), "utf8");
        return [
          ...source.matchAll(/export function ([A-Za-z]+StateDir)\(\)[^{]*\{([\s\S]*?)\n\}/gu),
        ]
          .map((match) => ({ helper: match[1] ?? "", body: match[2] ?? "" }))
          .filter(({ body }) => !body.includes("return e2eStateDir("))
          .map(({ helper }) => `${name}: ${helper}`);
      });
    expect(offenders).toEqual([]);
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
