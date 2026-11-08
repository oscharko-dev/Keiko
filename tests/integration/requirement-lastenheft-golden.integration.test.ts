// Golden proof of the requirement inventory over a large, nested German Lastenheft (Epic #4173).
//
// The specification under tests/fixtures/requirements/lastenheft-kundenportal states several
// hundred requirements in four nesting levels, in several identifier families, presentations
// (headings, plain id lines, bracketed tags, tables), priorities and acceptance-criteria shapes,
// next to prose, glossary, standards and error codes that are not requirements. The real parsers
// extract it as Markdown, Word and PDF, and the deterministic inventory (the function Knowledge Pods
// use) must list every requirement of the generator's manifest exactly once with the right content.
// The manifest is written by the generator from its own data; nothing here re-implements a rule.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ParsedUnit } from "@oscharko-dev/keiko-contracts";
import {
  deriveRequirementInventory,
  requirementContentDigest,
  type RequirementInventory,
  type RequirementInventoryEntry,
} from "@oscharko-dev/keiko-quality-intelligence";

import {
  unionSections,
  type ScopeDocumentSection,
} from "../../packages/keiko-local-knowledge/src/qualityIntelligence/scopeDocuments.js";
import { docxParser } from "../../packages/keiko-local-knowledge/src/parsers/docx-parser.js";
import { pdfParser } from "../../packages/keiko-local-knowledge/src/parsers/pdf-parser.js";
import {
  selectionFromBytes,
  selectionFromText,
} from "../../packages/keiko-local-knowledge/src/parsers/parser-test-fixtures.js";
import { buildParserOptions } from "../../packages/keiko-local-knowledge/src/parsers/registry.js";
import { textParser } from "../../packages/keiko-local-knowledge/src/parsers/text-parser.js";

interface PdfLayout {
  readonly firstPage: number;
  readonly lastPage: number;
  readonly wrapsOntoIdentifier: boolean;
}

interface ManifestRequirement {
  readonly id: string;
  readonly title: string;
  readonly priority: string;
  readonly statement: string;
  readonly acceptanceCriteria: readonly string[];
  readonly sectionPath: readonly string[];
  readonly presentation: "heading" | "plain" | "bracket" | "table";
  readonly layout: {
    readonly paragraphCount: number;
    readonly numberedCriteria: boolean;
    readonly markdownWrapsOntoIdentifier: boolean;
    readonly pdf: PdfLayout;
  };
}

interface Manifest {
  readonly document: string;
  readonly requirementCount: number;
  readonly statementClipChars: number;
  readonly requirements: readonly ManifestRequirement[];
  readonly traceabilityIds: readonly string[];
  readonly negativeControls: {
    readonly priorityLegend: readonly string[];
    readonly identifierLikeTokens: readonly string[];
    readonly sentences: readonly string[];
  };
}

const FIXTURE_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/requirements/lastenheft-kundenportal",
);
const BASE = "lastenheft-kundenportal-zahlungsverkehr";
const DOCUMENT_KEY = "lastenheft-kundenportal";
const OPTIONS = buildParserOptions({ now: () => 0 });
/** The entry bound a Knowledge Pod read uses (collectRequirementUnits). */
const POD_ENTRY_BOUND = 5000;

const manifest = JSON.parse(
  readFileSync(join(FIXTURE_DIRECTORY, "manifest.json"), "utf8"),
) as Manifest;

interface Extraction {
  readonly text: string;
  readonly sections: readonly ScopeDocumentSection[];
}

interface ParsedLike {
  readonly sections: readonly {
    sectionPath: readonly string[];
    characterStart: number;
    characterEnd: number;
  }[];
  readonly units: readonly ParsedUnit[];
  readonly normalizedText?: string;
}

/** What the knowledge store keeps for a document: the recorded sections plus the unit sections. */
function extraction(result: ParsedLike): Extraction {
  const unitSections = result.units.flatMap((unit): ScopeDocumentSection[] => {
    if (unit.kind === "section") {
      return [
        {
          sectionPath: unit.sectionPath,
          characterStart: unit.characterStart,
          characterEnd: unit.characterEnd,
        },
      ];
    }
    return [];
  });
  return {
    text: result.normalizedText ?? "",
    sections: unionSections(result.sections, unitSections),
  };
}

function read(name: string): Buffer {
  return readFileSync(join(FIXTURE_DIRECTORY, name));
}

function extractMarkdown(): Extraction {
  return extraction(
    textParser.parse(
      selectionFromText(read(`${BASE}.md`).toString("utf8"), {
        extension: "md",
        mediaType: "text/markdown",
      }),
      OPTIONS,
    ),
  );
}

