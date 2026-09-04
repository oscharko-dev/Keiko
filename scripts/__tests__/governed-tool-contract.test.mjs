import { validateResultExample } from "../lib/governed-tool-examples.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkGovernedToolContract,
  checkGovernedToolContractNegatives,
} from "../check-governed-tool-contract.mjs";
import {
  checkInventoryProbes,
  validateEvidenceExample,
  validateGovernedToolContract,
} from "../lib/governed-tool-contract.mjs";
const root = resolve(import.meta.dirname, "../..");
const original = JSON.parse(
  readFileSync(resolve(root, "docs/architecture/governed-tool-contract.v1.json"), "utf8"),
);
function changed(change) {
  const fixture = structuredClone(original);
  change(fixture);
  return validateGovernedToolContract(fixture);
}
describe("governed-tool architecture consistency", () => {
  it("reproduces every live inventory probe and contract mapping", () => {
    expect(checkGovernedToolContract(root)).toEqual([]);
    expect(checkGovernedToolContractNegatives(root)).toEqual([]);
  });
  for (const section of ["owners", "axes", "statuses", "bounds", "consumers", "interfaces"]) {
    it.each(Object.keys(original[section]))(`rejects an omitted ${section} entry: %s`, (key) => {
      expect(
        changed((fixture) => {
          Reflect.deleteProperty(fixture[section], key);
        }),
      ).not.toEqual([]);
    });
  }
  for (const [name, value] of Object.entries(original.interfaces)) {
    it.each(value.fields)(`rejects an omitted ${name} field: %s`, (field) => {
      expect(
        changed((fixture) => {
          fixture.interfaces[name].fields = value.fields.filter((entry) => entry !== field);
        }),
      ).not.toEqual([]);
    });
  }
  it("rejects an eighth status and recovery under the wrong status", () => {
    expect(
      changed((fixture) => {
        fixture.statuses["recovery-required"] = ["none"];
      }),
    ).not.toEqual([]);
    expect(
      changed((fixture) => {
        fixture.statuses.failed.push("recovery-required");
      }),
    ).not.toEqual([]);
  });
  it("rejects missing downstream input and competing producer", () => {
    expect(
      changed((fixture) => {
        fixture.consumers[3414].inputs.pop();
      }),
    ).not.toEqual([]);
    expect(
      changed((fixture) => {
        fixture.consumers[3414].outputs.push("InvocationReceipt");
      }),
    ).not.toEqual([]);
  });
  it("rejects a weakened bound, ambiguous digest and premature terminal status", () => {
    expect(
      changed((fixture) => {
        fixture.bounds.maxSearchHits = 0;
      }),
    ).not.toEqual([]);
    expect(
      changed((fixture) => {
        fixture.digests.projection.domain = fixture.digests.descriptor.domain;
      }),
    ).not.toEqual([]);
    expect(
      changed((fixture) => {
        fixture.phases["invocation-started"].required.push("status");
      }),
    ).not.toEqual([]);
  });
});
function phaseExample(phase) {
  return structuredClone(original.examples[phase]);
}
describe("architecture phase fixtures (not production evidence)", () => {
  it.each(Object.keys(original.phases))("accepts every defined phase: %s", (phase) => {
    expect(validateEvidenceExample(original, phase, phaseExample(phase))).toEqual([]);
  });
  it.each(Object.entries(original.statuses))(
    "accepts each closed terminal pair under %s",
    (status, reasons) => {
      for (const reason of reasons) {
        expect(
          validateEvidenceExample(original, "terminal", {
            ...phaseExample("terminal"),
            status,
            reason,
            ...(status === "failed" ? { errorKind: "TypeError", frames: [], causeChain: [] } : {}),
          }),
        ).toEqual([]);
      }
    },
  );
  it.each(original.evidenceForbidden)("rejects nested durable body field %s", (field) => {
    const example = { ...phaseExample("terminal"), frames: [{ [field]: "untrusted" }] };
    expect(validateEvidenceExample(original, "terminal", example)).toContain(
      "forbidden evidence field",
    );
  });
  it("rejects missing fields and terminal status in a started event", () => {
    const example = phaseExample("invocation-started");
    delete example.invocationId;
    expect(validateEvidenceExample(original, "invocation-started", example)).toContain(
      "missing phase field",
    );
    expect(
      validateEvidenceExample(original, "projection", {
        ...phaseExample("projection"),
        status: "completed",
      }),
    ).toContain("premature terminal status");
  });
});

// These are normative document examples, not a second runtime result validator.
describe("architecture result examples", () => {
  it.each(Object.keys(original.statuses))("validates the example for %s", (status) => {
    expect(validateResultExample(original, original.resultExamples[status])).toEqual([]);
  });
  it("rejects completed data masquerading as failure and false complete coverage", () => {
    const result = structuredClone(original.resultExamples.completed);
    result.status = "failed";
    result.reason = "handler-failed";
    expect(validateResultExample(original, result)).toContain("invalid result data/page condition");
    result.status = "completed";
    result.reason = "none";
    result.page = { truncated: false, reason: "file-cap", cursor: null };
    expect(validateResultExample(original, result)).toContain("invalid result data/page condition");
  });
});

