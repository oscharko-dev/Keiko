import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isWithinPath, runEditorDocLinkCheck } from "../check-editor-doc-links.mjs";

let parent;

function makeSandbox() {
  parent = mkdtempSync(join(tmpdir(), "editor-doc-links-"));
  const repoRoot = join(parent, "repo");
  const outsideRoot = join(parent, "outside");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(outsideRoot, { recursive: true });
  return { repoRoot, outsideRoot };
}

function write(root, relativePath, content) {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  return absolute;
}

function check(options) {
  return runEditorDocLinkCheck({
    log: () => undefined,
    error: () => undefined,
    ...options,
  });
}

describe("check-editor-doc-links", () => {
  afterEach(() => {
    if (parent) {
      rmSync(parent, { recursive: true, force: true });
      parent = undefined;
    }
  });

  it("accepts in-repository relative links and anchors", () => {
    const { repoRoot } = makeSandbox();
    write(
      repoRoot,
      "packages/keiko-editor/README.md",
      "# Package\n\n[Runbook](../../docs/keiko-editor/runbook.md#operations)\n",
    );
    write(repoRoot, "docs/keiko-editor/runbook.md", "# Runbook\n\n## Operations\n");

    expect(check({ repoRoot, files: ["packages/keiko-editor/README.md"] })).toMatchObject({
      ok: true,
      failures: [],
      fileCount: 1,
    });
  });

  it("rejects relative links that escape the repository", () => {
    const { repoRoot, outsideRoot } = makeSandbox();
    write(outsideRoot, "secret.md", "# Outside\n");
    write(
      repoRoot,
      "docs/keiko-editor/runbook.md",
      "# Runbook\n\n[outside](../../../outside/secret.md)\n",
    );

    const result = check({ repoRoot, files: ["docs/keiko-editor/runbook.md"] });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([expect.stringContaining("target path escapes repository")]);
  });

  it("rejects repository-local symlinks whose real target escapes", () => {
    const { repoRoot, outsideRoot } = makeSandbox();
    const outsideFile = write(outsideRoot, "secret.md", "# Outside\n");
    symlinkSync(outsideFile, join(repoRoot, "docs-outside.md"));
    write(
      repoRoot,
      "packages/keiko-editor/README.md",
      "# Package\n\n[outside](../../docs-outside.md)\n",
    );

    const result = check({ repoRoot, files: ["packages/keiko-editor/README.md"] });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      expect.stringContaining("target realpath escapes repository"),
    ]);
  });
});

describe("isWithinPath", () => {
  it("treats sibling prefixes as outside the root", () => {
    expect(isWithinPath("/tmp/repo", "/tmp/repo/docs/a.md")).toBe(true);
    expect(isWithinPath("/tmp/repo", "/tmp/repo-outside/a.md")).toBe(false);
  });
});
