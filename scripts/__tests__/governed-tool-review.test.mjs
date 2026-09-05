import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  keikoStackFrames,
  causeChain,
} from "../../packages/keiko-server/dist/observability/stack-frames.js";
import { checkGovernedToolContractNegatives } from "../check-governed-tool-contract.mjs";
import {
  checkInventoryProbes,
  validateGovernedToolContract,
} from "../lib/governed-tool-contract.mjs";
import { validateEvidenceExample, validateResultExample } from "../lib/governed-tool-examples.mjs";

const root = resolve(import.meta.dirname, "../..");
const original = JSON.parse(
  readFileSync(join(root, "docs/architecture/governed-tool-contract.v1.json"), "utf8"),
);
const roots = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
function changed(mutate) {
  const fixture = structuredClone(original);
  mutate(fixture);
  return validateGovernedToolContract(fixture);
}
describe("PR 3419 exact architecture boundaries", () => {
  for (const field of ["owners", "bounds"]) {
    it.each(Object.keys(original[field]))(`rejects replaced ${field} value %s`, (key) => {
      expect(
        changed((fixture) => {
          fixture[field][key] = field === "bounds" ? fixture[field][key] + 1 : "different-owner";
        }),
      ).not.toEqual([]);
    });
  }
  for (const field of ["evidenceAllowed", "evidenceForbidden"]) {
    it.each(original[field])(`rejects omitted ${field} member %s`, (key) => {
      expect(
        changed((fixture) => {
          fixture[field] = fixture[field].filter((value) => value !== key);
        }),
      ).not.toEqual([]);
    });
  }
  it("rejects coordinated evidence vocabulary and example poisoning", () => {
    expect(
      changed((fixture) => {
        fixture.evidenceAllowed.push("query");
        fixture.evidenceForbidden = fixture.evidenceForbidden.filter((value) => value !== "query");
        fixture.examples.terminal.query = "private query";
      }),
    ).not.toEqual([]);
  });
  for (const [name, definition] of Object.entries(original.digests)) {
    it(`rejects changed ${name} domain and missing digest`, () => {
      expect(
        changed((fixture) => {
          fixture.digests[name].domain += ".changed";
        }),
      ).not.toEqual([]);
      expect(
        changed((fixture) => {
          Reflect.deleteProperty(fixture.digests, name);
        }),
      ).not.toEqual([]);
    });
    it.each(definition.fields)(`rejects omitted ${name} digest input %s`, (key) => {
      expect(
        changed((fixture) => {
          fixture.digests[name].fields = definition.fields.filter((field) => field !== key);
        }),
      ).not.toEqual([]);
    });
  }
  for (const [name, definition] of Object.entries(original.phases)) {
    it(`rejects coordinated ${name} operation poisoning`, () => {
      expect(
        changed((fixture) => {
          fixture.phases[name].op = "tool-catalog.unregistered";
          fixture.examples[name].op = fixture.phases[name].op;
        }),
      ).not.toEqual([]);
    });
    it.each(definition.required)(`rejects omitted ${name} required field %s`, (key) => {
      expect(
        changed((fixture) => {
          fixture.phases[name].required = definition.required.filter((field) => field !== key);
        }),
      ).not.toEqual([]);
    });
  }
  it.each(["id", "path", "probe", "ownerIssue"])(
    "rejects replaced inventory %s despite retained cardinality",
    (field) => {
      const fixture = structuredClone(original);
      fixture.inventory[0][field] = field === "id" ? "replacement" : fixture.inventory[1][field];
      if (field === "ownerIssue") fixture.inventory[0][field] = 3406;
      expect(checkInventoryProbes(fixture, root)).not.toEqual([]);
    },
  );
});

describe("H1 checkpoint provenance within the integration PR", () => {
  it.each(["integrationPr", "verificationRef", "reviewRef"])(
    "rejects omitted checkpoint evidence field %s",
    (field) => {
      expect(
        changed((fixture) => {
          fixture.interfaces.H1Provenance.fields = fixture.interfaces.H1Provenance.fields.filter(
            (candidate) => candidate !== field,
          );
        }),
      ).not.toEqual([]);
    },
  );
  it.each(["mergedPr", "mergeCommit", "requiredChecksRef"])(
    "rejects premature final-delivery field %s in checkpoint requirements",
    (field) => {
      expect(
        changed((fixture) => {
          fixture.interfaces.H1Provenance.fields = [
            ...new Set([...fixture.interfaces.H1Provenance.fields, field]),
          ];
        }),
      ).not.toEqual([]);
    },
  );
});

