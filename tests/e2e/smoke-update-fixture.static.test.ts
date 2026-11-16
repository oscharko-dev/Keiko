import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// The smoke lanes run every spec with an @smoke title against a server that, left alone, asks the
// live npm registry for Keiko's latest release. On a branch behind that release the startup
// "Update available" notice then covers workspace controls, so the smoke result changed with the
// day the lane ran: on 2026-11-16 the 1.5.0 release broke three footer layering tests on the 1.4.0
// epic branch. `support/smoke-test.ts` answers that check with a fixed report. These tests keep
// every @smoke spec on that fixture, so a new spec cannot reach the live registry again.

const E2E_ROOT = resolve(import.meta.dirname);
const FIXTURE_IMPORT = /^import \{ test \} from "\.\/support\/smoke-test\.js";$/m;
const PLAYWRIGHT_IMPORT = /^import (type )?\{([^}]*)\} from "@playwright\/test";$/gm;

function specFiles(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : specFiles(path);
    }
    return entry.name.endsWith(".spec.ts") ? [path] : [];
  });
}

function importsPlaywrightTest(source: string): boolean {
  for (const match of source.matchAll(PLAYWRIGHT_IMPORT)) {
    if (match[1] !== undefined) {
      continue;
    }
    const names = (match[2] ?? "").split(",").map((specifier) => specifier.trim());
    if (names.some((name) => name === "test" || name.startsWith("test as "))) {
      return true;
    }
  }
  return false;
}

interface SmokeSpec {
  readonly name: string;
  readonly source: string;
}

// A spec joins the smoke lanes through an @smoke test title, not through a comment that mentions
// the tag. editor-performance.spec.ts names @smoke only in a comment that says it is not a smoke
// spec, and it must keep Playwright's HTTP cache, which the fixture's context route disables.
function isSmokeSpec(source: string): boolean {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").includes("@smoke");
}

function smokeSpecs(): readonly SmokeSpec[] {
  return specFiles(E2E_ROOT)
    .map((path) => ({ name: relative(E2E_ROOT, path), source: readFileSync(path, "utf8") }))
    .filter((spec) => isSmokeSpec(spec.source));
}

describe("smoke specs use the offline update fixture", () => {
  it("finds the smoke specs it guards", () => {
    expect(smokeSpecs().length).toBeGreaterThan(20);
  });

  it("imports test from support/smoke-test.js in every @smoke spec", () => {
    const missing = smokeSpecs()
      .filter((spec) => !FIXTURE_IMPORT.test(spec.source))
      .map((spec) => spec.name);
    expect(missing).toEqual([]);
  });

  it("imports no test value from @playwright/test in any @smoke spec", () => {
    const direct = smokeSpecs()
      .filter((spec) => importsPlaywrightTest(spec.source))
      .map((spec) => spec.name);
    expect(direct).toEqual([]);
  });

  it("selects specs by an @smoke title, not by a comment", () => {
    expect(isSmokeSpec('test("opens the window @smoke", async () => {});\n')).toBe(true);
    expect(isSmokeSpec("// This spec is not part of the @smoke set.\n")).toBe(false);
    expect(isSmokeSpec("/**\n * Not part of the required `@smoke` set.\n */\n")).toBe(false);
  });

  it("recognizes a direct Playwright test import", () => {
    expect(importsPlaywrightTest('import { expect, test } from "@playwright/test";\n')).toBe(true);
    expect(importsPlaywrightTest('import { test as base } from "@playwright/test";\n')).toBe(true);
    expect(importsPlaywrightTest('import { expect, type Page } from "@playwright/test";\n')).toBe(
      false,
    );
    expect(importsPlaywrightTest('import type { Page } from "@playwright/test";\n')).toBe(false);
  });
});
