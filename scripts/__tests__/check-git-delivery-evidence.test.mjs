import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkGitDeliveryEvidence } from "../check-git-delivery-evidence.mjs";

function tempRoot() {
  return mkdtempCompat("git-delivery-evidence-");
}

function mkdtempCompat(prefix) {
  const root = resolve(tmpdir(), `${prefix}${process.pid.toString()}-${Date.now().toString()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function write(root, relPath, contents) {
  const target = join(root, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

describe("checkGitDeliveryEvidence", () => {
  let root;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("passes on the live repository evidence set", () => {
    expect(checkGitDeliveryEvidence()).toEqual([]);
  });

  it("fails closed when the issue 479 evidence manifest is absent", () => {
    root = tempRoot();
    for (const doc of [
      "README.md",
      "verification-matrix.md",
      "operator-runbook.md",
      "policy-pack-guidance.md",
      "epic-470-closeout.md",
    ]) {
      write(root, `docs/git-delivery/${doc}`, "# Placeholder\n");
    }
    write(root, "docs/git-delivery/evidence/479/README.md", "# Placeholder\n");

    const failures = checkGitDeliveryEvidence(root);
    expect(failures).toContain(
      "missing evidence manifest docs/git-delivery/evidence/479/manifest.json",
    );
  });
});
