import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  recordContinuityBuild,
  readContinuityBuildIdentity,
} from "../testing/coding-workbench-lab/chat-continuity-build.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function write(root, path, value) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
}
function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "keiko-continuity-build-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  write(root, ".gitignore", "node_modules/\npackages/*/dist/\n");
  write(root, "packages/example/src/index.ts", "export const value = 1;\n");
  write(
    root,
    "tsconfig.packages.json",
    JSON.stringify({ references: [{ path: "./packages/example/tsconfig.json" }] }),
  );
  write(root, "node_modules/@typescript/native/package.json", '{"version":"synthetic"}');
  commit(root);
  recordContinuityBuild(root, () =>
    write(root, "packages/example/dist/index.js", "export const value = 1;\n"),
  );
  return root;
}
function commit(root) {
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "Synthetic source",
  ]);
}
it("accepts a matching forced-build record using the named checkout", () => {
  const root = fixture();
  const identity = readContinuityBuildIdentity(root);
  expect(identity.sourceHead).toBe(git(root, ["rev-parse", "HEAD"]));
  expect(identity.distributionDigest).toBe(identity.buildProvenance.distributionDigest);
});
it("rejects dirty product source before qualifying stale output", () => {
  const root = fixture();
  write(root, "packages/example/src/index.ts", "export const value = 2;\n");
  expect(() => readContinuityBuildIdentity(root)).toThrow(
    "continuity-product-source-must-be-clean",
  );
});
it("rejects a stale provenance record after a committed source change", () => {
  const root = fixture();
  write(root, "packages/example/src/index.ts", "export const value = 2;\n");
  commit(root);
  expect(() => readContinuityBuildIdentity(root)).toThrow("continuity-build-provenance-stale");
});
it("rejects output that changed independently of the recorded build", () => {
  const root = fixture();
  write(root, "packages/example/dist/index.js", "export const value = 999;\n");
  expect(() => readContinuityBuildIdentity(root)).toThrow("continuity-build-provenance-stale");
});
