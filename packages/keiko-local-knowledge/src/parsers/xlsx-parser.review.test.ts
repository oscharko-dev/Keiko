// Findings of the independent review of the workbook parser (#4235). Fixtures are written by hand,
// the way the writers in question store them.

import { describe, expect, it } from "vitest";

import { selectionFromBytes, zipTextEntries } from "./parser-test-fixtures.js";
import { buildParserOptions } from "./registry.js";
import { xlsxParser } from "./xlsx-parser.js";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

async function parse(
  entries: readonly { readonly name: string; readonly content: string }[],
): Promise<{ readonly text: string }> {
  const result = await xlsxParser.parseAsync(
    selectionFromBytes(zipTextEntries(entries), { extension: "xlsx" }),
    buildParserOptions({ now: () => 0 }),
  );
  return { text: "normalizedText" in result ? (result.normalizedText as string) : "" };
}

function inline(ref: string, text: string, prefix = ""): string {
  const p = prefix === "" ? "" : `${prefix}:`;
  return `<${p}c r="${ref}" t="inlineStr"><${p}is><${p}t>${text}</${p}t></${p}is></${p}c>`;
}

function prefixedWorkbook(prefix: string): readonly { name: string; content: string }[] {
  const row = (n: number, a: string, b: string): string =>
    `<${prefix}:row r="${String(n)}">${inline(`A${String(n)}`, a, prefix)}${inline(`B${String(n)}`, b, prefix)}</${prefix}:row>`;
  const sheet =
    `<${prefix}:worksheet xmlns:${prefix}="${MAIN}" xmlns:r="${RELATIONSHIPS}">` +
    `<${prefix}:sheetData>${row(1, "ID", "Titel")}${row(2, "FR-1", "Login")}</${prefix}:sheetData></${prefix}:worksheet>`;
  return [
    {
      name: "xl/workbook.xml",
      content: `<${prefix}:workbook xmlns:${prefix}="${MAIN}" xmlns:r="${RELATIONSHIPS}"><${prefix}:sheets><${prefix}:sheet name="Anforderungen" sheetId="1" r:id="rId1"/></${prefix}:sheets></${prefix}:workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    },
    { name: "xl/worksheets/sheet1.xml", content: sheet },
  ];
}

describe("elements written with a namespace prefix", () => {
  it.each(["x", "ss", "main"])(
    "reads a workbook whose elements carry the prefix %s:",
    async (p) => {
      const parsed = await parse(prefixedWorkbook(p));
      expect(parsed.text).toBe("Anforderungen!2: ID=FR-1 | Titel=Login\n");
    },
  );

  it("reads prefixed shared strings, and a prefixed relationships part", async () => {
    const x = "x";
    const sst =
      `<${x}:sst xmlns:${x}="${MAIN}"><${x}:si><${x}:t>ID</${x}:t></${x}:si><${x}:si><${x}:t>Titel</${x}:t></${x}:si>` +
      `<${x}:si><${x}:t>FR-1</${x}:t></${x}:si><${x}:si><${x}:t>Login</${x}:t></${x}:si></${x}:sst>`;
    const cell = (ref: string, index: number): string =>
      `<${x}:c r="${ref}" t="s"><${x}:v>${String(index)}</${x}:v></${x}:c>`;
    const sheet =
      `<${x}:worksheet xmlns:${x}="${MAIN}"><${x}:sheetData>` +
      `<${x}:row r="1">${cell("A1", 0)}${cell("B1", 1)}</${x}:row>` +
      `<${x}:row r="2">${cell("A2", 2)}${cell("B2", 3)}</${x}:row></${x}:sheetData></${x}:worksheet>`;
    const rels = `<rel:Relationships xmlns:rel="http://schemas.openxmlformats.org/package/2006/relationships"><rel:Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></rel:Relationships>`;
    const workbook = `<workbook xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}"><sheets><sheet name="Tab" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    const parsed = await parse([
      { name: "xl/workbook.xml", content: workbook },
      { name: "xl/_rels/workbook.xml.rels", content: rels },
      { name: "xl/sharedStrings.xml", content: sst },
      { name: "xl/worksheets/sheet1.xml", content: sheet },
    ]);
    expect(parsed.text).toBe("Tab!2: ID=FR-1 | Titel=Login\n");
  });

  it("leaves elements of another namespace alone", async () => {
    const sheet =
      `<worksheet xmlns="${MAIN}" xmlns:x14="urn:other"><sheetData>` +
      `<row r="1">${inline("A1", "ID")}${inline("B1", "Titel")}</row>` +
      `<row r="2">${inline("A2", "FR-1")}<x14:c r="B2" t="inlineStr"><x14:is><x14:t>fremd</x14:t></x14:is></x14:c>${inline("C2", "Login")}</row>` +
      `</sheetData></worksheet>`;
    const parsed = await parse([
      {
        name: "xl/workbook.xml",
        content: `<workbook xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        content: `<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      },
      { name: "xl/worksheets/sheet1.xml", content: sheet },
    ]);
    expect(parsed.text).toBe("S!2: ID=FR-1 | Column C=Login\n");
  });
});