describe("PR 3419 normative example semantics", () => {
  it.each([{}, null, []])("rejects empty or malformed examples", (value) => {
    expect(validateResultExample(original, value)).not.toEqual([]);
    expect(validateEvidenceExample(original, "terminal", value)).not.toEqual([]);
  });
  it.each([
    { invocationId: "bad/id" },
    { invocationId: null },
    { toolRef: null },
    { toolRef: { canonicalId: "keiko.repo.search", contractVersion: 1, content: "private" } },
    { projectionDigest: "wrong" },
    { projectionDigest: null },
    { metrics: { query: "private" } },
    { metrics: null },
    { metrics: { inputBytes: -1, outputBytes: 0, resultCount: 0, durationMs: 0 } },
    {
      metrics: {
        inputBytes: 0,
        outputBytes: 0,
        resultCount: Number.MAX_SAFE_INTEGER + 1,
        durationMs: 0,
      },
    },
    { page: { truncated: false, reason: "none", cursor: null, query: "private" } },
  ])("rejects malformed result fields: %j", (patch) => {
    expect(
      validateResultExample(original, { ...original.resultExamples.completed, ...patch }),
    ).not.toEqual([]);
  });
  it("accepts unresolved identities only before an effect, never for completed work", () => {
    const result = { ...original.resultExamples.invalid, toolRef: null, projectionDigest: null };
    expect(validateResultExample(original, result)).toEqual([]);
    expect(validateResultExample(original, { ...result, effectStarted: true })).not.toEqual([]);
  });
  it("accepts structured diagnostics derived through the owning stack producer", () => {
    const failure = new TypeError("private failure", { cause: new RangeError("private cause") });
    failure.stack =
      "TypeError: private failure\n    at /private/install/packages/keiko-server/dist/runtime/catalog.js:12:3";
    const frames = keikoStackFrames(failure);
    const causes = causeChain(failure);
    expect(frames).toHaveLength(1);
    expect(causes.length).toBeGreaterThan(0);
    expect(
      validateEvidenceExample(original, "terminal", {
        ...original.examples.terminal,
        status: "failed",
        reason: "handler-failed",
        errorKind: "TypeError",
        frames,
        causeChain: causes,
      }),
    ).toEqual([]);
  });
  it.each([
    { effectStarted: false, budgetDisposition: "released", reservationId: "reservation-1" },
    { effectStarted: false, budgetDisposition: "not-reserved", reservationId: null },
  ])("accepts explicit pre-effect settlement: %j", (patch) => {
    expect(
      validateEvidenceExample(original, "terminal", {
        ...original.examples.terminal,
        status: "denied",
        reason: "hard-denial",
        ...patch,
      }),
    ).toEqual([]);
  });
  it("requires a reservation for a started observation", () => {
    expect(
      validateEvidenceExample(original, "invocation-started", {
        ...original.examples["invocation-started"],
        reservationId: null,
      }),
    ).toContain("missing started reservation");
  });
  it.each([
    {},
    { errorKind: "private failure text", frames: [], causeChain: [] },
    { errorKind: "TypeError", frames: ["/private/source.ts:1:1"], causeChain: [] },
    { errorKind: "TypeError", frames: [], causeChain: ["private text"] },
  ])("rejects failed terminal without structured diagnostics: %j", (patch) => {
    expect(
      validateEvidenceExample(original, "terminal", {
        ...original.examples.terminal,
        status: "failed",
        reason: "handler-failed",
        ...patch,
      }),
    ).not.toEqual([]);
  });
  it.each([
    { effectStarted: true, budgetDisposition: "released", reservationId: "reservation-1" },
    { effectStarted: false, budgetDisposition: "committed", reservationId: "reservation-1" },
    { effectStarted: true, budgetDisposition: "not-reserved", reservationId: null },
    { effectStarted: false, budgetDisposition: "not-reserved", reservationId: "reservation-1" },
    { effectStarted: false, budgetDisposition: "released", reservationId: null },
  ])("rejects contradictory settlement accounting: %j", (patch) => {
    expect(
      validateEvidenceExample(original, "terminal", { ...original.examples.terminal, ...patch }),
    ).not.toEqual([]);
  });
});

