// Unit tests for scripts/check-quality-intelligence-supply-chain.mjs (Issue #287).
//
// Each test mkdtemps a synthetic repo root and drives the script's exported helpers against
// it. The live repo is never touched. The script's main() is invoked via the harness's
// `--root` flag to exercise the full pipeline end-to-end.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkLifecycleHooks,
  checkMatrixConsistency,
  checkMatrixLicenses,
  checkRootManifestForbidden,
  checkTelemetryStrings,
  checkUnapprovedRuntimeDependencies,
  checkWorkspaceManifestForbidden,
  collectPublishedRuntimeDependencies,
  findForbiddenImportHits,
  listScannableSourceFiles,
  parseDecisionMatrix,
} from "../check-quality-intelligence-supply-chain.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-quality-intelligence-supply-chain.mjs");
const MATRIX_PATH = "docs/release/quality-intelligence-dependency-decision-matrix.md";

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "qi-supply-"));
}

function writeFile(root, relative, content) {
  const absolute = join(root, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function writeJson(root, relative, value) {
  writeFile(root, relative, JSON.stringify(value, null, 2));
}

// Column order (ADR-0023 / Issue #287 AC1):
// package | namespace | runtime role | decision | license | owner | rationale | risk-class | rejection alternative
//
// The license cell at index 4 is required; rows without it cause the license check to fire.
// All matrix rows in this harness use a real license token (MIT / Apache-2.0 / etc.) so the
// license check never fires on a clean fixture.
function minimalCleanRoot(root) {
  writeJson(root, "package.json", {
    name: "synthetic-root",
    version: "0.0.0",
    private: true,
    dependencies: { ws: "^8.0.0" },
    devDependencies: { eslint: "^10.0.0", vitest: "^4.0.0", prettier: "^3.0.0" },
    bundleDependencies: ["@oscharko-dev/keiko-contracts"],
  });
  writeJson(root, "packages/keiko-contracts/package.json", {
    name: "@oscharko-dev/keiko-contracts",
    version: "0.0.0",
    private: true,
    license: "Apache-2.0",
  });
  writeFile(
    root,
    MATRIX_PATH,
    [
      "# matrix",
      "",
      "| package | namespace | runtime role | decision | license | owner | rationale | risk-class | rejection alternative |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      "| ws | (top-level) | transport | approved-runtime | MIT | pf | already shipped | low | n/a |",
      "| eslint | (top-level) | linter | approved-dev | MIT | pf | already shipped | low | n/a |",
      "| @oscharko-dev/test-intelligence | @oscharko-dev | denied | denied | n/a | security | ADR-0023 D12 | high | native reimpl |",
      "| @oscharko-dev/ti-* | @oscharko-dev | denied | denied | n/a | security | ADR-0023 D12 | high | native reimpl |",
      "| @sentry/* | @sentry | telemetry | denied | n/a | security | offline-by-default | high | local ledger |",
      "",
    ].join("\n"),
  );
}

function runScript(root, extraArgs = []) {
  return spawnSync(process.execPath, [SCRIPT, `--root=${root}`, ...extraArgs], {
    encoding: "utf8",
  });
}

// ---------------------------------------------------------------------------
// parseDecisionMatrix
// ---------------------------------------------------------------------------

describe("parseDecisionMatrix", () => {
  it("parses table rows and ignores headers", () => {
    const rows = parseDecisionMatrix(
      [
        "| package | ns | role | decision |",
        "| --- | --- | --- | --- |",
        "| ws | top | runtime | approved-runtime |",
        "| eslint | top | dev | approved-dev |",
        "| bad | top | telemetry | denied |",
        "| pending | top | tbd | defer-to-decision |",
        "| not-a-row | top | runtime | something-else |",
      ].join("\n"),
    );
    expect(rows.map((r) => r.decision)).toEqual([
      "approved-runtime",
      "approved-dev",
      "denied",
      "defer-to-decision",
    ]);
  });

  it("captures the license cell at index 4 when present", () => {
    const rows = parseDecisionMatrix(
      [
        "| package | ns | role | decision | license |",
        "| --- | --- | --- | --- | --- |",
        "| ws | top | runtime | approved-runtime | MIT |",
        "| eslint | top | dev | approved-dev | ISC |",
      ].join("\n"),
    );
    expect(rows[0]).toMatchObject({ name: "ws", decision: "approved-runtime", license: "MIT" });
    expect(rows[1]).toMatchObject({ name: "eslint", decision: "approved-dev", license: "ISC" });
  });

  it("returns empty string for license when the column is absent (4-cell row)", () => {
    const rows = parseDecisionMatrix(
      [
        "| package | ns | role | decision |",
        "| --- | --- | --- | --- |",
        "| ws | top | runtime | approved-runtime |",
      ].join("\n"),
    );
    expect(rows[0]?.license).toBe("");
  });

  it("tolerates Windows line-endings (CRLF)", () => {
    const rows = parseDecisionMatrix(
      "| package | ns | role | decision | license |\r\n" +
        "| --- | --- | --- | --- | --- |\r\n" +
        "| ws | top | runtime | approved-runtime | MIT |\r\n",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe("approved-runtime");
  });

  it("returns empty array for empty input", () => {
    expect(parseDecisionMatrix("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkMatrixConsistency
// ---------------------------------------------------------------------------

describe("checkMatrixConsistency — clean repo", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
    minimalCleanRoot(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns no mismatches", () => {
    const result = checkMatrixConsistency(
      join(root, MATRIX_PATH),
      join(root, "package.json"),
      join(root, "packages"),
    );
    expect(result.mismatches).toEqual([]);
    expect(result.rowCounts?.total).toBe(5);
  });
});

describe("checkMatrixConsistency — approved-runtime mismatch", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("flags an approved-runtime row that no manifest declares", () => {
    minimalCleanRoot(root);
    writeFile(
      root,
      MATRIX_PATH,
      [
        "| package | ns | role | decision | license |",
        "| --- | --- | --- | --- | --- |",
        "| ws | top | runtime | approved-runtime | MIT |",
        "| ghost-pkg | top | runtime | approved-runtime | MIT |",
      ].join("\n"),
    );
    const result = checkMatrixConsistency(
      join(root, MATRIX_PATH),
      join(root, "package.json"),
      join(root, "packages"),
    );
    expect(result.mismatches).toEqual([{ kind: "approved-runtime-missing", row: "ghost-pkg" }]);
  });
});

describe("checkMatrixConsistency — denied row present", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("flags a denied row that is actually present in a manifest", () => {
    minimalCleanRoot(root);
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      private: true,
      dependencies: { ws: "^8.0.0", "@sentry/node": "^7.0.0" },
    });
    const result = checkMatrixConsistency(
      join(root, MATRIX_PATH),
      join(root, "package.json"),
      join(root, "packages"),
    );
    const denied = result.mismatches.filter((m) => m.kind === "denied-present");
    expect(denied).toEqual([{ kind: "denied-present", row: "@sentry/*", present: "@sentry/node" }]);
  });
});

describe("checkMatrixConsistency — missing file", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reports missing when the matrix file does not exist", () => {
    const result = checkMatrixConsistency(
      join(root, "nope.md"),
      join(root, "package.json"),
      join(root, "packages"),
    );
    expect(result.mismatches[0]?.kind).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
// checkMatrixConsistency — defer-to-decision enforcement (M6, new behaviour)
// ---------------------------------------------------------------------------

describe("checkMatrixConsistency — defer-to-decision enforcement", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("flags a defer-to-decision row when the package IS present in a manifest", () => {
    // pending-lib is deferred; it appears in root dependencies — must be caught as deferred-present.
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      private: true,
      dependencies: { ws: "^8.0.0", "pending-lib": "^1.0.0" },
    });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
    });
    writeFile(
      root,
      MATRIX_PATH,
      [
        "| package | ns | role | decision | license |",
        "| --- | --- | --- | --- | --- |",
        "| ws | top | runtime | approved-runtime | MIT |",
        "| pending-lib | top | tbd | defer-to-decision | |",
      ].join("\n"),
    );
    const result = checkMatrixConsistency(
      join(root, MATRIX_PATH),
      join(root, "package.json"),
      join(root, "packages"),
    );
    const deferred = result.mismatches.filter((m) => m.kind === "deferred-present");
    expect(deferred).toEqual([
      { kind: "deferred-present", row: "pending-lib", present: "pending-lib" },
    ]);
  });

  it("does NOT flag a defer-to-decision row when the package is absent from all manifests", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      private: true,
      dependencies: { ws: "^8.0.0" },
    });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
    });
    writeFile(
      root,
      MATRIX_PATH,
      [
        "| package | ns | role | decision | license |",
        "| --- | --- | --- | --- | --- |",
        "| ws | top | runtime | approved-runtime | MIT |",
        "| pending-lib | top | tbd | defer-to-decision | |",
      ].join("\n"),
    );
    const result = checkMatrixConsistency(
      join(root, MATRIX_PATH),
      join(root, "package.json"),
      join(root, "packages"),
    );
    const deferred = result.mismatches.filter((m) => m.kind === "deferred-present");
    expect(deferred).toEqual([]);
  });

  it("produces kind deferred-present (not denied-present) for a defer-to-decision row", () => {
    // The mismatch kinds are distinct: denied rows produce denied-present; deferred rows produce
    // deferred-present. A test that only checks status !== 0 cannot distinguish them.
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      private: true,
      dependencies: { "review-pkg": "^1.0.0" },
    });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
    });
    writeFile(
      root,
      MATRIX_PATH,
      [
        "| package | ns | role | decision | license |",
        "| --- | --- | --- | --- | --- |",
        "| review-pkg | top | tbd | defer-to-decision | |",
      ].join("\n"),
    );
    const result = checkMatrixConsistency(
      join(root, MATRIX_PATH),
      join(root, "package.json"),
      join(root, "packages"),
    );
    expect(result.mismatches[0]?.kind).toBe("deferred-present");
    // Guard: must NOT be misclassified as denied-present
    expect(result.mismatches.some((m) => m.kind === "denied-present")).toBe(false);
  });

  it("flags a non-telemetry denied row via matrix check, isolated from the telemetry gate", () => {
    // bad-pkg is denied but is not a telemetry string — only the matrix gate catches it.
    // This test isolates checkMatrixConsistency from the separate telemetry check (fixes M1).
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      private: true,
      dependencies: { "bad-pkg": "^1.0.0" },
    });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
    });
    writeFile(
      root,
      MATRIX_PATH,
      [
        "| package | ns | role | decision | license |",
        "| --- | --- | --- | --- | --- |",
        "| bad-pkg | top | n/a | denied | n/a |",
      ].join("\n"),
    );
    const result = checkMatrixConsistency(
      join(root, MATRIX_PATH),
      join(root, "package.json"),
      join(root, "packages"),
    );
    expect(result.mismatches).toEqual([
      { kind: "denied-present", row: "bad-pkg", present: "bad-pkg" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// checkMatrixLicenses (new check 8)
// ---------------------------------------------------------------------------

describe("checkMatrixLicenses — approved rows must declare a license", () => {
  it("flags an approved-runtime row with an empty license", () => {
    const md = [
      "| package | ns | role | decision | license |",
      "| --- | --- | --- | --- | --- |",
      "| ws | top | transport | approved-runtime |  |",
    ].join("\n");
    const root = makeRoot();
    writeFile(root, MATRIX_PATH, md);
    try {
      const hits = checkMatrixLicenses(join(root, MATRIX_PATH));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ row: "ws", decision: "approved-runtime" });
      expect(hits[0]?.license.trim()).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags an approved-dev row with license literally n/a (case-insensitive)", () => {
    const root = makeRoot();
    writeFile(
      root,
      MATRIX_PATH,
      [
        "| package | ns | role | decision | license |",
        "| --- | --- | --- | --- | --- |",
        "| eslint | top | linter | approved-dev | N/A |",
      ].join("\n"),
    );
    try {
      const hits = checkMatrixLicenses(join(root, MATRIX_PATH));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ row: "eslint", decision: "approved-dev" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT flag an approved row with a real license token", () => {
    const root = makeRoot();
    writeFile(
      root,
      MATRIX_PATH,
      [
        "| package | ns | role | decision | license |",
        "| --- | --- | --- | --- | --- |",
        "| ws | top | transport | approved-runtime | MIT |",
        "| eslint | top | linter | approved-dev | MIT |",
      ].join("\n"),
    );
    try {
      expect(checkMatrixLicenses(join(root, MATRIX_PATH))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT flag denied or defer-to-decision rows (license not required on non-approved rows)", () => {
    const root = makeRoot();
    writeFile(
      root,
      MATRIX_PATH,
      [
        "| package | ns | role | decision | license |",
        "| --- | --- | --- | --- | --- |",
        "| @sentry/* | @sentry | telemetry | denied |  |",
        "| pending-lib | top | tbd | defer-to-decision |  |",
      ].join("\n"),
    );
    try {
      expect(checkMatrixLicenses(join(root, MATRIX_PATH))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns empty array when the matrix file does not exist", () => {
    const root = makeRoot();
    try {
      expect(checkMatrixLicenses(join(root, "no-such-matrix.md"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags only the rows missing a license when the matrix has a mix", () => {
    const root = makeRoot();
    writeFile(
      root,
      MATRIX_PATH,
      [
        "| package | ns | role | decision | license |",
        "| --- | --- | --- | --- | --- |",
        "| ws | top | transport | approved-runtime | MIT |",
        "| no-license-pkg | top | runtime | approved-runtime |  |",
        "| eslint | top | dev | approved-dev | MIT |",
        "| also-missing | top | dev | approved-dev | n/a |",
      ].join("\n"),
    );
    try {
      const hits = checkMatrixLicenses(join(root, MATRIX_PATH));
      expect(hits.map((h) => h.row)).toEqual(["no-license-pkg", "also-missing"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// collectPublishedRuntimeDependencies
// ---------------------------------------------------------------------------

describe("collectPublishedRuntimeDependencies", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("collects root runtime dependencies with label <root>", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: { ws: "^8.0.0" },
      bundleDependencies: [],
    });
    const map = collectPublishedRuntimeDependencies(
      join(root, "package.json"),
      join(root, "packages"),
    );
    expect(map.get("ws")).toMatchObject({ label: "<root>", section: "dependencies" });
  });

  it("collects root optionalDependencies with label <root>", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: {},
      optionalDependencies: { "some-native": "^1.0.0" },
      bundleDependencies: [],
    });
    const map = collectPublishedRuntimeDependencies(
      join(root, "package.json"),
      join(root, "packages"),
    );
    expect(map.get("some-native")).toMatchObject({
      label: "<root>",
      section: "optionalDependencies",
    });
  });

  it("collects deps from a BUNDLED workspace package with label = short package dir name", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: { "@oscharko-dev/keiko-contracts": "workspace:*" },
      bundleDependencies: ["@oscharko-dev/keiko-contracts"],
    });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      dependencies: { yauzl: "^2.0.0" },
    });
    const map = collectPublishedRuntimeDependencies(
      join(root, "package.json"),
      join(root, "packages"),
    );
    expect(map.get("yauzl")).toMatchObject({ label: "keiko-contracts", section: "dependencies" });
  });

  it("does NOT collect deps from a workspace package that is NOT in bundleDependencies", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: {},
      bundleDependencies: [],
    });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      dependencies: { "non-bundled-dep": "^1.0.0" },
    });
    const map = collectPublishedRuntimeDependencies(
      join(root, "package.json"),
      join(root, "packages"),
    );
    expect(map.has("non-bundled-dep")).toBe(false);
  });

  it("excludes @oscharko-dev/* workspace packages from the collected set", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: { "@oscharko-dev/keiko-contracts": "workspace:*" },
      bundleDependencies: ["@oscharko-dev/keiko-contracts"],
    });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
    });
    const map = collectPublishedRuntimeDependencies(
      join(root, "package.json"),
      join(root, "packages"),
    );
    // @oscharko-dev/* are completeness-exempt; they must not appear in the collected map
    expect(map.has("@oscharko-dev/keiko-contracts")).toBe(false);
  });

  it("excludes @types/* type-only packages from the collected set", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: { "@types/node": "^22.0.0" },
      bundleDependencies: [],
    });
    const map = collectPublishedRuntimeDependencies(
      join(root, "package.json"),
      join(root, "packages"),
    );
    expect(map.has("@types/node")).toBe(false);
  });

  it("does NOT collect devDependencies (they do not ship in the tarball)", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: {},
      devDependencies: { eslint: "^10.0.0" },
      bundleDependencies: [],
    });
    const map = collectPublishedRuntimeDependencies(
      join(root, "package.json"),
      join(root, "packages"),
    );
    expect(map.has("eslint")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkUnapprovedRuntimeDependencies (new check 7 — completeness)
// ---------------------------------------------------------------------------

describe("checkUnapprovedRuntimeDependencies — completeness gate", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("FAILS when root dependencies contains a package absent from the matrix", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: { ws: "^8.0.0", "pdfjs-dist": "^4.0.0" },
      bundleDependencies: [],
    });
    writeFile(
      root,
      MATRIX_PATH,
      [
        "| package | ns | role | decision | license |",
        "| --- | --- | --- | --- | --- |",
        "| ws | top | transport | approved-runtime | MIT |",
      ].join("\n"),
    );
    const hits = checkUnapprovedRuntimeDependencies(
      join(root, MATRIX_PATH),
      join(root, "package.json"),
      join(root, "packages"),
    );
    expect(hits.some((h) => h.name === "pdfjs-dist")).toBe(true);
    const pdfjsHit = hits.find((h) => h.name === "pdfjs-dist");
    expect(pdfjsHit).toMatchObject({ label: "<root>", section: "dependencies" });
  });

  it("FAILS when a BUNDLED workspace package's dependencies contains an unlisted external dep", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: { "@oscharko-dev/keiko-contracts": "workspace:*" },
      bundleDependencies: ["@oscharko-dev/keiko-contracts"],
    });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      dependencies: { yauzl: "^2.0.0" },
    });
    writeFile(
      root,
      MATRIX_PATH,
      ["| package | ns | role | decision | license |", "| --- | --- | --- | --- | --- |"].join(
        "\n",
      ),
    );
    const hits = checkUnapprovedRuntimeDependencies(
      join(root, MATRIX_PATH),
      join(root, "package.json"),
      join(root, "packages"),
    );
    expect(hits.some((h) => h.name === "yauzl")).toBe(true);
    const yauzlHit = hits.find((h) => h.name === "yauzl");
    expect(yauzlHit).toMatchObject({ label: "keiko-contracts", section: "dependencies" });
  });

  it("PASSES when all root and bundled-package runtime deps appear as approved-runtime rows", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: { ws: "^8.0.0" },
      bundleDependencies: [],
    });
    writeFile(
      root,
      MATRIX_PATH,
      [
        "| package | ns | role | decision | license |",
        "| --- | --- | --- | --- | --- |",
        "| ws | top | transport | approved-runtime | MIT |",
      ].join("\n"),
    );
    const hits = checkUnapprovedRuntimeDependencies(
      join(root, MATRIX_PATH),
      join(root, "package.json"),
      join(root, "packages"),
    );
    expect(hits).toEqual([]);
  });

  it("PASSES when the unlisted dep is only in devDependencies (out of scope)", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: {},
      devDependencies: { "some-build-tool": "^1.0.0" },
      bundleDependencies: [],
    });
    writeFile(
      root,
      MATRIX_PATH,
      ["| package | ns | role | decision | license |", "| --- | --- | --- | --- | --- |"].join(
        "\n",
      ),
    );
    expect(
      checkUnapprovedRuntimeDependencies(
        join(root, MATRIX_PATH),
        join(root, "package.json"),
        join(root, "packages"),
      ),
    ).toEqual([]);
  });

  it("PASSES when the unlisted dep is only in a NON-bundled workspace package (out of scope)", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: {},
      bundleDependencies: [],
    });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      dependencies: { yauzl: "^2.0.0" },
    });
    writeFile(
      root,
      MATRIX_PATH,
      ["| package | ns | role | decision | license |", "| --- | --- | --- | --- | --- |"].join(
        "\n",
      ),
    );
    expect(
      checkUnapprovedRuntimeDependencies(
        join(root, MATRIX_PATH),
        join(root, "package.json"),
        join(root, "packages"),
      ),
    ).toEqual([]);
  });

  it("PASSES when the runtime dep is an @oscharko-dev/* workspace package (exempt)", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: { "@oscharko-dev/keiko-contracts": "workspace:*" },
      bundleDependencies: ["@oscharko-dev/keiko-contracts"],
    });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
    });
    writeFile(
      root,
      MATRIX_PATH,
      ["| package | ns | role | decision | license |", "| --- | --- | --- | --- | --- |"].join(
        "\n",
      ),
    );
    expect(
      checkUnapprovedRuntimeDependencies(
        join(root, MATRIX_PATH),
        join(root, "package.json"),
        join(root, "packages"),
      ),
    ).toEqual([]);
  });

  it("PASSES when the runtime dep is covered by a namespace-wildcard approved-runtime row", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: { "acme-util-core": "^1.0.0", "acme-util-extra": "^1.0.0" },
      bundleDependencies: [],
    });
    writeFile(
      root,
      MATRIX_PATH,
      [
        "| package | ns | role | decision | license |",
        "| --- | --- | --- | --- | --- |",
        "| acme-util-* | top | runtime | approved-runtime | MIT |",
      ].join("\n"),
    );
    expect(
      checkUnapprovedRuntimeDependencies(
        join(root, MATRIX_PATH),
        join(root, "package.json"),
        join(root, "packages"),
      ),
    ).toEqual([]);
  });

  it("FAILS when optionalDependencies in root contains an unlisted dep", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: {},
      optionalDependencies: { "native-binding": "^1.0.0" },
      bundleDependencies: [],
    });
    writeFile(
      root,
      MATRIX_PATH,
      ["| package | ns | role | decision | license |", "| --- | --- | --- | --- | --- |"].join(
        "\n",
      ),
    );
    const hits = checkUnapprovedRuntimeDependencies(
      join(root, MATRIX_PATH),
      join(root, "package.json"),
      join(root, "packages"),
    );
    expect(hits.some((h) => h.name === "native-binding")).toBe(true);
    const hit = hits.find((h) => h.name === "native-binding");
    expect(hit).toMatchObject({ label: "<root>", section: "optionalDependencies" });
  });

  it("FAILS when a bundled package's optionalDependencies contains an unlisted dep", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: { "@oscharko-dev/keiko-contracts": "workspace:*" },
      bundleDependencies: ["@oscharko-dev/keiko-contracts"],
    });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      optionalDependencies: { "canvas-backend": "^1.0.0" },
    });
    writeFile(
      root,
      MATRIX_PATH,
      ["| package | ns | role | decision | license |", "| --- | --- | --- | --- | --- |"].join(
        "\n",
      ),
    );
    const hits = checkUnapprovedRuntimeDependencies(
      join(root, MATRIX_PATH),
      join(root, "package.json"),
      join(root, "packages"),
    );
    expect(hits.some((h) => h.name === "canvas-backend")).toBe(true);
    const hit = hits.find((h) => h.name === "canvas-backend");
    expect(hit).toMatchObject({ label: "keiko-contracts", section: "optionalDependencies" });
  });

  it("returns empty array when the matrix file is missing (gate is a no-op without a matrix)", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: { ws: "^8.0.0" },
      bundleDependencies: [],
    });
    expect(
      checkUnapprovedRuntimeDependencies(
        join(root, "no-such-matrix.md"),
        join(root, "package.json"),
        join(root, "packages"),
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findForbiddenImportHits
// ---------------------------------------------------------------------------

describe("findForbiddenImportHits", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
    minimalCleanRoot(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds the forbidden TI package literals", () => {
    writeFile(
      root,
      "packages/keiko-contracts/src/leak.ts",
      'import x from "@oscharko-dev/test-intelligence";\n',
    );
    const files = listScannableSourceFiles(root);
    const hits = findForbiddenImportHits(files);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.pattern === "@oscharko-dev/test-intelligence")).toBe(true);
  });

  it("finds the forbidden @oscharko-dev/ti-* literal prefix", () => {
    writeFile(
      root,
      "packages/keiko-contracts/src/leak-ti.ts",
      'import y from "@oscharko-dev/ti-runner";\n',
    );
    const hits = findForbiddenImportHits(listScannableSourceFiles(root));
    expect(hits.some((h) => h.pattern === "@oscharko-dev/ti-")).toBe(true);
  });

  it("does not flag a clean source tree", () => {
    writeFile(root, "packages/keiko-contracts/src/clean.ts", "export const ok = true;\n");
    const files = listScannableSourceFiles(root);
    expect(findForbiddenImportHits(files)).toEqual([]);
  });
});

