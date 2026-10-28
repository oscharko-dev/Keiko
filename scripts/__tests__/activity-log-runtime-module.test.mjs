import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  runtimeIdentityModule,
  runtimeMetadataModule,
  runtimeRegistryData,
  formatGeneratedJson,
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

function withGeneratedRuntime(check, typedRegistry = catalog.typedRegistry, inspection = "({})") {
  const root = mkdtempSync(join(tmpdir(), "activity-log-runtime-module-"));
  try {
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    writeFileSync(
      join(root, "activity-log-operations.generated.js"),
      transpileGenerated(runtimeOperationsModule(typedRegistry)),
    );
    copyFileSync(
      new URL(
        "../../packages/keiko-contracts/dist/activity-log-field-contracts.js",
        import.meta.url,
      ),
      join(root, "activity-log-field-contracts.js"),
    );
    const data = runtimeRegistryData(typedRegistry, inventory);
    writeFileSync(
      join(root, "activity-log-failure-class-coverage.generated.json"),
      JSON.stringify(data.failureClassCoverage),
    );
    writeFileSync(
      join(root, "activity-log-operation-surfaces.generated.json"),
      JSON.stringify(data.operationSurfaces),
    );
    writeFileSync(
      join(root, "activity-log-identity.generated.js"),
      transpileGenerated(runtimeIdentityModule(catalog.typedRegistry)),
    );
    writeFileSync(
      join(root, "activity-log-runtime-metadata.generated.js"),
      transpileGenerated(runtimeMetadataModule()),
    );
    const identityPath = join(root, "activity-log-registry.generated.js");
    writeFileSync(identityPath, transpileGenerated(runtimeRegistryModule()));
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const identity = await import(process.argv[1]); const operations = await import(process.argv[2]); const inspection = ${inspection}; process.stdout.write(JSON.stringify({identity, inspection, sameArray: identity.ACTIVITY_LOG_OPERATION_REGISTRY === operations.ACTIVITY_LOG_OPERATION_REGISTRY}));`,
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
  it("keeps both independently loadable metadata assets synchronized with the producer", async () => {
    const data = runtimeRegistryData(catalog.typedRegistry, inventory);
    for (const [name, value] of [
      ["activity-log-failure-class-coverage", data.failureClassCoverage],
      ["activity-log-operation-surfaces", data.operationSurfaces],
    ]) {
      const expected = await formatGeneratedJson(value);
      const actual = readFileSync(
        new URL("../../packages/keiko-contracts/src/" + name + ".generated.json", import.meta.url),
        "utf8",
      );
      expect(actual).toBe(expected);
    }
  });

  it("keeps the full operation array out of the shared identity module", () => {
    const source = runtimeRegistryModule(catalog.typedRegistry, inventory);
    expect(source.includes("export const ACTIVITY_LOG_OPERATION_REGISTRY =")).toBe(false);
    expect(source).toContain(
      'export { ACTIVITY_LOG_OPERATION_REGISTRY } from "./activity-log-operations.generated.js";',
    );
    expect(runtimeIdentityModule(catalog.typedRegistry)).toContain(
      catalog.typedRegistry.schemaDigest,
    );
    expect(runtimeIdentityModule(catalog.typedRegistry)).toContain(
      catalog.typedRegistry.catalogDigest,
    );
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

// #3918: execute emitted constructor expressions with the actual built leaf, preserving the
// original diagnosticWhen pin formerly observed by JSON.parse in op-catalog-drift.test.mjs.
describe("generated field construction preservation", () => {
  it("preserves complete operation values, recursive key order and conditional omission", () => {
    const expected = catalog.typedRegistry.operations.map(
      ({ registrationSite, emitterSites, ...operation }) => operation,
    );
    withGeneratedRuntime(({ identity }) => {
      // Derive the established runtime projection from the old checked-in catalog, independently
      // of constructor expansion; bookkeeping alone is excluded by the existing projection.
      const actual = identity.ACTIVITY_LOG_OPERATION_REGISTRY;
      expect(actual).toEqual(expected);
      for (const [index, operation] of actual.entries()) {
        const prior = expected[index];
        expect(operation.diagnosticWhen).toEqual(prior.diagnosticWhen);
        expect(Object.hasOwn(operation, "diagnosticWhen")).toBe(
          Object.hasOwn(prior, "diagnosticWhen"),
        );
        expect(operation.fields).toEqual(prior.fields);
        expect(Object.keys(operation.fields)).toEqual(Object.keys(prior.fields));
        for (const [name, descriptor] of Object.entries(operation.fields)) {
          expect(Object.keys(descriptor)).toEqual(Object.keys(prior.fields[name]));
        }
      }
    });
  });

  it("retains independent descriptor and enum occurrences with ordinary mutable properties", () => {
    withGeneratedRuntime(
      ({ inspection }) => {
        expect(inspection).toEqual({ independent: true, ordinary: true, isolated: true });
      },
      catalog.typedRegistry,
      `(() => {
      const fields = operations.ACTIVITY_LOG_OPERATION_REGISTRY.flatMap((operation) => Object.values(operation.fields));
      const enums = fields.filter((field) => Array.isArray(field.values));
      const independent = new Set(fields).size === fields.length && new Set(enums.map((field) => field.values)).size === enums.length;
      const ordinary = fields.every((field) => Object.getPrototypeOf(field) === Object.prototype && Reflect.ownKeys(field).every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(field, key);
        return descriptor.enumerable && descriptor.writable && descriptor.configurable;
      }));
      const before = JSON.stringify(enums.slice(1));
      enums[0].values.push("fixture-mutated");
      enums[0].required = !enums[0].required;
      return { independent, ordinary, isolated: JSON.stringify(enums.slice(1)) === before };
    })()`,
    );
  });

  it("preserves present and absent diagnosticWhen through the executed emitted module", () => {
    const base = catalog.typedRegistry.operations[0];
    const conditions = [
      { field: "outcome", values: ["failed"] },
      { field: "aborted", values: [true] },
      { field: "errorCount", positive: true },
    ];
    const fields = {
      outcome: {
        type: "string",
        dataClass: "closed-enum",
        required: true,
        values: ["ready", "failed"],
      },
      aborted: { type: "boolean", dataClass: "closed-enum", required: false },
      errorCount: { type: "integer", dataClass: "count", required: true },
    };
    const { diagnosticWhen, ...withoutConditions } = base;
    const operations = [
      { ...withoutConditions, fields, diagnosticWhen: conditions },
      { ...withoutConditions, fields },
    ];
    withGeneratedRuntime(
      ({ identity }) => {
        const [present, absent] = identity.ACTIVITY_LOG_OPERATION_REGISTRY;
        expect(present.diagnosticWhen).toEqual(conditions);
        expect(Object.hasOwn(absent, "diagnosticWhen")).toBe(false);
      },
      { ...catalog.typedRegistry, operations },
    );
  });
});

it("binds the staged built canonical helper to its actual current source", () => {
  const source = readFileSync(
    new URL("../../packages/keiko-contracts/src/activity-log-field-contracts.ts", import.meta.url),
    "utf8",
  );
  const built = readFileSync(
    new URL("../../packages/keiko-contracts/dist/activity-log-field-contracts.js", import.meta.url),
    "utf8",
  );
  expect(built.trim()).toBe(transpileGenerated(source).trim());
});

it("leaves unsupported descriptor keys, class combinations and ordering as exact literals", () => {
  const base = catalog.typedRegistry.operations[0];
  const fields = {
    reordered: { required: true, dataClass: "count", type: "integer" },
    bounded: { type: "integer", dataClass: "count", required: true, maxItems: 2 },
    numeric: { type: "number", dataClass: "duration", required: false },
    unusual: {
      type: "string",
      dataClass: "safe-platform-class",
      required: false,
      values: ["linux"],
    },
  };
  withGeneratedRuntime(
    ({ identity }) => {
      const actual = identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields;
      expect(actual).toEqual(fields);
      for (const [name, descriptor] of Object.entries(fields)) {
        expect(Object.keys(actual[name])).toEqual(Object.keys(descriptor));
      }
    },
    { ...catalog.typedRegistry, operations: [{ ...base, fields }] },
  );
});

it.each([{ values: ["404"] }, { values: ["provider:model"] }])(
  "constructs supported enum field vocabularies using their existing grammar: $values",
  ({ values }) => {
    const descriptor = { type: "string", dataClass: "closed-enum", required: true, values };
    const registry = {
      ...catalog.typedRegistry,
      operations: [{ ...catalog.typedRegistry.operations[0], fields: { outcome: descriptor } }],
    };
    expect(runtimeOperationsModule(registry)).toContain(
      `activityLogStringEnumField(true, ${JSON.stringify(values)})`,
    );
    withGeneratedRuntime(({ identity }) => {
      expect(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields.outcome).toEqual(descriptor);
    }, registry);
  },
);

describe("automatic catalog runtime field policy rendering", () => {
  it("renders the complete ordered pilot after its unchanged completeness and loss prefix", () => {
    const pilot = catalog.typedRegistry.operations.find(
      (operation) => operation.op === "gateway.catalog.automatic.completed",
    );
    const registry = { ...catalog.typedRegistry, operations: [pilot] };
    const source = runtimeOperationsModule(registry);
    expect(source).toContain(
      '"completeness": {"type":"string","dataClass":"completeness-state","required":true},"loss": {"type":"string","dataClass":"loss-state","required":true}, ...activityLogAutomaticCatalogFields()',
    );
    withGeneratedRuntime(({ identity }) => {
      expect(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields).toEqual(pilot.fields);
      expect(Object.keys(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields)).toEqual(
        Object.keys(pilot.fields),
      );
    }, registry);
  });

  it.each([
    "reordered",
    "missing",
    "extra",
    "descriptor",
    "descriptor-order",
    "vocabulary",
    "prefix",
    "other-operation",
  ])("retains literal field construction for a nonexact policy: %s", (mode) => {
    const pilot = catalog.typedRegistry.operations.find(
      (operation) => operation.op === "gateway.catalog.automatic.completed",
    );
    const fields = structuredClone(pilot.fields);
    if (mode === "reordered") {
      const first = fields.outcome;
      delete fields.outcome;
      fields.outcome = first;
    }
    if (mode === "missing") delete fields.phase;
    if (mode === "extra") fields.extraCount = fields.configuredModelCount;
    if (mode === "descriptor") fields.retryDeadlineMs.dataClass = "duration";
    if (mode === "descriptor-order") {
      const { required, ...descriptor } = fields.retryable;
      fields.retryable = { required, ...descriptor };
    }
    if (mode === "vocabulary") fields.outcome.values.reverse();
    if (mode === "prefix") fields.loss.required = false;
    const operation = { ...pilot, fields };
    if (mode === "other-operation") operation.op = "fixture.other.completed";
    const registry = { ...catalog.typedRegistry, operations: [operation] };
    expect(runtimeOperationsModule(registry)).not.toContain(
      "...activityLogAutomaticCatalogFields()",
    );
    withGeneratedRuntime(({ identity }) => {
      expect(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields).toEqual(fields);
      expect(Object.keys(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields)).toEqual(
        Object.keys(fields),
      );
    }, registry);
  });
});

it("does not fold a descriptor with an extra own undefined property into the factory", () => {
  const pilot = catalog.typedRegistry.operations.find(
    (operation) => operation.op === "gateway.catalog.automatic.completed",
  );
  const fields = structuredClone(pilot.fields);
  fields.retryable.extra = undefined;
  expect(Object.hasOwn(fields.retryable, "extra")).toBe(true);
  const registry = { ...catalog.typedRegistry, operations: [{ ...pilot, fields }] };
  expect(runtimeOperationsModule(registry)).not.toContain("...activityLogAutomaticCatalogFields()");
});
