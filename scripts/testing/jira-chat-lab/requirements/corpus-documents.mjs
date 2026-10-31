// Office renderings of the synthetic requirements corpus (epic #4173, #4174): Word, Excel,
// PowerPoint and a text-layer PDF, all derived from buildCorpus(version). Text layer only.
import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCorpus } from "./corpus.mjs";
import { createZip } from "./ooxml-zip.mjs";

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const REL_TYPE = `${NS_REL}`;
const CT_XML = "application/xml";
const CT_RELS = "application/vnd.openxmlformats-package.relationships+xml";
const CT_WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml";
const CT_SHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml";
const CT_SLIDE = "application/vnd.openxmlformats-officedocument.presentationml";
const CT_THEME = "application/vnd.openxmlformats-officedocument.theme+xml";

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function relationships(items) {
  const rels = items
    .map(
      ([id, type, target]) =>
        `<Relationship Id="${id}" Type="${REL_TYPE}/${type}" Target="${target}"/>`,
    )
    .join("");
  return `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">${rels}</Relationships>`;
}

function contentTypes(overrides) {
  const parts = overrides
    .map(([name, type]) => `<Override PartName="/${name}" ContentType="${type}"/>`)
    .join("");
  return (
    `${XML_HEAD}<Types xmlns="${NS_CT}"><Default Extension="rels" ContentType="${CT_RELS}"/>` +
    `<Default Extension="xml" ContentType="${CT_XML}"/>${parts}</Types>`
  );
}

