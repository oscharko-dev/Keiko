// Regression pin for issue #2670 (AC6: persisted index artifacts remain redacted/encrypted).
// The code-intelligence index used to write a plaintext JSON projection of the workspace to
// `<workspace-root>/.keiko/code-intelligence/<sha256>.json`, carrying the absolute workspace root,
// the scanned path list, every symbol and DTO field name, every call/reference edge, and every API
// endpoint in cleartext — the one persisted index escaping both the sealed-at-rest posture of
// `workspaceIndex.ts` and the local-state auditor. The on-disk tier is gone; the in-process LRU is
// the only cache. These tests fail the moment any `.keiko` artifact carries index content again.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCodeIntelligenceIndex } from "./codeIntelligence.js";
import { nodeWorkspaceFs } from "./fs.js";
import { DEFAULT_SEARCH_LIMITS, type SearchScope } from "./repoSearch.js";
import type { WorkspaceInfo } from "./types.js";

// Reconstructive strings the artifact used to leak verbatim: a DTO field name, a function name, and
// the source path they live in.
const SECRET_FIELD = "socialSecurityNumber";
const SECRET_SYMBOL = "chargePatientCard";
const SECRET_PATH = "src/billing.ts";
const STALE_ARTIFACT = join(".keiko", "code-intelligence", "stale.json");

const BILLING_SOURCE = [
  "export interface PatientRecord {",
  `  ${SECRET_FIELD}: string;`,
  "}",
  "",
  `export function ${SECRET_SYMBOL}(record: PatientRecord, amountCents: number): string {`,
  `  return \`\${record.${SECRET_FIELD}}:\${String(amountCents)}\`;`,
  "}",
].join("\n");

function scopeFor(root: string): SearchScope {
  const workspace: WorkspaceInfo = {
    root,
    name: "billing-demo",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: [],
    languages: ["typescript"],
    ignoreLines: [],
  };
  return { workspace, scopeId: "persistent-index", relativePaths: [] };
}

function collectFiles(dir: string, out: string[]): readonly string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(abs, out);
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

function localStateFiles(root: string): readonly string[] {
  const stateDir = join(root, ".keiko");
  const files = existsSync(stateDir) ? collectFiles(stateDir, []) : [];
  return files.map((path) => relative(root, path)).sort((a, b) => a.localeCompare(b));
}

// Reports, per local-state artifact, which reconstructive workspace strings it carries in cleartext.
function leakedTerms(root: string): readonly string[] {
  const terms = [SECRET_SYMBOL, SECRET_FIELD, SECRET_PATH, root];
  return localStateFiles(root).flatMap((relativePath) => {
    const text = readFileSync(join(root, relativePath), "utf8");
    return terms.filter((term) => text.includes(term)).map((term) => `${relativePath}: ${term}`);
  });
}

describe("code-intelligence index persistence", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "keiko-ci-persist-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "billing-demo" }), "utf8");
    writeFileSync(join(root, SECRET_PATH), BILLING_SOURCE, "utf8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("never writes workspace-derived index content into the local state tree", () => {
    const index = buildCodeIntelligenceIndex(
      scopeFor(root),
      DEFAULT_SEARCH_LIMITS,
      nodeWorkspaceFs,
    );

    expect(index.symbols.some((symbol) => symbol.name === SECRET_SYMBOL)).toBe(true);
    expect(leakedTerms(root)).toEqual([]);
    expect(localStateFiles(root)).toEqual([]);
  });

  it("serves a repeated build from the in-process cache without touching the local state tree", () => {
    const scope = scopeFor(root);
    const first = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, nodeWorkspaceFs);
    const second = buildCodeIntelligenceIndex(scope, DEFAULT_SEARCH_LIMITS, nodeWorkspaceFs);

    expect(second).toBe(first);
    expect(localStateFiles(root)).toEqual([]);
  });

  it("ignores a plaintext artifact left behind by an older version instead of reading or rewriting it", () => {
    mkdirSync(join(root, ".keiko", "code-intelligence"), { recursive: true });
    const stale = JSON.stringify({ schemaVersion: 13, fingerprint: "stale", index: {} });
    writeFileSync(join(root, STALE_ARTIFACT), stale, "utf8");

    const index = buildCodeIntelligenceIndex(
      scopeFor(root),
      DEFAULT_SEARCH_LIMITS,
      nodeWorkspaceFs,
    );

    expect(index.symbols.some((symbol) => symbol.name === SECRET_SYMBOL)).toBe(true);
    // The legacy artifact is user data: it is neither consulted nor rewritten, only left untouched.
    expect(readFileSync(join(root, STALE_ARTIFACT), "utf8")).toBe(stale);
    expect(localStateFiles(root)).toEqual([STALE_ARTIFACT]);
  });
});
