import { describe, expect, it } from "vitest";

import { generateTypedActivityLogRegistry } from "../generate-op-catalog.mjs";
import { generateFailureSurfaceInventory } from "../lib/activity-log-failure-surface-inventory.mjs";
import { failureModeOf } from "../lib/activity-log-failure-surfaces.mjs";
import { withTypedRegistryFixture } from "./support/typed-registry-fixture.mjs";

// Negative and mutation fixtures for the #3532 failure-surface inventory. Every fixture builds a
// throwaway repository through withTypedRegistryFixture and runs the PRODUCTION registry and
// inventory generators against it; removing one piece of evidence — a surface mapping, a proof
// id's resolving call, a scenario, a port — must turn the generated inventory red with a named
// violation.

const OWNER = "zzz-fixture-surface-owner";
const OP = "probe.surface.failed";
const PROOF_ID = "probe.surface.failed.line";
const FAILURE_CLASS = "probe-surface-failure";
const SCENARIO = "bff.dependency-failure";

const REGISTRATION_SOURCE = [
  'import { activityLogEvent, defineActivityLogOperation } from "../../keiko-contracts/src/observability.js";',
  "export interface FixtureLogSink { write(event: object): void }",
  "const operation = defineActivityLogOperation({",
  '  contractKind: "activity-log-operation" as const, schemaVersion: 1 as const,',
  `  op: "${OP}", category: "diagnostic",`,
  `  owner: "${OWNER}", emitter: "fixture.emitFailure", fields: {},`,
  '  causal: "correlation", lifecycle: "failure", analyzerProjection: "failure-cluster",',
  `  failureClasses: ["${FAILURE_CLASS}"], proofIds: ["${PROOF_ID}"],`,
  '  releaseImpact: "patch",',
  "});",
  "activityLogEvent(operation, {}, {});",
  "",
].join("\n");

const PROOF_TEST = `expectActivityLogProof("${PROOF_ID}", line);\n`;
const SCENARIO_TEST = `expectActivityLogScenario("${SCENARIO}", run);\n`;

const FAILURE_CLASS_CONTRACT = {
  contractKind: "activity-log-failure-class",
  schemaVersion: 1,
  failureClass: FAILURE_CLASS,
  requiredProductSurfaces: [OWNER],
  requiredLifecycleOperations: { start: [], state: [], end: [], failure: [OP], loss: [] },
  requiredCausalOperations: [OP],
  requiredLossOperations: [],
  requiredProofOperations: [OP],
  requiredReplayProofIds: [],
  requiredResourceOperations: [],
  requiredEvidenceClasses: ["completeness-state", "loss-state"],
  requiredFrameOperations: [],
  requiredCauseOperations: [],
};

const SURFACE_RULES = [{ owner: OWNER, emitterPrefix: "fixture", surface: "bff" }];
const OWNER_PORTS = { [OWNER]: { port: "FixtureLogSink", declaredIn: OWNER } };

function fixtureInventory(extraFiles, options = {}) {
  return withTypedRegistryFixture(
    OWNER,
    REGISTRATION_SOURCE,
    (root) => {
      const registry = generateTypedActivityLogRegistry(root, [FAILURE_CLASS_CONTRACT]);
      expect(registry.violations).toEqual([]);
      return generateFailureSurfaceInventory(root, registry, {
        surfaceRules: SURFACE_RULES,
        ownerPorts: OWNER_PORTS,
        enforceResolution: true,
        ...options,
      });
    },
    extraFiles,
  );
}

// The fixture instruments one surface only; the other eight are reported uninstrumented by design.
function violationsBesidesUninstrumented(inventory) {
  return inventory.violations.filter((entry) => entry.code !== "surface-uninstrumented");
}

const COMPLETE_EVIDENCE = {
  [`packages/${OWNER}/src/fixture.test.ts`]: PROOF_TEST,
  "tests/fixture-scenario.test.ts": SCENARIO_TEST,
};

