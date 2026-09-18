import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  activityLogErrorKindOr,
  isActivityLogIdentityDigest,
  isActivityLogInstanceId,
  isActivityLogPlatformClass,
  isActivityLogProcessId,
  isActivityLogProductVersion,
  isActivityLogSequence,
} from "../../packages/keiko-contracts/dist/observability.js";
import {
  activityLogSchemaDigest,
  activityLogSchemaDigestMaterial,
  formatGeneratedJson,
  generateActivityLogFailureSurfaceInventory,
  generateOpCatalog,
  generateTypedActivityLogRegistry,
  validateActivityLogFailureClassContracts,
  validateActivityLogRegistryExemptions,
} from "../generate-op-catalog.mjs";
import { failureSurfaceInventoryDrift } from "../lib/activity-log-failure-surface-inventory.mjs";
import { withTypedRegistryFixture } from "./support/typed-registry-fixture.mjs";
import {
  newFailurePathFindings,
  unregisteredFailurePathViolations,
} from "../check-error-observability.mjs";
import {
  TOOL_CATALOG_OPERATIONS_PATH,
  generateToolCatalogOperations,
  toolCatalogOperationsBytes,
} from "../lib/tool-catalog-operations.mjs";

// Pins docs/observability/op-catalog.generated.json against the generator that derives it — the
// same "derive, don't restate, pin with a drift test" pattern route-template.test.ts already runs
// against API_ROUTES (see AGENTS.md §7). A hand-edited catalog entry, a new instrumentation site
// added without regenerating, or a generator change that silently reorders/drops entries all turn
// this red. The fix is always `npm run generate:op-catalog`, never editing the JSON by hand.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CATALOG_PATH = join(repoRoot, "docs", "observability", "op-catalog.generated.json");
const INVENTORY_PATH = join(
  repoRoot,
  "docs",
  "observability",
  "failure-surface-inventory.generated.json",
);
// Coverage instrumentation makes a complete repository scan take more than two minutes on the
// smallest CI workers. This is a harness deadline, not a product latency budget; cache the one
// immutable result and keep that unavoidable scan bounded without letting the global 15-second
// test limit abort it.
const REPOSITORY_SCAN_TEST_TIMEOUT_MS = 4 * 60_000;
let currentCatalog;

const ACTIVITY_FIELD_TYPES_BY_DATA_CLASS = {
  "closed-enum": new Set(["boolean", "string", "string-array"]),
  "completeness-state": new Set(["string"]),
  count: new Set(["integer", "number"]),
  digest: new Set(["string", "string-array"]),
  duration: new Set(["integer", "number"]),
  "error-kind": new Set(["string", "string-array"]),
  "loss-state": new Set(["string"]),
  "opaque-id": new Set(["string", "string-array"]),
  "safe-platform-class": new Set(["string", "string-array"]),
  "safe-version": new Set(["integer", "string"]),
};

function generateCurrentOpCatalog() {
  currentCatalog ??= generateOpCatalog(repoRoot);
  return currentCatalog;
}

function generateCurrentTypedRegistry() {
  return generateCurrentOpCatalog().typedRegistry;
}

function readCheckedInCatalog() {
  return JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
}

