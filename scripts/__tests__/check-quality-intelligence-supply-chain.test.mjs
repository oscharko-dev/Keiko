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
  checkRootManifestForbidden,
  checkTelemetryStrings,
  checkWorkspaceManifestForbidden,
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
      "| package | namespace | role | decision |",
      "| --- | --- | --- | --- |",
      "| ws | (top-level) | runtime | approved-runtime |",
      "| eslint | (top-level) | dev | approved-dev |",
      "| @oscharko-dev/test-intelligence | @oscharko-dev | denied | denied |",
      "| @oscharko-dev/ti-* | @oscharko-dev | denied | denied |",
      "| @sentry/* | @sentry | telemetry | denied |",
      "",
    ].join("\n"),
  );
}

function runScript(root, extraArgs = []) {
  return spawnSync(process.execPath, [SCRIPT, `--root=${root}`, ...extraArgs], {
    encoding: "utf8",
  });
}

// Each describe block owns its own root lifecycle so the top-level callback is short
// (max-lines-per-function = 50).

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
});

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
        "| package | ns | role | decision |",
        "| --- | --- | --- | --- |",
        "| ws | top | runtime | approved-runtime |",
        "| ghost-pkg | top | runtime | approved-runtime |",
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

  it("does not flag a clean source tree", () => {
    writeFile(root, "packages/keiko-contracts/src/clean.ts", "export const ok = true;\n");
    const files = listScannableSourceFiles(root);
    expect(findForbiddenImportHits(files)).toEqual([]);
  });
});

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

  it("returns an empty list on a clean root manifest", () => {
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: { ws: "^8.0.0" },
    });
    expect(checkRootManifestForbidden(join(root, "package.json"))).toEqual([]);
  });
});

describe("checkWorkspaceManifestForbidden", () => {
  let root;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("detects a forbidden entry in a workspace package", () => {
    writeJson(root, "packages/keiko-contracts/package.json", {
      name: "@oscharko-dev/keiko-contracts",
      version: "0.0.0",
      dependencies: { "@oscharko-dev/test-intelligence": "*" },
    });
    const hits = checkWorkspaceManifestForbidden(join(root, "packages"));
    expect(hits.length).toBe(1);
    expect(hits[0]?.name).toBe("@oscharko-dev/test-intelligence");
  });
});

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
});

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
});

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

  it("exits 1 on a matrix mismatch (denied row present in manifests)", () => {
    // @sentry/* is a denied row; @sentry/something present in the root manifest matches.
    // Either the telemetry gate or the matrix gate fires; both are valid evidence the
    // script caught the violation. We only assert non-zero exit and a non-empty stderr.
    writeJson(root, "package.json", {
      name: "synthetic-root",
      version: "0.0.0",
      dependencies: { ws: "^8.0.0", "@sentry/something": "^1.0.0" },
    });
    const result = runScript(root);
    expect(result.status).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
