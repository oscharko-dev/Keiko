import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilePolicyPluginDirectory, policyPluginSources } from "../lib/code-quality-plugin.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), "keiko-policy-compiler-"));
  roots.push(path);
  return path;
}

it("rejects a source symlink before compiling or inventorying it", () => {
  const source = directory();
  const output = directory();
  const outside = directory();
  writeFileSync(join(outside, "source.ts"), "export const value = 1;");
  symlinkSync(join(outside, "source.ts"), join(source, "source.ts"));
  expect(() => policyPluginSources(source)).toThrow("unsafe-upstream-source");
  expect(() => compilePolicyPluginDirectory(source, output)).toThrow("unsafe-upstream-source");
});

it("rejects real malformed TypeScript with a valid compilation control", () => {
  const source = directory();
  const output = directory();
  writeFileSync(join(source, "source.ts"), "export const value: number = 1;");
  expect(() => compilePolicyPluginDirectory(source, output)).not.toThrow();
  writeFileSync(join(source, "source.ts"), "const = ;");
  expect(() => compilePolicyPluginDirectory(source, output)).toThrow("upstream-transpile-failed");
});