describe("PR 3419 negative fixture maintenance", () => {
  it.each([
    [],
    ["missing", "nested", "key"],
    ["owners", "missing"],
    ["owners", "genericTypes", "nested"],
  ])("reports stale or empty mutation paths without throwing: %j", (path) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "governed-tool-negative-"));
    roots.push(fixtureRoot);
    for (const [file, value] of [
      ["docs/architecture/governed-tool-contract.v1.json", original],
      [
        "tests/architecture/fixtures/governed-tool-contract/omissions.json",
        [{ path, expected: "owners:" }],
      ],
    ]) {
      mkdirSync(dirname(join(fixtureRoot, file)), { recursive: true });
      writeFileSync(join(fixtureRoot, file), JSON.stringify(value));
    }
    expect(checkGovernedToolContractNegatives(fixtureRoot)).toContain(
      "negative contract fixture: invalid or stale mutation path",
    );
  });
});

describe("closed status lookup rejects inherited property names", () => {
  for (const status of ["toString", "constructor", "__proto__"]) {
    it(`rejects result status ${status} without throwing`, () => {
      expect(
        validateResultExample(original, {
          ...original.resultExamples.invalid,
          status,
        }),
      ).toContain("invalid result pair");
    });
    it(`rejects terminal status ${status} without throwing`, () => {
      expect(
        validateEvidenceExample(original, "terminal", {
          ...original.examples.terminal,
          status,
        }),
      ).toContain("invalid terminal pair");
    });
  }
});

function inventoryFixture() {
  const target = mkdtempSync(join(tmpdir(), "governed-tool-inventory-"));
  roots.push(target);
  const retired = Object.keys(original.inventoryMigrations);
  const sources = [
    ...original.inventory.filter((row) => !retired.includes(row.id)),
    ...Object.values(original.inventoryMigrations).flatMap((row) => row.replacements),
  ];
  for (const source of sources) {
    const file = join(target, source.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, readFileSync(join(root, source.path)));
  }
  return target;
}

describe("historical inventory and current policy ownership", () => {
  const retired = original.inventory.find((row) => row.id === "coding-delivery-policy");
  it("retains the historical mapping while checking only the verified live owners", () => {
    expect(checkInventoryProbes(original, inventoryFixture())).toEqual([]);
  });
  it.each(["toString", "constructor", "__proto__"])(
    "rejects inherited migration identity %s without interpreting it as a source",
    (id) => {
      const contract = structuredClone(original);
      contract.inventory.at(-1).id = id;
      expect(checkInventoryProbes(contract, inventoryFixture())).toContain(
        `inventory ${id}: audited source mapping differs`,
      );
    },
  );
  it("rejects restoring the removed authority stack", () => {
    const target = inventoryFixture();
    writeFileSync(join(target, retired.path), "// retired authority stack restored");
    expect(checkInventoryProbes(original, target)).toContain(
      "inventory coding-delivery-policy: retired source restored",
    );
  });
  it.each(original.inventoryMigrations["coding-delivery-policy"].replacements)(
    "rejects a missing current owner $path",
    (source) => {
      const target = inventoryFixture();
      rmSync(join(target, source.path));
      expect(checkInventoryProbes(original, target)).toContain(
        `inventory coding-delivery-policy (${source.path}): source file missing`,
      );
    },
  );
  it.each([undefined, {}, { unexpected: {} }])(
    "rejects unverified migration mapping %j",
    (value) => {
      const contract = { ...original, inventoryMigrations: value };
      expect(checkInventoryProbes(contract, inventoryFixture())).toContain(
        "inventory: migration mapping differs",
      );
    },
  );
  it.each(["removedInCommit", "removalIssue", "ownerIssue", "replacements"])(
    "rejects a changed migration %s",
    (field) => {
      const contract = structuredClone(original);
      contract.inventoryMigrations["coding-delivery-policy"][field] = null;
      expect(checkInventoryProbes(contract, inventoryFixture())).toContain(
        "inventory: migration mapping differs",
      );
    },
  );
});
