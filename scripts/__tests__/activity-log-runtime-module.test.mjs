import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, URL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import * as registered from "../../packages/keiko-contracts/dist/activity-log-registry.generated.js";
import {
  generateOpCatalog,
  runtimeOperationsModule,
  runtimeRegistryModule,
} from "../generate-op-catalog.mjs";

const catalog = JSON.parse(
  readFileSync(
    new URL("../../docs/observability/op-catalog.generated.json", import.meta.url),
    "utf8",
  ),
);
const inventory = JSON.parse(
  readFileSync(
    new URL("../../docs/observability/failure-surface-inventory.generated.json", import.meta.url),
    "utf8",
  ),
);

function transpileGenerated(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function withGeneratedRuntime(check) {
  const root = mkdtempSync(join(tmpdir(), "activity-log-runtime-module-"));
  try {
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    writeFileSync(
      join(root, "activity-log-operations.generated.js"),
      transpileGenerated(runtimeOperationsModule(catalog.typedRegistry)),
    );
    const identityPath = join(root, "activity-log-registry.generated.js");
    writeFileSync(
      identityPath,
      transpileGenerated(runtimeRegistryModule(catalog.typedRegistry, inventory)),
    );
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "const identity = await import(process.argv[1]); const operations = await import(process.argv[2]); process.stdout.write(JSON.stringify({identity, sameArray: identity.ACTIVITY_LOG_OPERATION_REGISTRY === operations.ACTIVITY_LOG_OPERATION_REGISTRY}));",
        pathToFileURL(identityPath).href,
        pathToFileURL(join(root, "activity-log-operations.generated.js")).href,
      ],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    expect(result.status, result.stderr).toBe(0);
    check(JSON.parse(result.stdout));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("generated Activity Log runtime module ownership", () => {
  it("keeps the full operation array out of the shared identity module", () => {
    const source = runtimeRegistryModule(catalog.typedRegistry, inventory);
    expect(source.includes("export const ACTIVITY_LOG_OPERATION_REGISTRY =")).toBe(false);
    expect(source).toContain(
      'export { ACTIVITY_LOG_OPERATION_REGISTRY } from "./activity-log-operations.generated.js";',
    );
    expect(source).toContain(catalog.typedRegistry.schemaDigest);
    expect(source).toContain(catalog.typedRegistry.catalogDigest);
  });

  it("preserves public registry values and reexports the exact internal operation array", () => {
    withGeneratedRuntime(({ identity, sameArray }) => {
      expect(sameArray).toBe(true);
      expect(identity.ACTIVITY_LOG_OPERATION_REGISTRY).toEqual(
        registered.ACTIVITY_LOG_OPERATION_REGISTRY,
      );
      for (const name of [
        "ACTIVITY_LOG_REGISTRY_VERSION",
        "ACTIVITY_LOG_SCHEMA_DIGEST",
        "ACTIVITY_LOG_CATALOG_DIGEST",
        "ACTIVITY_LOG_FAILURE_SURFACES",
        "ACTIVITY_LOG_FAILURE_CLASS_COVERAGE",
        "ACTIVITY_LOG_OPERATION_SURFACES",
      ]) {
        expect(identity[name]).toEqual(registered[name]);
      }
    });
  });

  it("does not rediscover the generated operation list as new emitter sites", () => {
    const root = mkdtempSync(join(tmpdir(), "activity-log-generated-discovery-"));
    try {
      const sourceRoot = join(root, "packages", "keiko-contracts", "src");
      mkdirSync(sourceRoot, { recursive: true });
      const source = `${runtimeOperationsModule(catalog.typedRegistry)}\nlog.info({ category: "gateway", op: "fixture.generated" });\n`;
      writeFileSync(join(sourceRoot, "activity-log-operations.generated.ts"), source);
      expect(generateOpCatalog(root).entries).toEqual([]);
      writeFileSync(join(sourceRoot, "fixture.ts"), source);
      expect(generateOpCatalog(root).entries.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
