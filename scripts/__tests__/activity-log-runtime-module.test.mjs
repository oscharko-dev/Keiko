import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
      // The checked-in catalog comes from the same generator and constructors, so this proves the
      // runtime module and the catalog agree, not that a constructor kept its values. The literal
      // descriptor pins in activity-log-field-contracts.test.ts cover that. Bookkeeping alone is
      // excluded by the existing projection.
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

  it("renders constructor runs and repeated larger field sets once without repeating them", () => {
    const source = runtimeOperationsModule(catalog.typedRegistry);
    const single = /"\w+": (activityLog(?:Count|Duration|Boolean)Field\((?:true|false)\))/gu;
    const calls = [...source.matchAll(single)];
    const repeated = calls.some(
      (call, index) =>
        index >= 2 &&
        call[1] === calls[index - 1]?.[1] &&
        call[1] === calls[index - 2]?.[1] &&
        source.slice(calls[index - 2].index, call.index).split(",").length === 3,
    );
    expect(repeated).toBe(false);
    expect(source).toContain("...activityLogCountFields(false, [");
    const factories = [...source.matchAll(/const (sharedOperationFields\d+) = \(\) =>/gu)];
    expect(factories.length).toBeGreaterThan(0);
    for (const [, name] of factories) {
      expect(source.split(`${name}()`).length - 1).toBeGreaterThan(1);
    }
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
      '"completeness": activityLogCompletenessField(),"loss": activityLogLossField(), ...activityLogAutomaticCatalogFields()',
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

describe("universal runtime descriptor rendering", () => {
  it.each([
    ["complete", "completeness-state", "activityLogCompletenessField"],
    ["lost", "loss-state", "activityLogLossField"],
  ])("uses only the exact ordered %s descriptor", (field, dataClass, constructor) => {
    const descriptor = { type: "string", dataClass, required: true };
    const registry = {
      ...catalog.typedRegistry,
      operations: [{ ...catalog.typedRegistry.operations[0], fields: { [field]: descriptor } }],
    };
    expect(runtimeOperationsModule(registry)).toContain('"' + field + '": ' + constructor + "()");
    withGeneratedRuntime(({ identity }) => {
      expect(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields[field]).toEqual(descriptor);
      expect(Object.keys(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields[field])).toEqual([
        "type",
        "dataClass",
        "required",
      ]);
    }, registry);
  });

  it.each(["completeness-state", "loss-state"])("keeps nonexact %s shapes literal", (dataClass) => {
    for (const descriptor of [
      { required: true, dataClass, type: "string" },
      { type: "string", dataClass, required: true, maxLength: 4 },
      { type: "string", dataClass, required: false },
    ]) {
      const registry = {
        ...catalog.typedRegistry,
        operations: [{ ...catalog.typedRegistry.operations[0], fields: { tested: descriptor } }],
      };
      expect(runtimeOperationsModule(registry)).not.toContain(
        '"tested": activityLogCompletenessField()',
      );
      expect(runtimeOperationsModule(registry)).not.toContain('"tested": activityLogLossField()');
      withGeneratedRuntime(({ identity }) => {
        expect(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields.tested).toEqual(descriptor);
        expect(Object.keys(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields.tested)).toEqual(
          Object.keys(descriptor),
        );
      }, registry);
    }
  });

  it.each(["completeness-state", "loss-state"])(
    "does not fold an extra own undefined property for %s",
    (dataClass) => {
      const descriptor = { type: "string", dataClass, required: true, extra: undefined };
      const registry = {
        ...catalog.typedRegistry,
        operations: [{ ...catalog.typedRegistry.operations[0], fields: { tested: descriptor } }],
      };
      expect(Object.hasOwn(descriptor, "extra")).toBe(true);
      expect(runtimeOperationsModule(registry)).not.toContain(
        '"tested": activityLogCompletenessField()',
      );
      expect(runtimeOperationsModule(registry)).not.toContain('"tested": activityLogLossField()');
    },
  );
});

describe("embedding retry runtime field policy rendering", () => {
  it.each(["embedding.batch.partial-progress", "embedding.batch.retry"])(
    "renders a fresh exact bundle for %s",
    (op) => {
      const operation = catalog.typedRegistry.operations.find((entry) => entry.op === op);
      const registry = { ...catalog.typedRegistry, operations: [operation] };
      expect(runtimeOperationsModule(registry)).toContain(
        "...activityLogEmbeddingBatchRetryFields()",
      );
      withGeneratedRuntime(({ identity }) => {
        expect(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields).toEqual(operation.fields);
        expect(Object.keys(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields)).toEqual(
          Object.keys(operation.fields),
        );
      }, registry);
    },
  );

  it.each([
    "reordered",
    "missing",
    "extra",
    "descriptor-order",
    "integer-delay",
    "vocabulary",
    "other-operation",
  ])("keeps nonexact retry policy literal: %s", (mode) => {
    const prior = catalog.typedRegistry.operations.find(
      (entry) => entry.op === "embedding.batch.retry",
    );
    const fields = structuredClone(prior.fields);
    if (mode === "reordered") {
      const value = fields.attempt;
      delete fields.attempt;
      fields.attempt = value;
    }
    if (mode === "missing") delete fields.completedCount;
    if (mode === "extra") fields.extraCount = fields.attempt;
    if (mode === "descriptor-order") {
      const { required, ...rest } = fields.delayMs;
      fields.delayMs = { required, ...rest };
    }
    if (mode === "integer-delay") fields.delayMs.type = "integer";
    if (mode === "vocabulary") fields.transport.values.push("scalar");
    const operation = { ...prior, fields };
    if (mode === "other-operation") operation.op = "embedding.chunk.retry";
    const registry = { ...catalog.typedRegistry, operations: [operation] };
    expect(runtimeOperationsModule(registry)).not.toContain(
      "...activityLogEmbeddingBatchRetryFields()",
    );
    withGeneratedRuntime(({ identity }) => {
      expect(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields).toEqual(fields);
      expect(Object.keys(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields)).toEqual(
        Object.keys(fields),
      );
    }, registry);
  });

  it("refuses an extra own undefined descriptor property when considering retry folding", () => {
    const prior = catalog.typedRegistry.operations.find(
      (entry) => entry.op === "embedding.batch.retry",
    );
    const fields = structuredClone(prior.fields);
    fields.delayMs.extra = undefined;
    expect(Object.hasOwn(fields.delayMs, "extra")).toBe(true);
    const registry = { ...catalog.typedRegistry, operations: [{ ...prior, fields }] };
    expect(runtimeOperationsModule(registry)).not.toContain(
      "...activityLogEmbeddingBatchRetryFields()",
    );
  });
});

const GIT_DRAFT_MODEL_OPERATIONS = [
  "git.commit.draft.completed",
  "git.commit.draft.attempt.completed",
];

describe("Git draft runtime model field policy rendering", () => {
  it.each(GIT_DRAFT_MODEL_OPERATIONS)("renders the exact ordered model policy for %s", (op) => {
    const operation = catalog.typedRegistry.operations.find((entry) => entry.op === op);
    const registry = { ...catalog.typedRegistry, operations: [operation] };
    expect(runtimeOperationsModule(registry)).toContain("...activityLogCommitDraftModelFields()");
    withGeneratedRuntime(({ identity }) => {
      const actual = identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields;
      expect(actual).toEqual(operation.fields);
      expect(Object.keys(actual)).toEqual(Object.keys(operation.fields));
      for (const name of Object.keys(operation.fields)) {
        expect(Object.keys(actual[name])).toEqual(Object.keys(operation.fields[name]));
      }
    }, registry);
  });

  it.each([
    [
      "field-order",
      (fields) => {
        const outcome = fields.outcome;
        delete fields.outcome;
        fields.outcome = outcome;
      },
    ],
    [
      "missing-field",
      (fields) => {
        delete fields.breakingTrailerCount;
      },
    ],
    [
      "extra-field",
      (fields) => {
        fields.extraCount = fields.bodyBulletCount;
      },
    ],
    [
      "descriptor-order",
      (fields) => {
        const { required, ...rest } = fields.deadlineMs;
        fields.deadlineMs = { required, ...rest };
      },
    ],
    [
      "requiredness",
      (fields) => {
        fields.outcome.required = false;
      },
    ],
    [
      "vocabulary-value",
      (fields) => {
        fields.outcome.values.push("later");
      },
    ],
    [
      "vocabulary-order",
      (fields) => {
        fields.normalizationRule.values.reverse();
      },
    ],
    [
      "numeric-duration",
      (fields) => {
        fields.deadlineMs.type = "number";
      },
    ],
    [
      "digest-bound",
      (fields) => {
        fields.draftKeyDigest.maxLength = 63;
      },
    ],
  ])("keeps a nonexact draft policy literal: %s", (_mode, mutate) => {
    for (const op of GIT_DRAFT_MODEL_OPERATIONS) {
      const prior = catalog.typedRegistry.operations.find((entry) => entry.op === op);
      const fields = structuredClone(prior.fields);
      mutate(fields);
      const registry = { ...catalog.typedRegistry, operations: [{ ...prior, fields }] };
      expect(runtimeOperationsModule(registry)).not.toContain(
        "...activityLogCommitDraftModelFields()",
      );
      withGeneratedRuntime(({ identity }) => {
        const actual = identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields;
        expect(actual).toEqual(fields);
        expect(Object.keys(actual)).toEqual(Object.keys(fields));
        for (const name of Object.keys(fields)) {
          expect(Object.keys(actual[name])).toEqual(Object.keys(fields[name]));
        }
      }, registry);
    }
  });

  it.each(GIT_DRAFT_MODEL_OPERATIONS)(
    "refuses a changed operation or undefined extra key for %s",
    (op) => {
      const prior = catalog.typedRegistry.operations.find((entry) => entry.op === op);
      const fields = structuredClone(prior.fields);
      fields.draftKeyDigest.extra = undefined;
      expect(Object.hasOwn(fields.draftKeyDigest, "extra")).toBe(true);
      expect(
        runtimeOperationsModule({ ...catalog.typedRegistry, operations: [{ ...prior, fields }] }),
      ).not.toContain("...activityLogCommitDraftModelFields()");
      const other = { ...prior, op: "git.commit.preview.completed" };
      expect(
        runtimeOperationsModule({ ...catalog.typedRegistry, operations: [other] }),
      ).not.toContain("...activityLogCommitDraftModelFields()");
      withGeneratedRuntime(
        ({ identity }) => {
          expect(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields).toEqual(prior.fields);
        },
        { ...catalog.typedRegistry, operations: [other] },
      );
    },
  );

  it("refuses changed final context requiredness and the attempt counter", () => {
    for (const [op, name] of [
      ["git.commit.draft.completed", "stagedFileCount"],
      ["git.commit.draft.attempt.completed", "attempt"],
    ]) {
      const prior = catalog.typedRegistry.operations.find((entry) => entry.op === op);
      const fields = structuredClone(prior.fields);
      fields[name].required = !fields[name].required;
      const registry = { ...catalog.typedRegistry, operations: [{ ...prior, fields }] };
      expect(runtimeOperationsModule(registry)).not.toContain(
        "...activityLogCommitDraftModelFields()",
      );
      withGeneratedRuntime(({ identity }) => {
        expect(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields).toEqual(fields);
      }, registry);
    }
  });

  it("keeps separately generated draft operations' descriptor and enum graphs distinct", () => {
    const operations = GIT_DRAFT_MODEL_OPERATIONS.map((op) =>
      catalog.typedRegistry.operations.find((entry) => entry.op === op),
    );
    withGeneratedRuntime(
      ({ inspection }) => {
        expect(inspection).toEqual({
          distinctFields: true,
          distinctOutcome: true,
          distinctValues: true,
        });
      },
      { ...catalog.typedRegistry, operations },
      `(() => {
      const [final, attempt] = operations.ACTIVITY_LOG_OPERATION_REGISTRY;
      return {
        distinctFields: final.fields !== attempt.fields,
        distinctOutcome: final.fields.outcome !== attempt.fields.outcome,
        distinctValues: final.fields.outcome.values !== attempt.fields.outcome.values,
      };
    })()`,
    );
  });
});

describe("bounded descriptor runtime rendering", () => {
  it.each([
    [
      { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
      'fieldContracts.activityLogBoundedStringField(true, "opaque-id", 128)',
    ],
    [
      {
        type: "string-array",
        dataClass: "safe-platform-class",
        required: false,
        maxLength: 512,
        maxItems: 8,
      },
      'fieldContracts.activityLogBoundedStringArrayField(false, "safe-platform-class", 512, 8)',
    ],
  ])("constructs an exact ordered bounded policy %#", (descriptor, call) => {
    const base = catalog.typedRegistry.operations[0];
    const registry = {
      ...catalog.typedRegistry,
      operations: [{ ...base, fields: { bounded: descriptor } }],
    };
    expect(runtimeOperationsModule(registry)).toContain(call);
    withGeneratedRuntime(({ identity }) => {
      const actual = identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields.bounded;
      expect(actual).toEqual(descriptor);
      expect(Reflect.ownKeys(actual)).toEqual(Reflect.ownKeys(descriptor));
    }, registry);
  });

  it.each([
    { required: false, type: "string", dataClass: "digest", maxLength: 64 },
    { type: "string", dataClass: "digest", required: false, maxLength: 64, values: ["a"] },
    { type: "string", dataClass: "count", required: false, maxLength: 64 },
    { type: "string", dataClass: "completeness-state", required: false, maxLength: 64 },
    { type: "string", dataClass: "digest", required: false, maxLength: 8193 },
    { type: "string-array", dataClass: "digest", required: false, maxItems: 5, maxLength: 64 },
    {
      type: "string-array",
      dataClass: "safe-version",
      required: false,
      maxLength: 64,
      maxItems: 5,
    },
    { type: "string-array", dataClass: "digest", required: false, maxLength: 64, maxItems: 65 },
  ])("retains noncanonical bounded descriptor keys, class, bounds or order %#", (descriptor) => {
    const base = catalog.typedRegistry.operations[0];
    const registry = {
      ...catalog.typedRegistry,
      operations: [{ ...base, fields: { bounded: descriptor } }],
    };
    const source = runtimeOperationsModule(registry);
    expect(source).not.toContain('"bounded": fieldContracts.activityLogBoundedString');
    withGeneratedRuntime(({ identity }) => {
      const actual = identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields.bounded;
      expect(actual).toEqual(descriptor);
      expect(Object.keys(actual)).toEqual(Object.keys(descriptor));
    }, registry);
  });
});

it.each(["extra", "values"])(
  "does not fold a bounded array with an extra own undefined %s",
  (key) => {
    const expected = {
      type: "string-array",
      dataClass: "digest",
      required: false,
      maxLength: 64,
      maxItems: 5,
    };
    const descriptor = { ...expected, [key]: undefined };
    expect(Object.hasOwn(descriptor, key)).toBe(true);
    const base = catalog.typedRegistry.operations[0];
    const registry = {
      ...catalog.typedRegistry,
      operations: [{ ...base, fields: { bounded: descriptor } }],
    };
    expect(runtimeOperationsModule(registry)).not.toContain(
      '"bounded": fieldContracts.activityLogBoundedString',
    );
    withGeneratedRuntime(({ identity }) => {
      expect(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields.bounded).toEqual(expected);
    }, registry);
  },
);

function builtFieldBundleCompilerOptions(root) {
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  expect(config.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  expect(parsed.errors).toEqual([]);
  expect(parsed.options.module).toBe(ts.ModuleKind.NodeNext);
  expect(parsed.options.moduleResolution).toBe(ts.ModuleResolutionKind.NodeNext);
  return { options: { ...parsed.options, noEmit: true }, references: parsed.projectReferences };
}

function builtFieldBundleCompilerHost(options, proofPath, proof) {
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (path) => (path === proofPath ? proof : readFile(path));
  host.fileExists = (path) => path === proofPath || fileExists(path);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    path === proofPath
      ? ts.createSourceFile(path, proof, languageVersion, true)
      : getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  return host;
}

function expectLoadedBuiltFieldDeclaration(program, path) {
  const source = program
    .getSourceFiles()
    .find((file) => file.isDeclarationFile && realpathSync(file.fileName) === path);
  expect(source?.text).toBe(readFileSync(path, "utf8"));
}

const BUILT_FIELD_BUNDLE_DECLARATION_PROOF = `
import type { ACTIVITY_LOG_OPERATION_REGISTRY } from "@oscharko-dev/keiko-contracts/runtime/observability";
import type {
  activityLogAutomaticCatalogFields,
  activityLogCommitDraftModelFields,
  ActivityLogLossSummaryFields,
  ActivityLogWorkspaceIoFields,
} from "../packages/keiko-contracts/dist/activity-log-field-contracts.js";

type Registry = typeof ACTIVITY_LOG_OPERATION_REGISTRY;
type AutomaticProducerFields = ReturnType<typeof activityLogAutomaticCatalogFields>;
type DraftProducerFields = ReturnType<typeof activityLogCommitDraftModelFields>;
type LossProducerFields = Readonly<ActivityLogLossSummaryFields>;
type GenericEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

type AutomaticCatalogBundle = Assert<GenericEqual<
  Pick<Extract<Registry[number], { readonly op: "gateway.catalog.automatic.completed" }>["fields"], keyof AutomaticProducerFields>,
  AutomaticProducerFields
>>;
type DraftAttemptBundle = Assert<GenericEqual<
  Pick<Extract<Registry[number], { readonly op: "git.commit.draft.attempt.completed" }>["fields"], keyof DraftProducerFields>,
  DraftProducerFields
>>;
type DraftCompletedBundle = Assert<GenericEqual<
  Pick<Extract<Registry[number], { readonly op: "git.commit.draft.completed" }>["fields"], keyof DraftProducerFields>,
  DraftProducerFields
>>;
type LossSummaryBundle = Assert<GenericEqual<
  Pick<Extract<Registry[number], { readonly op: "activity-log.loss" }>["fields"], keyof LossProducerFields>,
  LossProducerFields
>>;
type WorkspaceIoOptionalFields = Readonly<ActivityLogWorkspaceIoFields<false>>;
type WorkspaceIoRequiredFields = Readonly<ActivityLogWorkspaceIoFields<true>>;
type CompletionWorkspaceIoBundle = Assert<GenericEqual<
  Pick<Extract<Registry[number], { readonly op: "search.connected-context.completion-details" }>["fields"], keyof WorkspaceIoOptionalFields>,
  WorkspaceIoOptionalFields
>>;
type FailedWorkspaceIoBundle = Assert<GenericEqual<
  Pick<Extract<Registry[number], { readonly op: "search.connected-context.failed" }>["fields"], keyof WorkspaceIoRequiredFields>,
  WorkspaceIoRequiredFields
>>;
`;

it("preserves built public registry field bundles as their canonical producer return types", () => {
  const root = realpathSync(new URL("../../", import.meta.url));
  const proofPath = join(root, "tests", "activity-log-field-bundle-declarations.proof.ts");
  const proof = BUILT_FIELD_BUNDLE_DECLARATION_PROOF;
  const { options, references } = builtFieldBundleCompilerOptions(root);
  const resolved = ts.resolveModuleName(
    "@oscharko-dev/keiko-contracts/runtime/observability",
    proofPath,
    options,
    ts.sys,
  ).resolvedModule;
  const dist = join(root, "packages", "keiko-contracts", "dist");
  expect(resolved).toBeDefined();
  expect(realpathSync(resolved.resolvedFileName)).toBe(join(dist, "observability.d.ts"));
  const program = ts.createProgram({
    rootNames: [proofPath],
    options,
    projectReferences: references,
    host: builtFieldBundleCompilerHost(options, proofPath, proof),
  });
  expect(program.getSourceFile(proofPath)?.text).toBe(proof);
  for (const file of [
    "observability.d.ts",
    "activity-log-operations.generated.d.ts",
    "activity-log-field-contracts.d.ts",
  ]) {
    expectLoadedBuiltFieldDeclaration(program, join(dist, file));
  }
  const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
    code: diagnostic.code,
    file: diagnostic.file?.fileName,
    start: diagnostic.start,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
  }));
  expect(diagnostics).toEqual([]);
});

function registeredLossRuntimePilot() {
  return catalog.typedRegistry.operations.find((operation) => operation.op === "activity-log.loss");
}

describe("loss-summary runtime field policy rendering", () => {
  it("renders the complete loss policy only after its unchanged global prefix", () => {
    const pilot = registeredLossRuntimePilot();
    const registry = { ...catalog.typedRegistry, operations: [pilot] };
    expect(runtimeOperationsModule(registry)).toContain("...activityLogLossSummaryFields()");
    withGeneratedRuntime(({ identity }) => {
      const fields = identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields;
      expect(fields).toEqual(pilot.fields);
      expect(Reflect.ownKeys(fields)).toEqual(Reflect.ownKeys(pilot.fields));
    }, registry);
  });

  it.each([
    "other-operation",
    "field-order",
    "missing-field",
    "requiredness",
    "trigger-order",
    "descriptor-order",
  ])("keeps a nonexact loss policy on the full fallback path: %s", (variant) => {
    const pilot = registeredLossRuntimePilot();
    const fields = { ...pilot.fields };
    let op = pilot.op;
    if (variant === "other-operation") op = "gateway.catalog.automatic.completed";
    if (variant === "field-order") {
      const trigger = fields.trigger;
      delete fields.trigger;
      fields.trigger = trigger;
    }
    if (variant === "missing-field") delete fields.loggerWriteFailed;
    if (variant === "requiredness") fields.totalLost = { ...fields.totalLost, required: false };
    if (variant === "trigger-order")
      fields.trigger = { ...fields.trigger, values: ["exit", "heartbeat"] };
    if (variant === "descriptor-order")
      fields.totalLost = { required: true, dataClass: "count", type: "integer" };
    const registry = { ...catalog.typedRegistry, operations: [{ ...pilot, op, fields }] };
    expect(runtimeOperationsModule(registry)).not.toContain("...activityLogLossSummaryFields()");
    withGeneratedRuntime(({ identity }) => {
      expect(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields).toEqual(fields);
      expect(Object.keys(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields)).toEqual(
        Object.keys(fields),
      );
    }, registry);
  });

  it("retains the descriptor extra-own-undefined refusal instead of folding the loss bundle", () => {
    const pilot = registeredLossRuntimePilot();
    const fields = { ...pilot.fields, totalLost: { ...pilot.fields.totalLost, extra: undefined } };
    expect(Object.hasOwn(fields.totalLost, "extra")).toBe(true);
    const registry = { ...catalog.typedRegistry, operations: [{ ...pilot, fields }] };
    expect(runtimeOperationsModule(registry)).not.toContain("...activityLogLossSummaryFields()");
    withGeneratedRuntime(({ identity }) => {
      expect(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields).toEqual(pilot.fields);
    }, registry);
  });
});

function workspaceIoRuntimePilot(op) {
  return catalog.typedRegistry.operations.find((operation) => operation.op === op);
}

const WORKSPACE_IO_RUNTIME_CASES = [
  ["search.connected-context.completion-details", false],
  ["search.connected-context.failed", true],
];

describe.each(WORKSPACE_IO_RUNTIME_CASES)(
  "workspace-I/O segment rendering for %s",
  (op, required) => {
    it("folds only the seven-field segment and preserves every surrounding field and order", () => {
      const pilot = workspaceIoRuntimePilot(op);
      const registry = { ...catalog.typedRegistry, operations: [pilot] };
      expect(runtimeOperationsModule(registry)).toContain(
        `...activityLogWorkspaceIoFields(${String(required)})`,
      );
      withGeneratedRuntime(({ identity }) => {
        const fields = identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields;
        expect(fields).toEqual(pilot.fields);
        expect(Reflect.ownKeys(fields)).toEqual(Reflect.ownKeys(pilot.fields));
      }, registry);
    });

    it("preserves an independently changed neighbor while folding only its workspace-I/O segment", () => {
      const pilot = workspaceIoRuntimePilot(op);
      const fields = {
        ...pilot.fields,
        scopeIdentitySha256: { ...pilot.fields.scopeIdentitySha256, maxLength: 32 },
      };
      const registry = { ...catalog.typedRegistry, operations: [{ ...pilot, fields }] };
      expect(runtimeOperationsModule(registry)).toContain(
        `...activityLogWorkspaceIoFields(${String(required)})`,
      );
      withGeneratedRuntime(({ identity }) => {
        expect(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields).toEqual(fields);
        expect(Object.keys(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields)).toEqual(
          Object.keys(fields),
        );
      }, registry);
    });

    it.each([
      "other-op",
      "missing",
      "reordered",
      "interrupted",
      "required",
      "type",
      "class",
      "descriptor-order",
    ])("retains individual-field rendering for a nonexact segment: %s", (variant) => {
      const pilot = workspaceIoRuntimePilot(op);
      const fields = nonexactWorkspaceIoFields(pilot.fields, variant, required);
      const selectedOp = variant === "other-op" ? "search.connected-context.completed" : op;
      const registry = {
        ...catalog.typedRegistry,
        operations: [{ ...pilot, op: selectedOp, fields }],
      };
      expect(runtimeOperationsModule(registry)).not.toContain("...activityLogWorkspaceIoFields(");
      withGeneratedRuntime(({ identity }) => {
        expect(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields).toEqual(fields);
        expect(Object.keys(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields)).toEqual(
          Object.keys(fields),
        );
      }, registry);
    });

    it("refuses an extra own undefined descriptor member without changing serialization fallback", () => {
      const pilot = workspaceIoRuntimePilot(op);
      const descriptor = { ...pilot.fields.workspaceIoStatCalls, extra: undefined };
      expect(Object.hasOwn(descriptor, "extra")).toBe(true);
      const fields = { ...pilot.fields, workspaceIoStatCalls: descriptor };
      const registry = { ...catalog.typedRegistry, operations: [{ ...pilot, fields }] };
      expect(runtimeOperationsModule(registry)).not.toContain("...activityLogWorkspaceIoFields(");
      withGeneratedRuntime(({ identity }) => {
        expect(identity.ACTIVITY_LOG_OPERATION_REGISTRY[0].fields).toEqual(pilot.fields);
      }, registry);
    });
  },
);

function nonexactWorkspaceIoFields(original, variant, required) {
  const fields = { ...original };
  if (variant === "missing") delete fields.workspaceIoStatCalls;
  if (variant === "reordered") {
    const first = fields.workspaceIoReadDirCalls;
    delete fields.workspaceIoReadDirCalls;
    fields.workspaceIoReadDirCalls = first;
  }
  if (variant === "interrupted") {
    const entries = Object.entries(fields);
    const index = entries.findIndex(([name]) => name === "workspaceIoStatCalls");
    entries.splice(index, 0, [
      "fixtureInterruption",
      { type: "integer", dataClass: "count", required },
    ]);
    return Object.fromEntries(entries);
  }
  if (variant === "required")
    fields.workspaceIoStatCalls = { ...fields.workspaceIoStatCalls, required: !required };
  if (variant === "type")
    fields.workspaceIoStatCalls = { type: "number", dataClass: "count", required };
  if (variant === "class")
    fields.workspaceIoStatCalls = { type: "integer", dataClass: "duration", required };
  if (variant === "descriptor-order")
    fields.workspaceIoStatCalls = { required, dataClass: "count", type: "integer" };
  return fields;
}
