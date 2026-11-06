// Synthetic .pptx builders for the pptx parser tests. Every part is a literal string the test
// controls, zipped by the shared fixture zip writer — no binary blobs, no filesystem.

import { zipTextEntries, type ZipTextEntry } from "./parser-test-fixtures.js";

const NAMESPACES =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export const PPTX_EXTENSION_INPUT = {
  extension: "pptx",
  mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;

export function runXml(text: string): string {
  return `<a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r>`;
}

export function paragraphXml(...runs: readonly string[]): string {
  return `<a:p>${runs.map(runXml).join("")}</a:p>`;
}

export function shapeXml(
  placeholder: string | undefined,
  ...paragraphs: readonly string[]
): string {
  const ph = placeholder === undefined ? "" : `<p:ph type="${placeholder}"/>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Shape"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraphs.join("")}</p:txBody></p:sp>`;
}

export function tableXml(rows: readonly (readonly string[])[], firstRow: boolean): string {
  const body = rows
    .map(
      (cells) =>
        `<a:tr h="370840">${cells
          .map((cell) => `<a:tc><a:txBody><a:bodyPr/>${paragraphXml(cell)}</a:txBody></a:tc>`)
          .join("")}</a:tr>`,
    )
    .join("");
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/><p:nvPr/></p:nvGraphicFramePr><a:graphic><a:graphicData><a:tbl><a:tblPr firstRow="${firstRow ? "1" : "0"}"/>${body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

export function slidePartXml(...shapes: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NAMESPACES}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${shapes.join("")}</p:spTree></p:cSld></p:sld>`;
}

export function notesPartXml(...paragraphs: readonly string[]): string {
  return slidePartXml(
    shapeXml("sldImg"),
    shapeXml("body", ...paragraphs.map((text) => paragraphXml(text))),
    shapeXml("sldNum", `<a:p><a:fld id="{1}" type="slidenum"><a:t>7</a:t></a:fld></a:p>`),
  );
}

export function relationshipsXml(
  entries: readonly { readonly id: string; readonly type: string; readonly target: string }[],
): string {
  const body = entries
    .map(
      (entry) =>
        `<Relationship Id="${entry.id}" Type="${REL_TYPE}/${entry.type}" Target="${entry.target}"/>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}">${body}</Relationships>`;
}

export function presentationPartXml(relationshipIds: readonly string[]): string {
  const ids = relationshipIds
    .map((id, index) => `<p:sldId id="${String(256 + index)}" r:id="${id}"/>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${NAMESPACES}><p:sldIdLst>${ids}</p:sldIdLst></p:presentation>`;
}

export interface FixtureSlide {
  /** Slide part file name under ppt/slides/, for example `slide1.xml`. */
  readonly file: string;
  readonly relationshipId: string;
  readonly xml: string;
  /** Speaker notes paragraphs; when present a notes part is added and linked. */
  readonly notes?: readonly string[];
}

/** Builds the package parts of a deck whose presentation order is the order of `slides`. */
export function pptxEntries(slides: readonly FixtureSlide[]): ZipTextEntry[] {
  const entries: ZipTextEntry[] = [
    {
      name: "ppt/presentation.xml",
      content: presentationPartXml(slides.map((slide) => slide.relationshipId)),
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      content: relationshipsXml(
        slides.map((slide) => ({
          id: slide.relationshipId,
          type: "slide",
          target: `slides/${slide.file}`,
        })),
      ),
    },
  ];
  for (const slide of slides) {
    entries.push({ name: `ppt/slides/${slide.file}`, content: slide.xml });
    if (slide.notes === undefined) continue;
    const notesFile = slide.file.replace("slide", "notesSlide");
    entries.push(
      { name: `ppt/notesSlides/${notesFile}`, content: notesPartXml(...slide.notes) },
      {
        name: `ppt/slides/_rels/${slide.file}.rels`,
        content: relationshipsXml([
          { id: "rId1", type: "notesSlide", target: `../notesSlides/${notesFile}` },
        ]),
      },
    );
  }
  return entries;
}

export function buildPptx(slides: readonly FixtureSlide[]): Uint8Array {
  return zipTextEntries(pptxEntries(slides));
}
