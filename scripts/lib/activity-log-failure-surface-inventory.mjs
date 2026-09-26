// Assembles docs/observability/failure-surface-inventory.generated.json (#3532) from the typed
// Activity Log registry, the closed surface tables in activity-log-failure-surfaces.mjs, and the
// literal proof/scenario calls found in the test sources. Stable, machine-readable input for the
// permanent Activity Log quality gate (#3540); it adds no second catalog, analyzer or gate.

import { CODING_WORKBENCH_MODES } from "../../packages/keiko-contracts/dist/coding-workbench.js";
import {
  ACTIVITY_LOG_FAILURE_MODES,
  ACTIVITY_LOG_FAILURE_SURFACES,
  ACTIVITY_LOG_OWNER_PORTS,
  ACTIVITY_LOG_SURFACE_RULES,
  failureModeOf,
  failureSurfaceOwnerPortViolations,
  failureSurfaceRuleViolations,
  scanActivityLogProofCalls,
  surfaceRuleFor,
} from "./activity-log-failure-surfaces.mjs";

const FAILURE_SURFACE_INVENTORY_SCHEMA = "keiko-activity-log-failure-surface-inventory/1";

// Every registered proof id and every scenario a failure class maps to must resolve: an unresolved
// one is a violation. `options.enforceResolution: false` exists only so negative fixtures can
// isolate the other rules.
const RESOLUTION_ENFORCED = true;