async function extractDocx(): Promise<Extraction> {
  return extraction(
    await docxParser.parseAsync(
      selectionFromBytes(Uint8Array.from(read(`${BASE}.docx`)), {
        extension: "docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      OPTIONS,
    ),
  );
}

async function extractPdf(): Promise<Extraction> {
  return extraction(
    await pdfParser.parseAsync(
      selectionFromBytes(Uint8Array.from(read(`${BASE}.pdf`)), {
        extension: "pdf",
        mediaType: "application/pdf",
      }),
      OPTIONS,
    ),
  );
}

function inventoryOf(extracted: Extraction): RequirementInventory {
  return deriveRequirementInventory({
    ...extracted,
    documentKey: DOCUMENT_KEY,
    maxEntries: POD_ENTRY_BOUND,
  });
}

type Format = "markdown" | "docx" | "pdf";

function expectedStatement(requirement: ManifestRequirement): string {
  return requirement.statement.length > manifest.statementClipChars
    ? requirement.statement.slice(0, manifest.statementClipChars)
    : requirement.statement;
}

function expectedUnitKind(requirement: ManifestRequirement, format: Format): string {
  // A PDF has no table cells: the same rows are typeset as records of identifier blocks.
  return requirement.presentation === "table" && format !== "pdf" ? "table-row" : "block";
}

interface Deviation {
  readonly id: string;
  readonly field: string;
  readonly detail: string;
}

function show(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value).slice(0, 140);
}

function deviationsOf(
  entry: RequirementInventoryEntry,
  requirement: ManifestRequirement,
  format: Format,
): readonly Deviation[] {
  const found: Deviation[] = [];
  const differ = (field: string, actual: unknown, wanted: unknown): void => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted))
      found.push({
        id: requirement.id,
        field,
        detail: `expected ${show(wanted)} but got ${show(actual)}`,
      });
  };
  differ("title", entry.title, requirement.title);
  differ("idOrigin", entry.idOrigin, "explicit");
  differ("unitKind", entry.unitKind, expectedUnitKind(requirement, format));
  if (format !== "pdf")
    differ("section path", entry.sectionPath.slice(1, 1 + requirement.sectionPath.length), [
      ...requirement.sectionPath,
    ]);
  differ("priority", entry.priority, requirement.priority);
  differ("statement", entry.statement, expectedStatement(requirement));
  differ(
    "criteria",
    entry.acceptanceCriteria.map(({ text }) => text),
    requirement.acceptanceCriteria,
  );
  differ(
    "criterion ids",
    entry.acceptanceCriteria.map(({ id }) => id),
    entry.acceptanceCriteria.map((_, index) => `${requirement.id}/AC${String(index + 1)}`),
  );
  return found;
}

interface Comparison {
  readonly missing: readonly string[];
  readonly duplicated: readonly string[];
  readonly unexpected: readonly string[];
  /** Every field of every requirement that differs from the manifest. */
  readonly deviations: readonly Deviation[];
}

function compareToManifest(inventory: RequirementInventory, format: Format): Comparison {
  const byId = new Map<string, RequirementInventoryEntry[]>();
  for (const entry of inventory.entries) byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry]);
  const known = new Set(manifest.requirements.map(({ id }) => id));
  const deviations = manifest.requirements.flatMap((requirement) => {
    const entry = byId.get(requirement.id)?.[0];
    return entry === undefined ? [] : deviationsOf(entry, requirement, format);
  });
  return {
    missing: manifest.requirements.filter(({ id }) => !byId.has(id)).map(({ id }) => id),
    duplicated: [...byId].filter(([, entries]) => entries.length > 1).map(([id]) => id),
    unexpected: inventory.entries
      .filter(({ id, idOrigin }) => idOrigin === "explicit" && !known.has(id))
      .map(({ id }) => id),
    deviations,
  };
}

function expectCoverage(inventory: RequirementInventory, comparison: Comparison): void {
  expect(comparison.missing, "requirements the inventory did not detect").toEqual([]);
  expect(comparison.duplicated, "identifiers detected more than once").toEqual([]);
  expect(comparison.unexpected, "identifiers that are no requirement of the manifest").toEqual([]);
  expect(inventory.truncated).toBe(false);
  expect(
    inventory.entries.filter(({ idOrigin }) => idOrigin === "explicit"),
    "explicit requirements",
  ).toHaveLength(manifest.requirementCount);
  expect(inventory.entries, "every unit is a requirement of the manifest").toHaveLength(
    manifest.requirementCount,
  );
  expect(comparison.deviations, "fields that differ from the manifest").toEqual([]);
}

