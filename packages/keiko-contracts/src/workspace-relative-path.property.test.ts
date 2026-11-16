import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";

import {
  characters,
  checkProperty,
  shrinkString,
  type SeededRandom,
} from "../../../tests/support/seeded-property.js";
import { isCodeTaskRepoRelativePath } from "./code-task-acceptance.js";
import { isValidScopePath } from "./connected-context.js";
import { isContainedAgentPath } from "./editor-agent-path.js";
import { isPortableWorkspaceRelativePath } from "./workspace-contract-primitives.js";

/**
 * #4271: every pure predicate that admits a "workspace-relative" path must admit only paths that
 * stay inside a root under BOTH the POSIX and the Windows reading, judged by `node:path`, not by
 * the predicate's own rules. Admitting fewer paths than the spec would is allowed; admitting an
 * escaping one is not.
 */

const SEGMENTS = [
  "..",
  ".",
  "",
  "a",
  "src",
  "...",
  "%2e%2e",
  "\uFF0E\uFF0E",
  "\u2024\u2024",
  "\u00E9",
  "e\u0301",
  "\u0001",
  "\u0000",
  "C:",
  "d:x",
  "\\",
  "..\\",
  "\\\\srv\\share",
  "~",
  "~root",
  "x".repeat(5000),
];
const PREFIXES = ["", "", "/", "./", "../", "//", "C:\\", "C:", "\\\\", "\\", "~/", "\u00A0"];
const SEPARATORS = ["/", "/", "//", "/./", "\\"];

function candidate(random: SeededRandom): string {
  const parts = random.array(0, 7, () => random.pick(SEGMENTS));
  let joined = random.pick(PREFIXES);
  for (const [index, part] of parts.entries()) {
    joined += (index === 0 ? "" : random.pick(SEPARATORS)) + part;
  }
  return random.boolean(0.2) ? `${joined}/` : joined;
}

function insideUnder(flavor: typeof posix, root: string, path: string): boolean {
  const rel = flavor.relative(root, flavor.resolve(root, path));
  return rel !== ".." && !rel.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(rel);
}

function staysInside(path: string): boolean {
  return (
    !path.includes("\u0000") &&
    insideUnder(posix, "/repo/root", path) &&
    insideUnder(win32, "C:\\repo\\root", path)
  );
}

const PREDICATES: readonly [string, (value: string) => boolean][] = [
  ["isPortableWorkspaceRelativePath", isPortableWorkspaceRelativePath],
  ["isContainedAgentPath", isContainedAgentPath],
  ["isCodeTaskRepoRelativePath", isCodeTaskRepoRelativePath],
  ["isValidScopePath", (value): boolean => isValidScopePath(value, { mustBeRelative: true })],
];

describe("workspace-relative path predicates (#4271)", () => {
  it.each(PREDICATES)("%s admits only paths that stay inside the root", (_name, admit) => {
    checkProperty(
      candidate,
      (path) => {
        if (admit(path)) expect(staysInside(path)).toBe(true);
      },
      { shrink: shrinkString },
    );
  });

  it.each(PREDICATES)("%s is deterministic and never throws on arbitrary text", (_name, admit) => {
    checkProperty(
      (random) => random.string(characters("./\\:%~\u0000\uFF0E\u2024 aé\ud83d\ude00"), 0, 40),
      (path) => {
        expect(admit(path)).toBe(admit(path));
      },
      { shrink: shrinkString },
    );
  });
});