describe("failure-surface inventory fixtures", () => {
  it("resolves a mapped, proven and scenario-covered operation without violations", () => {
    const inventory = fixtureInventory(COMPLETE_EVIDENCE);
    expect(violationsBesidesUninstrumented(inventory)).toEqual([]);
    expect(inventory.proofs[PROOF_ID]).toEqual([`packages/${OWNER}/src/fixture.test.ts`]);
    expect(inventory.scenarios[SCENARIO]).toEqual(["tests/fixture-scenario.test.ts"]);
    expect(inventory.failureClassScenarios[FAILURE_CLASS]).toEqual([SCENARIO]);
    expect(inventory.surfaces.find((entry) => entry.surface === "bff")).toMatchObject({
      owners: [OWNER],
      ports: ["FixtureLogSink"],
      operations: [OP],
      scenarios: [SCENARIO],
    });
  });

  it("goes red when the operation's surface mapping is removed", () => {
    const inventory = fixtureInventory(COMPLETE_EVIDENCE, { surfaceRules: [] });
    expect(violationsBesidesUninstrumented(inventory)).toContainEqual(
      expect.objectContaining({ code: "surface-unmapped", site: `operations.${OP}` }),
    );
  });

  it("goes red when the proof id's resolving call is removed", () => {
    const inventory = fixtureInventory({ "tests/fixture-scenario.test.ts": SCENARIO_TEST });
    expect(inventory.proofs[PROOF_ID]).toEqual([]);
    expect(violationsBesidesUninstrumented(inventory)).toEqual([
      expect.objectContaining({ code: "proof-unresolved", site: `proofs.${PROOF_ID}` }),
    ]);
  });

  it("does not count a commented-out call or a call spelled inside a string", () => {
    const inventory = fixtureInventory({
      [`packages/${OWNER}/src/fixture.test.ts`]: `// ${PROOF_TEST}const text = '${PROOF_TEST.trim()}';\n`,
      "tests/fixture-scenario.test.ts": SCENARIO_TEST,
    });
    expect(violationsBesidesUninstrumented(inventory)).toEqual([
      expect.objectContaining({ code: "proof-unresolved" }),
    ]);
  });

  it("goes red when the only proof call sits in another package", () => {
    const inventory = fixtureInventory({
      "packages/zzz-other-package/src/other.test.ts": PROOF_TEST,
      "tests/fixture-scenario.test.ts": SCENARIO_TEST,
    });
    expect(violationsBesidesUninstrumented(inventory)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "proof-outside-owner",
          site: "packages/zzz-other-package/src/other.test.ts:1",
        }),
        expect.objectContaining({ code: "proof-unresolved" }),
      ]),
    );
  });

  it("rejects non-literal and unregistered proof calls", () => {
    const inventory = fixtureInventory({
      ...COMPLETE_EVIDENCE,
      [`packages/${OWNER}/src/dynamic.test.ts`]: [
        "expectActivityLogProof(proofId, line);",
        'expectActivityLogProof("probe.surface.unknown.line", line);',
        "",
      ].join("\n"),
    });
    expect(violationsBesidesUninstrumented(inventory)).toEqual([
      expect.objectContaining({ code: "proof-call-not-literal" }),
      expect.objectContaining({
        code: "proof-unregistered",
        detail: "probe.surface.unknown.line",
      }),
    ]);
  });

  it("resolves a proof through the stderr-notice helper too", () => {
    const inventory = fixtureInventory({
      [`packages/${OWNER}/src/fixture.test.ts`]: `expectActivityLogStderrProof("${PROOF_ID}", line);\n`,
      "tests/fixture-scenario.test.ts": SCENARIO_TEST,
    });
    expect(violationsBesidesUninstrumented(inventory)).toEqual([]);
  });

  it("goes red when the class's scenario is removed or misnamed", () => {
    const removed = fixtureInventory({ [`packages/${OWNER}/src/fixture.test.ts`]: PROOF_TEST });
    expect(violationsBesidesUninstrumented(removed)).toEqual([
      expect.objectContaining({ code: "scenario-unresolved", site: `scenarios.${SCENARIO}` }),
    ]);
    const misnamed = fixtureInventory({
      ...COMPLETE_EVIDENCE,
      "tests/misnamed-scenario.test.ts": 'expectActivityLogScenario("bff.timeout", run);\n',
    });
    expect(violationsBesidesUninstrumented(misnamed)).toEqual([
      expect.objectContaining({ code: "scenario-unknown", detail: "bff.timeout" }),
    ]);
  });

  it("reports unresolved evidence without violations until resolution is enforced", () => {
    const inventory = fixtureInventory({}, { enforceResolution: false });
    expect(violationsBesidesUninstrumented(inventory)).toEqual([]);
    expect(inventory.summary).toMatchObject({ resolvedProofCount: 0, resolvedScenarioCount: 0 });
  });

  it("goes red when the owner's log port is unmapped or undeclared", () => {
    expect(
      violationsBesidesUninstrumented(fixtureInventory(COMPLETE_EVIDENCE, { ownerPorts: {} })),
    ).toEqual([expect.objectContaining({ code: "owner-port-unmapped", detail: OWNER })]);
    const undeclared = fixtureInventory(COMPLETE_EVIDENCE, {
      ownerPorts: { [OWNER]: { port: "MissingLogSink", declaredIn: OWNER } },
    });
    expect(violationsBesidesUninstrumented(undeclared)).toEqual([
      expect.objectContaining({ code: "owner-port-undeclared", detail: "MissingLogSink" }),
    ]);
  });

  it("rejects ambiguous and stale surface rules", () => {
    const inventory = fixtureInventory(COMPLETE_EVIDENCE, {
      surfaceRules: [
        ...SURFACE_RULES,
        { owner: OWNER, emitterPrefix: "fixture", surface: "ui" },
        { owner: OWNER, emitterPrefix: "retired-module", surface: "bff" },
      ],
    });
    expect(violationsBesidesUninstrumented(inventory)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "surface-rule-ambiguous" }),
        expect.objectContaining({ code: "surface-rule-unused", detail: "bff" }),
      ]),
    );
  });
});

describe("failure mode classification", () => {
  const operation = (op, lifecycle) => ({ op, lifecycle });

  it("maps a registered loss lifecycle to loss before any name token", () => {
    expect(failureModeOf([operation("probe.request.rejected", "loss")])).toBe("loss");
  });

  it("maps closed name tokens to crash, rejection and loss", () => {
    expect(failureModeOf([operation("probe.process.terminated", "end")])).toBe("crash");
    expect(failureModeOf([operation("probe.request.denied", "failure")])).toBe("rejection");
    expect(failureModeOf([operation("probe.report.rate-limited", "failure")])).toBe("loss");
  });

  it("falls back to dependency failure or timeout", () => {
    expect(failureModeOf([operation("probe.call.failed", "failure")])).toBe("dependency-failure");
  });
});
