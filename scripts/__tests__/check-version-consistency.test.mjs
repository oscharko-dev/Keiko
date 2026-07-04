// Regression gate for scripts/check-version-consistency.mjs (Epic #423 issue #433).
//
// check-version-consistency.mjs is a required release gate: it is wired into ci.yml, the
// prepack chain, and the publish path (see docs/release and package.json scripts). It
// asserts that every workspace package.json version, and every exported KEIKO_*_VERSION /
// KEIKO_PRODUCT_VERSION source constant, agrees with the root package version. A silent
// regression here (a constant drifting from its manifest, or the failure message losing the
// offending package/constant name) would let inconsistent versions ship.
//
// The script derives repoRoot from import.meta.url and runs entirely at import — it exposes
// no exported functions and accepts no --root flag. So we drive it the way the house drives
// other spawn-only gates: build a self-contained mini-repo under mkdtemp, copy the real
// script (and the two real root facade files, byte-for-byte) into it so import.meta.url
// resolves repoRoot to the mini-repo, then spawnSync it and assert on BOTH the exit code and
// the emitted message. Fixtures are fully controlled — we never assert real-repo drift.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_SCRIPT = join(REPO_ROOT, "scripts", "check-version-consistency.mjs");
// The script pins the sha256 of these two root facade files, and requires src/ to contain
// exactly them. We copy the live files byte-for-byte so the green fixture stays valid even if
// the facades (and their pinned hashes) are legitimately updated together in the future.
const REAL_ROOT_SRC_FILES = ["src/index.ts", "src/cli/index.ts"];

const VERSION = "0.2.11";

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "version-consistency-"));
}

