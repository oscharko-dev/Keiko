// The requirement inventory of one specification is the same for every supported document format
// and independent of any model (#4179, Epic #4173): the real parsers extract the same logical
// specification from Markdown, plain text, HTML, Word and PowerPoint, and the deterministic
// inventory derived from each extraction carries identical identifiers, titles, priorities,
// acceptance criteria and digests. Only the location differs, as it must.

import { describe, expect, it } from "vitest";

import type { ParsedUnit } from "@oscharko-dev/keiko-contracts";
import { deriveRequirementInventory } from "@oscharko-dev/keiko-quality-intelligence";

import {
  unionSections,
  type ScopeDocumentSection,
} from "../../packages/keiko-local-knowledge/src/qualityIntelligence/scopeDocuments.js";
import { docxParser } from "../../packages/keiko-local-knowledge/src/parsers/docx-parser.js";
import { htmlParser } from "../../packages/keiko-local-knowledge/src/parsers/html-parser.js";
import {
  selectionFromBytes,
  selectionFromText,
  zipTextEntries,
} from "../../packages/keiko-local-knowledge/src/parsers/parser-test-fixtures.js";
import {
  buildPptx,
  paragraphXml,
  shapeXml,
  slidePartXml,
} from "../../packages/keiko-local-knowledge/src/parsers/pptx-test-fixtures.js";
import { pptxParser } from "../../packages/keiko-local-knowledge/src/parsers/pptx-parser.js";
import { buildParserOptions } from "../../packages/keiko-local-knowledge/src/parsers/registry.js";
import { textParser } from "../../packages/keiko-local-knowledge/src/parsers/text-parser.js";

interface Spec {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly priority: string;
  readonly criteria: readonly string[];
}

const SPECS: readonly Spec[] = [
  {
    id: "LH-001",
    title: "Anmeldung: Kundennummer",
    text: "Das Portal unterstützt die Anmeldung per Kundennummer; die Bearbeitung ist innerhalb von 10 Minuten abgeschlossen.",
    priority: "Muss",
    criteria: [
      "Die Kundennummer ist für angemeldete Versicherungsnehmer verfügbar.",
      "Fehlerhafte Eingaben werden vor dem Absenden gemeldet.",
    ],
  },
  {
    id: "LH-002",
    title: "Anmeldung: Einmalcode",
    text: "Das Portal unterstützt Einmalcodes schnell und benutzerfreundlich.",
    priority: "Soll",
    criteria: [],
  },
  {
    id: "LH-003",
    title: "Statusverfolgung: Verlauf",
    text: "Der Verlauf eines Schadens ist einsehbar.",
    priority: "Kann",
    criteria: ["Der Verlauf zeigt alle Statuswechsel."],
  },
];

const DOCUMENT_KEY = "spec-document";
const OPTIONS = buildParserOptions({ now: () => 0 });
const INTRO = "Schadenmeldungen werden heute telefonisch erfasst.";

function markdown(): string {
  const lines = ["# Lastenheft", "", INTRO, ""];
  for (const spec of SPECS) {
    lines.push(`### ${spec.id} ${spec.title}`, "", spec.text, "");
    if (spec.criteria.length > 0)
      lines.push("Abnahmekriterien:", ...spec.criteria.map((line) => `- ${line}`), "");
    lines.push(`Priorität: ${spec.priority}.`, "");
  }
  return lines.join("\n");
}

