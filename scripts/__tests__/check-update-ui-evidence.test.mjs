import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { compileFunction } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import {
  UPDATE_UI_HARNESS_PATHS,
  UPDATE_UI_SOURCE_PATHS,
  checkUpdateUiEvidence,
  measureUpdateUiEvidenceInputs,
} from "../check-update-ui-evidence.mjs";

const roots = [];
const repoRoot = resolve(import.meta.dirname, "../..");

/** Execute the browser producer's real helpers without collecting its Playwright journeys. */
function browserProducedHarnessHashes() {
  const path = join(repoRoot, "tests/e2e/update-ui-1696.spec.ts");
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const helpers = ["sourceSha256", "harnessProvenanceHashes"].map((name) => {
    const declaration = source.statements.find(
      (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    );
    if (declaration === undefined) throw new Error(`Missing browser evidence helper ${name}`);
    return declaration.getText(source);
  });
  const emitted = ts.transpileModule(`${helpers.join("\n")}\nreturn harnessProvenanceHashes();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const produce = compileFunction(emitted, ["createHash", "readFileSync", "resolve", "REPO_ROOT"]);
  return produce(createHash, readFileSync, resolve, repoRoot);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function write(root, path, value) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value, "utf8");
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "keiko-update-ui-evidence-"));
  roots.push(root);
  for (const path of [...UPDATE_UI_SOURCE_PATHS, ...UPDATE_UI_HARNESS_PATHS]) {
    write(root, path, `${path}\n`);
  }
  const measured = measureUpdateUiEvidenceInputs(root);
  for (const name of [
    "manifest.json",
    "a11y-proof.json",
    "update-experience-fidelity-proof.json",
  ]) {
    write(root, `docs/design-system/evidence/3405/${name}`, `${JSON.stringify(measured)}\n`);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("updater UI evidence freshness", () => {
  it("binds the actual browser producer's complete harness hashes to the canonical checker", () => {
    expect(browserProducedHarnessHashes()).toEqual(
      measureUpdateUiEvidenceInputs(repoRoot).harnessProvenanceSha256,
    );
  });

  it.each([
    "scripts/lib/d12-baseline.mjs",
    "scripts/lib/workspace-storage-fixture.mjs",
    "scripts/lib/workspace-storage-fixture.d.mts",
    "tests/e2e/support/workspace-storage.ts",
    "packages/keiko-ui/src/app/components/desktop/hooks/workspace-storage.ts",
  ])("rejects drift in shared workspace fixture provenance %s", (path) => {
    const root = fixtureRoot();
    write(root, path, "changed workspace storage fixture\n");
    expect(() => checkUpdateUiEvidence(root)).toThrow(
      `stale harnessProvenanceSha256 digest for ${path}`,
    );
  });

  it("accepts records bound to every declared source and harness input", () => {
    expect(() => checkUpdateUiEvidence(fixtureRoot())).not.toThrow();
  });

  it("rejects source drift in every evidence record", () => {
    const root = fixtureRoot();
    const changedPath = UPDATE_UI_SOURCE_PATHS[0];
    write(root, changedPath, "changed\n");

    expect(() => checkUpdateUiEvidence(root)).toThrow(
      `stale sourceFiles digest for ${changedPath}`,
    );
  });

  it.each([
    "packages/keiko-ui/src/app/components/desktop/update/UpdateStartupNoticeContent.tsx",
    "packages/keiko-ui/src/lib/i18n-messages.optional.en.ts",
    "packages/keiko-ui/src/lib/i18n-messages.optional.de.ts",
    "packages/keiko-ui/src/lib/optional-widget-i18n.ts",
  ])("rejects drift in the lazy updater translation owner %s", (path) => {
    const root = fixtureRoot();
    write(root, path, "changed lazy update presentation\n");
    expect(() => checkUpdateUiEvidence(root)).toThrow(`stale sourceFiles digest for ${path}`);
  });

  it("rejects a narrowed or expanded digest path set", () => {
    const root = fixtureRoot();
    const measured = measureUpdateUiEvidenceInputs(root);
    write(
      root,
      "docs/design-system/evidence/3405/manifest.json",
      `${JSON.stringify({ ...measured, sourceFiles: [{ path: "omitted", sha256: sha256("omitted") }] })}\n`,
    );

    expect(() => checkUpdateUiEvidence(root)).toThrow("unexpected sourceFiles path set");
  });
});

it("rejects duplicate source rows and extra metadata fields", () => {
  const root = fixtureRoot();
  const measured = measureUpdateUiEvidenceInputs(root);
  const path = "docs/design-system/evidence/3405/manifest.json";
  write(
    root,
    path,
    JSON.stringify({
      ...measured,
      sourceFiles: [...measured.sourceFiles, measured.sourceFiles[0]],
    }),
  );
  expect(() => checkUpdateUiEvidence(root)).toThrow("duplicate sourceFiles path");
  write(
    root,
    path,
    JSON.stringify({
      ...measured,
      sourceFiles: [
        { ...measured.sourceFiles[0], extra: "untrusted metadata" },
        ...measured.sourceFiles.slice(1),
      ],
    }),
  );
  expect(() => checkUpdateUiEvidence(root)).toThrow("invalid sourceFiles entry");
});
it("rejects the legacy source provenance representation", () => {
  const root = fixtureRoot();
  const measured = measureUpdateUiEvidenceInputs(root);
  write(
    root,
    "docs/design-system/evidence/3405/manifest.json",
    JSON.stringify({ ...measured, sourceProvenanceVersion: 1 }),
  );
  expect(() => checkUpdateUiEvidence(root)).toThrow("unsupported source provenance version");
});