function writeFile(root, relative, content) {
  const absolute = join(root, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function writeJson(root, relative, value) {
  writeFile(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

// Builds a mini-repo that PASSES every branch of the gate. Individual tests then mutate one
// field to prove that the corresponding failure branch fires (and names the offender).
function writeCleanRoot(root, { version = VERSION } = {}) {
  // 1) Copy the script into <root>/scripts so its repoRoot === <root>.
  const scriptDir = join(root, "scripts");
  mkdirSync(scriptDir, { recursive: true });
  copyFileSync(REAL_SCRIPT, join(scriptDir, "check-version-consistency.mjs"));

  // 2) Copy the two real root facade files byte-for-byte (pinned-hash + exact-listing checks).
  for (const relative of REAL_ROOT_SRC_FILES) {
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    copyFileSync(join(REPO_ROOT, relative), absolute);
  }

  // 3) Root manifest establishes the expected version.
  writeJson(root, "package.json", {
    name: "@oscharko-dev/keiko",
    version,
    private: true,
  });

  // 4) keiko-contracts: manifest + KEIKO_PRODUCT_VERSION + a second KEIKO_*_VERSION constant,
  //    all agreeing with the root version.
  writeJson(root, "packages/keiko-contracts/package.json", {
    name: "@oscharko-dev/keiko-contracts",
    version,
    private: true,
  });
  writeFile(
    root,
    "packages/keiko-contracts/src/index.ts",
    [
      `export const KEIKO_CONTRACTS_VERSION = "${version}" as const;`,
      `export const KEIKO_PRODUCT_VERSION = "${version}" as const;`,
      "",
    ].join("\n"),
  );

  // 5) A second workspace with its own KEIKO_*_VERSION source constant.
  writeJson(root, "packages/keiko-harness/package.json", {
    name: "@oscharko-dev/keiko-harness",
    version,
    private: true,
  });
  writeFile(
    root,
    "packages/keiko-harness/src/version.ts",
    `export const KEIKO_HARNESS_VERSION = "${version}" as const;\n`,
  );

  // 6) keiko-sdk must import + directly re-export KEIKO_PRODUCT_VERSION as SDK_VERSION.
  writeJson(root, "packages/keiko-sdk/package.json", {
    name: "@oscharko-dev/keiko-sdk",
    version,
    private: true,
  });
  writeFile(
    root,
    "packages/keiko-sdk/src/index.ts",
    [
      'import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts";',
      "export const SDK_VERSION: string = KEIKO_PRODUCT_VERSION;",
      "",
    ].join("\n"),
  );
}

function runGate(root) {
  return spawnSync(process.execPath, [join(root, "scripts", "check-version-consistency.mjs")], {
    encoding: "utf8",
  });
}

describe("check-version-consistency gate", () => {
  let root;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  // GREEN path: a fully consistent mini-repo passes with exit 0 and the PASS banner.
  it("passes when every manifest and KEIKO_*_VERSION constant agrees with the root version", () => {
    root = makeRoot();
    writeCleanRoot(root);

    const result = runGate(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("version-consistency: PASS");
    expect(result.stdout).toContain(VERSION);
    // A green run must not emit the failure banner.
    expect(result.stderr).not.toContain("version-consistency: FAIL");
  });

  // RED path A: a package's src KEIKO_*_VERSION constant drifts from its own package.json.
  it("fails and names the offending package/constant when a src KEIKO_*_VERSION constant drifts", () => {
    root = makeRoot();
    writeCleanRoot(root);
    // keiko-harness manifest stays 0.2.11 but its source constant drifts to 0.2.10.
    writeFile(
      root,
      "packages/keiko-harness/src/version.ts",
      'export const KEIKO_HARNESS_VERSION = "0.2.10" as const;\n',
    );

    const result = runGate(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("version-consistency: FAIL");
    // The message must name the package, the constant, the drifted value, and the manifest value.
    expect(result.stderr).toContain("keiko-harness");
    expect(result.stderr).toContain("KEIKO_HARNESS_VERSION");
    expect(result.stderr).toContain("src/version.ts");
    expect(result.stderr).toContain("is 0.2.10");
    expect(result.stderr).toContain(`but package.json is ${VERSION}`);
  });

  // RED path B: the aggregate product constant (keiko-contracts KEIKO_PRODUCT_VERSION) drifts
  // from the root version. keiko-contracts' package.json also drifts with it, so the ONLY
  // remaining mismatch is the dedicated root/product-version check (lines 140-145 of the gate),
  // proving that branch fires independently of the per-package manifest check.
  it("fails and names KEIKO_PRODUCT_VERSION when the product constant drifts from the root version", () => {
    root = makeRoot();
    writeCleanRoot(root);
    // Bump the contracts manifest AND both of its source constants to 0.2.99 so the ONLY
    // surviving discrepancy is contracts' KEIKO_PRODUCT_VERSION vs the root's 0.2.11.
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.2.99",
      private: true,
    });
    writeFile(
      root,
      "packages/keiko-contracts/src/index.ts",
      [
        'export const KEIKO_CONTRACTS_VERSION = "0.2.99" as const;',
        'export const KEIKO_PRODUCT_VERSION = "0.2.99" as const;',
        "",
      ].join("\n"),
    );

    const result = runGate(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("version-consistency: FAIL");
    expect(result.stderr).toContain("keiko-contracts KEIKO_PRODUCT_VERSION 0.2.99");
    expect(result.stderr).toContain(`does not match root ${VERSION}`);
  });

  // RED path C: a workspace package.json version drifts from the root version.
  it("fails and names the offending package when a workspace package.json version drifts", () => {
    root = makeRoot();
    writeCleanRoot(root);
    // Drift the harness manifest AND its source constant together, so the manifest-vs-root
    // check is the failure under test (the src-constant-vs-manifest check stays satisfied).
    writeJson(root, "packages/keiko-harness/package.json", {
      name: "@oscharko-dev/keiko-harness",
      version: "0.1.0",
      private: true,
    });
    writeFile(
      root,
      "packages/keiko-harness/src/version.ts",
      'export const KEIKO_HARNESS_VERSION = "0.1.0" as const;\n',
    );

    const result = runGate(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("version-consistency: FAIL");
    expect(result.stderr).toContain(`keiko-harness: version 0.1.0 does not match root ${VERSION}`);
  });
});
