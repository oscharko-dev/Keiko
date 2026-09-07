import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { redactLogFields } from "../../packages/keiko-server/dist/observability/log-redaction.js";
import {
  compileToolCatalogOperations,
  generateToolCatalogOperations,
  toolCatalogOperationsBytes,
  validateToolCatalogOperationFixture,
  TOOL_CATALOG_OPERATIONS_PATH,
} from "../lib/tool-catalog-operations.mjs";

const ROOT = process.cwd();
function source() {
  return JSON.parse(
    readFileSync(join(ROOT, "docs/architecture/governed-tool-contract.v1.json"), "utf8"),
  );
}
describe("generated lifecycle contracts and synthetic phase fixtures", () => {
  it("uses the actual frozen producer and normative interface fields", async () => {
    const contract = source();
    const generated = generateToolCatalogOperations(ROOT);
    expect(generated.qualification).toBe("declared-contract-only");
    expect(generated.contracts).toHaveLength(6);
    for (const operation of generated.contracts) {
      expect(Object.keys(operation).sort()).toEqual(
        [...contract.interfaces.LifecycleOperationContract.fields].sort(),
      );
      expect(operation.op).toBe(contract.phases[operation.phase].op);
      expect(operation.requiredFields).toEqual(contract.phases[operation.phase].required);
      expect(operation.provenance).toMatchObject({
        declarationOwnerIssue: 3412,
        runtimeOwnerIssue: 3413,
        readiness: "contract-only",
        source: "docs/architecture/governed-tool-contract.v1.json",
      });
      expect(operation.provenance.sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(readFileSync(join(ROOT, TOOL_CATALOG_OPERATIONS_PATH), "utf8")).toBe(
      await toolCatalogOperationsBytes(ROOT),
    );
    expect(generated).not.toHaveProperty("entries");
  });
  it("generates all seven terminal states without adding a running status", () => {
    const generated = generateToolCatalogOperations(ROOT);
    expect(generated.terminalFixtures.map((fixture) => fixture.evidence.status)).toEqual([
      "completed",
      "denied",
      "invalid",
      "busy",
      "cancelled",
      "timeout",
      "failed",
    ]);
    for (const fixture of [...generated.fixtures, ...generated.terminalFixtures]) {
      expect(fixture.classification).toBe("synthetic-contract-fixture");
      expect(validateToolCatalogOperationFixture(ROOT, fixture.phase, fixture.evidence)).toEqual(
        [],
      );
    }
    const started = generated.fixtures.find((fixture) => fixture.phase === "invocation-started");
    expect(started.evidence.state).toBe("started");
    expect(started.evidence).not.toHaveProperty("status");
  });
  it("rejects missing or altered operations and missing source provenance", () => {
    const contract = source();
    const missing = structuredClone(contract);
    delete missing.phases["bind-ready"];
    expect(() => compileToolCatalogOperations(missing)).toThrow(
      "Invalid governed lifecycle source contract",
    );
    const altered = structuredClone(contract);
    altered.phases.terminal.op = "tool-catalog.done";
    expect(() => compileToolCatalogOperations(altered)).toThrow(
      "Invalid governed lifecycle source contract",
    );
    const generated = generateToolCatalogOperations(ROOT);
    const tampered = structuredClone(generated);
    delete tampered.contracts[0].provenance;
    expect(tampered).not.toEqual(generateToolCatalogOperations(ROOT));
  });
  it("is canonical across object insertion order while retaining each phase's required fields", () => {
    const contract = source();
    const reordered = Object.fromEntries(Object.entries(contract).reverse());
    reordered.phases = Object.fromEntries(Object.entries(contract.phases).reverse());
    expect(compileToolCatalogOperations(reordered)).toEqual(compileToolCatalogOperations(contract));
  });
  it("rejects phase-inappropriate terminal status, missing fields and unstructured failures", () => {
    const generated = generateToolCatalogOperations(ROOT);
    for (const fixture of generated.fixtures) {
      const definition = generated.contracts.find((entry) => entry.phase === fixture.phase);
      for (const field of definition.requiredFields) {
        const evidence = Object.fromEntries(
          Object.entries(fixture.evidence).filter(([key]) => key !== field),
        );
        expect(
          validateToolCatalogOperationFixture(ROOT, fixture.phase, evidence).length,
        ).toBeGreaterThan(0);
      }
      if (fixture.phase !== "terminal")
        expect(
          validateToolCatalogOperationFixture(ROOT, fixture.phase, {
            ...fixture.evidence,
            status: "completed",
          }).length,
        ).toBeGreaterThan(0);
    }
    const failed = generated.terminalFixtures.find(
      (fixture) => fixture.evidence.status === "failed",
    );
    for (const change of [
      { errorKind: "private failure text" },
      { frames: ["/private/user/source.ts:1:1"] },
      { causeChain: ["private failure message"] },
      { reason: "result-contract-failed", status: "result-contract-failed" },
    ])
      expect(
        validateToolCatalogOperationFixture(ROOT, "terminal", { ...failed.evidence, ...change })
          .length,
      ).toBeGreaterThan(0);
  });
  it("rejects body fields on every generated phase using the existing evidence validator", () => {
    const generated = generateToolCatalogOperations(ROOT);
    for (const fixture of generated.fixtures)
      for (const field of [
        "arguments",
        "path",
        "query",
        "snippet",
        "schema",
        "output",
        "prompt",
        "credentials",
        "endpoint",
        "message",
      ])
        expect(
          validateToolCatalogOperationFixture(ROOT, fixture.phase, {
            ...fixture.evidence,
            [field]: "private customer body",
          }).length,
        ).toBeGreaterThan(0);
    expect(validateToolCatalogOperationFixture(ROOT, "unknown", {})).toEqual([
      "invalid phase example",
    ]);
  });
  it("pins retained phase fields and existing null/empty diagnostic omissions", () => {
    const generated = generateToolCatalogOperations(ROOT);
    for (const fixture of [...generated.fixtures, ...generated.terminalFixtures]) {
      expect(validateToolCatalogOperationFixture(ROOT, fixture.phase, fixture.evidence)).toEqual(
        [],
      );
      // The event's op is outside extra; the existing redactor drops reserved envelope keys.
      const extra = Object.fromEntries(
        Object.entries(fixture.evidence).filter(([key]) => key !== "op"),
      );
      const retained = Object.fromEntries(
        Object.entries(extra).filter(
          ([, value]) => value !== null && !(Array.isArray(value) && value.length === 0),
        ),
      );
      expect(redactLogFields(extra)).toEqual(retained);
      if (extra.reservationId === null) {
        expect(redactLogFields(extra)).not.toHaveProperty("reservationId");
        expect(retained).toMatchObject({ budgetDisposition: "not-reserved", effectStarted: false });
      }
      if (extra.status === "failed") {
        expect(extra).toMatchObject({ frames: [], causeChain: [], errorKind: "TypeError" });
        expect(redactLogFields(extra)).not.toHaveProperty("frames");
        expect(redactLogFields(extra)).not.toHaveProperty("causeChain");
      }
      expect(redactLogFields({ ...extra, query: "private customer body" }).query).toBe(
        "[redacted:key]",
      );
      // The generic redactor intentionally allows this short string. The closed phase validator
      // above rejects the key; #3413 must apply that check before its actual runtime sink.
      expect(redactLogFields({ arguments: "private customer body" }).arguments).toBe(
        "private customer body",
      );
    }
  });
});