describe("findForbiddenImportHits — dynamic template-literal evasion", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
    minimalCleanRoot(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("flags a dynamic template-literal import that assembles the forbidden package name", () => {
    // The contiguous literal "@oscharko-dev/test-intelligence" never appears: the name is built
    // from a template literal. A `.includes()` scan misses it; the dynamic-scope pattern catches it.
    writeFile(
      root,
      "packages/keiko-contracts/src/sneaky.ts",
      'const n = "test-intelligence";\nconst m = await import(`@oscharko-dev/${n}`);\n',
    );
    const hits = findForbiddenImportHits(listScannableSourceFiles(root));
    expect(hits.some((h) => h.pattern.startsWith("dynamic @oscharko-dev/"))).toBe(true);
  });

  it("flags a dynamic require that interpolates the ti-* package name", () => {
    writeFile(
      root,
      "packages/keiko-contracts/src/sneaky-require.ts",
      "const sub = process.env.X;\nconst m = require(`@oscharko-dev/ti-${sub}`);\n",
    );
    const hits = findForbiddenImportHits(listScannableSourceFiles(root));
    expect(hits.some((h) => h.pattern.startsWith("dynamic @oscharko-dev/"))).toBe(true);
  });

  it("does NOT flag a dynamic SUBPATH of a statically-named allowed package", () => {
    // The package name is static (`@oscharko-dev/keiko-foo`); only the subpath is interpolated.
    // This must stay allowed so the gate does not over-block legitimate dynamic imports.
    writeFile(
      root,
      "packages/keiko-contracts/src/dynamic-subpath.ts",
      "const sub = process.env.X;\nconst m = await import(`@oscharko-dev/keiko-foo/${sub}`);\n",
    );
    expect(findForbiddenImportHits(listScannableSourceFiles(root))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkRootManifestForbidden (M7 gaps filled: dependencies + devDependencies sections)
// ---------------------------------------------------------------------------

describe("checkRootManifestForbidden", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("detects a forbidden entry in bundleDependencies", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: {},
      bundleDependencies: ["@oscharko-dev/ti-core"],
    });
    const hits = checkRootManifestForbidden(join(root, "package.json"));
    expect(hits).toEqual([
      { section: "bundleDependencies", name: "@oscharko-dev/ti-core", match: "@oscharko-dev/ti-" },
    ]);
  });

  it("detects a forbidden entry in the root peerDependencies section", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: { ws: "^8.0.0" },
      peerDependencies: { "@oscharko-dev/test-intelligence": "*" },
    });
    const hits = checkRootManifestForbidden(join(root, "package.json"));
    expect(hits).toEqual([
      {
        section: "peerDependencies",
        name: "@oscharko-dev/test-intelligence",
        match: "@oscharko-dev/test-intelligence",
      },
    ]);
  });

  it("detects a forbidden entry in the root dependencies section (M7 fix)", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: { "@oscharko-dev/test-intelligence": "^1.0.0" },
    });
    const hits = checkRootManifestForbidden(join(root, "package.json"));
    expect(hits).toEqual([
      {
        section: "dependencies",
        name: "@oscharko-dev/test-intelligence",
        match: "@oscharko-dev/test-intelligence",
      },
    ]);
  });

  it("detects a forbidden entry in the root devDependencies section (M7 fix)", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: {},
      devDependencies: { "@oscharko-dev/ti-core": "^1.0.0" },
    });
    const hits = checkRootManifestForbidden(join(root, "package.json"));
    expect(hits).toEqual([
      {
        section: "devDependencies",
        name: "@oscharko-dev/ti-core",
        match: "@oscharko-dev/ti-",
      },
    ]);
  });

  it("detects a forbidden entry in the root optionalDependencies section", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: {},
      optionalDependencies: { "@oscharko-dev/ti-native": "^1.0.0" },
    });
    const hits = checkRootManifestForbidden(join(root, "package.json"));
    expect(hits).toEqual([
      {
        section: "optionalDependencies",
        name: "@oscharko-dev/ti-native",
        match: "@oscharko-dev/ti-",
      },
    ]);
  });

  it("returns an empty list on a clean root manifest", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: { ws: "^8.0.0" },
    });
    expect(checkRootManifestForbidden(join(root, "package.json"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkWorkspaceManifestForbidden (M2 fix: clean happy path + more sections)
// ---------------------------------------------------------------------------

describe("checkWorkspaceManifestForbidden", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("detects a forbidden entry in a workspace package's dependencies", () => {
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      dependencies: { "@oscharko-dev/test-intelligence": "*" },
    });
    const hits = checkWorkspaceManifestForbidden(join(root, "packages"));
    expect(hits.length).toBe(1);
    expect(hits[0]?.name).toBe("@oscharko-dev/test-intelligence");
  });

  it("detects a forbidden entry in a workspace package's devDependencies", () => {
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      devDependencies: { "@oscharko-dev/ti-runner": "^1.0.0" },
    });
    const hits = checkWorkspaceManifestForbidden(join(root, "packages"));
    expect(hits.length).toBe(1);
    expect(hits[0]).toMatchObject({ section: "devDependencies", name: "@oscharko-dev/ti-runner" });
  });

  it("detects a forbidden entry in a workspace package's optionalDependencies", () => {
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      optionalDependencies: { "@oscharko-dev/ti-native": "^1.0.0" },
    });
    const hits = checkWorkspaceManifestForbidden(join(root, "packages"));
    expect(hits.length).toBe(1);
    expect(hits[0]).toMatchObject({
      section: "optionalDependencies",
      name: "@oscharko-dev/ti-native",
    });
  });

  it("returns an empty list when all workspace packages are clean (M2 fix)", () => {
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      dependencies: { ws: "^8.0.0" },
    });
    expect(checkWorkspaceManifestForbidden(join(root, "packages"))).toEqual([]);
  });

  it("returns an empty list when the packages dir does not exist", () => {
    expect(checkWorkspaceManifestForbidden(join(root, "packages"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkLifecycleHooks (M3, M5 gaps filled: preinstall, install, root hook, clean path)
// ---------------------------------------------------------------------------

describe("checkLifecycleHooks", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("detects a postinstall hook in a workspace manifest", () => {
    writeJson(root, "package.json", { name: "synthetic-root", version: "0.0.0" });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      scripts: { postinstall: "node ./bad.js" },
    });
    const hits = checkLifecycleHooks(join(root, "package.json"), join(root, "packages"));
    expect(hits).toEqual([{ package: "keiko-contracts", hook: "postinstall" }]);
  });

  it("detects a preinstall hook in a workspace manifest (M5 fix)", () => {
    writeJson(root, "package.json", { name: "synthetic-root", version: "0.0.0" });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      scripts: { preinstall: "node ./pre.js" },
    });
    const hits = checkLifecycleHooks(join(root, "package.json"), join(root, "packages"));
    expect(hits).toEqual([{ package: "keiko-contracts", hook: "preinstall" }]);
  });

  it("detects an install hook in a workspace manifest (M5 fix)", () => {
    writeJson(root, "package.json", { name: "synthetic-root", version: "0.0.0" });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      scripts: { install: "node ./inst.js" },
    });
    const hits = checkLifecycleHooks(join(root, "package.json"), join(root, "packages"));
    expect(hits).toEqual([{ package: "keiko-contracts", hook: "install" }]);
  });

  it("detects a lifecycle hook declared in the root manifest itself (M3 fix)", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      scripts: { postinstall: "echo hi from root" },
    });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
    });
    const hits = checkLifecycleHooks(join(root, "package.json"), join(root, "packages"));
    expect(hits).toEqual([{ package: "<root>", hook: "postinstall" }]);
  });

  it("returns an empty list when no hooks are present (M3 fix — happy path)", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      scripts: { build: "node build.js" },
    });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      scripts: { build: "tsc" },
    });
    const hits = checkLifecycleHooks(join(root, "package.json"), join(root, "packages"));
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkTelemetryStrings (M4 gaps filled: all needles + clean path)
// ---------------------------------------------------------------------------

