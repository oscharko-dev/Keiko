import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  UPDATE_UI_HARNESS_PATHS,
  UPDATE_UI_SOURCE_PATHS,
  checkUpdateUiEvidence,
  measureUpdateUiEvidenceInputs,
} from "../check-update-ui-evidence.mjs";

const roots = [];

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
  it("accepts records bound to every declared source and harness input", () => {
    expect(() => checkUpdateUiEvidence(fixtureRoot())).not.toThrow();
  });

  it("rejects source drift in every evidence record", () => {
    const root = fixtureRoot();
    const changedPath = UPDATE_UI_SOURCE_PATHS[0];
    write(root, changedPath, "changed\n");

    expect(() => checkUpdateUiEvidence(root)).toThrow(
      `stale sourceSha256 digest for ${changedPath}`,
    );
  });

  it("rejects a narrowed or expanded digest path set", () => {
    const root = fixtureRoot();
    const measured = measureUpdateUiEvidenceInputs(root);
    write(
      root,
      "docs/design-system/evidence/3405/manifest.json",
      `${JSON.stringify({ ...measured, sourceSha256: { omitted: sha256("omitted") } })}\n`,
    );

    expect(() => checkUpdateUiEvidence(root)).toThrow("unexpected sourceSha256 path set");
  });
});