describe("the shared package controls", () => {
  const WORKBOOK = prefixedWorkbook("x");
  const options = (
    overrides: Parameters<typeof buildParserOptions>[0],
  ): ReturnType<typeof buildParserOptions> => buildParserOptions({ now: () => 0, ...overrides });
  const read = async (
    entries: readonly { readonly name: string; readonly content: string }[],
    overrides: Parameters<typeof buildParserOptions>[0] = {},
  ): Promise<{ readonly text: string; readonly codes: readonly string[] }> => {
    const result = await xlsxParser.parseAsync(
      selectionFromBytes(zipTextEntries(entries), { extension: "xlsx" }),
      options(overrides),
    );
    return {
      text: "normalizedText" in result ? (result.normalizedText as string) : "",
      codes: result.diagnostics.map((entry) => entry.code),
    };
  };

  it("reads the workbook when nothing stops it", async () => {
    const { text, codes } = await read(WORKBOOK);
    expect(text).toContain("FR-1");
    expect(codes).toEqual([]);
  });

  it("refuses a package that lists a sheet twice", async () => {
    const sheet = WORKBOOK.find((entry) => entry.name.includes("worksheets"));
    if (sheet === undefined) throw new Error("the fixture has a sheet");
    const { text, codes } = await read([...WORKBOOK, { ...sheet, content: `${sheet.content} ` }]);
    expect(codes).toEqual(["MALFORMED_INPUT"]);
    expect(text).toBe("");
  });

  it("charges the zip scan and the sheets against one deadline", async () => {
    const clock = [0, 100];
    const { text, codes } = await read(WORKBOOK, {
      now: () => clock.shift() ?? 100,
      timeoutMs: 10,
    });
    expect(codes).toEqual(["PARSER_TIMEOUT"]);
    expect(text).toBe("");
  });

  it("reports the deadline when it runs out behind the zip scan", async () => {
    let asked = 0;
    const now = (): number => {
      asked += 1;
      return asked <= WORKBOOK.length + 2 ? 0 : 100;
    };
    const { text, codes } = await read(WORKBOOK, { now, timeoutMs: 10 });
    expect(codes).toEqual(["PARSER_TIMEOUT"]);
    expect(text).toBe("");
  });

  it("stops when the caller aborts during the zip scan", async () => {
    const controller = new AbortController();
    let asked = 0;
    const now = (): number => {
      asked += 1;
      if (asked === 2) controller.abort();
      return 0;
    };
    const { codes } = await read(WORKBOOK, { now, signal: controller.signal });
    expect(codes).toEqual(["PARSER_CANCELLED"]);
  });

  it("gives up on a package of many irrelevant entries", async () => {
    const filler = Array.from({ length: 16_400 }, (_, index) => ({
      name: `docProps/filler${String(index)}.txt`,
      content: "",
    }));
    const { text, codes } = await read([...filler, ...WORKBOOK]);
    expect(codes).toEqual(["PARSER_TIMEOUT"]);
    expect(text).toBe("");
  });
});