describe("checkTelemetryStrings", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("detects @sentry/node in a workspace manifest", () => {
    writeJson(root, "package.json", { name: "synthetic-root", version: "0.0.0" });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      dependencies: { "@sentry/node": "^7.0.0" },
    });
    const hits = checkTelemetryStrings(join(root, "package.json"), join(root, "packages"));
    expect(hits.length).toBe(1);
    expect(hits[0]?.needle).toBe("@sentry/");
  });

  it("detects @opentelemetry/* in a workspace manifest (M4 fix)", () => {
    writeJson(root, "package.json", { name: "synthetic-root", version: "0.0.0" });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      dependencies: { "@opentelemetry/api": "^1.0.0" },
    });
    const hits = checkTelemetryStrings(join(root, "package.json"), join(root, "packages"));
    expect(hits.some((h) => h.needle === "@opentelemetry/")).toBe(true);
  });

  it("detects posthog in a workspace manifest (M4 fix)", () => {
    writeJson(root, "package.json", { name: "synthetic-root", version: "0.0.0" });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      dependencies: { "posthog-node": "^2.0.0" },
    });
    const hits = checkTelemetryStrings(join(root, "package.json"), join(root, "packages"));
    expect(hits.some((h) => h.needle === "posthog")).toBe(true);
  });

  it("detects mixpanel in a workspace manifest (M4 fix)", () => {
    writeJson(root, "package.json", { name: "synthetic-root", version: "0.0.0" });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      dependencies: { mixpanel: "^2.0.0" },
    });
    const hits = checkTelemetryStrings(join(root, "package.json"), join(root, "packages"));
    expect(hits.some((h) => h.needle === "mixpanel")).toBe(true);
  });

  it("detects a dep whose name contains 'analytics' in a workspace manifest (M4 fix)", () => {
    writeJson(root, "package.json", { name: "synthetic-root", version: "0.0.0" });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      dependencies: { "analytics-node": "^4.0.0" },
    });
    const hits = checkTelemetryStrings(join(root, "package.json"), join(root, "packages"));
    expect(hits.some((h) => h.needle === "analytics")).toBe(true);
  });

  it("detects @sentry/* in the root manifest as well", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: { "@sentry/browser": "^7.0.0" },
    });
    const hits = checkTelemetryStrings(join(root, "package.json"), join(root, "packages"));
    expect(hits.some((h) => h.needle === "@sentry/" && h.package === "<root>")).toBe(true);
  });

  it("detects telemetry in optionalDependencies (new SCANNED_DEPENDENCY_SECTIONS coverage)", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      optionalDependencies: { "posthog-js": "^1.0.0" },
    });
    const hits = checkTelemetryStrings(join(root, "package.json"), join(root, "packages"));
    expect(hits.some((h) => h.needle === "posthog" && h.section === "optionalDependencies")).toBe(
      true,
    );
  });

  it("returns an empty list when no telemetry strings are present (M4 fix — happy path)", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: { ws: "^8.0.0" },
    });
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      dependencies: { "some-safe-dep": "^1.0.0" },
    });
    const hits = checkTelemetryStrings(join(root, "package.json"), join(root, "packages"));
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// end-to-end main() via subprocess — pass case
// ---------------------------------------------------------------------------

