import { describe, expect, it } from "vitest";

import {
  deriveRequirementInventory,
  type RequirementInventoryEntry,
} from "../domain/requirementInventory.js";
import {
  MISSING_ACCEPTANCE_CRITERIA,
  assessRequirementInventoryQuality,
} from "../domain/requirementInventoryQuality.js";
import {
  REQUIREMENT_TRACE_FOOTER_END,
  REQUIREMENT_TRACE_FOOTER_START,
  REQUIREMENT_TRACE_MARKER_LABEL,
  documentLabel,
  requirementChangeQueries,
  requirementReference,
  requirementTrace,
  resolveRequirementReferences,
  revisionLabel,
  shortRequirementDigest,
  type RequirementTraceUnit,
} from "../domain/requirementTrace.js";

const TEXT = [
  "LH-001: Anmeldung",
  "Das Portal unterstützt die Anmeldung; die Bearbeitung ist innerhalb von 10 Minuten abgeschlossen.",
  "Abnahmekriterien:",
  "Die Anmeldung ist möglich.",
  "Fehler werden gemeldet.",
  "Priorität: Muss.",
  "",
  "LH-002: Einmalcode",
  "Das Portal unterstützt Einmalcodes schnell und benutzerfreundlich.",
  "Priorität: Soll.",
];

function entries(documentKey = "doc:a", lines = TEXT): readonly RequirementInventoryEntry[] {
  return deriveRequirementInventory({ text: lines.join("\n"), documentKey }).entries;
}
function unitsOf(
  list: readonly RequirementInventoryEntry[],
  name = "Spec.md",
): readonly RequirementTraceUnit[] {
  return list.map((entry) => ({
    entry,
    source: { documentName: name, documentDigest: "f".repeat(64), pageLabel: "3" },
    findings: [],
  }));
}
function first(units: readonly RequirementTraceUnit[]): RequirementTraceUnit {
  const [unit] = units;
  if (unit === undefined) throw new Error("expected a unit");
  return unit;
}

describe("requirement quality over an inventory", () => {
  it("flags vague wording and states a missing acceptance criterion as its own finding", () => {
    const findings = assessRequirementInventoryQuality(entries());

    expect(findings.get("LH-001")).toBeUndefined();
    expect(findings.get("LH-002")).toEqual(["ambiguity", MISSING_ACCEPTANCE_CRITERIA]);
  });
});

describe("explicit requirement references (#4179 review, defect 8)", () => {
  const units = [...unitsOf(entries("doc:a")), ...unitsOf(entries("doc:b"), "Other.md")];

  it("resolves an id that exists once, a scoped reference and a criterion", () => {
    const single = unitsOf(entries("doc:a"));
    const scoped = requirementReference(first(units).entry);

    const plain = resolveRequirementReferences(["LH-002"], single);
    const withCriterion = resolveRequirementReferences([`${scoped}/AC2`], units);

    expect(plain).toMatchObject({ ok: true, resolved: [{ unit: { entry: { id: "LH-002" } } }] });
    expect(withCriterion).toMatchObject({
      ok: true,
      resolved: [{ criterion: { id: "LH-001/AC2" } }],
    });
  });

  it("refuses an id that exists in several documents instead of letting one win", () => {
    const result = resolveRequirementReferences(["LH-001"], units);

    expect(result).toMatchObject({
      ok: false,
      problems: [{ reference: "LH-001", reason: "ambiguous" }],
    });
    expect(result.ok ? [] : result.problems[0]?.candidates).toHaveLength(2);
  });

  it.each([
    ["an unknown id", ["LH-999"], "unknown"],
    ["a wrong document scope", ["deadbeef:LH-001"], "unknown"],
    ["an empty reference", [""], "malformed"],
  ])("refuses %s", (_name, references, reason) => {
    expect(resolveRequirementReferences(references, units)).toMatchObject({
      ok: false,
      problems: [{ reason }],
    });
  });

  it("refuses a criterion the requirement does not have", () => {
    const single = unitsOf(entries("doc:a"));

    expect(resolveRequirementReferences(["LH-002/AC1"], single)).toMatchObject({
      ok: false,
      problems: [{ reason: "unknown" }],
    });
  });

  it("does not trace by prose: a mention in text is not a reference", () => {
    expect(resolveRequirementReferences(["Siehe LH-001."], units)).toMatchObject({ ok: false });
  });

  it("allows several references per item and bounds their number", () => {
    const single = unitsOf(entries("doc:a"));

    expect(resolveRequirementReferences(["LH-001", "LH-002"], single)).toMatchObject({
      ok: true,
      resolved: [{ unit: { entry: { id: "LH-001" } } }, { unit: { entry: { id: "LH-002" } } }],
    });
    expect(
      resolveRequirementReferences(
        Array.from({ length: 9 }, () => "LH-001"),
        single,
      ),
    ).toMatchObject({ ok: false });
  });
});

