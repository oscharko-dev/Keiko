import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { validateMatrix, verificationPathFailures } from "../check-security-regression-matrix.mjs";

// The gate's core claim is coverage-of-record: every entry names a test or document that STILL
// exists and can therefore still prove its finding. Before audit KEIKO-0030 the checker validated
// JSON shape only, so it printed "PASS - 42 findings mapped" while 13 verification paths pointed at
// deleted or never-committed files. These tests pin the file-existence half of that claim.

// Each caller owns its directory for the length of one test, so nothing is shared and no ordering
// between tests can matter.
function withRepoRoot(files, assert) {
  const root = mkdtempSync(join(tmpdir(), "keiko-security-matrix-"));
  try {
    for (const relativePath of files) {
      const absolute = join(root, relativePath);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, "");
    }
    assert(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const REAL_ID = "AUDIT-SEC-001";

function entry(verification, id = REAL_ID) {
  return { id, verification, notes: "fixture entry" };
}

describe("verification path existence", () => {
  it("fails when a verification command names a test file that does not exist", () => {
    withRepoRoot([], (root) => {
      const failures = verificationPathFailures(
        REAL_ID,
        ["npx vitest run packages/keiko-server/src/does-not-exist.test.ts"],
        root,
      );

      expect(failures).toEqual([
        `${REAL_ID} verification path does not exist: packages/keiko-server/src/does-not-exist.test.ts`,
      ]);
    });
  });

  it("passes when every named path exists", () => {
    withRepoRoot(["packages/keiko-server/src/real.test.ts"], (root) => {
      expect(
        verificationPathFailures(
          REAL_ID,
          ["npx vitest run packages/keiko-server/src/real.test.ts"],
          root,
        ),
      ).toEqual([]);
    });
  });

  it("reports every missing path in a multi-file command, not just the first", () => {
    withRepoRoot(["a.test.ts"], (root) => {
      expect(
        verificationPathFailures(REAL_ID, ["npx vitest run a.test.ts b.test.ts c.test.ts"], root),
      ).toEqual([
        `${REAL_ID} verification path does not exist: b.test.ts`,
        `${REAL_ID} verification path does not exist: c.test.ts`,
      ]);
    });
  });

  // The keiko-ui entries run vitest from the package directory, so their paths are relative to it.
  // Resolving them against the repository root would report every one of them as missing.
  it("resolves paths in a `cd <dir> && …` command against that directory", () => {
    withRepoRoot(
      ["packages/keiko-ui/vitest.config.ts", "packages/keiko-ui/src/lib/safe.test.ts"],
      (root) => {
        const command =
          "cd packages/keiko-ui && npx vitest run --config vitest.config.ts src/lib/safe.test.ts";

        expect(verificationPathFailures(REAL_ID, [command], root)).toEqual([]);
        expect(
          verificationPathFailures(REAL_ID, [`${command} src/lib/gone.test.tsx`], root),
        ).toEqual([
          `${REAL_ID} verification path does not exist: packages/keiko-ui/src/lib/gone.test.tsx`,
        ]);
      },
    );
  });

  it("fails when the `cd` target directory itself is missing", () => {
    withRepoRoot([], (root) => {
      expect(
        verificationPathFailures(REAL_ID, ["cd packages/gone && npx vitest run a.test.ts"], root),
      ).toEqual([
        `${REAL_ID} verification path does not exist: packages/gone`,
        `${REAL_ID} verification path does not exist: packages/gone/a.test.ts`,
      ]);
    });
  });

  // Runner words, npm script names and flags carry no extension, and a quoted ripgrep pattern may
  // contain any character at all — none of them is a path, and treating one as a path would make
  // the gate fail on entries that are perfectly healthy.
  it("does not treat runner words, npm script names, flags or quoted patterns as paths", () => {
    withRepoRoot(["docs/security.md"], (root) => {
      const commands = [
        "npm run check:local-state",
        "npm run arch:check:negative",
        'rg -n "tamper-evident, not tamper-proof|Most are not encrypted" docs/security.md',
      ];

      expect(verificationPathFailures(REAL_ID, commands, root)).toEqual([]);
    });
  });
});

describe("validateMatrix", () => {
  it("surfaces a missing verification path alongside the existing shape failures", () => {
    withRepoRoot([], (root) => {
      const { failures } = validateMatrix([entry(["npx vitest run gone.test.ts"])], root);

      expect(failures).toContain(`${REAL_ID} verification path does not exist: gone.test.ts`);
    });
  });

  it("still rejects an unknown finding id, an empty verification list and empty notes", () => {
    withRepoRoot([], (root) => {
      const { failures } = validateMatrix(
        [
          { id: "AUDIT-NOT-A-FINDING", verification: ["npm run x"], notes: "n" },
          { id: "AUDIT-FS-001", verification: [], notes: "n" },
          { id: "AUDIT-EVID-001", verification: ["npm run x"], notes: "  " },
        ],
        root,
      );

      expect(failures).toContain("entry 0 has unknown id AUDIT-NOT-A-FINDING");
      expect(failures).toContain("AUDIT-FS-001 must list at least one verification command");
      expect(failures).toContain("AUDIT-EVID-001 must include non-empty notes");
    });
  });

  it("rejects a non-array matrix root without throwing", () => {
    withRepoRoot([], (root) => {
      expect(validateMatrix({ id: REAL_ID }, root)).toEqual({
        failures: ["matrix root must be a JSON array."],
        count: 0,
      });
    });
  });
});