function plainText(): string {
  return markdown().replaceAll(/^#+ /gmu, "").replaceAll(/^- /gmu, "");
}

function html(): string {
  const body = [`<h1>Lastenheft</h1>`, `<p>${INTRO}</p>`];
  for (const spec of SPECS) {
    body.push(`<h3>${spec.id} ${spec.title}</h3>`, `<p>${spec.text}</p>`);
    if (spec.criteria.length > 0)
      body.push(
        "<p>Abnahmekriterien:</p>",
        `<ul>${spec.criteria.map((line) => `<li>${line}</li>`).join("")}</ul>`,
      );
    body.push(`<p>Priorität: ${spec.priority}.</p>`);
  }
  return `<!DOCTYPE html><html><body>${body.join("\n")}</body></html>`;
}

function paragraph(text: string, style?: string): string {
  const props = style === undefined ? "" : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
  return `<w:p>${props}<w:r><w:t>${text}</w:t></w:r></w:p>`;
}

function docx(): Uint8Array {
  const paragraphs = [paragraph("Lastenheft", "Heading1"), paragraph(INTRO)];
  for (const spec of SPECS) {
    paragraphs.push(paragraph(`${spec.id} ${spec.title}`, "Heading3"), paragraph(spec.text));
    if (spec.criteria.length > 0)
      paragraphs.push(paragraph("Abnahmekriterien:"), ...spec.criteria.map((c) => paragraph(c)));
    paragraphs.push(paragraph(`Priorität: ${spec.priority}.`));
  }
  const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join("")}</w:body></w:document>`;
  return zipTextEntries([{ name: "word/document.xml", content: document }]);
}

function pptx(): Uint8Array {
  return buildPptx(
    SPECS.map((spec, index) => {
      const body = [
        paragraphXml(spec.text),
        ...(spec.criteria.length === 0
          ? []
          : [paragraphXml("Abnahmekriterien:"), ...spec.criteria.map((c) => paragraphXml(c))]),
        paragraphXml(`Priorität: ${spec.priority}.`),
      ];
      return {
        file: `slide${String(index + 1)}.xml`,
        relationshipId: `rId${String(index + 2)}`,
        xml: slidePartXml(
          shapeXml("title", paragraphXml(`${spec.id} ${spec.title}`)),
          shapeXml(undefined, ...body),
        ),
      };
    }),
  );
}

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
}

/** What the knowledge store keeps for a document: the recorded sections plus the unit sections. */
function extraction(result: ParsedLike): Extraction {
  const unitSections = result.units.flatMap((unit): ScopeDocumentSection[] => {
    if (unit.kind === "section")
      return [
        {
          sectionPath: unit.sectionPath,
          characterStart: unit.characterStart,
          characterEnd: unit.characterEnd,
        },
      ];
    if (unit.kind === "html-block" && unit.headingPath !== undefined && unit.headingPath.length > 0)
      return [
        {
          sectionPath: unit.headingPath,
          characterStart: unit.characterStart,
          characterEnd: unit.characterEnd,
        },
      ];
    return [];
  });
  const text =
    "normalizedText" in result && typeof result.normalizedText === "string"
      ? result.normalizedText
      : "";
  return { text, sections: unionSections(result.sections, unitSections) };
}

async function extract(format: string): Promise<Extraction> {
  switch (format) {
    case "markdown":
      return extraction(
        textParser.parse(
          selectionFromText(markdown(), { extension: "md", mediaType: "text/markdown" }),
          OPTIONS,
        ),
      );
    case "text":
      return extraction(textParser.parse(selectionFromText(plainText()), OPTIONS));
    case "html":
      return extraction(
        htmlParser.parse(
          selectionFromText(html(), { extension: "html", mediaType: "text/html" }),
          OPTIONS,
        ),
      );
    case "docx":
      return extraction(
        await docxParser.parseAsync(
          selectionFromBytes(docx(), {
            extension: "docx",
            mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          }),
          OPTIONS,
        ),
      );
    default:
      return extraction(
        await pptxParser.parseAsync(
          selectionFromBytes(pptx(), {
            extension: "pptx",
            mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          }),
          OPTIONS,
        ),
      );
  }
}

const FORMATS = ["markdown", "text", "html", "docx", "pptx"] as const;

function content(extracted: Extraction): readonly unknown[] {
  return deriveRequirementInventory({ ...extracted, documentKey: DOCUMENT_KEY }).entries.map(
    (entry) => [
      entry.id,
      entry.idOrigin,
      entry.title,
      entry.priority,
      entry.statement,
      entry.acceptanceCriteria,
      entry.digest,
    ],
  );
}

describe("requirement inventory across document formats", () => {
  it("derives the specification's requirements from every supported format", async () => {
    for (const format of FORMATS) {
      const inventory = deriveRequirementInventory({
        ...(await extract(format)),
        documentKey: DOCUMENT_KEY,
      });
      expect(
        inventory.entries.map((entry) => entry.id),
        format,
      ).toEqual(SPECS.map((s) => s.id));
      expect(inventory.truncated, format).toBe(false);
    }
  });

  it("yields identical identifiers, titles, priorities, criteria and digests in every format", async () => {
    const reference = content(await extract("markdown"));

    expect(reference).toHaveLength(SPECS.length);
    for (const format of FORMATS) {
      expect(content(await extract(format)), format).toEqual(reference);
    }
  });

  it("locates the same requirement differently per format without changing its content", async () => {
    const slides = deriveRequirementInventory({
      ...(await extract("pptx")),
      documentKey: DOCUMENT_KEY,
    }).entries[0];
    const markdownEntry = deriveRequirementInventory({
      ...(await extract("markdown")),
      documentKey: DOCUMENT_KEY,
    }).entries[0];

    expect(slides?.digest).toBe(markdownEntry?.digest);
    expect(slides?.sectionPath).not.toEqual(markdownEntry?.sectionPath);
  });
});