describe("requirement trace labels and footer (#4179 review, defect 7 and 11)", () => {
  it("scopes the labels by document so equal ids of two documents stay apart", () => {
    const a = first(unitsOf(entries("doc:a")));
    const b = first(unitsOf(entries("doc:b")));

    const traceA = requirementTrace([{ unit: a }]);
    const traceB = requirementTrace([{ unit: b }]);

    expect(traceA.labels).toEqual([
      REQUIREMENT_TRACE_MARKER_LABEL,
      documentLabel(a.entry.documentScope),
      "keiko-req-LH-001",
      revisionLabel(a.entry.digest),
    ]);
    expect(traceA.labels).not.toEqual(traceB.labels);
    expect(traceA.labels[2]).toBe(traceB.labels[2]);
    expect(traceA.labels[1]).not.toBe(traceB.labels[1]);
  });

  it("labels several requirements and a criterion of one item", () => {
    const units = unitsOf(entries("doc:a"));
    const resolved = resolveRequirementReferences(["LH-001/AC2", "LH-002"], units);
    if (!resolved.ok) throw new Error("expected resolution");

    const trace = requirementTrace(resolved.resolved);

    expect(trace.labels).toEqual(
      expect.arrayContaining(["keiko-req-LH-001", "keiko-req-LH-002", "keiko-ac-LH-001-AC2"]),
    );
    expect(trace.footer.match(/^Requirement: /gmu)).toHaveLength(2);
  });

  it("writes source location, scoped reference, digests and findings into the footer", () => {
    const unit = { ...first(unitsOf(entries())), findings: ["ambiguity"] };

    const { footer } = requirementTrace([{ unit }]);

    expect(footer.startsWith(REQUIREMENT_TRACE_FOOTER_START)).toBe(true);
    expect(footer.endsWith(`\n${REQUIREMENT_TRACE_FOOTER_END}`)).toBe(true);
    expect(footer).toContain("Requirement: LH-001 · Anmeldung");
    expect(footer).toContain(`Reference: ${requirementReference(unit.entry)}`);
    expect(footer).toContain("Source: Spec.md · page 3");
    expect(footer).toContain(`Document digest: ${"f".repeat(12)}`);
    expect(footer).toContain(`Requirement digest: ${shortRequirementDigest(unit.entry.digest)}`);
    expect(footer).toContain("Quality findings: ambiguity");
  });

  it("neutralizes wiki markup, image embeds and hidden characters from the document's words", () => {
    const unit = first(unitsOf(entries()));
    const hostile: RequirementTraceUnit = {
      ...unit,
      entry: {
        ...unit.entry,
        title: "Login {code} [~admin] !http://evil/x.png! *bold* [x|http://y]\u202E",
        sectionPath: ["A | B", "~C"],
      },
      source: { documentName: "Spec {panel}.md", documentDigest: "f".repeat(64) },
    };

    const { footer } = requirementTrace([{ unit: hostile }]);

    expect(footer).not.toMatch(/[{}|~!*[\]\u202E]/u);
    expect(footer).toContain("Source: Spec panel.md · A B · C");
  });

  it("passes every document-derived fragment through the redactor", () => {
    const unit = first(unitsOf(entries()));
    const secret: RequirementTraceUnit = {
      ...unit,
      entry: { ...unit.entry, title: "Token sk-live-ABCDEF123456" },
    };

    const { footer } = requirementTrace([{ unit: secret }], (value) =>
      value.replaceAll("sk-live-ABCDEF123456", "[REDACTED]"),
    );

    expect(footer).not.toContain("sk-live");
    expect(footer).toContain("REDACTED");
  });

  it("redacts secret shapes with the default redactor", () => {
    const unit = first(unitsOf(entries()));
    const secret: RequirementTraceUnit = {
      ...unit,
      entry: { ...unit.entry, title: "Key AKIAIOSFODNN7EXAMPLE verwendet" },
    };

    expect(requirementTrace([{ unit: secret }]).footer).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

describe("change queries (#4179 review, defect 10)", () => {
  function many(count: number): readonly RequirementInventoryEntry[] {
    const lines = Array.from(
      { length: count },
      (_, i) => `REQ-${String(i + 1)}: Titel ${String(i)}`,
    );
    return entries("doc:big", lines);
  }

  it("batches the stale queries within the JQL length bound instead of omitting them", () => {
    const list = many(300);

    const queries = requirementChangeQueries(list, 1800);

    const stale = queries.filter((query) => query.purpose === "stale");
    expect(stale.length).toBeGreaterThan(1);
    expect(stale.every((query) => query.jql.length <= 1800)).toBe(true);
    expect(stale.flatMap((query) => query.requirementIds)).toEqual(list.map((entry) => entry.id));
    for (const query of stale)
      expect(query.jql).toContain(documentLabel(list[0]?.documentScope ?? ""));
  });

  it("states a stale query as one clause per requirement and its own current revision", () => {
    const list = entries();
    const [first, second] = list;

    const [stale] = requirementChangeQueries(list);

    expect(stale?.jql).toBe(
      `labels = "${documentLabel(first?.documentScope ?? "")}" AND ((labels = "keiko-req-LH-001" AND labels != "${revisionLabel(first?.digest ?? "")}") OR (labels = "keiko-req-LH-002" AND labels != "${revisionLabel(second?.digest ?? "")}"))`,
    );
  });

  it("selects an item derived from A (outdated) and B (current): a revision of B never hides A", () => {
    const [a, b] = entries();
    const [stale] = requirementChangeQueries(entries());
    const clauses = [
      ...(stale?.jql ?? "").matchAll(/\(labels = "([^"]+)" AND labels != "([^"]+)"\)/gu),
    ].map((m) => ({ requirement: m[1] ?? "", revision: m[2] ?? "" }));
    const selects = (labels: readonly string[]): boolean =>
      clauses.some(
        (clause) => labels.includes(clause.requirement) && !labels.includes(clause.revision),
      );
    const mixed = [
      "keiko-req-LH-001",
      "keiko-rev-oldoldoldold",
      "keiko-req-LH-002",
      revisionLabel(b?.digest ?? ""),
    ];
    const current = ["keiko-req-LH-001", revisionLabel(a?.digest ?? ""), ...mixed.slice(2)];

    expect(clauses).toHaveLength(2);
    expect(selects(mixed)).toBe(true);
    expect(selects(current)).toBe(false);
  });

  it("scopes the queries per document and lists a removed query only where it fits", () => {
    const small = entries("doc:a");
    const big = many(300);

    const queries = requirementChangeQueries([...small, ...big]);

    const removed = queries.filter((query) => query.purpose === "removed");
    expect(removed.map((query) => query.documentScope)).toEqual([small[0]?.documentScope]);
    expect(queries.filter((query) => query.purpose === "traced")).toHaveLength(2);
  });
});
