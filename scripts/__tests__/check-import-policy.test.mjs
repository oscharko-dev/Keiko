import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  checkArchitectureImportPolicy,
  countImportPolicyViolationsByRule,
} from "../check-import-policy.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function makeRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeText(root, relative, value) {
  const absolute = join(root, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, value, "utf8");
}

describe("checkArchitectureImportPolicy", () => {
  let root;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("passes on the live production source tree", async () => {
    await expect(checkArchitectureImportPolicy(REPO_ROOT)).resolves.toEqual([]);
  });

  it("allows provider SDK imports inside keiko-model-gateway", async () => {
    root = makeRoot("import-policy-");
    writeText(
      root,
      "packages/keiko-model-gateway/src/openai-adapter.ts",
      'import OpenAI from "openai";\nexport const provider = OpenAI;\n',
    );

    await expect(checkArchitectureImportPolicy(root)).resolves.toEqual([]);
  });

  it("rejects production import-specifier policy violations", async () => {
    root = makeRoot("import-policy-");
    writeText(root, "packages/keiko-tools/src/fs.ts", 'import { readFileSync } from "node:fs";\n');
    writeText(root, "packages/keiko-harness/src/patch.ts", 'const fs = require("fs/promises");\n');
    writeText(root, "src/workflows/provider.ts", 'await import("@anthropic-ai/sdk");\n');

    const violations = await checkArchitectureImportPolicy(root);
    expect(violations.map((violation) => violation.rule).sort()).toEqual([
      "adr-0019-trust-1-provider-sdk-isolation",
      "adr-0019-trust-4-no-direct-fs-outside-workspace",
      "adr-0019-trust-5-patch-routes-through-tools",
    ]);
  });

  it("counts the import-policy negative fixtures by rule", async () => {
    const counts = countImportPolicyViolationsByRule(
      await checkArchitectureImportPolicy(REPO_ROOT, { mode: "fixtures" }),
    );

    expect(Object.fromEntries([...counts.entries()].sort())).toEqual({
      "adr-0019-trust-1-provider-sdk-isolation": 1,
      "adr-0019-trust-4-no-direct-fs-outside-workspace": 1,
      "adr-0019-trust-5-patch-routes-through-tools": 1,
    });
  });
});
