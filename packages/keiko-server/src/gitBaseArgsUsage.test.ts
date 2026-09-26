// KEIKO-0149 hygiene regression: the git-safety two-literal prefix
// ["--no-pager", "--no-optional-locks"] must never be re-hardcoded at a keiko-server call
// site. Every git invocation from keiko-server must spread GIT_BASE_ARGS (imported from
// @oscharko-dev/keiko-git) so a single point of decision governs the flags. A new call
// site introducing the literal prefix instead of the import trips this test.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const GIT_CALL_SITE_FILES = [
  "gitRoutes.ts",
  "gitRepositoryReads.ts",
  "gitDelivery/syncExecution.ts",
  "grounded-git-history-evidence.ts",
] as const;

// Adjacent quoted string literals: "--no-pager"[optional whitespace/comma/newline]"--no-optional-locks".
const HAND_TYPED_PREFIX = /["']--no-pager["'][\s,]*["']--no-optional-locks["']/u;

describe("keiko-server never re-hardcodes GIT_BASE_ARGS", () => {
  for (const relative of GIT_CALL_SITE_FILES) {
    it(`${relative} imports GIT_BASE_ARGS and does not restate the safety prefix`, () => {
      const source = readFileSync(resolve(HERE, relative), "utf8");
      expect(source).toMatch(/GIT_BASE_ARGS/u);
      expect(HAND_TYPED_PREFIX.test(source)).toBe(false);
    });
  }
});