describe("architecture gate rejects tampered metadata and examples", () => {
  it.each(["owners", "axes", "statuses", "bounds", "consumers", "interfaces", "phases", "digests"])(
    "fails closed when the whole %s section is missing",
    (section) => {
      expect(
        changed((fixture) => {
          Reflect.deleteProperty(fixture, section);
        }),
      ).not.toEqual([]);
    },
  );
  it("rejects false runtime claims, empty owners and unknown downstream fields", () => {
    expect(
      changed((fixture) => {
        fixture.schemaVersion = 2;
      }),
    ).not.toEqual([]);
    expect(
      changed((fixture) => {
        fixture.implementation = "runtime-ready";
      }),
    ).not.toEqual([]);
    expect(
      changed((fixture) => {
        fixture.owners.genericTypes = "";
      }),
    ).not.toEqual([]);
    expect(
      changed((fixture) => {
        fixture.consumers[3414].inputs.push("UnknownInterface");
      }),
    ).not.toEqual([]);
    expect(
      changed((fixture) => {
        fixture.phases.projection.required.push("query");
      }),
    ).not.toEqual([]);
    expect(
      changed((fixture) => {
        fixture.phases.projection.op = "unregistered";
      }),
    ).not.toEqual([]);
  });
  it.each([
    { disposition: "permit-anything" },
    { ownerIssue: 1 },
    { path: "../escape.ts" },
    { path: "packages/missing-source.ts" },
    { probe: "missing-source-token-3411" },
  ])("rejects an unverifiable inventory claim: %j", (patch) => {
    const fixture = structuredClone(original);
    Object.assign(fixture.inventory[0], patch);
    expect(checkInventoryProbes(fixture, root)).not.toEqual([]);
  });
  it("rejects a removed or duplicated inventory record", () => {
    const fixture = structuredClone(original);
    fixture.inventory.pop();
    expect(checkInventoryProbes(fixture, root)).not.toEqual([]);
    fixture.inventory.push(fixture.inventory[0]);
    expect(checkInventoryProbes(fixture, root)).not.toEqual([]);
  });
  it.each([
    { durationMs: -1 },
    { correlationId: "untrusted path/field" },
    { projectionDigest: "wrong" },
    { profile: { id: "profile", version: 0 } },
    { toolRef: null },
    { readiness: "assumed" },
    { state: "completed" },
    { effectStarted: "yes" },
    { budgetDisposition: "recharged" },
    { unexpected: "content" },
    { op: "tool-catalog.other" },
  ])("rejects mistyped lifecycle evidence: %j", (patch) => {
    expect(
      validateEvidenceExample(original, "terminal", { ...phaseExample("terminal"), ...patch }),
    ).not.toEqual([]);
  });
  it("rejects wrong phase reasons, terminal pairs and deep evidence", () => {
    expect(
      validateEvidenceExample(original, "invocation-started", {
        ...phaseExample("invocation-started"),
        reason: "late-completion",
      }),
    ).not.toEqual([]);
    expect(
      validateEvidenceExample(original, "discarded", {
        ...phaseExample("discarded"),
        reason: "none",
      }),
    ).not.toEqual([]);
    expect(
      validateEvidenceExample(original, "terminal", {
        ...phaseExample("terminal"),
        reason: "recovery-required",
      }),
    ).not.toEqual([]);
    let nested = {};
    for (let level = 0; level < 18; level += 1) nested = { nested };
    expect(
      validateEvidenceExample(original, "terminal", {
        ...phaseExample("terminal"),
        frames: [nested],
      }),
    ).not.toEqual([]);
  });
  it.each([
    null,
    { truncated: "false", reason: "none", cursor: null },
    { truncated: true, reason: "none", cursor: null },
    { truncated: true, reason: "file-cap", cursor: "x".repeat(4097) },
  ])("rejects malformed pagination: %j", (page) => {
    expect(
      validateResultExample(original, { ...original.resultExamples.completed, page }),
    ).not.toEqual([]);
  });
  it("accepts bounded incomplete data and rejects overflow/extra result fields", () => {
    const result = structuredClone(original.resultExamples.completed);
    result.page = { truncated: true, reason: "file-cap", cursor: "opaque-next-page" };
    expect(validateResultExample(original, result)).toEqual([]);
    expect(validateResultExample(original, { ...result, authority: "smuggled" })).not.toEqual([]);
    expect(validateResultExample(original, { ...result, data: "x".repeat(262144) })).toContain(
      "result too large",
    );
    expect(validateResultExample(original, { ...result, status: "unsupported" })).toContain(
      "invalid result pair",
    );
    expect(validateResultExample(original, { ...result, effectStarted: "yes" })).toContain(
      "invalid effect state",
    );
  });
});