function compareCodepoints(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sortedUnique(values) {
  return [...new Set(values)].toSorted(compareCodepoints);
}

function violation(code, site, detail, correctiveAction) {
  return { code, site, detail, correctiveAction };
}

function inventoryOperation(registration, context) {
  const rule = surfaceRuleFor(registration, context.surfaceRules);
  return {
    op: registration.op,
    owner: registration.owner,
    emitter: registration.emitter,
    port: context.ownerPorts[registration.owner]?.port ?? null,
    surface: rule?.surface ?? null,
    category: registration.category,
    lifecycle: registration.lifecycle,
    causal: registration.causal,
    analyzerProjection: registration.analyzerProjection,
    failureClasses: registration.failureClasses,
    proofIds: registration.proofIds,
  };
}

function unmappedOperationViolations(operations) {
  return operations
    .filter((operation) => operation.surface === null)
    .map((operation) =>
      violation(
        "surface-unmapped",
        `operations.${operation.op}`,
        `${operation.owner}:${operation.emitter}`,
        "Map the operation's owner package and emitter module to a product surface.",
      ),
    );
}

function failureClassEntry(contract, operations) {
  const members = operations.filter((operation) =>
    operation.failureClasses.includes(contract.failureClass),
  );
  const surfaces = sortedUnique(
    members.map((operation) => operation.surface).filter((surface) => surface !== null),
  );
  const mode = failureModeOf(members);
  return {
    failureClass: contract.failureClass,
    surfaces,
    mode,
    scenarios: surfaces.map((surface) => `${surface}.${mode}`),
  };
}

function proofCallsById(calls) {
  return Map.groupBy(
    calls.filter((call) => call.kind === "proof" && call.id !== undefined),
    (call) => call.id,
  );
}

function proofEntries(operations, calls) {
  const byId = proofCallsById(calls);
  return operations.flatMap((operation) =>
    operation.proofIds.map((proofId) => {
      const owning = (byId.get(proofId) ?? []).filter((call) =>
        call.file.startsWith(`packages/${operation.owner}/`),
      );
      return {
        proofId,
        op: operation.op,
        owner: operation.owner,
        surface: operation.surface,
        status: owning.length > 0 ? "resolved" : "unresolved",
        testFiles: sortedUnique(owning.map((call) => call.file)),
      };
    }),
  );
}

function proofCallViolations(operations, calls) {
  const ownerByProof = new Map(
    operations.flatMap((operation) => operation.proofIds.map((id) => [id, operation.owner])),
  );
  return calls
    .filter((call) => call.kind === "proof")
    .flatMap((call) => {
      if (call.id === undefined)
        return [
          violation(
            "proof-call-not-literal",
            call.site,
            "expectActivityLogProof",
            "Pass the registered proof id as a string literal so the generator can resolve it.",
          ),
        ];
      const owner = ownerByProof.get(call.id);
      if (owner === undefined)
        return [
          violation(
            "proof-unregistered",
            call.site,
            call.id,
            "Use a proof id a registered operation declares, or register the proof id.",
          ),
        ];
      // A call in ANOTHER package is a misplaced proof. The cross-package root suite (tests/,
      // e.g. the scenario matrix) may assert persisted lines too; it just never resolves a proof.
      return call.file.startsWith(`packages/${owner}/`) || !call.file.startsWith("packages/")
        ? []
        : [
            violation(
              "proof-outside-owner",
              call.site,
              call.id,
              "Prove the operation in a test of its owning package, through its production emitter.",
            ),
          ];
    });
}

function unresolvedProofViolations(proofs, enforceResolution) {
  if (!enforceResolution) return [];
  return proofs
    .filter((proof) => proof.status === "unresolved")
    .map((proof) =>
      violation(
        "proof-unresolved",
        `proofs.${proof.proofId}`,
        proof.op,
        "Add an owning-package test that calls expectActivityLogProof with a production-persisted line.",
      ),
    );
}

function isScenarioId(id) {
  const [surface, mode, ...rest] = id.split(".");
  return (
    rest.length === 0 &&
    ACTIVITY_LOG_FAILURE_SURFACES.includes(surface) &&
    ACTIVITY_LOG_FAILURE_MODES.includes(mode)
  );
}

function scenarioEntries(classes, calls) {
  const scenarioCalls = calls.filter((call) => call.kind === "scenario" && call.id !== undefined);
  const required = sortedUnique([
    ...classes.flatMap((entry) => entry.scenarios),
    ...scenarioCalls.map((call) => call.id).filter(isScenarioId),
  ]);
  return required.map((scenario) => {
    const [surface, mode] = scenario.split(".");
    const resolving = scenarioCalls.filter((call) => call.id === scenario);
    return {
      scenario,
      surface,
      mode,
      status: resolving.length > 0 ? "resolved" : "unresolved",
      testFiles: sortedUnique(resolving.map((call) => call.file)),
      failureClasses: classes
        .filter((entry) => entry.scenarios.includes(scenario))
        .map((entry) => entry.failureClass),
    };
  });
}

function scenarioViolations(scenarios, calls, enforceResolution) {
  const callViolations = calls
    .filter((call) => call.kind === "scenario")
    .filter((call) => call.id === undefined || !isScenarioId(call.id))
    .map((call) =>
      violation(
        call.id === undefined ? "scenario-call-not-literal" : "scenario-unknown",
        call.site,
        call.id ?? "expectActivityLogScenario",
        "Name the scenario as a literal '<surface>.<failure mode>' from the closed vocabularies.",
      ),
    );
  const unresolved = enforceResolution
    ? scenarios
        .filter((scenario) => scenario.status === "unresolved")
        .map((scenario) =>
          violation(
            "scenario-unresolved",
            `scenarios.${scenario.scenario}`,
            scenario.failureClasses.join(","),
            "Add an end-to-end scenario that drives this surface and mode to a complete report.",
          ),
        )
    : [];
  return [...callViolations, ...unresolved];
}

// Only what op-catalog.generated.json does not already carry: the surface each operation maps to
// and the port it emits through. Everything else about an operation (fields, lifecycle, causal
// mode, analyzer projection, failure classes, proof ids) is joined from the catalog by op name.
function surfaceEntry(surface, operations, scenarios) {
  const members = operations.filter((operation) => operation.surface === surface);
  return {
    surface,
    owners: sortedUnique(members.map((operation) => operation.owner)),
    ports: sortedUnique(members.map((operation) => operation.port).filter(Boolean)),
    operations: members.map((operation) => operation.op).toSorted(compareCodepoints),
    scenarios: scenarios
      .filter((scenario) => scenario.surface === surface)
      .map((scenario) => scenario.scenario),
  };
}

function failureClassScenarios(classes) {
  return Object.fromEntries(classes.map((entry) => [entry.failureClass, entry.scenarios]));
}

function resolutionFiles(entries, key) {
  return Object.fromEntries(entries.map((entry) => [entry[key], entry.testFiles]));
}

function emptySurfaceViolations(surfaces) {
  return surfaces
    .filter((entry) => entry.operations.length === 0)
    .map((entry) =>
      violation(
        "surface-uninstrumented",
        `surfaces.${entry.surface}`,
        entry.surface,
        "Register the surface's production operations or remove the surface from the closed set.",
      ),
    );
}

function autonomyContext(registry) {
  const modes = new Set(CODING_WORKBENCH_MODES);
  const carriers = registry.operations.flatMap((operation) =>
    Object.entries(operation.fields)
      .filter(([, field]) => field.values?.length > 0 && field.values.every((v) => modes.has(v)))
      .map(([field]) => ({ op: operation.op, field })),
  );
  return {
    role: "closed-context",
    matrixMultiplier: false,
    modes: [...CODING_WORKBENCH_MODES],
    carriers,
  };
}

function summary(operations, proofs, classes, scenarios) {
  const resolved = (entries) => entries.filter((entry) => entry.status === "resolved").length;
  return {
    operationCount: operations.length,
    proofCount: proofs.length,
    resolvedProofCount: resolved(proofs),
    failureClassCount: classes.length,
    scenarioCount: scenarios.length,
    resolvedScenarioCount: resolved(scenarios),
  };
}

function assembleViolations(repoRoot, registry, context, parts) {
  return [
    ...failureSurfaceRuleViolations(context.surfaceRules, registry.operations),
    ...failureSurfaceOwnerPortViolations(repoRoot, registry.operations, context.ownerPorts),
    ...unmappedOperationViolations(parts.operations),
    ...emptySurfaceViolations(parts.surfaces),
    ...proofCallViolations(parts.operations, parts.calls),
    ...unresolvedProofViolations(parts.proofs, context.enforceResolution),
    ...scenarioViolations(parts.scenarios, parts.calls, context.enforceResolution),
  ].toSorted(
    (left, right) =>
      compareCodepoints(left.site, right.site) || compareCodepoints(left.code, right.code),
  );
}

/**
 * The failure-surface inventory for `registry` (generateTypedActivityLogRegistry's output).
 * `options` replaces the checked-in tables or the scanned calls for negative fixtures.
 */
export function generateFailureSurfaceInventory(repoRoot, registry, options = {}) {
  const context = {
    surfaceRules: options.surfaceRules ?? ACTIVITY_LOG_SURFACE_RULES,
    ownerPorts: options.ownerPorts ?? ACTIVITY_LOG_OWNER_PORTS,
    enforceResolution: options.enforceResolution ?? RESOLUTION_ENFORCED,
  };
  const calls = options.calls ?? scanActivityLogProofCalls(repoRoot);
  const operations = registry.operations.map((entry) => inventoryOperation(entry, context));
  const classes = registry.failureClassContracts.map((contract) =>
    failureClassEntry(contract, operations),
  );
  const proofs = proofEntries(operations, calls);
  const scenarios = scenarioEntries(classes, calls);
  const surfaces = ACTIVITY_LOG_FAILURE_SURFACES.map((surface) =>
    surfaceEntry(surface, operations, scenarios),
  );
  const parts = { operations, proofs, scenarios, surfaces, calls };
  return {
    $schema: FAILURE_SURFACE_INVENTORY_SCHEMA,
    generatedBy: "scripts/generate-op-catalog.mjs",
    joinsWith: "docs/observability/op-catalog.generated.json",
    registry: { schemaDigest: registry.schemaDigest, catalogDigest: registry.catalogDigest },
    autonomyContext: autonomyContext(registry),
    failureModes: ACTIVITY_LOG_FAILURE_MODES,
    summary: summary(operations, proofs, classes, scenarios),
    surfaces,
    // failure class -> "<surface>.<mode>" scenario ids; an empty list only for a class no mapped
    // operation belongs to, which the surface-unmapped violation already reports.
    failureClassScenarios: failureClassScenarios(classes),
    // proof id / scenario id -> the test files that resolve it; an empty list is unresolved.
    proofs: resolutionFiles(proofs, "proofId"),
    scenarios: resolutionFiles(scenarios, "scenario"),
    violations: assembleViolations(repoRoot, registry, context, parts),
  };
}

/**
 * A named drift message when the checked-in inventory bytes differ from the freshly generated and
 * formatted bytes; undefined when they are identical. Byte comparison, not structural equality:
 * formatting drift is drift too, exactly like the catalog pin.
 */
export function failureSurfaceInventoryDrift(generatedBytes, checkedInBytes) {
  if (generatedBytes === checkedInBytes) return undefined;
  return (
    "docs/observability/failure-surface-inventory.generated.json is stale: it differs from what " +
    "scripts/generate-op-catalog.mjs generates now. Run `npm run generate:op-catalog` and commit."
  );
}
