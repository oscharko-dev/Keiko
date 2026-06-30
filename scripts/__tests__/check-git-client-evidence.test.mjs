import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkGitClientEvidence } from "../check-git-client-evidence.mjs";

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfab780000000049454e44ae426082",
  "hex",
);

function mkdtempCompat(prefix) {
  const root = resolve(tmpdir(), `${prefix}${process.pid.toString()}-${Date.now().toString()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function write(root, relPath, contents) {
  const target = join(root, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

describe("checkGitClientEvidence", () => {
  let root;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("passes on the live repository Git client evidence set", () => {
    expect(checkGitClientEvidence()).toEqual([]);
  });

  it("fails closed when the issue 1578 manifest is absent", () => {
    root = mkdtempCompat("git-client-evidence-");
    write(root, "docs/git-delivery/git-client-desktop-reuse-contract.md", "# Contract\n");
    write(root, "docs/git-delivery/git-client-repository-api.md", "# API\n");
    write(
      root,
      "docs/git-delivery/epic-1571-closeout.md",
      "#1573 #1574 #1575 #1576 #1577 #1578 BFF CSRF credential agent operation MIT Qodana CodeQL\n",
    );

    const failures = checkGitClientEvidence(root);
    expect(failures).toContain(
      "missing Git client evidence manifest docs/git-delivery/evidence/1578/manifest.json",
    );
  });

  it("rejects temp paths and timestamps in manifests", () => {
    root = mkdtempCompat("git-client-evidence-");
    write(root, "docs/git-delivery/git-client-desktop-reuse-contract.md", "# Contract\n");
    write(root, "docs/git-delivery/git-client-repository-api.md", "# API\n");
    write(
      root,
      "docs/git-delivery/epic-1571-closeout.md",
      "#1573 #1574 #1575 #1576 #1577 #1578 BFF CSRF credential agent operation MIT Qodana CodeQL\n",
    );
    write(
      root,
      "docs/git-delivery/evidence/1575/manifest.json",
      JSON.stringify({
        issue: "#1575",
        epic: "#1571",
        evidencePath: "docs/git-delivery/evidence/1575",
        generatedAt: "2026-06-28T00:00:00Z",
        fixtureRoot: "/private/var/folders/example",
        routesIntercepted: [],
        artifacts: ["manifest.json", "git-changes-view.png"],
      }),
    );
    write(root, "docs/git-delivery/evidence/1575/git-changes-view.png", PNG_1X1);

    const failures = checkGitClientEvidence(root);
    expect(failures.some((failure) => failure.includes("forbidden evidence text"))).toBe(true);
  });
});
