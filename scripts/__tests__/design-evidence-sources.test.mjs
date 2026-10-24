import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import paths from "../../docs/design-system/evidence/1300/source-inputs.json" with { type: "json" };
import { designEvidenceSourceHashes } from "../lib/design-evidence-sources.mjs";

it("pins every local static dependency of the shared evidence producers", () => {
  expect(new Set(paths).size).toBe(paths.length);
  for (const file of paths.filter((path) => path.endsWith(".mjs"))) {
    const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const node of ast.statements) {
      if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node))) continue;
      const module = node.moduleSpecifier?.text;
      if (module?.startsWith("."))
        expect(paths, file).toContain(relative(process.cwd(), resolve(dirname(file), module)));
    }
  }
});
it("invalidates evidence when a shared fixture input changes", () => {
  const root = mkdtempSync(resolve(tmpdir(), "keiko-source-evidence-"));
  try {
    for (const path of paths) {
      const file = resolve(root, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, path);
    }
    const before = designEvidenceSourceHashes(root);
    const fixture = "docs/design-system/evidence/1300/component-fixture-data.json";
    writeFileSync(resolve(root, fixture), "changed owned fixture");
    const after = designEvidenceSourceHashes(root);
    expect(after.filter((row, index) => row.sha256 !== before[index].sha256)).toEqual([
      { path: fixture, sha256: createHash("sha256").update("changed owned fixture").digest("hex") },
    ]);
    expect(after.map((row) => row.path)).toEqual(paths);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