describe("end-to-end main() via subprocess — pass case", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
    minimalCleanRoot(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("exits 0 on a clean synthetic repo", () => {
    const result = runScript(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/qi-supply-chain check passed/);
  });
});

// ---------------------------------------------------------------------------
// end-to-end main() via subprocess — fail cases
// Each test crafts a fixture that trips ONLY the target check; the stderr pattern
// is specific enough to confirm WHICH check fired (M1 fix).
// ---------------------------------------------------------------------------

describe("end-to-end main() via subprocess — fail cases", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
    minimalCleanRoot(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("exits 1 when a workspace manifest imports test-intelligence", () => {
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      dependencies: { "@oscharko-dev/test-intelligence": "*" },
    });
    const result = runScript(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/test-intelligence/);
  });

  it("exits 1 on a postinstall hook", () => {
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      scripts: { postinstall: "echo hi" },
    });
    const result = runScript(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/postinstall/);
  });

  it("exits 1 on a telemetry dependency", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: { ws: "^8.0.0", "@sentry/node": "^7.0.0" },
    });
    const result = runScript(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/sentry|telemetry/);
  });

  it("exits 1 on a matrix mismatch (denied row present) — specific stderr confirms which check fired (M1 fix)", () => {
    // Use a non-telemetry denied package so only the matrix check fires, not the telemetry check.
    // The matrix fixture includes bad-pkg as denied; root manifest declares it.
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: { ws: "^8.0.0", "bad-pkg": "^1.0.0" },
    });
    writeFile(
      root,
      MATRIX_PATH,
      [
        "| package | ns | role | decision | license |",
        "| --- | --- | --- | --- | --- |",
        "| ws | top | transport | approved-runtime | MIT |",
        "| eslint | top | linter | approved-dev | MIT |",
        "| bad-pkg | top | n/a | denied | n/a |",
        "| @oscharko-dev/test-intelligence | @oscharko-dev | denied | denied | n/a |",
        "| @oscharko-dev/ti-* | @oscharko-dev | denied | denied | n/a |",
        "| @sentry/* | @sentry | telemetry | denied | n/a |",
      ].join("\n"),
    );
    const result = runScript(root);
    expect(result.status).toBe(1);
    // "denied but a manifest declares" is the reportMatrixMismatch marker for denied-present
    expect(result.stderr).toMatch(/denied but a manifest declares/);
  });

  it("exits 1 on a missing license in an approved row (new check 8)", () => {
    // Override the matrix with an approved-runtime row that has no license.
    // The root manifest only has ws so the completeness check passes; only the license check fires.
    writeFile(
      root,
      MATRIX_PATH,
      [
        "| package | ns | role | decision | license |",
        "| --- | --- | --- | --- | --- |",
        "| ws | top | transport | approved-runtime |  |",
        "| eslint | top | linter | approved-dev | MIT |",
        "| @oscharko-dev/test-intelligence | @oscharko-dev | denied | denied | n/a |",
        "| @oscharko-dev/ti-* | @oscharko-dev | denied | denied | n/a |",
        "| @sentry/* | @sentry | telemetry | denied | n/a |",
      ].join("\n"),
    );
    const result = runScript(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/declares no license/);
  });

  it("exits 1 on an unapproved runtime dependency (new check 7 / completeness)", () => {
    // Add pdfjs-dist to root dependencies but give it no approved-runtime matrix row.
    // The existing matrix rows keep all other checks green.
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      private: true,
      dependencies: { ws: "^8.0.0", "pdfjs-dist": "^4.0.0" },
      devDependencies: { eslint: "^10.0.0", vitest: "^4.0.0", prettier: "^3.0.0" },
      bundleDependencies: ["@oscharko-dev/keiko-contracts"],
    });
    const result = runScript(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unapproved runtime dependency/);
  });
});