// Builds a throwaway `<tmp>/packages/<pkgName>/src/fixture.ts` and runs `check(root)` against it,
// always cleaning up afterward. `generateOpCatalog` discovers package roots by listing `packages/*`
// under whatever root it is given (see `scannedPackageRoots`), so pointing it at a fixture root
// exercises the real production entry point end to end — no re-derivation of any of the
// generator's own extraction rules inside the test.
function withFixturePackage(pkgName, fileContents, check) {
  const root = mkdtempSync(join(tmpdir(), "op-catalog-fixture-"));
  try {
    const srcDir = join(root, "packages", pkgName, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "fixture.ts"), fileContents, "utf8");
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const EXEMPTION_OPERATION_FIXTURE = {
  op: "fixture.registry.completed",
  owner: "keiko-contracts",
  failureClasses: ["fixture-failure"],
};

function validExemption(overrides = {}) {
  return {
    contractKind: "activity-log-exemption",
    schemaVersion: 1,
    id: "fixture-platform-boundary",
    operation: "fixture.registry.completed",
    failureClass: "fixture-failure",
    boundary: "platform",
    owner: "keiko-contracts",
    reason: "The fixture platform cannot expose this proof signal.",
    trackingIssue: 3529,
    expiresOn: "2026-12-31",
    ...overrides,
  };
}

function fixtureFailureClassContract({
  op,
  owner,
  lifecycle,
  causal = "correlation",
  evidenceClasses = ["completeness-state", "loss-state"],
  proofIds = ["fixture-proof"],
}) {
  const lifecycleOperations = Object.fromEntries(
    ["start", "state", "end", "failure", "loss"].map((phase) => [
      phase,
      phase === lifecycle ? [op] : [],
    ]),
  );
  return {
    contractKind: "activity-log-failure-class",
    schemaVersion: 1,
    failureClass: "fixture-failure",
    requiredProductSurfaces: [owner],
    requiredLifecycleOperations: lifecycleOperations,
    requiredCausalOperations: causal === "none" ? [] : [op],
    requiredLossOperations: lifecycle === "loss" ? [op] : [],
    requiredProofOperations: [op],
    requiredReplayProofIds: proofIds.filter((proofId) => /replay|seed|fixture/u.test(proofId)),
    requiredResourceOperations: ["start", "state", "end"].includes(lifecycle) ? [op] : [],
    requiredEvidenceClasses: evidenceClasses,
    requiredFrameOperations: [],
    requiredCauseOperations: [],
  };
}

describe("Activity Log registry exemptions", () => {
  const now = new Date("2026-09-17T00:00:00.000Z");

  it("accepts one exact reviewed operation and failure-class boundary", () => {
    expect(
      validateActivityLogRegistryExemptions([validExemption()], [EXEMPTION_OPERATION_FIXTURE], now),
    ).toEqual([]);
  });

  it.each([
    ["missing owner", { owner: undefined }, "exemption-invalid", "owner"],
    ["missing reason", { reason: undefined }, "exemption-invalid", "reason"],
    ["missing issue", { trackingIssue: undefined }, "exemption-invalid", "trackingIssue"],
    ["broad operation", { operation: "*" }, "exemption-invalid", "operation"],
    ["expired", { expiresOn: "2026-09-16" }, "exemption-expired", "2026-09-16"],
    ["effectively permanent", { expiresOn: "2027-03-17" }, "exemption-permanent", "2027-03-17"],
    [
      "owned by another package",
      { owner: "keiko-server" },
      "exemption-owner-mismatch",
      "keiko-server",
    ],
    [
      "unknown operation",
      { operation: "fixture.registry.unknown" },
      "exemption-unknown-operation",
      "fixture.registry.unknown",
    ],
    [
      "unowned failure class",
      { failureClass: "other-failure" },
      "exemption-failure-class-mismatch",
      "other-failure",
    ],
    ["prohibited field authorization", { fields: ["prompt"] }, "exemption-invalid", "unknown-key"],
    ["silent loss authorization", { allowSilentLoss: true }, "exemption-invalid", "unknown-key"],
    [
      "incomplete evidence authorization",
      { allowIncomplete: true },
      "exemption-invalid",
      "unknown-key",
    ],
  ])("rejects %s", (_label, mutation, code, detail) => {
    expect(
      validateActivityLogRegistryExemptions(
        [validExemption(mutation)],
        [EXEMPTION_OPERATION_FIXTURE],
        now,
      ),
    ).toContainEqual(expect.objectContaining({ code, detail }));
  });

  it("rejects duplicate exemption ids", () => {
    expect(
      validateActivityLogRegistryExemptions(
        [validExemption(), validExemption({ operation: "fixture.registry.completed" })],
        [EXEMPTION_OPERATION_FIXTURE],
        now,
      ),
    ).toContainEqual(
      expect.objectContaining({ code: "exemption-duplicate", detail: "fixture-platform-boundary" }),
    );
  });

  it("rejects an exemption registry above its closed entry bound", () => {
    const exemptions = Array.from({ length: 65 }, (_unused, index) =>
      validExemption({ id: `fixture-platform-boundary-${String(index)}` }),
    );
    expect(
      validateActivityLogRegistryExemptions(exemptions, [EXEMPTION_OPERATION_FIXTURE], now),
    ).toEqual([expect.objectContaining({ code: "exemption-registry-invalid" })]);
  });
});

const FAILURE_CLASS_OPERATION_FIXTURES = [
  {
    op: "fixture.lifecycle.started",
    owner: "fixture-owner",
    lifecycle: "start",
    causal: "correlation",
    failureClasses: ["fixture-failure"],
    proofIds: ["replay-start"],
    emitterSites: ["packages/fixture/src/fixture.ts:1"],
    fields: {
      completeness: { dataClass: "completeness-state" },
      loss: { dataClass: "loss-state" },
      resourceCount: { dataClass: "count" },
      frames: { dataClass: "opaque-id" },
    },
  },
  {
    op: "fixture.lifecycle.lost",
    owner: "fixture-owner",
    lifecycle: "loss",
    causal: "parent-correlation",
    failureClasses: ["fixture-failure"],
    proofIds: ["proof-loss"],
    emitterSites: ["packages/fixture/src/fixture.ts:2"],
    fields: {
      completeness: { dataClass: "completeness-state" },
      loss: { dataClass: "loss-state" },
      causeChain: { dataClass: "opaque-id" },
    },
  },
];

const FAILURE_CLASS_CONTRACT_FIXTURE = {
  contractKind: "activity-log-failure-class",
  schemaVersion: 1,
  failureClass: "fixture-failure",
  requiredProductSurfaces: ["fixture-owner"],
  requiredLifecycleOperations: {
    start: ["fixture.lifecycle.started"],
    state: [],
    end: [],
    failure: [],
    loss: ["fixture.lifecycle.lost"],
  },
  requiredCausalOperations: ["fixture.lifecycle.lost", "fixture.lifecycle.started"],
  requiredLossOperations: ["fixture.lifecycle.lost"],
  requiredProofOperations: ["fixture.lifecycle.lost", "fixture.lifecycle.started"],
  requiredReplayProofIds: ["replay-start"],
  requiredResourceOperations: ["fixture.lifecycle.started"],
  requiredEvidenceClasses: ["completeness-state", "count", "loss-state", "opaque-id"],
  requiredFrameOperations: ["fixture.lifecycle.started"],
  requiredCauseOperations: ["fixture.lifecycle.lost"],
};

function failureContractViolations(contract, operations = FAILURE_CLASS_OPERATION_FIXTURES) {
  return validateActivityLogFailureClassContracts([contract], operations);
}

describe("canonical Activity Log failure-class obligations", () => {
  it("accepts exactly satisfied explicit lifecycle, loss, causal, proof, and replay duties", () => {
    expect(failureContractViolations(structuredClone(FAILURE_CLASS_CONTRACT_FIXTURE))).toEqual([]);
  });

  it("rejects missing, duplicate, and unknown failure-class declarations", () => {
    expect(
      validateActivityLogFailureClassContracts([], FAILURE_CLASS_OPERATION_FIXTURES),
    ).toContainEqual(expect.objectContaining({ code: "failure-class-contract-missing" }));
    expect(
      validateActivityLogFailureClassContracts(
        [FAILURE_CLASS_CONTRACT_FIXTURE, structuredClone(FAILURE_CLASS_CONTRACT_FIXTURE)],
        FAILURE_CLASS_OPERATION_FIXTURES,
      ),
    ).toContainEqual(expect.objectContaining({ code: "failure-class-contract-duplicate" }));
    const operations = structuredClone(FAILURE_CLASS_OPERATION_FIXTURES);
    operations[0].failureClasses.push("unknown-failure");
    expect(
      validateActivityLogFailureClassContracts([FAILURE_CLASS_CONTRACT_FIXTURE], operations),
    ).toContainEqual(
      expect.objectContaining({
        code: "failure-class-contract-missing",
        detail: "unknown-failure",
      }),
    );
  });

  it.each([
    ["lifecycle-start", (operations) => (operations[0].lifecycle = "state")],
    ["loss-signals", (operations) => (operations[1].lifecycle = "failure")],
    ["causal-edges", (operations) => (operations[0].causal = "none")],
    ["executable-proof", (operations) => (operations[1].proofIds = [])],
    ["replay-references", (operations) => (operations[0].proofIds = ["proof-start"])],
    ["evidence-classes", (operations) => delete operations[0].fields.resourceCount],
    ["frame-evidence", (operations) => delete operations[0].fields.frames],
    ["cause-evidence", (operations) => delete operations[1].fields.causeChain],
  ])("rejects a missing %s obligation", (detail, mutate) => {
    const operations = structuredClone(FAILURE_CLASS_OPERATION_FIXTURES);
    mutate(operations);
    expect(failureContractViolations(FAILURE_CLASS_CONTRACT_FIXTURE, operations)).toContainEqual(
      expect.objectContaining({ code: "failure-class-contract-unsatisfied", detail }),
    );
  });

  it("rejects removal of an explicit resource-signal obligation", () => {
    const contract = structuredClone(FAILURE_CLASS_CONTRACT_FIXTURE);
    contract.requiredResourceOperations = [];
    expect(failureContractViolations(contract)).toContainEqual(
      expect.objectContaining({
        code: "failure-class-contract-unsatisfied",
        detail: "resource-signals",
      }),
    );
  });

  it("rejects a proof obligation that does not cover every required operation", () => {
    const contract = structuredClone(FAILURE_CLASS_CONTRACT_FIXTURE);
    contract.requiredProofOperations = ["fixture.lifecycle.started"];
    expect(failureContractViolations(contract)).toContainEqual(
      expect.objectContaining({
        code: "failure-class-contract-inconsistent",
        detail: "requiredProofOperations",
      }),
    );
  });
});

describe("Activity Log contracts shared by writers and readers", () => {
  it("keeps identity shapes and numeric bounds canonical", () => {
    expect(isActivityLogIdentityDigest("a".repeat(64))).toBe(true);
    expect(isActivityLogIdentityDigest("a".repeat(63))).toBe(false);
    expect(isActivityLogInstanceId("0123abcd")).toBe(true);
    expect(isActivityLogInstanceId("0123ABCDE")).toBe(false);
    expect(isActivityLogPlatformClass("linux-x64")).toBe(true);
    expect(isActivityLogPlatformClass("freebsd-x64")).toBe(false);
    expect(isActivityLogProductVersion("1.0.4-prerelease.1")).toBe(true);
    expect(isActivityLogProductVersion("v1.0.4")).toBe(false);
    expect(isActivityLogProcessId(2_147_483_647)).toBe(true);
    expect(isActivityLogProcessId(2_147_483_648)).toBe(false);
    expect(isActivityLogSequence(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isActivityLogSequence(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  it("normalizes unknown Activity Log error kinds through one closed helper", () => {
    expect(activityLogErrorKindOr("timeout", "unknown")).toBe("timeout");
    expect(activityLogErrorKindOr("provider secret response", "unknown")).toBe("unknown");
  });
});

describe("new failure-path observability", () => {
  it("rejects raw, empty, and non-empty catches without evidence or propagation", () => {
    const source = [
      "function rawConsoleFailure() { try { run(); } catch (error) { console.error(error); } }",
      "function emptyFailure() { try { run(); } catch {} }",
      "function fallbackFailure() { try { run(); } catch { return false; } }",
      "function responseWriteFailure() { try { run(); } catch { response.write('failed'); return false; } }",
      "function databaseRecordFailure() { try { run(); } catch (error) { db.record(error); } }",
      "function registeredFailure() {",
      "  try { run(); } catch (error) { activityLogEvent(operation, {}, { error }); }",
      "}",
      "function diagnosticFailure() { try { run(); } catch (error) { diagnostics.record(error); } }",
      "function propagatedFailure() { try { run(); } catch (error) { throw error; } }",
    ].join("\n");
    expect(unregisteredFailurePathViolations(source, "packages/fixture/src/failure.ts")).toEqual([
      expect.objectContaining({ owner: "rawConsoleFailure", kind: "raw-console-catch" }),
      expect.objectContaining({ owner: "emptyFailure", kind: "unregistered-catch" }),
      expect.objectContaining({ owner: "fallbackFailure", kind: "unregistered-catch" }),
      expect.objectContaining({ owner: "responseWriteFailure", kind: "unregistered-catch" }),
      expect.objectContaining({ owner: "databaseRecordFailure", kind: "unregistered-catch" }),
    ]);
  });

  it("keys each class member's catch by its own owner", () => {
    const source = [
      "class Store {",
      "  constructor() { try { run(); } catch {} }",
      "  get value() { try { return run(); } catch { return 0; } }",
      "  load() { try { run(); } catch {} }",
      "  save() { try { run(); } catch {} }",
      "  flush = () => { try { run(); } catch {} };",
      "}",
    ].join("\n");
    expect(
      unregisteredFailurePathViolations(source, "packages/fixture/src/store.ts").map(
        (finding) => finding.owner,
      ),
    ).toEqual(["Store.constructor", "Store.get value", "Store.load", "Store.save", "Store.flush"]);
  });

  it("does not let a fixed catch in one method hide a new one in another", () => {
    const base = [
      "class Store {",
      "  load() { try { run(); } catch {} }",
      "  save() { try { run(); } catch (error) { reportFailure(error); } }",
      "}",
    ].join("\n");
    const head = [
      "class Store {",
      "  load() { try { run(); } catch (error) { reportFailure(error); } }",
      "  save() { try { run(); } catch {} }",
      "}",
    ].join("\n");
    expect(newFailurePathFindings(base, head, "packages/fixture/src/store.ts")).toEqual([
      expect.objectContaining({ owner: "Store.save", kind: "unregistered-catch" }),
    ]);
  });

  it("permits only an exact reviewed cleanup boundary", () => {
    const source =
      "function closeDescriptorIgnoringErrors() { try { close(); } catch { return; } }";
    expect(
      unregisteredFailurePathViolations(source, "packages/keiko-security/src/fs-hardening.ts"),
    ).toEqual([]);
    expect(unregisteredFailurePathViolations(source, "packages/fixture/src/failure.ts")).toEqual([
      expect.objectContaining({
        owner: "closeDescriptorIgnoringErrors",
        kind: "unregistered-catch",
      }),
    ]);
  });
});

describe("op catalog drift", () => {
  it("binds the schema digest to the complete persisted envelope and closed vocabularies", () => {
    const material = activityLogSchemaDigestMaterial();

    expect(Object.keys(material.persistedEnvelope)).toEqual([
      "ts",
      "schemaVersion",
      "registryVersion",
      "schemaDigest",
      "catalogDigest",
      "buildClass",
      "releaseClass",
      "platformClass",
      "productVersion",
      "compatibilityState",
      "writerCapability",
      "pid",
      "instanceId",
      "seq",
      "level",
      "category",
      "op",
      "correlationId",
      "parentCorrelationId",
      "durationMs",
      "status",
      "errorKind",
    ]);
    expect(material.persistedEnvelope).toMatchObject({
      schemaVersion: { type: "integer", required: true, values: [2] },
      schemaDigest: { type: "string", required: true, format: "sha256-hex" },
      catalogDigest: { type: "string", required: true, format: "sha256-hex" },
      buildClass: { values: ["node-esm"] },
      releaseClass: { values: ["stable", "prerelease"] },
      platformClass: {
        pattern: "^(?:darwin|linux|win32|other)-(?:arm64|x64|other)$",
      },
      status: { type: "integer", required: false },
      errorKind: { values: material.vocabularies.errorKinds },
    });
    expect(material.vocabularies).toMatchObject({
      completenessStates: ["complete", "partial", "unknown"],
      lossStates: ["none", "event-dropped", "event-location-unknown", "publication-unavailable"],
      errorKinds: [
        "unknown",
        "internal",
        "invalid-request",
        "validation-failed",
        "permission-denied",
        "authority-denied",
        "unavailable",
        "timeout",
        "cancelled",
        "rate-limited",
        "conflict",
        "unsafe-target",
        "target-exists",
        "target-mutated",
        "open-failed",
        "read-failed",
        "write-failed",
        "durability-failed",
        "publish-unsupported",
      ],
      compatibilityStates: [
        "supported",
        "legacy-supported",
        "unsupported-version",
        "corrupt",
        "truncated",
        "incomplete",
      ],
      writerCapabilityStates: ["active", "degraded", "unavailable"],
      levels: ["debug", "info", "warn", "error"],
      buildClasses: ["node-esm"],
      releaseClasses: ["stable", "prerelease"],
    });
    expect(activityLogSchemaDigest()).toBe(
      "9740e94c6279e425140dbc63d6f27a04f7c7cc68f18c091d2fd96c3201e217ba",
    );
  });

  it("discovers a typed registration and emission with its exact owning source sites", () => {
    withTypedRegistryFixture(
      "zzz-fixture-typed-registry",
      [
        'import { activityLogEvent, defineActivityLogOperation } from "../../keiko-contracts/src/observability.js";',
        "const operation = defineActivityLogOperation({",
        '  contractKind: "activity-log-operation" as const,',
        "  schemaVersion: 1 as const,",
        '  op: "fixture.registry.completed",',
        '  category: "diagnostic",',
        '  owner: "zzz-fixture-typed-registry",',
        '  emitter: "fixture",',
        "  fields: {},",
        '  causal: "correlation",',
        '  lifecycle: "end",',
        '  analyzerProjection: "timeline",',
        '  failureClasses: ["fixture-failure"],',
        '  proofIds: ["fixture-proof"],',
        '  releaseImpact: "patch",',
        "});",
        "activityLogEvent(operation, {}, {});",
        "",
      ].join("\n"),
      (root) => {
        const registry = generateTypedActivityLogRegistry(root, [
          fixtureFailureClassContract({
            op: "fixture.registry.completed",
            owner: "zzz-fixture-typed-registry",
            lifecycle: "end",
          }),
        ]);
        expect(registry.violations).toEqual([]);
        expect(registry.operations).toEqual([
          expect.objectContaining({
            op: "fixture.registry.completed",
            owner: "zzz-fixture-typed-registry",
            registrationSite: "packages/zzz-fixture-typed-registry/src/fixture.ts:2",
            emitterSites: ["packages/zzz-fixture-typed-registry/src/fixture.ts:17"],
            fields: expect.objectContaining({
              completeness: expect.objectContaining({ required: true }),
              loss: expect.objectContaining({ required: true }),
            }),
          }),
        ]);
        expect(registry.failureClassCoverage).toMatchObject({
          releaseExpectation: "100%-complete",
          supportedClassCount: 1,
          completeClassCount: 1,
          completeness: "complete",
          classes: [
            expect.objectContaining({
              lifecycleOperations: {
                start: [],
                state: [],
                end: ["fixture.registry.completed"],
                failure: [],
                loss: [],
              },
              lossSignals: [],
            }),
          ],
        });
      },
    );
  });

  it("discovers a typed registration composed from closed const spreads", () => {
    withTypedRegistryFixture(
      "zzz-fixture-typed-registry-spread",
      [
        'import { activityLogEvent, defineActivityLogOperation } from "../../keiko-contracts/src/observability.js";',
        "const sharedFields = {",
        '  runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },',
        "} as const;",
        "const sharedRegistration = {",
        '  contractKind: "activity-log-operation" as const, schemaVersion: 1 as const,',
        '  category: "diagnostic" as const, owner: "zzz-fixture-typed-registry-spread",',
        '  emitter: "fixture", causal: "correlation" as const, lifecycle: "end" as const,',
        '  analyzerProjection: "timeline" as const, releaseImpact: "patch" as const,',
        "} as const;",
        'const sharedFailureClasses = ["fixture-failure"] as const;',
        "const operation = defineActivityLogOperation({",
        "  ...sharedRegistration,",
        '  op: "fixture.registry.spread",',
        "  fields: { ...sharedFields },",
        '  failureClasses: [...sharedFailureClasses], proofIds: ["fixture-proof"],',
        "});",
        'activityLogEvent(operation, {}, { runId: "run-1" });',
        "",
      ].join("\n"),
      (root) => {
        const registry = generateTypedActivityLogRegistry(root, [
          fixtureFailureClassContract({
            op: "fixture.registry.spread",
            owner: "zzz-fixture-typed-registry-spread",
            lifecycle: "end",
            evidenceClasses: ["completeness-state", "loss-state", "opaque-id"],
          }),
        ]);
        expect(registry.violations).toEqual([]);
        expect(registry.operations).toEqual([
          expect.objectContaining({
            op: "fixture.registry.spread",
            owner: "zzz-fixture-typed-registry-spread",
            fields: expect.objectContaining({
              runId: expect.objectContaining({ dataClass: "opaque-id" }),
            }),
          }),
        ]);
      },
    );
  });

  it("rejects a typed registration composed from a runtime spread", () => {
    withTypedRegistryFixture(
      "zzz-fixture-typed-registry-dynamic-spread",
      [
        'import { defineActivityLogOperation } from "../../keiko-contracts/src/observability.js";',
        "const runtimeFields = Object.freeze({});",
        "defineActivityLogOperation({",
        '  contractKind: "activity-log-operation" as const, schemaVersion: 1 as const,',
        '  op: "fixture.registry.dynamic-spread", category: "diagnostic",',
        '  owner: "zzz-fixture-typed-registry-dynamic-spread", emitter: "fixture",',
        "  fields: { ...runtimeFields },",
        '  causal: "correlation", lifecycle: "end", analyzerProjection: "timeline",',
        '  failureClasses: ["fixture-failure"], proofIds: ["fixture-proof"],',
        '  releaseImpact: "patch",',
        "});",
        "",
      ].join("\n"),
      (root) => {
        const registry = generateTypedActivityLogRegistry(root, []);
        expect(registry.operations).toEqual([]);
        expect(registry.violations).toContainEqual(
          expect.objectContaining({ code: "registration-not-literal" }),
        );
      },
    );
  });

  it("adds mandatory loss and completeness fields to every registered operation", () => {
    withTypedRegistryFixture(
      "zzz-fixture-incomplete-failure-class",
      [
        'import { activityLogEvent, defineActivityLogOperation } from "../../keiko-contracts/src/observability.js";',
        "const operation = defineActivityLogOperation({",
        '  contractKind: "activity-log-operation" as const, schemaVersion: 1 as const,',
        '  op: "fixture.registry.incomplete", category: "diagnostic",',
        '  owner: "zzz-fixture-incomplete-failure-class", emitter: "fixture", fields: {},',
        '  causal: "correlation", lifecycle: "failure", analyzerProjection: "failure-cluster",',
        '  failureClasses: ["fixture-failure"], proofIds: ["fixture-proof"],',
        '  releaseImpact: "patch",',
        "});",
        "activityLogEvent(operation, {}, {});",
        "",
      ].join("\n"),
      (root) => {
        const registry = generateTypedActivityLogRegistry(root, [
          fixtureFailureClassContract({
            op: "fixture.registry.incomplete",
            owner: "zzz-fixture-incomplete-failure-class",
            lifecycle: "failure",
          }),
        ]);
        expect(registry.failureClassCoverage).toMatchObject({
          supportedClassCount: 1,
          completeClassCount: 1,
          completeness: "complete",
        });
        expect(registry.violations).toEqual([]);
      },
    );
  });

  it("fails closed with a corrective action for a dynamic typed registration", () => {
    withTypedRegistryFixture(
      "zzz-fixture-dynamic-registry",
      [
        'import { defineActivityLogOperation } from "../../keiko-contracts/src/observability.js";',
        'let runtimeOp = "fixture.registry.dynamic";',
        "defineActivityLogOperation({",
        '  contractKind: "activity-log-operation" as const,',
        "  schemaVersion: 1 as const,",
        "  op: runtimeOp,",
        '  category: "diagnostic",',
        "});",
        "",
      ].join("\n"),
      (root) => {
        const registry = generateTypedActivityLogRegistry(root, []);
        expect(registry.operations).toEqual([]);
        expect(registry.violations).toEqual([
          expect.objectContaining({
            code: "registration-not-literal",
            site: "packages/zzz-fixture-dynamic-registry/src/fixture.ts:3",
            correctiveAction: expect.stringContaining("defineActivityLogOperation"),
          }),
        ]);
      },
    );
  });

  it("rejects a literal registration with missing governed metadata", () => {
    withTypedRegistryFixture(
      "zzz-fixture-invalid-registration",
      [
        'import { defineActivityLogOperation } from "../../keiko-contracts/src/observability.js";',
        "defineActivityLogOperation({",
        '  contractKind: "activity-log-operation" as const,',
        "  schemaVersion: 1 as const,",
        '  op: "fixture.registry.invalid",',
        '  category: "diagnostic",',
        "});",
        "",
      ].join("\n"),
      (root) => {
        const registry = generateTypedActivityLogRegistry(root, []);
        expect(registry.operations).toEqual([]);
        expect(registry.violations).toEqual([
          expect.objectContaining({ code: "registration-invalid", detail: "fields" }),
        ]);
      },
    );
  });

  it("rejects a string array without both item-count and per-item bounds", () => {
    withTypedRegistryFixture(
      "zzz-fixture-unbounded-registration",
      [
        'import { defineActivityLogOperation } from "../../keiko-contracts/src/observability.js";',
        "defineActivityLogOperation({",
        '  contractKind: "activity-log-operation" as const, schemaVersion: 1 as const,',
        '  op: "fixture.registry.unbounded", category: "diagnostic",',
        '  owner: "zzz-fixture-unbounded-registration", emitter: "fixture",',
        '  fields: { labels: { type: "string-array", dataClass: "opaque-id", required: true, maxItems: 4 } },',
        '  causal: "correlation", lifecycle: "state", analyzerProjection: "timeline",',
        '  failureClasses: ["fixture-failure"], proofIds: ["fixture-proof"],',
        '  releaseImpact: "patch",',
        "});",
        "",
      ].join("\n"),
      (root) => {
        expect(generateTypedActivityLogRegistry(root, []).violations).toContainEqual(
          expect.objectContaining({
            code: "registration-invalid",
            detail: "fields.labels",
          }),
        );
      },
    );
  });

  // #3532: persisted-line redaction omits an empty frames/causeChain array, so a required one
  // rejected every failure line without Keiko frames or a cause (found twice in production).
  it.each(["frames", "causeChain"])("rejects a registration that requires %s", (fieldName) => {
    withTypedRegistryFixture(
      "zzz-fixture-required-omitted-field",
      [
        'import { activityLogEvent, defineActivityLogOperation } from "../../keiko-contracts/src/observability.js";',
        "const operation = defineActivityLogOperation({",
        '  contractKind: "activity-log-operation" as const, schemaVersion: 1 as const,',
        '  op: "fixture.registry.omitted-field", category: "diagnostic",',
        '  owner: "zzz-fixture-required-omitted-field", emitter: "fixture",',
        `  fields: { ${fieldName}: { type: "string-array", dataClass: "opaque-id", required: true, maxLength: 64, maxItems: 4 } },`,
        '  causal: "correlation", lifecycle: "failure", analyzerProjection: "failure-cluster",',
        '  failureClasses: ["fixture-failure"], proofIds: ["fixture.registry.omitted-field.line"],',
        '  releaseImpact: "patch",',
        "});",
        "activityLogEvent(operation, {}, {});",
        "",
      ].join("\n"),
      (root) => {
        const registry = generateTypedActivityLogRegistry(root, []);
        expect(registry.operations).toEqual([]);
        expect(registry.violations).toContainEqual(
          expect.objectContaining({
            code: "registration-omitted-field-required",
            site: "packages/zzz-fixture-required-omitted-field/src/fixture.ts:2",
            detail: `fields.${fieldName}`,
          }),
        );
      },
    );
  });

  it("rejects an emitted event whose descriptor is not a discovered registration", () => {
    withTypedRegistryFixture(
      "zzz-fixture-unregistered-emission",
      [
        'import { activityLogEvent } from "../../keiko-contracts/src/observability.js";',
        'const unregistered = { contractKind: "activity-log-operation" as const };',
        "activityLogEvent(unregistered, {}, {});",
        "",
      ].join("\n"),
      (root) => {
        const registry = generateTypedActivityLogRegistry(root, []);
        expect(registry.operations).toEqual([]);
        expect(registry.violations).toEqual([
          expect.objectContaining({
            code: "emission-unregistered",
            site: "packages/zzz-fixture-unregistered-emission/src/fixture.ts:3",
          }),
        ]);
      },
    );
  });

  it("rejects duplicate operation registrations and registrations with no emitter", () => {
    withTypedRegistryFixture(
      "zzz-fixture-duplicate-registration",
      [
        'import { defineActivityLogOperation } from "../../keiko-contracts/src/observability.js";',
        "defineActivityLogOperation({",
        '  contractKind: "activity-log-operation" as const, schemaVersion: 1 as const,',
        '  op: "fixture.registry.duplicate", category: "diagnostic",',
        '  owner: "zzz-fixture-duplicate-registration", emitter: "fixture", fields: {',
        '    completeness: { type: "string", dataClass: "completeness-state", required: true },',
        '    loss: { type: "string", dataClass: "loss-state", required: true },',
        "  },",
        '  causal: "correlation", lifecycle: "end", analyzerProjection: "timeline",',
        '  failureClasses: ["fixture-failure"], proofIds: ["fixture-proof"],',
        '  releaseImpact: "patch",',
        "});",
        "defineActivityLogOperation({",
        '  contractKind: "activity-log-operation" as const, schemaVersion: 1 as const,',
        '  op: "fixture.registry.duplicate", category: "diagnostic",',
        '  owner: "zzz-fixture-duplicate-registration", emitter: "fixture", fields: {',
        '    completeness: { type: "string", dataClass: "completeness-state", required: true },',
        '    loss: { type: "string", dataClass: "loss-state", required: true },',
        "  },",
        '  causal: "correlation", lifecycle: "end", analyzerProjection: "timeline",',
        '  failureClasses: ["fixture-failure"], proofIds: ["fixture-proof"],',
        '  releaseImpact: "patch",',
        "});",
        "",
      ].join("\n"),
      (root) => {
        const registry = generateTypedActivityLogRegistry(root, [
          fixtureFailureClassContract({
            op: "fixture.registry.duplicate",
            owner: "zzz-fixture-duplicate-registration",
            lifecycle: "end",
          }),
        ]);
        expect(registry.violations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "registration-duplicate" }),
            expect.objectContaining({ code: "registration-not-emitted" }),
            expect.objectContaining({
              code: "failure-class-incomplete",
              detail: expect.stringContaining("failure-evidence"),
            }),
          ]),
        );
        expect(registry.failureClassCoverage).toMatchObject({
          supportedClassCount: 1,
          completeClassCount: 0,
          completeness: "incomplete",
        });
      },
    );
  });

  it("ignores a same-shape helper that is not the canonical contracts API", () => {
    withFixturePackage(
      "zzz-fixture-fake-registration",
      [
        "function defineActivityLogOperation<const T>(value: T): T { return value; }",
        "defineActivityLogOperation({",
        '  contractKind: "activity-log-operation" as const,',
        '  op: "fixture.fake.registration", category: "diagnostic",',
        "});",
        "",
      ].join("\n"),
      (root) => {
        const registry = generateTypedActivityLogRegistry(root, []);
        expect(registry).toMatchObject({ schemaVersion: 1, operations: [], violations: [] });
        expect(registry.schemaDigest).toMatch(/^[a-f0-9]{64}$/u);
        expect(registry.catalogDigest).toMatch(/^[a-f0-9]{64}$/u);
      },
    );
  });

  it(
    "pins the separate future lifecycle contract without inventing runtime source sites",
    async () => {
      const catalog = generateCurrentOpCatalog();
      const bytes = readFileSync(join(repoRoot, TOOL_CATALOG_OPERATIONS_PATH), "utf8");
      expect(catalog.operationContracts).toEqual([TOOL_CATALOG_OPERATIONS_PATH]);
      expect(bytes).toBe(await toolCatalogOperationsBytes(repoRoot));
      expect(JSON.parse(bytes)).toEqual(generateToolCatalogOperations(repoRoot));
    },
    REPOSITORY_SCAN_TEST_TIMEOUT_MS,
  );
  it("matches the checked-in file exactly, by value, in the same order", () => {
    const regenerated = generateCurrentOpCatalog();
    const checkedIn = readCheckedInCatalog();
    expect(regenerated).toEqual(checkedIn);
  });

  // #3532: the failure-surface inventory is a generated view over the same typed registry, pinned
  // byte for byte so a new operation, a moved proof or a reformatted file cannot leave it stale.
  it(
    "matches the checked-in failure-surface inventory byte for byte",
    async () => {
      const generated = await formatGeneratedJson(
        generateActivityLogFailureSurfaceInventory(repoRoot, generateCurrentTypedRegistry()),
      );
      expect(failureSurfaceInventoryDrift(generated, readFileSync(INVENTORY_PATH, "utf8"))).toBe(
        undefined,
      );
    },
    REPOSITORY_SCAN_TEST_TIMEOUT_MS,
  );

  it("names the stale inventory when its checked-in bytes drift from the generator", () => {
    const checkedIn = readFileSync(INVENTORY_PATH, "utf8");
    const tampered = checkedIn.replace('"lifecycle-crash"', '"lifecycle-crashed"');
    expect(tampered).not.toBe(checkedIn);
    expect(failureSurfaceInventoryDrift(checkedIn, tampered)).toMatch(
      /failure-surface-inventory\.generated\.json is stale/u,
    );
    expect(failureSurfaceInventoryDrift(checkedIn, `${checkedIn}\n`)).toMatch(/is stale/u);
    expect(failureSurfaceInventoryDrift(checkedIn, checkedIn)).toBeUndefined();
  });

  it("has no failure-surface inventory violations", () => {
    expect(JSON.parse(readFileSync(INVENTORY_PATH, "utf8")).violations).toEqual([]);
  });

  it("does not recursively rediscover the generated runtime registry", () => {
    const catalog = generateCurrentOpCatalog();
    expect(
      catalog.entries.some((entry) =>
        entry.site.startsWith("packages/keiko-contracts/src/activity-log-registry.generated.ts:"),
      ),
    ).toBe(false);
  });

  // The generator's own audit is expected to be empty today (verified in the generator's
  // docstring against every current literal) — this is the assertion AGENTS.md's addenda calls
  // for: red only when a violation genuinely exists, never widened to accept one.
  it("has no OP_NAME_PATTERN violations in the checked-in catalog", () => {
    const checkedIn = readCheckedInCatalog();
    expect(checkedIn.violations).toEqual([]);
  });

  it("fails drift when the authoritative typed registry has any violation", () => {
    expect(readCheckedInCatalog().typedRegistry.violations).toEqual([]);
  });

  it(
    "generates only primitive types whose data-class semantics can validate them",
    () => {
      const registry = generateCurrentTypedRegistry();
      for (const operation of registry.operations) {
        for (const [name, contract] of Object.entries(operation.fields)) {
          expect(
            ACTIVITY_FIELD_TYPES_BY_DATA_CLASS[contract.dataClass],
            `${operation.op}.${name} has incompatible ${contract.type}/${contract.dataClass}`,
          ).toContain(contract.type);
        }
      }
    },
    REPOSITORY_SCAN_TEST_TIMEOUT_MS,
  );

  it(
    "projects loss signals only from explicit loss lifecycle operations",
    () => {
      const coverage = generateCurrentTypedRegistry().failureClassCoverage;
      const byFailureClass = new Map(coverage.classes.map((entry) => [entry.failureClass, entry]));
      // A state-only class projects no loss signal; the pin class projects exactly its one
      // registered loss marker (#3530 retired the capacity class this pin first sat on).
      expect(byFailureClass.get("activity-log-retention")?.lossSignals).toEqual([]);
      expect(byFailureClass.get("activity-log-pin")?.lossSignals).toEqual([
        "activity-log.pin.quota-exhausted",
      ]);
      expect(byFailureClass.get("activity-log-contract")?.lossSignals).toEqual([
        "server-log.line-dropped",
        "server-log.write-failed",
      ]);
    },
    REPOSITORY_SCAN_TEST_TIMEOUT_MS,
  );

  it("carries the schema and generator identity the catalog contract promises", () => {
    const checkedIn = readCheckedInCatalog();
    expect(checkedIn.$schema).toBe("keiko-activity-log-registry/2");
    expect(checkedIn.generatedBy).toBe("scripts/generate-op-catalog.mjs");
    expect(checkedIn.authority).toEqual({
      operationSource: "typedRegistry.operations",
      legacyDiscovery: "non-authoritative-migration-input",
    });
    expect(checkedIn.legacyDiscovery).toEqual({
      dynamicCount: checkedIn.entries.filter((entry) => entry.op === "<dynamic>").length,
      unknownCategoryCount: checkedIn.entries.filter((entry) => entry.category === "unknown")
        .length,
      authoritative: false,
    });
    expect(
      checkedIn.typedRegistry.operations.some(
        (operation) => operation.op === "<dynamic>" || operation.category === "unknown",
      ),
    ).toBe(false);
    expect(checkedIn.typedRegistry.obligationCategories).toEqual([
      "typed-operation-registration",
      "closed-bounded-fields",
      "causal-correlation",
      "lifecycle-evidence",
      "failure-evidence",
      "loss-evidence",
      "analyzer-projection",
      "executable-proof",
      "release-impact",
    ]);
    expect(checkedIn.typedRegistry.exemptionSchema).toMatchObject({
      schemaVersion: 1,
      scope: "exact-operation-and-failure-class",
      maximumEntries: 64,
    });
    expect(checkedIn.typedRegistry.exemptions).toEqual([]);
    expect(checkedIn.typedRegistry.failureClassCoverage).toMatchObject({
      schemaVersion: 1,
      releaseExpectation: "100%-complete",
      completeness: "complete",
    });
  });

  // PR #3394 regression: a stale regeneration dropped these 26 still-emitted operations while
  // leaving the catalog internally self-consistent. Pin the incident's complete vocabulary at the
  // production generator boundary so regenerating the JSON cannot silently bless the same loss.
  it("retains every operation lost by the issue-to-PR catalog regression", () => {
    const catalog = generateCurrentOpCatalog();
    expect(catalog.operations).toEqual(
      expect.arrayContaining([
        "coding-runtime.description",
        "coding-runtime.operation.refused",
        "coding-runtime.run.recovery-acknowledged",
        "coding-sidecar.gateway.readiness-insufficient",
        "coding-sidecar.gateway.rejected",
        "coding-sidecar.tool-facade.rejected",
        "editor.producer-turn.completed",
        "gateway.tool-catalog.native-passthrough",
        "git-change.chat.apply",
        "git-change.chat.blocked",
        "git-change.chat.connected",
        "git-change.chat.refreshed",
        "git-change.chat.stale",
        "git.delivery.commit.approval.minted",
        "git.delivery.commit.approval.required",
        "git.delivery.pr.approval.minted",
        "git.delivery.pr.approval.required",
        "git.delivery.push.approval.minted",
        "git.delivery.push.approval.required",
        "git.journey-outcome.recorded",
        "pr-description.chat.turn.admitted",
        "pr-description.chat.turn.denied",
        "pr-description.model-egress.denied",
        "pr-description.workbench.egress.denied",
        "runtime.confinement.unavailable",
        "tool-catalog.dispatch-unbound",
      ]),
    );
  });

  // These operations have migrated from the predecessor's object-argument inference into their
  // owning typed registrations. Pin the authoritative category instead of requiring the legacy
  // scanner to infer through a cross-module emitter.
  it("retains deterministic categories after indexing operations migrate to typed emitters", () => {
    const registry = generateCurrentTypedRegistry();
    const byOp = (op) => registry.operations.find((entry) => entry.op === op);
    expect(byOp("indexing.document.failed")?.category).toBe("indexing");
    expect(byOp("embedding.preflight.identity-rejected")?.category).toBe("embedding");
  });

  // Proves the drift gate actually fails closed: mutating a COPY of the checked-in catalog must
  // make it stop matching what the generator produces right now. Without this, a future change
  // that made `generateOpCatalog` just return the parsed checked-in file (or made the "matches the
  // checked-in file" comparison above lenient) could leave every other test in this file green.
  describe("rejects a tampered copy of the checked-in catalog", () => {
    it("when one entry's op value is changed", () => {
      const regenerated = generateCurrentOpCatalog();
      const tampered = structuredClone(readCheckedInCatalog());
      const first = tampered.entries[0];
      if (first === undefined) throw new Error("checked-in catalog has no entries to tamper with");
      tampered.entries[0] = { ...first, op: `${first.op}.tampered` };
      expect(regenerated).not.toEqual(tampered);
    });

    it("when one entry is removed", () => {
      const regenerated = generateCurrentOpCatalog();
      const tampered = structuredClone(readCheckedInCatalog());
      tampered.entries.pop();
      expect(regenerated).not.toEqual(tampered);
    });

    it("when two entries are reordered", () => {
      const regenerated = generateCurrentOpCatalog();
      const tampered = structuredClone(readCheckedInCatalog());
      const [first, second] = tampered.entries;
      if (first === undefined || second === undefined) {
        throw new Error("checked-in catalog needs at least two entries to reorder");
      }
      tampered.entries[0] = second;
      tampered.entries[1] = first;
      expect(regenerated).not.toEqual(tampered);
    });
  });

  // Pins the op-name vocabulary shape with fixed positive/negative examples, driven through the
  // real generator entry point rather than by re-applying OP_NAME_PATTERN to already-generated
  // entries (the previous version of this test: it turned red only when `regenerated.violations`
  // was non-empty, which the drift-equality and violations-empty tests above already detect) or by
  // importing OP_NAME_PATTERN into the test at all (AGENTS.md §7: a fixture must never restate a
  // formula the code under test owns — asserting the SAME regex against a STRING is exactly that).
  it("flags a malformed op name and accepts a well-formed one", () => {
    withFixturePackage(
      "zzz-fixture-vocabulary",
      [
        "export const events = [",
        '  { category: "custom", op: "gateway.chat.completed" },',
        '  { category: "custom", op: "Gateway.Chat" },',
        '  { category: "custom", op: "a.b.c.d.e.f.g" },',
        "];",
        "",
      ].join("\n"),
      (root) => {
        const catalog = generateOpCatalog(root);
        const violationOps = catalog.violations.map((violation) => violation.op);
        expect(violationOps).toContain("Gateway.Chat");
        expect(violationOps).toContain("a.b.c.d.e.f.g");
        expect(violationOps).not.toContain("gateway.chat.completed");
      },
    );
  });

  // A package root outside any hardcoded list must still be scanned — `SCANNED_PACKAGE_ROOTS` was
  // replaced by `scannedPackageRoots`, which lists `packages/*/src` directly, so a new instrumented
  // package is never invisible to the generator again.
  it("discovers instrumentation in a package outside any hardcoded root list", () => {
    withFixturePackage(
      "zzz-fixture-new-package",
      'export const events = [\n  { category: "custom", op: "fixture.new-package.discovered" },\n];\n',
      (root) => {
        const catalog = generateOpCatalog(root);
        const ops = catalog.entries.map((entry) => entry.op);
        expect(ops).toContain("fixture.new-package.discovered");
      },
    );
  });

  // A nested ternary must resolve to `<dynamic>`, never silently drop the first branch's literal.
  // `flag ? "a" : other ? "b" : "c"` used to match `TERNARY_OF_LITERALS`'s lazy prefix against the
  // SECOND `?`, returning `["b", "c"]` and dropping `"a"` without any `<dynamic>` marker at all.
  it("reports a nested ternary as dynamic instead of dropping its first branch", () => {
    withFixturePackage(
      "zzz-fixture-nested-ternary",
      [
        "const flag = true;",
        "const other = false;",
        "export const events = [",
        '  { category: "custom", op: flag ? "fixture.branch.a" : other ? "fixture.branch.b" : "fixture.branch.c" },',
        "];",
        "",
      ].join("\n"),
      (root) => {
        const catalog = generateOpCatalog(root);
        const fixtureEntries = catalog.entries.filter((entry) => entry.site.includes("fixture.ts"));
        const ops = fixtureEntries.map((entry) => entry.op);
        expect(ops).not.toContain("fixture.branch.a");
        expect(ops).not.toContain("fixture.branch.b");
        expect(ops).not.toContain("fixture.branch.c");
        expect(ops).toContain("<dynamic>");
      },
    );
  });

  // A commented-out `op:` must never become a catalog entry, and blanking a preceding comment must
  // not shift the LINE NUMBER of the real entry that follows it — the generator used to strip
  // comments only for the file-level category-binding tier, and its line-comment handling emitted
  // an extra newline per `//` comment, which would have shifted this site's line number by 3.
  it("ignores a commented-out op and keeps the real entry's line number exact", () => {
    withFixturePackage(
      "zzz-fixture-comments",
      [
        "// comment line 1",
        "// comment line 2",
        // Shaped exactly like the real false positive this fix removed from the checked-in
        // catalog: `server-logger.ts`'s header illustrates a call as a doc comment
        // (`// log.warn({ op: "indexing.job.skipped", ... });`), and a raw (unblanked) scan reads
        // the quoted literal right off that comment line as a real entry.
        '// log.warn({ op: "fixture.comment.op", extra: { reason } });',
        "export const events = [",
        '  { category: "custom", op: "fixture.real.op" },',
        "];",
        "",
      ].join("\n"),
      (root) => {
        const catalog = generateOpCatalog(root);
        const fixtureEntries = catalog.entries.filter((entry) => entry.site.includes("fixture.ts"));
        const ops = fixtureEntries.map((entry) => entry.op);
        expect(ops).not.toContain("fixture.comment.op");
        const real = fixtureEntries.find((entry) => entry.op === "fixture.real.op");
        expect(real?.site.endsWith(":5")).toBe(true);
      },
    );
  });

  // A type/interface/parameter declaration named `op` must be skipped entirely — no entry at all,
  // dynamic or otherwise — because it never carries a runtime value.
  // Covers both new `isTypeAnnotationValue` branches this change added — a bare PascalCase type
  // reference (`OpName`) and a quoted string-literal union (`"pull" | "put"`) — neither of which
  // the pre-existing `op: string;`/`op: () => Promise<void>` cases below exercise. Both new
  // members deliberately end WITHOUT a `;`, closing over their interface's own `}` instead: a
  // `;`- or `)`-terminated member is already skipped by `closesOverDeclaration` regardless of
  // `isTypeAnnotationValue`, so ending on `;`/`)` would let either new branch be silently deleted
  // without ever failing this test.
  it("skips op type declarations without emitting a dynamic entry", () => {
    withFixturePackage(
      "zzz-fixture-type-declarations",
      [
        "interface FixtureEvent {",
        "  readonly op: string;",
        "}",
        "",
        "interface FixtureTypedEvent {",
        "  readonly op: OpName",
        "}",
        "",
        "interface FixtureUnionEvent {",
        '  readonly op: "pull" | "put"',
        "}",
        "",
        "function fixtureHelper(op: () => Promise<void>): void {",
        "  op().catch(() => {});",
        "}",
        "",
        "export const events = [",
        '  { category: "custom", op: "fixture.real.declaration-check" },',
        "];",
        "",
      ].join("\n"),
      (root) => {
        const catalog = generateOpCatalog(root);
        const fixtureEntries = catalog.entries.filter((entry) => entry.site.includes("fixture.ts"));
        expect(fixtureEntries).toHaveLength(1);
        expect(fixtureEntries[0]?.op).toBe("fixture.real.declaration-check");
      },
    );
  });

  // Regression: before this fix, `isTypeAnnotationValue`'s parenthesis branch matched ANY value
  // starting with `(`, so a parenthesized RUNTIME value (not a function type) was skipped like a
  // type annotation — no entry at all, not even `<dynamic>`. Requiring a top-level `=>` after the
  // MATCHING close paren (found by depth, not a regex) narrows the branch to actual function
  // types, so a parenthesized runtime expression now falls through to `resolveLiteralValues`
  // (which cannot enumerate a ternary whose match is broken by the trailing `)`) and reports
  // `<dynamic>` instead of silently vanishing from the catalog.
  it("reports a parenthesized runtime value as dynamic instead of dropping it as a type", () => {
    withFixturePackage(
      "zzz-fixture-parenthesized-runtime-value",
      [
        "export function fixtureRuntimeParen(flag) {",
        '  return { category: "custom", op: (flag ? "a" : "b") };',
        "}",
        "",
      ].join("\n"),
      (root) => {
        const catalog = generateOpCatalog(root);
        const fixtureEntries = catalog.entries.filter((entry) => entry.site.includes("fixture.ts"));
        expect(fixtureEntries.map((entry) => entry.op)).toEqual(["<dynamic>"]);
      },
    );
  });

  // Regression (#2902 PR review, round 3): before this fix, `isTypeAnnotationValue`'s
  // parenthesized-function-type check looked only at the value's own content (does it start with
  // `(` and have a top-level `=>` after the matching close paren?), never at WHERE its value span
  // actually stopped. A runtime arrow function assigned as an object-literal property — the exact
  // shape CodeRabbit's finding cited, `op: (value) => value,` — is structurally identical to a
  // function-type annotation past the opening paren, and was misclassified as a type: the site was
  // dropped entirely, not even recorded `<dynamic>`. The fix defers the parenthesized-function-type
  // case entirely to `closesOverDeclaration`'s `stopChar` check (already run first in
  // `opPropertyEntries`), so a real declaration (`;` or the enclosing `)`) is still skipped, while
  // an object-literal property — which always stops at `,` or `}` — now falls through to
  // `resolveLiteralValues` and reports `<dynamic>` instead of vanishing.
  it("reports a runtime arrow-function op value as dynamic instead of dropping it as a type", () => {
    withFixturePackage(
      "zzz-fixture-runtime-arrow-value",
      [
        "export function fixtureRuntimeArrow(value) {",
        "  return {",
        '    category: "custom",',
        "    op: (value) => value,",
        "  };",
        "}",
        "",
      ].join("\n"),
      (root) => {
        const catalog = generateOpCatalog(root);
        const fixtureEntries = catalog.entries.filter((entry) => entry.site.includes("fixture.ts"));
        expect(fixtureEntries).toHaveLength(1);
        expect(fixtureEntries[0]?.op).toBe("<dynamic>");
        expect(fixtureEntries[0]?.category).toBe("custom");
      },
    );
  });

  // A positional-helper call whose argument the bracket scan cannot read (here: an unterminated
  // call reaching end of file) must surface as a `<dynamic>` entry, never vanish silently.
  // `gatewayEvent` is one of the unscoped `POSITIONAL_OP_HELPERS` entries, so it is recognized in
  // any file, fixture included.
  it("reports an unreadable helper-call argument as dynamic instead of dropping the site", () => {
    withFixturePackage(
      "zzz-fixture-unreadable-call",
      "export const trigger = gatewayEvent(\n",
      (root) => {
        const catalog = generateOpCatalog(root);
        const fixtureEntries = catalog.entries.filter((entry) => entry.site.includes("fixture.ts"));
        expect(fixtureEntries).toHaveLength(1);
        expect(fixtureEntries[0]?.op).toBe("<dynamic>");
        expect(fixtureEntries[0]?.category).toBe("gateway");
      },
    );
  });
});

describe("approved diagnostic operation source extraction", () => {
  it("captures literal operations through the diagnostic builder and emitter", () => {
    withFixturePackage(
      "keiko-server",
      `
      emitServerDiagnostic(sink, {
        operation: "tool-catalog.invocation.failed",
        correlationId: "fixture", errorClass: "Error", message: "server-operation-failed",
      });
      const record = serverDiagnosticFromError({
        operation: "tool-catalog.bind.unavailable", error,
      });
      emitServerDiagnostic(sink, serverDiagnosticFromError({ operation: "fixture.nested", error }));
      defaultServerDiagnosticSink.record({ operation: "fixture.default", errorClass: "Error" });
    `,
      (root) => {
        const catalog = generateOpCatalog(root);
        const literals = catalog.entries.filter((entry) => entry.op !== "<dynamic>");
        expect(literals.map((entry) => entry.op)).toEqual([
          "fixture.default",
          "fixture.nested",
          "tool-catalog.bind.unavailable",
          "tool-catalog.invocation.failed",
        ]);
        expect(
          literals.every(
            (entry) =>
              entry.category === "diagnostic" && entry.sourceKind === "diagnostic-operation",
          ),
        ).toBe(true);
      },
    );
  });
  it("does not catalogue payload fields, nested fields, prose or unsupported wrappers as literal operations", () => {
    withFixturePackage(
      "keiko-server",
      `
      const data = { operation: "payload.operation" };
      unsupportedDiagnostic({ operation: "wrapper.operation" });
      object.emitServerDiagnostic(sink, { operation: "object.operation" });
      const prose = 'emitServerDiagnostic(sink, { operation: "prose.operation" })';
      emitServerDiagnostic(sink, { extra: { operation: "nested.payload" }, operation: runtimeOperation });
      emitServerDiagnostic(sink, wrap({ operation: "wrapped.operation" }));
    `,
      (root) => {
        const catalog = generateOpCatalog(root);
        expect(catalog.entries.every((entry) => entry.op === "<dynamic>")).toBe(true);
        expect(catalog.entries).toHaveLength(2);
      },
    );
  });
});

describe("diagnostic source completeness and false-positive boundaries", () => {
  it("does not resolve a constant from prose or conflicting lexical bindings", () => {
    withFixturePackage(
      "keiko-server",
      `
      const FROM_PROSE = runtime();
      const prose = 'const FROM_PROSE = "fixture.fabricated";';
      emitServerDiagnostic(sink, { operation: FROM_PROSE });
      if (flag) { const SHADOWED = "fixture.first"; emitServerDiagnostic(sink, { operation: SHADOWED }); }
      else { const SHADOWED = "fixture.second"; emitServerDiagnostic(sink, { operation: SHADOWED }); }
      const MIXED = "fixture.constant";
      function local() { const MIXED = runtime(); emitServerDiagnostic(sink, { operation: MIXED }); }
    `,
      (root) => {
        const catalog = generateOpCatalog(root);
        expect(catalog.entries).toHaveLength(4);
        expect(catalog.entries.every((entry) => entry.op === "<dynamic>")).toBe(true);
      },
    );
  });
});

describe("diagnostic operation projection rules", () => {
  it("keeps source sites while deduplicating the actual operation vocabulary", () => {
    withFixturePackage(
      "keiko-server",
      `
      const FAILURE_OP = "fixture.repeat";
      emitServerDiagnostic(sink, { operation: FAILURE_OP });
      emitServerDiagnostic(sink, { operation: "fixture.repeat" });
      emitServerDiagnostic(sink, { operation: flag ? "fixture.same" : "fixture.same" });
    `,
      (root) => {
        const catalog = generateOpCatalog(root);
        expect(catalog.operations).toEqual(["fixture.repeat", "fixture.same"]);
        expect(catalog.entries.filter((entry) => entry.op === "fixture.repeat")).toHaveLength(2);
        expect(new Set(catalog.entries.map((entry) => entry.site)).size).toBe(3);
        expect(catalog.entries.filter((entry) => entry.op === "fixture.same")).toHaveLength(1);
      },
    );
  });
  it("keeps concatenation, templates and overwritable fields dynamic", () => {
    withFixturePackage(
      "keiko-server",
      [
        'emitServerDiagnostic(sink, { operation: "fixture." + suffix });',
        "emitServerDiagnostic(sink, { operation: `fixture.${suffix}` });",
        'emitServerDiagnostic(sink, { operation: "fixture.before-spread", ...input });',
        'emitServerDiagnostic(sink, { operation: "fixture.before-key", [key]: value });',
        'emitServerDiagnostic(sink, { operation: "fixture.before-getter", get operation() { return value; } });',
        'emitServerDiagnostic(sink, { ...input, operation: "fixture.after-spread" });',
        'serverDiagnosticFromError(({ operation: "fixture.wrapped" }));',
        'emitServerDiagnostic(sink, { extra: { operation: "nested.payload" }, operation: "fixture.outer" });',
      ].join("\n"),
      (root) => {
        const catalog = generateOpCatalog(root);
        expect(catalog.operations).toEqual(["fixture.after-spread", "fixture.outer"]);
        expect(catalog.entries.filter((entry) => entry.op === "<dynamic>")).toHaveLength(6);
      },
    );
  });
  it("retains approved diagnostic spelling without relaxing activity-op validation", () => {
    withFixturePackage(
      "keiko-server",
      `
      emitServerDiagnostic(sink, { operation: "figma.snapshotBuild" });
      serverDiagnosticFromError({ operation: "POST /api/gateway/setup" });
      emitServerDiagnostic(sink, { operation: "invalid@operation" });
      log.write({ category: "diagnostic", op: "figma.snapshotBuild" });
    `,
      (root) => {
        const catalog = generateOpCatalog(root);
        expect(catalog.violations.map((entry) => entry.op)).toEqual([
          "figma.snapshotBuild",
          "invalid@operation",
        ]);
        expect(
          catalog.entries.find((entry) => entry.op === "POST /api/gateway/setup")?.sourceKind,
        ).toBe("diagnostic-operation");
      },
    );
  });
  it("includes the three current direct-sink owners and ignores unrelated record methods", () => {
    const catalog = generateCurrentOpCatalog();
    for (const operation of [
      "grounded.entailment",
      "coding-runtime.sse-fanout",
      "coding-app-session.channel.subscribe",
    ])
      expect(
        catalog.entries.some(
          (entry) => entry.op === operation && entry.sourceKind === "diagnostic-operation",
        ),
      ).toBe(true);
    withFixturePackage(
      "keiko-server",
      'diagnostics.record({operation: "unapproved.record"}); sink.record({operation: "unapproved.sink"});',
      (root) => {
        expect(generateOpCatalog(root).entries).toEqual([]);
      },
    );
  });
  it("proves closed spread keys without guessing runtime or overriding keys", () => {
    withFixturePackage(
      "keiko-server",
      [
        'emitServerDiagnostic(sink, { operation: "fixture.closed", ...(code === undefined ? {} : { code }) });',
        'emitServerDiagnostic(sink, { operation: "fixture.object", ...{ code, source: nested() } });',
        'emitServerDiagnostic(sink, { operation: "fixture.overridden", ...(flag ? {} : { operation }) });',
        'emitServerDiagnostic(sink, { operation: "fixture.computed", ...(flag ? {} : { [key]: value }) });',
        'emitServerDiagnostic(sink, { operation: "fixture.spread", ...(flag ? {} : { ...input }) });',
        'emitServerDiagnostic(sink, { operation: "fixture.shorthand", operation });',
        'emitServerDiagnostic(sink, { operation: "fixture.method", operation() { return value; } });',
        'emitServerDiagnostic(sink, { operation: "fixture.getter", get "operation"() { return value; } });',
      ].join("\n"),
      (root) => {
        const catalog = generateOpCatalog(root);
        expect(catalog.operations).toEqual(["fixture.closed", "fixture.object"]);
        expect(catalog.entries.filter((entry) => entry.op === "<dynamic>")).toHaveLength(6);
      },
    );
  });
  it("rejects a generated vocabulary or source-kind tamper", () => {
    const generated = generateCurrentOpCatalog();
    const removed = structuredClone(generated);
    removed.operations.pop();
    expect(removed).not.toEqual(generated);
    const provenance = structuredClone(generated);
    const diagnostic = provenance.entries.find(
      (entry) => entry.sourceKind === "diagnostic-operation",
    );
    expect(diagnostic).toBeDefined();
    delete diagnostic.sourceKind;
    expect(provenance).not.toEqual(generated);
  });
});
