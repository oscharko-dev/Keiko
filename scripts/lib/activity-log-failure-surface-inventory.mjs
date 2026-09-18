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

export const FAILURE_SURFACE_INVENTORY_SCHEMA = "keiko-activity-log-failure-surface-inventory/1";

// Transitional: the retrofit of every registered proof and scenario lands across several commits
// of #3532. Until it is complete an unresolved proof or scenario is reported with status
// "unresolved" but is not yet a violation.
const RESOLUTION_ENFORCED = false;

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
    operations: members.map((operation) => operation.op).toSorted(compareCodepoints),
    requiredEvidenceClasses: contract.requiredEvidenceClasses,
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
      return call.file.startsWith(`packages/${owner}/`)
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

function unresolvedProofViolations(proofs) {
  if (!RESOLUTION_ENFORCED) return [];
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

function scenarioViolations(scenarios, calls) {
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
  const unresolved = RESOLUTION_ENFORCED
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

function lifecycleOperations(members) {
  return Object.fromEntries(
    ["start", "state", "end", "failure", "loss"].map((phase) => [
      phase,
      members
        .filter((operation) => operation.lifecycle === phase)
        .map((operation) => operation.op)
        .toSorted(compareCodepoints),
    ]),
  );
}

function surfaceEntry(surface, operations, classes, proofs, scenarios) {
  const members = operations.filter((operation) => operation.surface === surface);
  const surfaceClasses = classes.filter((entry) => entry.surfaces.includes(surface));
  return {
    surface,
    owners: sortedUnique(members.map((operation) => operation.owner)),
    ports: sortedUnique(members.map((operation) => operation.port).filter(Boolean)),
    emitters: sortedUnique(members.map((operation) => operation.emitter)),
    operations: members.map((operation) => operation.op).toSorted(compareCodepoints),
    lifecycleOperations: lifecycleOperations(members),
    failureClasses: surfaceClasses.map((entry) => entry.failureClass),
    requiredEvidenceClasses: sortedUnique(
      surfaceClasses.flatMap((entry) => entry.requiredEvidenceClasses),
    ),
    analyzerProjections: sortedUnique(members.map((operation) => operation.analyzerProjection)),
    proofIds: proofs.filter((proof) => proof.surface === surface).map((proof) => proof.proofId),
    scenarios: scenarios
      .filter((scenario) => scenario.surface === surface)
      .map((scenario) => scenario.scenario),
  };
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
    ...unresolvedProofViolations(parts.proofs),
    ...scenarioViolations(parts.scenarios, parts.calls),
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
  };
  const calls = options.calls ?? scanActivityLogProofCalls(repoRoot);
  const operations = registry.operations.map((entry) => inventoryOperation(entry, context));
  const classes = registry.failureClassContracts.map((contract) =>
    failureClassEntry(contract, operations),
  );
  const proofs = proofEntries(operations, calls);
  const scenarios = scenarioEntries(classes, calls);
  const surfaces = ACTIVITY_LOG_FAILURE_SURFACES.map((surface) =>
    surfaceEntry(surface, operations, classes, proofs, scenarios),
  );
  const parts = { operations, proofs, scenarios, surfaces, calls };
  return {
    $schema: FAILURE_SURFACE_INVENTORY_SCHEMA,
    generatedBy: "scripts/generate-op-catalog.mjs",
    registry: { schemaDigest: registry.schemaDigest, catalogDigest: registry.catalogDigest },
    autonomyContext: autonomyContext(registry),
    failureModes: ACTIVITY_LOG_FAILURE_MODES,
    surfaceRules: context.surfaceRules,
    ownerPorts: context.ownerPorts,
    summary: summary(operations, proofs, classes, scenarios),
    surfaces,
    operations,
    failureClasses: classes,
    proofs,
    scenarios,
    violations: assembleViolations(repoRoot, registry, context, parts),
  };
}
