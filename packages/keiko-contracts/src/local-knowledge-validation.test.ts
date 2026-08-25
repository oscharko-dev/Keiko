// Dedup guard for the shared allowlist-key validator (audit KEIKO-0530).
//
// Four copies of the same "reject any object key outside an explicit allowlist" check used to
// exist across packages/keiko-contracts/src/: the canonical `validateOnlyKeys` below, plus three
// private `onlyKeys` copies in local-knowledge-pods.ts, local-knowledge-retrieval-activity.ts, and
// local-knowledge-model-use-policy.ts. Two of the three siblings now import the canonical function
// directly (aliased to `onlyKeys` so their call sites — arity and argument order — read unchanged).
//
// local-knowledge-model-use-policy.ts keeps a private copy instead of importing the canonical one.
// This file already imports `validateKnowledgePodModelUsePolicy` (a value import, not `import
// type`) from local-knowledge-model-use-policy.ts to validate a capsule's nested modelUsePolicy
// field, so an import running the other way — local-knowledge-model-use-policy.ts pulling
// `validateOnlyKeys` from here — would close a two-file circular module dependency. That risk is
// real, not theoretical: dependency-cruiser's config in this repo has no default rule set to catch
// it (`.dependency-cruiser.cjs` defines `forbidden` from scratch, with no `circular: true` rule),
// so nothing else in the gate surface would flag a cycle introduced here.
//
// This suite pins the resulting three-way split mechanically (source greps, so a future edit that
// silently reintroduces a fourth copy or removes the exemption's precondition fails loudly) and
// behaviorally (the retained private copy is exercised through its real production entry point and
// must still agree with the canonical implementation on the exact rejection message).

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateOnlyKeys } from "./local-knowledge-validation.js";
import {
  standardPodModelUsePolicy,
  validateKnowledgePodModelUsePolicy,
} from "./local-knowledge-model-use-policy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(HERE, ".");

const CANONICAL_FILE = "local-knowledge-validation.ts";
// Deduped onto the canonical export — must define no allowlist-key validator of their own.
const DEDUPED_SIBLINGS = [
  "local-knowledge-pods.ts",
  "local-knowledge-retrieval-activity.ts",
] as const;
// The sole holdout: keeps a private copy because merging it would create a circular import (see
// file header). Any *other* file defining a competing copy is still a regression.
const EXEMPT_SIBLING = "local-knowledge-model-use-policy.ts";

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "dist") continue;
      results.push(...collectTsFiles(join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      results.push(join(dir, entry.name));
    }
  }
  return results;
}

function readSource(fileName: string): string {
  return readFileSync(resolve(HERE, fileName), "utf8");
}

function onlyKeysDefinitionLines(source: string): string[] {
  return source
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("function onlyKeys") || line.startsWith("function validateOnlyKeys"),
    );
}

describe("validateOnlyKeys is the single canonical allowlist-key validator", () => {
  it("local-knowledge-validation.ts exports exactly one canonical definition", () => {
    const source = readSource(CANONICAL_FILE);
    const exportedLines = source
      .split("\n")
      .filter((line) => line.startsWith("export function validateOnlyKeys"));
    expect(exportedLines).toHaveLength(1);
    // And nothing in this file also defines an un-exported shadow of it.
    expect(onlyKeysDefinitionLines(source)).toHaveLength(0);
  });

  it.each(DEDUPED_SIBLINGS)(
    "%s no longer defines its own onlyKeys/validateOnlyKeys",
    (fileName) => {
      const source = readSource(fileName);
      expect(onlyKeysDefinitionLines(source)).toEqual([]);
    },
  );

  it.each(DEDUPED_SIBLINGS)("%s imports the canonical validateOnlyKeys as onlyKeys", (fileName) => {
    const source = readSource(fileName);
    expect(source).toMatch(/validateOnlyKeys as onlyKeys/);
    expect(source).toMatch(/}\s*from\s*"\.\/local-knowledge-validation\.js";/s);
  });

  it("no other source file in this package defines a competing onlyKeys/validateOnlyKeys", () => {
    const otherFiles = collectTsFiles(SRC_DIR)
      .map((path) => path.slice(SRC_DIR.length + 1))
      .filter((name) => name !== CANONICAL_FILE && name !== EXEMPT_SIBLING)
      .filter((name) => !(DEDUPED_SIBLINGS as readonly string[]).includes(name));

    for (const fileName of otherFiles) {
      expect(onlyKeysDefinitionLines(readSource(fileName))).toEqual([]);
    }
  });

  it(
    "local-knowledge-model-use-policy.ts stays the sole exception, and only while the " +
      "circular-import precondition holds",
    () => {
      // Still keeps its own copy today...
      expect(onlyKeysDefinitionLines(readSource(EXEMPT_SIBLING))).toHaveLength(1);

      // ...specifically because local-knowledge-validation.ts still imports
      // validateKnowledgePodModelUsePolicy (a value import) from it. If that import is ever
      // removed or turned into a type-only import, the circular-import justification disappears
      // and this file should be deduped onto validateOnlyKeys like its two siblings above.
      const validationSource = readSource(CANONICAL_FILE);
      expect(validationSource).toMatch(
        /import \{ validateKnowledgePodModelUsePolicy \} from "\.\/local-knowledge-model-use-policy\.js";/,
      );
    },
  );

  it("the retained private copy still implements the exact canonical algorithm", () => {
    const canonicalErrors: string[] = [];
    validateOnlyKeys(
      { allowedKey: 1, unexpectedKey: 2 },
      ["allowedKey"],
      "modelUsePolicy",
      canonicalErrors,
    );
    expect(canonicalErrors).toEqual(["modelUsePolicy must not include unexpectedKey"]);

    // Exercised through the real production entry point (AGENTS.md §7: never restate the formula
    // under test), not a re-typed expectation of what the private copy "should" do.
    const result = validateKnowledgePodModelUsePolicy({
      ...standardPodModelUsePolicy(),
      unexpectedKey: 2,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid model-use policy");
    expect(result.errors).toEqual(["modelUsePolicy must not include unexpectedKey"]);
  });
});
