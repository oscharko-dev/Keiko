import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkArchitectureImportPolicy } from "../check-import-policy.mjs";

const roots = [];
function source(path, text) {
  const root = mkdtempSync(join(tmpdir(), "raw-coordinate-policy-"));
  roots.push(root);
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("ADR-0165 governed coding-search coordinate boundary", () => {
  it("accepts empty source without claiming executable coverage", async () => {
    const root = source("packages/keiko-server/src/coding-runtime/empty.ts", "");
    await expect(checkArchitectureImportPolicy(root)).resolves.toEqual([]);
  });
  it("retains the lane denial in syntactically malformed source", async () => {
    const root = source(
      "packages/keiko-server/src/coding-runtime/malformed.ts",
      'const broken = { contentLane: "editor";',
    );
    const violations = await checkArchitectureImportPolicy(root);
    expect(violations.map((item) => item.rule)).toContain("adr-0165-raw-coordinate-owner");
  });
  it.each([
    'const deps = { contentLane: "editor" };',
    'const deps = { ["contentLane"]: lane };',
    "deps.contentLane = lane;",
    'deps["contentLane"] = "editor";',
    'const contentLane = "editor"; const deps = { contentLane };',
  ])("rejects a coding handler bypass through the public search barrel: %s", async (text) => {
    const root = source("packages/keiko-server/src/coding-runtime/repositorySearch.ts", text);
    const violations = await checkArchitectureImportPolicy(root);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((item) => item.rule === "adr-0165-raw-coordinate-owner")).toBe(true);
  });

  it.each([
    "packages/keiko-workspace/src/repoSearch.ts",
    "packages/keiko-workspace/src/codingSearch.ts",
    "packages/keiko-server/src/editor/workspaceSearchRoutes.ts",
  ])("allows the workspace coordinate owner and existing Editor surface: %s", async (path) => {
    const root = source(path, 'const deps = { contentLane: "editor" };');
    await expect(checkArchitectureImportPolicy(root)).resolves.toEqual([]);
  });

  it("does not grant a blanket server Editor exemption to lane selection", async () => {
    const root = source(
      "packages/keiko-server/src/editor/newEvidenceRoute.ts",
      '({ contentLane: "editor" });',
    );
    expect(await checkArchitectureImportPolicy(root)).toHaveLength(1);
  });

  it("does not flag comments or unrelated string contents", async () => {
    const root = source(
      "packages/keiko-server/src/example.ts",
      '// contentLane\nconst note = "contentLane is private";',
    );
    await expect(checkArchitectureImportPolicy(root)).resolves.toEqual([]);
  });
});