function expectNegativeControls(inventory: RequirementInventory): void {
  const ids = new Set(inventory.entries.map(({ id }) => id));
  for (const token of manifest.negativeControls.identifierLikeTokens)
    expect(ids.has(token), `identifier-like token ${token} became a requirement`).toBe(false);
  const bodies = inventory.entries
    .filter(({ idOrigin }) => idOrigin === "explicit")
    .map(({ statement }) => statement)
    .join("\n");
  for (const sentence of manifest.negativeControls.sentences)
    expect(bodies.includes(sentence), `prose became requirement text: ${sentence}`).toBe(false);
}

/** Prose, a legend, a field line or a table must never become a requirement without an identifier. */
function expectNoDerivedStatements(inventory: RequirementInventory): void {
  const derived = inventory.entries
    .filter(({ idOrigin }) => idOrigin === "derived")
    .map(({ statement }) => statement);
  expect(derived, "statements derived without an identifier").toEqual([]);
}

/** Every identifier is defined once: a reference, a matrix row or a listing never conflicts. */
function expectNoConflicts(inventory: RequirementInventory): void {
  expect(inventory.conflictingIds, "identifiers defined with conflicting content").toEqual([]);
  expect(inventory.entries.map(({ id }) => id)).toHaveLength(manifest.requirementCount);
}

describe("golden Lastenheft: shape of the fixture", () => {
  it("states between 330 and 400 requirements with unique identifiers in four nesting levels", () => {
    expect(manifest.requirementCount).toBe(manifest.requirements.length);
    expect(manifest.requirementCount).toBeGreaterThanOrEqual(330);
    expect(manifest.requirementCount).toBeLessThanOrEqual(400);
    expect(new Set(manifest.requirements.map(({ id }) => id)).size).toBe(manifest.requirementCount);
    for (const { sectionPath } of manifest.requirements) expect(sectionPath).toHaveLength(4);
    expect(new Set(manifest.requirements.map(({ presentation }) => presentation))).toEqual(
      new Set(["heading", "plain", "bracket", "table"]),
    );
    expect(
      manifest.requirements.filter(({ statement }) => statement.length > 1500).length,
    ).toBeGreaterThanOrEqual(4);
    expect(
      manifest.requirements.some(({ statement }) => statement.length > manifest.statementClipChars),
    ).toBe(true);
  });

  it("is exactly what the generator writes", () => {
    const script = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../scripts/generate-lastenheft-golden.mjs",
    );
    expect(() =>
      execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" }),
    ).not.toThrow();
  });
});

describe("golden Lastenheft: requirement inventory", () => {
  it("detects every requirement of the Markdown specification exactly once", () => {
    const inventory = inventoryOf(extractMarkdown());

    expectCoverage(inventory, compareToManifest(inventory, "markdown"));
    expectNegativeControls(inventory);
    expectNoDerivedStatements(inventory);
    expectNoConflicts(inventory);
  });

  it("detects every requirement of the Word specification exactly once", async () => {
    const inventory = inventoryOf(await extractDocx());

    expectCoverage(inventory, compareToManifest(inventory, "docx"));
    expectNegativeControls(inventory);
    expectNoDerivedStatements(inventory);
    expectNoConflicts(inventory);
  });

  it("detects every requirement of the PDF specification exactly once", async () => {
    const inventory = inventoryOf(await extractPdf());

    expectCoverage(inventory, compareToManifest(inventory, "pdf"));
    expectNegativeControls(inventory);
    expectNoDerivedStatements(inventory);
    expectNoConflicts(inventory);
  });

  it("keeps long statements whole in the digest and clips only the presented text", () => {
    const inventory = inventoryOf(extractMarkdown());
    const longOnes = manifest.requirements.filter(({ statement }) => statement.length > 1500);

    expect(longOnes.length).toBeGreaterThanOrEqual(4);
    for (const requirement of longOnes) {
      const entry = inventory.entries.find(({ id }) => id === requirement.id);
      expect(entry?.statement, requirement.id).toBe(expectedStatement(requirement));
      expect(entry?.digest, requirement.id).toBe(
        requirementContentDigest({
          id: requirement.id,
          title: requirement.title,
          priority: requirement.priority,
          statement: requirement.statement,
          criteria: requirement.acceptanceCriteria,
        }),
      );
    }
  });

  it("gives every requirement the same content digest in every format", async () => {
    const inventories = {
      markdown: inventoryOf(extractMarkdown()),
      docx: inventoryOf(await extractDocx()),
      pdf: inventoryOf(await extractPdf()),
    };
    const digestOf = (format: Format, id: string): string | undefined =>
      inventories[format].entries.find((entry) => entry.id === id)?.digest;
    const sound = manifest.requirements;

    expect(sound).toHaveLength(manifest.requirementCount);
    for (const { id } of sound) {
      expect(digestOf("docx", id), id).toBe(digestOf("markdown", id));
      expect(digestOf("pdf", id), id).toBe(digestOf("markdown", id));
    }
  });
});
