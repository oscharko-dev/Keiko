import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  containsPrimaryShellCommand,
  runPortableLaunchSetupSmoke,
  validatePortableLaunchSetupDocs,
} from "../portable-launch-setup-smoke.mjs";

let currentRoot;

function root() {
  const base = join(homedir(), ".keiko-test-roots");
  mkdirSync(base, { recursive: true });
  currentRoot = mkdtempSync(join(base, "portable-launch-setup-test-"));
  return currentRoot;
}

describe("portable launch/setup smoke", () => {
  afterEach(() => {
    if (currentRoot !== undefined) {
      rmSync(currentRoot, { recursive: true, force: true });
      currentRoot = undefined;
    }
  });

  it("proves managed setup and relaunch for every portable target without path node/npm", async () => {
    const dir = root();
    const evidencePath = join(dir, "evidence", "portable-launch-setup-smoke.json");

    const evidence = await runPortableLaunchSetupSmoke(["--evidence", evidencePath], {
      now: new Date("2026-07-06T00:00:00.000Z"),
      tempRoot: dir,
    });

    expect(evidence.fixtureTargets).toHaveLength(3);
    expect(evidence.fixtureTargets.map((target) => target.platformTarget)).toEqual([
      "windows-x64",
      "macos-arm64",
      "macos-x64",
    ]);
    for (const target of evidence.fixtureTargets) {
      expect(target).toMatchObject({
        manualDownloadUpgrade: {
          clickedNewerPackageStoppedServer: true,
          noRollbackPathUsed: true,
          relaunchedAfterSwap: true,
          upgradedPackageVersion: true,
        },
        pathWithoutNodeOrNpm: true,
        relaunchedFromManagedAppRoot: true,
        setupStatus: "managed",
        spawnedManagedLauncher: true,
        updateEligible: true,
      });
    }
    const rendered = readFileSync(evidencePath, "utf8");
    expect(rendered).toContain('"issue": 1953');
    expect(rendered).not.toContain(dir);
  }, 30_000);

  it("keeps the primary portable user journey free of shell commands", () => {
    expect(validatePortableLaunchSetupDocs()).toEqual({
      primaryJourneyShellFree: true,
      troubleshootingHonest: true,
    });
  });

  it("still detects each primary-shell-command shape", () => {
    expect(containsPrimaryShellCommand("plain prose with no commands")).toBe(false);
    expect(containsPrimaryShellCommand("```\nsome code\n```")).toBe(true);
    expect(containsPrimaryShellCommand("run npm install to set up")).toBe(true);
    expect(containsPrimaryShellCommand("keiko start")).toBe(true);
    expect(containsPrimaryShellCommand("keiko portable")).toBe(true);
    expect(containsPrimaryShellCommand("  npm install")).toBe(true);
    expect(containsPrimaryShellCommand("text\n    node script.js\nmore text")).toBe(true);
  });

  // The line-start indent must accept ANY `\s` member other than `\n` (matching the pre-S8786-fix
  // `\s*` semantics), not just space/tab. A narrower `[ \t]*` silently stops detecting a keyword
  // preceded by a bare CR, form feed, vertical tab, NBSP, or a Unicode line/paragraph separator —
  // all real filler a CRLF-unnormalised file or content pasted from Word/Notion/Google Docs can
  // contain — which would let a real shell command slip past this documentation-quality gate.
  it("detects a keyword indented with non-tab/space whitespace (CR, FF, VT, NBSP, U+2028/2029)", () => {
    expect(containsPrimaryShellCommand("\rnode server.js")).toBe(true);
    expect(containsPrimaryShellCommand("\fnode server.js")).toBe(true);
    expect(containsPrimaryShellCommand("\vnode server.js")).toBe(true);
    // \u-escapes, not raw bytes: three consecutive Coverage and SonarCloud failures
    // (java.lang.IllegalArgumentException, "N is not a valid line offset for pointer", at a
    // shifting position downstream of these lines on each attempt) traced to the raw multi-byte
    // UTF-8 characters that used to be embedded directly in these three literals. U+2028 LINE
    // SEPARATOR and U+2029 PARAGRAPH SEPARATOR are ECMAScript LineTerminator code points; the
    // SonarCloud JS analyzer bridge's line-splitting evidently counts them as line breaks while
    // the Java-side scanner's own line model does not, desyncing every subsequent line/column
    // computation for the rest of the file. Escaping keeps the runtime strings byte-for-byte
    // identical while removing the raw line-terminator bytes the desync needs.
    expect(containsPrimaryShellCommand("\u00a0node server.js")).toBe(true);
    expect(containsPrimaryShellCommand("\u2028node server.js")).toBe(true);
    expect(containsPrimaryShellCommand("\u2029node server.js")).toBe(true);
    expect(containsPrimaryShellCommand("intro\r\nnode server.js")).toBe(true);
  });

  // The former `(?:^|\n)\s*(?:node|npm|npx|yarn|keiko)\s+` let its `\s*` re-enter the same run of
  // newlines that `(?:^|\n)` already anchors on, so text with many blank lines and no matching
  // keyword forced a retry at every offset of the run — quadratic in the run length (S8786;
  // empirically ~1.3s at 40k newlines before this fix). Regression-tests both the fix's speed and
  // that a real command mention deep inside such a document is still found.
  it("scans a document with many newlines and no keyword in linear time", () => {
    const filler = "\n ".repeat(50_000);
    const start = Date.now();
    const noCommand = containsPrimaryShellCommand(`${filler}just prose, no commands here`);
    const withCommand = containsPrimaryShellCommand(`${filler}npm install`);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(500);
    expect(noCommand).toBe(false);
    expect(withCommand).toBe(true);
  });
});