// ---------------------------------------------------------------------------
// end-to-end main() via subprocess — defer-to-decision fail case (isolated)
// ---------------------------------------------------------------------------

describe("end-to-end main() via subprocess — defer-to-decision fail case", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
    minimalCleanRoot(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("exits 1 when a manifest declares a defer-to-decision package, with specific stderr marker", () => {
    // pending-lib is deferred. Root manifest declares it in dependencies.
    // The matrix also has ws as approved-runtime so the consistency check passes for ws,
    // and no telemetry or forbidden-import violations exist. Only the deferred check fires.
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      private: true,
      dependencies: { ws: "^8.0.0", "pending-lib": "^1.0.0" },
      devDependencies: { eslint: "^10.0.0" },
      bundleDependencies: ["@oscharko-dev/keiko-contracts"],
    });
    writeFile(
      root,
      MATRIX_PATH,
      [
        "| package | ns | role | decision | license |",
        "| --- | --- | --- | --- | --- |",
        "| ws | top | transport | approved-runtime | MIT |",
        "| eslint | top | linter | approved-dev | MIT |",
        "| pending-lib | top | tbd | defer-to-decision | |",
        "| @oscharko-dev/test-intelligence | @oscharko-dev | denied | denied | n/a |",
        "| @oscharko-dev/ti-* | @oscharko-dev | denied | denied | n/a |",
        "| @sentry/* | @sentry | telemetry | denied | n/a |",
      ].join("\n"),
    );
    const result = runScript(root);
    expect(result.status).toBe(1);
    // "defer-to-decision (treated as denied" is the exact reportMatrixMismatch marker
    expect(result.stderr).toMatch(/defer-to-decision \(treated as denied/);
  });
});

// ---------------------------------------------------------------------------
// end-to-end main() via subprocess — dynamic evasion fail case
// ---------------------------------------------------------------------------

describe("end-to-end main() via subprocess — dynamic evasion fail case", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
    minimalCleanRoot(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("exits 1 when a source file dynamically assembles a forbidden package name", () => {
    writeFile(
      root,
      "packages/keiko-contracts/src/sneaky.ts",
      'const n = "test-intelligence";\nexport const m = import(`@oscharko-dev/${n}`);\n',
    );
    const result = runScript(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/dynamic @oscharko-dev|forbidden import/);
  });
});