/** Splits the Markdown into typed blocks; the only text source for Word, PDF and the parser. */
function markdownBlocks(markdown) {
  const patterns = [
    ["title", /^# (.*)$/u],
    ["h1", /^## (.*)$/u],
    ["h2", /^### (.*)$/u],
    ["bullet", /^- (.*)$/u],
  ];
  return markdown.split("\n").map((line) => {
    for (const [kind, pattern] of patterns) {
      const match = pattern.exec(line);
      if (match) return { kind, text: match[1] };
    }
    return line.trim() === "" ? { kind: "blank", text: "" } : { kind: "para", text: line };
  });
}

function applyBlock(current, { kind, text }) {
  if (kind === "bullet") current.criteria.push(text);
  else if (kind === "para" && !/^(Abnahmekriterien:|Priorität: )/u.test(text)) current.text = text;
}

/** Reads description and acceptance criteria per requirement and cross-checks them with truth. */
function parseRequirements(corpus) {
  const byId = new Map(corpus.truth.map((item) => [item.id, { ...item, text: "", criteria: [] }]));
  let current = null;
  for (const block of markdownBlocks(corpus.markdown)) {
    if (block.kind === "h1" || block.kind === "title") current = null;
    else if (block.kind === "h2") current = byId.get(block.text.split(" ")[0]) ?? null;
    else if (current) applyBlock(current, block);
  }
  for (const item of byId.values()) {
    if (item.criteria.length !== item.acceptanceCount || item.text === "") {
      throw new Error(`corpus parse mismatch for ${item.id}`);
    }
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------- Word

const DOCX_STYLES = `${XML_HEAD}<w:styles xmlns:w="${NS_W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="de-DE"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:spacing w:after="40"/><w:contextualSpacing/></w:pPr></w:style></w:styles>`;

const DOCX_NUMBERING = `${XML_HEAD}<w:numbering xmlns:w="${NS_W}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

const DOCX_STYLE_OF = { title: "Title", h1: "Heading1", h2: "Heading2", bullet: "ListBullet" };

function wordParagraph({ kind, text }) {
  const style = DOCX_STYLE_OF[kind];
  const props = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${props}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function buildDocx(corpus) {
  const body = markdownBlocks(corpus.markdown)
    .filter(({ kind }) => kind !== "blank")
    .map(wordParagraph)
    .join("");
  const section =
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1304" ' +
    'w:bottom="1440" w:left="1304" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';
  return createZip([
    {
      name: "[Content_Types].xml",
      data: contentTypes([
        ["word/document.xml", `${CT_WORD}.document.main+xml`],
        ["word/styles.xml", `${CT_WORD}.styles+xml`],
        ["word/numbering.xml", `${CT_WORD}.numbering+xml`],
      ]),
    },
    { name: "_rels/.rels", data: relationships([["rId1", "officeDocument", "word/document.xml"]]) },
    {
      name: "word/_rels/document.xml.rels",
      data: relationships([
        ["rId1", "styles", "styles.xml"],
        ["rId2", "numbering", "numbering.xml"],
      ]),
    },
    {
      name: "word/document.xml",
      data: `${XML_HEAD}<w:document xmlns:w="${NS_W}"><w:body>${body}${section}</w:body></w:document>`,
    },
    { name: "word/styles.xml", data: DOCX_STYLES },
    { name: "word/numbering.xml", data: DOCX_NUMBERING },
  ]);
}

// ---------------------------------------------------------------- Excel

const XLSX_HEADER = ["ID", "Titel", "Bereich", "Priorität", "Abnahmekriterien"];
const XLSX_COLUMN_WIDTHS = [10, 38, 20, 12, 70];
const XLSX_STYLES = `${XML_HEAD}<styleSheet xmlns="${NS_S}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function sheetRows(requirements) {
  const rows = [
    XLSX_HEADER,
    ...requirements.map((item) => [
      item.id,
      item.title,
      item.area,
      item.priority,
      item.criteria.join("\n"),
    ]),
  ];
  return rows.map((cells, rowIndex) => ({ cells, header: rowIndex === 0 }));
}

function buildSheetXml(rows, indexOf) {
  const columns = XLSX_COLUMN_WIDTHS.map(
    (width, index) =>
      `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`,
  ).join("");
  const data = rows
    .map(({ cells, header }, rowIndex) => {
      const style = header ? 1 : 2;
      const cellXml = cells.map(
        (value, col) =>
          `<c r="${String.fromCharCode(65 + col)}${rowIndex + 1}" s="${style}" t="s"><v>${indexOf(value)}</v></c>`,
      );
      return `<row r="${rowIndex + 1}">${cellXml.join("")}</row>`;
    })
    .join("");
  const last = `E${rows.length}`;
  return (
    `${XML_HEAD}<worksheet xmlns="${NS_S}"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0">` +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<sheetFormatPr defaultRowHeight="15"/><cols>${columns}</cols><sheetData>${data}</sheetData>` +
    `<autoFilter ref="A1:${last}"/></worksheet>`
  );
}

function buildXlsx(requirements) {
  const rows = sheetRows(requirements);
  const strings = [...new Set(rows.flatMap(({ cells }) => cells))];
  const index = new Map(strings.map((value, position) => [value, position]));
  const total = rows.reduce((sum, { cells }) => sum + cells.length, 0);
  const sst =
    `${XML_HEAD}<sst xmlns="${NS_S}" count="${total}" uniqueCount="${strings.length}">` +
    strings.map((value) => `<si><t xml:space="preserve">${esc(value)}</t></si>`).join("") +
    "</sst>";
  const workbook =
    `${XML_HEAD}<workbook xmlns="${NS_S}" xmlns:r="${NS_REL}"><bookViews><workbookView/></bookViews>` +
    '<sheets><sheet name="Anforderungen" sheetId="1" r:id="rId1"/></sheets>' +
    '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">' +
    `Anforderungen!$A$1:$E$${rows.length}</definedName></definedNames></workbook>`;
  return createZip([
    {
      name: "[Content_Types].xml",
      data: contentTypes([
        ["xl/workbook.xml", `${CT_SHEET}.sheet.main+xml`],
        ["xl/worksheets/sheet1.xml", `${CT_SHEET}.worksheet+xml`],
        ["xl/styles.xml", `${CT_SHEET}.styles+xml`],
        ["xl/sharedStrings.xml", `${CT_SHEET}.sharedStrings+xml`],
      ]),
    },
    { name: "_rels/.rels", data: relationships([["rId1", "officeDocument", "xl/workbook.xml"]]) },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: relationships([
        ["rId1", "worksheet", "worksheets/sheet1.xml"],
        ["rId2", "styles", "styles.xml"],
        ["rId3", "sharedStrings", "sharedStrings.xml"],
      ]),
    },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/worksheets/sheet1.xml", data: buildSheetXml(rows, (value) => index.get(value)) },
    { name: "xl/styles.xml", data: XLSX_STYLES },
    { name: "xl/sharedStrings.xml", data: sst },
  ]);
}

// ---------------------------------------------------------------- PowerPoint

const NS_DECL_P = `xmlns:a="${NS_A}" xmlns:r="${NS_REL}" xmlns:p="${NS_P}"`;
const GROUP_PROPS =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm>' +
  '<a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const MASTER_CLR_MAP =
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
  'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
const CLR_OVERRIDE = "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>";
const SOLID = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
const LINE = `<a:ln w="9525">${SOLID}</a:ln>`;
const ACCENTS = ["2563EB", "0F766E", "B45309", "7C3AED", "BE123C", "475569"];
const THEME = `${XML_HEAD}<a:theme xmlns:a="${NS_A}" name="Lab"><a:themeElements><a:clrScheme name="Lab"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2>${ACCENTS.map((hex, i) => `<a:accent${i + 1}><a:srgbClr val="${hex}"/></a:accent${i + 1}>`).join("")}<a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme><a:fontScheme name="Lab"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Lab"><a:fillStyleLst>${SOLID}${SOLID}${SOLID}</a:fillStyleLst><a:lnStyleLst>${LINE}${LINE}${LINE}</a:lnStyleLst><a:effectStyleLst>${"<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${SOLID}${SOLID}${SOLID}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

const NO_BULLET =
  '<a:lstStyle><a:lvl1pPr marL="0" indent="0"><a:buNone/><a:defRPr sz="2400"/></a:lvl1pPr></a:lstStyle>';

function placeholder({ id, name, ph, box, text, list = "<a:lstStyle/>" }) {
  const spPr = box
    ? `<p:spPr><a:xfrm><a:off x="${box[0]}" y="${box[1]}"/><a:ext cx="${box[2]}" cy="${box[3]}"/></a:xfrm></p:spPr>`
    : "<p:spPr/>";
  const body = text === undefined ? '<a:p><a:endParaRPr lang="de-DE"/></a:p>' : text;
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
    `<p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr>${spPr}<p:txBody><a:bodyPr/>${list}${body}</p:txBody></p:sp>`
  );
}

function paragraphs(lines) {
  return lines
    .map((line) => `<a:p><a:r><a:rPr lang="de-DE"/><a:t>${esc(line)}</a:t></a:r></a:p>`)
    .join("");
}

const TITLE_BOX = [838200, 365125, 10515600, 1325563];
const BODY_BOX = [838200, 1825625, 10515600, 4351338];
const MASTER = `${XML_HEAD}<p:sldMaster ${NS_DECL_P}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP_PROPS}${placeholder({ id: 2, name: "Title", ph: 'type="title"', box: TITLE_BOX })}${placeholder({ id: 3, name: "Body", ph: 'type="body" idx="1"', box: BODY_BOX })}</p:spTree></p:cSld>${MASTER_CLR_MAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3200" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="2200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;

function layout(type, name, shapes) {
  return `${XML_HEAD}<p:sldLayout ${NS_DECL_P} type="${type}" preserve="1"><p:cSld name="${name}"><p:spTree>${GROUP_PROPS}${shapes}</p:spTree></p:cSld>${CLR_OVERRIDE}</p:sldLayout>`;
}

const LAYOUT_TITLE = layout(
  "title",
  "Titelfolie",
  placeholder({
    id: 2,
    name: "Title",
    ph: 'type="ctrTitle"',
    box: [1524000, 1122363, 9144000, 2387600],
  }) +
    placeholder({
      id: 3,
      name: "Subtitle",
      ph: 'type="subTitle" idx="1"',
      box: [1524000, 3602038, 9144000, 1655762],
      list: NO_BULLET,
    }),
);
const LAYOUT_BODY = layout(
  "obj",
  "Titel und Inhalt",
  placeholder({ id: 2, name: "Title", ph: 'type="title"' }) +
    placeholder({ id: 3, name: "Content", ph: 'idx="1"' }),
);

const NOTES_MASTER = `${XML_HEAD}<p:notesMaster ${NS_DECL_P}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP_PROPS}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:sp>${placeholder({ id: 3, name: "Notes", ph: 'type="body" sz="quarter" idx="3"', box: [685800, 4400550, 5486400, 3600450] })}</p:spTree></p:cSld>${MASTER_CLR_MAP}<p:notesStyle><a:lvl1pPr marL="0" algn="l"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`;

function slideXml(shapes) {
  return `${XML_HEAD}<p:sld ${NS_DECL_P}><p:cSld><p:spTree>${GROUP_PROPS}${shapes}</p:spTree></p:cSld>${CLR_OVERRIDE}</p:sld>`;
}

function notesXml(lines) {
  const image =
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>';
  const notes = placeholder({
    id: 3,
    name: "Notes",
    ph: 'type="body" idx="1"',
    text: paragraphs(lines),
  });
  return `${XML_HEAD}<p:notes ${NS_DECL_P}><p:cSld><p:spTree>${GROUP_PROPS}${image}${notes}</p:spTree></p:cSld>${CLR_OVERRIDE}</p:notes>`;
}

function areaStatistics(items) {
  const criteria = items.reduce((sum, item) => sum + item.acceptanceCount, 0);
  const without = items.filter((item) => item.acceptanceCount === 0).length;
  const vague = items.filter((item) => item.vague).length;
  return [
    `${items.length} Anforderungen, ${criteria} Abnahmekriterien.`,
    `${without} Anforderungen ohne Abnahmekriterien, ${vague} unscharf formuliert.`,
  ];
}

/** Slide plan: title slide first, then one slide per area in first-appearance order. */
function slidePlan(corpus, version) {
  const areas = [...new Set(corpus.truth.map((item) => item.area))];
  const title = {
    shapes:
      placeholder({
        id: 2,
        name: "Title",
        ph: 'type="ctrTitle"',
        text: paragraphs(["Lenkungskreis Kundenportal Schadenmeldung"]),
      }) +
      placeholder({
        id: 3,
        name: "Subtitle",
        ph: 'type="subTitle" idx="1"',
        text: paragraphs([`Anforderungsstand Version ${version}.0 (synthetisch, fiktiv)`]),
      }),
    notes: [`${corpus.truth.length} Anforderungen in ${areas.length} Bereichen.`],
    layout: 1,
  };
  const slides = areas.map((area) => {
    const items = corpus.truth.filter((item) => item.area === area);
    return {
      shapes:
        placeholder({ id: 2, name: "Title", ph: 'type="title"', text: paragraphs([area]) }) +
        placeholder({
          id: 3,
          name: "Content",
          ph: 'idx="1"',
          text: paragraphs(items.map((item) => `${item.id} ${item.title}`)),
        }),
      notes: areaStatistics(items).map((line) => `${area}: ${line}`),
      layout: 2,
    };
  });
  return [title, ...slides];
}

function pptxOverrides(count) {
  const slides = Array.from({ length: count }, (_, i) => i + 1);
  return [
    ["ppt/presentation.xml", `${CT_SLIDE}.presentation.main+xml`],
    ["ppt/slideMasters/slideMaster1.xml", `${CT_SLIDE}.slideMaster+xml`],
    ["ppt/slideLayouts/slideLayout1.xml", `${CT_SLIDE}.slideLayout+xml`],
    ["ppt/slideLayouts/slideLayout2.xml", `${CT_SLIDE}.slideLayout+xml`],
    ["ppt/notesMasters/notesMaster1.xml", `${CT_SLIDE}.notesMaster+xml`],
    ["ppt/theme/theme1.xml", CT_THEME],
    ["ppt/theme/theme2.xml", CT_THEME],
    ...slides.map((n) => [`ppt/slides/slide${n}.xml`, `${CT_SLIDE}.slide+xml`]),
    ...slides.map((n) => [`ppt/notesSlides/notesSlide${n}.xml`, `${CT_SLIDE}.notesSlide+xml`]),
  ];
}

function presentationXml(count) {
  const ids = Array.from(
    { length: count },
    (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`,
  );
  return (
    `${XML_HEAD}<p:presentation ${NS_DECL_P}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/>` +
    `</p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>` +
    `<p:sldIdLst>${ids.join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/>` +
    '<p:notesSz cx="6858000" cy="9144000"/></p:presentation>'
  );
}

function slideEntries(plan) {
  return plan.flatMap((slide, index) => {
    const n = index + 1;
    return [
      { name: `ppt/slides/slide${n}.xml`, data: slideXml(slide.shapes) },
      {
        name: `ppt/slides/_rels/slide${n}.xml.rels`,
        data: relationships([
          ["rId1", "slideLayout", `../slideLayouts/slideLayout${slide.layout}.xml`],
          ["rId2", "notesSlide", `../notesSlides/notesSlide${n}.xml`],
        ]),
      },
      { name: `ppt/notesSlides/notesSlide${n}.xml`, data: notesXml(slide.notes) },
      {
        name: `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
        data: relationships([
          ["rId1", "notesMaster", "../notesMasters/notesMaster1.xml"],
          ["rId2", "slide", `../slides/slide${n}.xml`],
        ]),
      },
    ];
  });
}

function buildPptx(corpus, version) {
  const plan = slidePlan(corpus, version);
  const presentationRels = [
    ["rId1", "slideMaster", "slideMasters/slideMaster1.xml"],
    ["rId2", "notesMaster", "notesMasters/notesMaster1.xml"],
    ...plan.map((_, i) => [`rId${i + 3}`, "slide", `slides/slide${i + 1}.xml`]),
  ];
  const layoutRel = relationships([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]);
  return createZip([
    { name: "[Content_Types].xml", data: contentTypes(pptxOverrides(plan.length)) },
    {
      name: "_rels/.rels",
      data: relationships([["rId1", "officeDocument", "ppt/presentation.xml"]]),
    },
    { name: "ppt/presentation.xml", data: presentationXml(plan.length) },
    { name: "ppt/_rels/presentation.xml.rels", data: relationships(presentationRels) },
    { name: "ppt/slideMasters/slideMaster1.xml", data: MASTER },
    {
      name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      data: relationships([
        ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
        ["rId2", "slideLayout", "../slideLayouts/slideLayout2.xml"],
        ["rId3", "theme", "../theme/theme1.xml"],
      ]),
    },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: LAYOUT_TITLE },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: layoutRel },
    { name: "ppt/slideLayouts/slideLayout2.xml", data: LAYOUT_BODY },
    { name: "ppt/slideLayouts/_rels/slideLayout2.xml.rels", data: layoutRel },
    { name: "ppt/notesMasters/notesMaster1.xml", data: NOTES_MASTER },
    {
      name: "ppt/notesMasters/_rels/notesMaster1.xml.rels",
      data: relationships([["rId1", "theme", "../theme/theme2.xml"]]),
    },
    { name: "ppt/theme/theme1.xml", data: THEME },
    { name: "ppt/theme/theme2.xml", data: THEME },
    ...slideEntries(plan),
  ]);
}

// ---------------------------------------------------------------- PDF

const PAGE = { width: 595, height: 842, margin: 56 };
const PDF_STYLES = {
  title: { font: "F2", size: 16, wrap: 62, before: 0, after: 8 },
  h1: { font: "F2", size: 13, wrap: 76, before: 14, after: 4 },
  h2: { font: "F2", size: 11, wrap: 88, before: 8, after: 2 },
  para: { font: "F1", size: 10, wrap: 92, before: 0, after: 0 },
  bullet: { font: "F1", size: 10, wrap: 88, before: 0, after: 0 },
};
const WIN_ANSI = new Map(
  Object.entries({
    "€": 0x80,
    "‚": 0x82,
    "„": 0x84,
    "…": 0x85,
    "‘": 0x91,
    "’": 0x92,
    "“": 0x93,
    "”": 0x94,
    "•": 0x95,
    "–": 0x96,
    "—": 0x97,
    "™": 0x99,
  }),
);

/** Escapes text for a PDF literal string in WinAnsi; every non-ASCII byte is an octal escape. */
function pdfString(text) {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0);
    const byte = WIN_ANSI.get(char) ?? (code < 0x100 ? code : 0x3f);
    if (char === "(" || char === ")" || char === "\\") out += `\\${char}`;
    else if (byte < 0x20 || byte > 0x7e) out += `\\${byte.toString(8).padStart(3, "0")}`;
    else out += char;
  }
  return `(${out})`;
}

function wrapText(text, width, indent) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + word.length + 1 > width) {
      lines.push(line);
      line = indent + word;
    } else line = line === "" ? word : `${line} ${word}`;
  }
  return [...lines, line];
}

/** Lays the blocks out onto pages as `[{ x, y, font, size, text }]`. */
function layoutPdf(blocks) {
  const pages = [[]];
  let y = PAGE.height - PAGE.margin;
  for (const { kind, text } of blocks) {
    if (kind === "blank") continue;
    const style = PDF_STYLES[kind];
    const prefix = kind === "bullet" ? "• " : "";
    const lines = wrapText(`${prefix}${text}`, style.wrap, kind === "bullet" ? "  " : "");
    y -= style.before;
    for (const line of lines) {
      y -= style.size * 1.45;
      if (y < PAGE.margin) {
        pages.push([]);
        y = PAGE.height - PAGE.margin - style.size * 1.45;
      }
      pages
        .at(-1)
        .push({ x: PAGE.margin, y: y.toFixed(2), font: style.font, size: style.size, text: line });
    }
    y -= style.after;
  }
  return pages;
}

function pageStream(lines) {
  const ops = lines.map(
    ({ x, y, font, size, text }) =>
      `/${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm ${pdfString(text)} Tj`,
  );
  return `BT\n${ops.join("\n")}\nET`;
}

function buildPdf(corpus) {
  const pages = layoutPdf(markdownBlocks(corpus.markdown));
  const fonts = "/Font << /F1 3 0 R /F2 4 0 R >>";
  const kids = pages.map((_, i) => `${6 + i * 2} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    "<< /Title (Lastenheft Schadenmeldung) /Producer (Keiko Jira lab) >>",
  ];
  pages.forEach((lines, i) => {
    const stream = pageStream(lines);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << ${fonts} >> /Contents ${7 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  return assemblePdf(objects);
}

function assemblePdf(objects) {
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  const rows = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${rows}` +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

// ---------------------------------------------------------------- Public API

/** Writes the Word, Excel, PowerPoint and PDF renderings; returns their absolute paths. */
export function writeCorpusDocuments(directory, version = 1) {
  const corpus = buildCorpus(version);
  const stem = corpus.fileName.replace(/\.md$/u, "");
  const suffix = `Schadenmeldung-v${version}`;
  const files = [
    [`${stem}.docx`, buildDocx(corpus)],
    [`Anforderungsliste-${suffix}.xlsx`, buildXlsx(parseRequirements(corpus))],
    [`Lenkungskreis-${suffix}.pptx`, buildPptx(corpus, version)],
    [`${stem}.pdf`, buildPdf(corpus)],
  ];
  mkdirSync(directory, { recursive: true });
  return files.map(([name, data]) => {
    const path = resolve(directory, name);
    writeFileSync(path, data);
    return path;
  });
}

function parseArguments(argv) {
  const [directory, ...rest] = argv;
  const flag = rest.indexOf("--version");
  const version = flag === -1 ? 1 : Number(rest[flag + 1]);
  if (!directory || (version !== 1 && version !== 2)) {
    throw new Error("usage: corpus-documents.mjs <outDir> [--version 1|2]");
  }
  return { directory, version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { directory, version } = parseArguments(process.argv.slice(2));
  for (const path of writeCorpusDocuments(join(directory), version)) console.log(path);
}
