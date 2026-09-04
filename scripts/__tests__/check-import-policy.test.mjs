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
  }, 60_000);

  it("allows provider SDK imports inside keiko-model-gateway", async () => {
    root = makeRoot("import-policy-");
    writeText(
      root,
      "packages/keiko-model-gateway/src/openai-adapter.ts",
      'import OpenAI from "openai";\nexport const provider = OpenAI;\n',
    );

    await expect(checkArchitectureImportPolicy(root)).resolves.toEqual([]);
  });

  it("allows only the reviewed Local Knowledge ANN worker boundary", async () => {
    root = makeRoot("import-policy-");
    writeText(
      root,
      "packages/keiko-local-knowledge/src/retrieval/usearch-ann-index.ts",
      'import { Worker } from "node:worker_threads";\nexport const worker = Worker;\n',
    );
    writeText(
      root,
      "packages/keiko-local-knowledge/src/retrieval/usearch-index-worker.ts",
      'import { workerData } from "node:worker_threads";\nexport const data = workerData;\n',
    );
    await expect(checkArchitectureImportPolicy(root)).resolves.toEqual([]);

    writeText(
      root,
      "packages/keiko-local-knowledge/src/retrieval/second-worker.ts",
      'import { Worker } from "node:worker_threads";\nexport const worker = Worker;\n',
    );
    const violations = await checkArchitectureImportPolicy(root);
    expect(violations).toMatchObject([{ rule: "adr-0019-trust-9-local-knowledge-no-egress" }]);
  });

  it("keeps Local Knowledge egress matching exact at module and package boundaries", async () => {
    root = makeRoot("import-policy-");
    const cases = [
      ["node:https", true],
      ["node:https/subpath", false],
      ["fetch", true],
      ["fetch/subpath", false],
      ["axios", true],
      ["axios/request", true],
      ["axios-extra", false],
      ["sharp", true],
      ["sharp/codec", true],
      ["sharpness", false],
    ];
    for (const [index, [specifier]] of cases.entries()) {
      const path = `packages/keiko-local-knowledge/src/case-${String(index)}.ts`;
      writeText(root, path, `import value from "${specifier}";\nexport default value;\n`);
    }

    const violations = await checkArchitectureImportPolicy(root);
    expect(violations.map((violation) => violation.specifier).sort()).toEqual(
      cases
        .filter(([, forbidden]) => forbidden)
        .map(([specifier]) => specifier)
        .sort(),
    );
  });

  it("rejects production import-specifier policy violations", async () => {
    root = makeRoot("import-policy-");
    writeText(root, "packages/keiko-tools/src/fs.ts", 'import { readFileSync } from "node:fs";\n');
    writeText(root, "packages/keiko-harness/src/patch.ts", 'const fs = require("fs/promises");\n');
    writeText(root, "src/workflows/provider.ts", 'await import("@anthropic-ai/sdk");\n');
    writeText(root, "packages/keiko-local-knowledge/src/egress.ts", "await fetch(url);\n");
    writeText(
      root,
      "packages/keiko-server/src/bypass.ts",
      'import { OpenAIChatAdapter } from "../../keiko-model-gateway/dist/openai-adapter.js";\n',
    );
    writeText(
      root,
      "packages/keiko-cli/src/bypass.ts",
      'const normalize = require("node_modules/@oscharko-dev/keiko-model-gateway/dist/normalize.js");\n',
    );

    const violations = await checkArchitectureImportPolicy(root);
    expect(violations.map((violation) => violation.rule).sort()).toEqual([
      "adr-0019-trust-1-provider-sdk-isolation",
      "adr-0019-trust-4-no-direct-fs-outside-workspace",
      "adr-0019-trust-5-patch-routes-through-tools",
      "adr-0019-trust-9-local-knowledge-no-egress",
      "adr-0112-provider-runtime-no-internal-bypass",
      "adr-0112-provider-runtime-no-internal-bypass",
    ]);
  });

  it("counts the import-policy negative fixtures by rule", async () => {
    const counts = countImportPolicyViolationsByRule(
      await checkArchitectureImportPolicy(REPO_ROOT, { mode: "fixtures" }),
    );

    expect(Object.fromEntries([...counts.entries()].sort())).toEqual({
      "adr-0165-raw-coordinate-owner": 1,
      "adr-0005-owned-root-authority-implementation-private": 1,
      "adr-0005-owned-root-containment-allowed-callers": 1,
      "adr-0005-owned-root-lookup-allowed-callers": 1,
      "adr-0005-owned-root-mint-allowed-callers": 1,
      "adr-0005-owned-root-preserve-allowed-callers": 1,
      "adr-0019-trust-1-provider-sdk-isolation": 1,
      "adr-0019-trust-4-no-direct-fs-outside-workspace": 1,
      "adr-0019-trust-5-patch-routes-through-tools": 1,
      "adr-0019-trust-9-local-knowledge-no-egress": 1,
      "adr-0112-provider-runtime-no-internal-bypass": 3,
      "adr-0128-connectors-no-direct-egress": 1,
      "gen-arch-coding-runtime-restricted-egress": 1,
      "gen-perf-cli-001-cli-heavy-graphs-load-lazily": 1,
    });
  });
});
