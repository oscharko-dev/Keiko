// Text of the objects a slide embeds by relationship: charts (`ppt/charts/chartN.xml`) and SmartArt
// diagrams (`ppt/diagrams/dataN.xml`). Both are text the audience reads on the slide - a chart's
// title, axis titles, series names, categories and plotted values; a diagram's node labels - yet
// none of it sits in the slide part. Each reader is a linear walk over the shared OOXML tokens and
// returns plain lines with the number of objects it spent, so the caller can charge the deck-wide
// object budget. Cached values are read; the workbook behind a chart is never opened.

import { scanXmlTokens, type XmlTag } from "./pptx-xml.js";

export interface EmbeddedLimits {
  readonly maxDepth: number;
  /** Remaining object budget; the walk stops when it is exceeded. */
  readonly maxObjects: number;
}

export interface EmbeddedRead {
  readonly lines: readonly string[];
  readonly objectCount: number;
  readonly limitReached: boolean;
}

// ─── Charts ──────────────────────────────────────────────────────────────────

type SeriesPart = "name" | "category" | "value";

interface Series {
  name: string;
  readonly categories: string[];
  readonly values: string[];
}

interface ChartState {
  readonly lines: string[];
  /** Local names of the open elements, outermost first. */
  readonly path: string[];
  series: Series | undefined;
  seriesCount: number;
  part: SeriesPart | undefined;
  title: string[] | undefined;
  titleOwner: string;
  /** Character data of the open `c:v` or `a:t` element. */
  text: string[] | undefined;
  objectCount: number;
}

const CATEGORY_PARTS: ReadonlySet<string> = new Set(["cat", "xVal"]);
const VALUE_PARTS: ReadonlySet<string> = new Set(["val", "yVal"]);

type ChartHandler = (state: ChartState, tag: XmlTag) => void;

function seriesPartOf(local: string): SeriesPart | undefined {
  if (local === "tx") return "name";
  if (CATEGORY_PARTS.has(local)) return "category";
  return VALUE_PARTS.has(local) ? "value" : undefined;
}

function seriesLine(series: Series, index: number): string {
  const label = series.name.length > 0 ? series.name : `Series ${String(index)}`;
  const pairs = series.values.map((value, position) => {
    const category = series.categories[position];
    return category === undefined || category.length === 0 ? value : `${category}=${value}`;
  });
  return pairs.length === 0
    ? `Chart series: ${label}`
    : `Chart series ${label}: ${pairs.join(" | ")}`;
}

function titleLine(owner: string, text: string): string {
  return owner === "chart" ? `Chart title: ${text}` : `Axis title: ${text}`;
}

function openText(state: ChartState): void {
  state.text = [];
}

function openTitleText(state: ChartState): void {
  if (state.title !== undefined) state.text = [];
}

function openSeriesPart(state: ChartState, tag: XmlTag): void {
  // Only direct children of the series: a data label's own `c:tx` is not the series name.
  if (state.series !== undefined && state.path.at(-1) === "ser") {
    state.part = seriesPartOf(tag.local);
  }
}

function closeSeriesPart(state: ChartState, tag: XmlTag): void {
  if (state.path.at(-1) === "ser" && seriesPartOf(tag.local) === state.part) state.part = undefined;
}

function closeSeries(state: ChartState): void {
  if (state.series !== undefined) {
    state.seriesCount += 1;
    state.lines.push(seriesLine(state.series, state.seriesCount));
  }
  state.series = undefined;
  state.part = undefined;
}

function closeTitle(state: ChartState): void {
  const text = state.title?.join("").replaceAll(/\s+/gu, " ").trim() ?? "";
  if (text.length > 0) state.lines.push(titleLine(state.titleOwner, text));
  state.title = undefined;
}

function recordSeriesValue(series: Series, part: SeriesPart | undefined, text: string): void {
  if (part === "name") series.name = text;
  else if (part === "category") series.categories.push(text);
  else if (part === "value") series.values.push(text);
}

function chartText(state: ChartState): void {
  const raw = state.text?.join("");
  state.text = undefined;
  const text = raw?.trim();
  if (raw === undefined || text === undefined || text.length === 0) return;
  state.objectCount += 1;
  if (state.title !== undefined) {
    // Runs of one title join as written; the spaces between words sit inside the runs.
    state.title.push(raw);
  } else if (state.series !== undefined) {
    recordSeriesValue(state.series, state.part, text);
  }
}

const CHART_OPEN: Readonly<Record<string, ChartHandler>> = {
  "c:ser": (state) => {
    state.series = { name: "", categories: [], values: [] };
  },
  "c:title": (state) => {
    state.title = [];
    state.titleOwner = state.path.at(-1) ?? "";
  },
  "c:tx": openSeriesPart,
  "c:cat": openSeriesPart,
  "c:xVal": openSeriesPart,
  "c:val": openSeriesPart,
  "c:yVal": openSeriesPart,
  "c:v": openText,
  "a:t": openTitleText,
};

const CHART_CLOSE: Readonly<Record<string, ChartHandler>> = {
  "c:ser": closeSeries,
  "c:title": closeTitle,
  "c:tx": closeSeriesPart,
  "c:cat": closeSeriesPart,
  "c:xVal": closeSeriesPart,
  "c:val": closeSeriesPart,
  "c:yVal": closeSeriesPart,
  "a:p": (state) => {
    state.title?.push(" ");
  },
  "c:v": chartText,
  "a:t": chartText,
};

function handlerFor<T>(table: Readonly<Record<string, T>>, tag: XmlTag): T | undefined {
  const key = `${tag.prefix}:${tag.local}`;
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function applyChartTag(state: ChartState, tag: XmlTag): void {
  // The path always ends at the parent while a handler runs, for opening and closing tags alike.
  if (!tag.closing) handlerFor(CHART_OPEN, tag)?.(state, tag);
  if (tag.closing && !tag.selfClosing) state.path.pop();
  if (tag.closing || tag.selfClosing) handlerFor(CHART_CLOSE, tag)?.(state, tag);
  if (!tag.closing && !tag.selfClosing) state.path.push(tag.local);
}

/** Title, axis titles and series (name, categories, cached values) of one chart part. */
export function readChartLines(xml: string, limits: EmbeddedLimits): EmbeddedRead {
  const state: ChartState = {
    lines: [],
    path: [],
    series: undefined,
    seriesCount: 0,
    part: undefined,
    title: undefined,
    titleOwner: "",
    text: undefined,
    objectCount: 0,
  };
  for (const token of scanXmlTokens(xml, limits.maxDepth)) {
    if (token.kind === "text") state.text?.push(token.value);
    else applyChartTag(state, token);
    if (state.objectCount > limits.maxObjects) {
      return { lines: state.lines, objectCount: state.objectCount, limitReached: true };
    }
  }
  return { lines: state.lines, objectCount: state.objectCount, limitReached: false };
}

// ─── SmartArt diagrams ───────────────────────────────────────────────────────

/** Points that are layout bookkeeping rather than diagram text. */
const STRUCTURAL_POINT_TYPES: ReadonlySet<string> = new Set(["pres", "parTrans", "sibTrans"]);

interface DiagramState {
  readonly lines: string[];
  pointText: boolean;
  inPointText: boolean;
  paragraph: string[] | undefined;
  text: string[] | undefined;
  objectCount: number;
}

type DiagramHandler = (state: DiagramState, tag: XmlTag) => void;

function closeDiagramParagraph(state: DiagramState): void {
  if (state.paragraph === undefined) return;
  const line = state.paragraph.join("").replaceAll(/\s+/gu, " ").trim();
  state.paragraph = undefined;
  state.objectCount += 1;
  if (line.length > 0) state.lines.push(line);
}

function closeDiagramText(state: DiagramState): void {
  if (state.text === undefined) return;
  state.paragraph?.push(state.text.join(""));
  state.text = undefined;
}

const DIAGRAM_OPEN: Readonly<Record<string, DiagramHandler>> = {
  "dgm:pt": (state, tag) => {
    state.pointText = !STRUCTURAL_POINT_TYPES.has(tag.attributes.get("type") ?? "node");
  },
  "dgm:t": (state) => {
    state.inPointText = true;
  },
  "a:p": (state) => {
    if (state.inPointText && state.pointText) state.paragraph = [];
  },
  "a:t": (state) => {
    if (state.paragraph !== undefined) state.text = [];
  },
};

const DIAGRAM_CLOSE: Readonly<Record<string, DiagramHandler>> = {
  "dgm:pt": (state) => {
    state.pointText = false;
  },
  "dgm:t": (state) => {
    state.inPointText = false;
  },
  "a:t": closeDiagramText,
  "a:p": closeDiagramParagraph,
};

/** Node labels of one SmartArt data model, in the order the model lists them. */
export function readDiagramLines(xml: string, limits: EmbeddedLimits): EmbeddedRead {
  const state: DiagramState = {
    lines: [],
    pointText: false,
    inPointText: false,
    paragraph: undefined,
    text: undefined,
    objectCount: 0,
  };
  for (const token of scanXmlTokens(xml, limits.maxDepth)) {
    if (token.kind === "text") {
      state.text?.push(token.value);
      continue;
    }
    if (!token.closing) handlerFor(DIAGRAM_OPEN, token)?.(state, token);
    if (token.closing || token.selfClosing) handlerFor(DIAGRAM_CLOSE, token)?.(state, token);
    if (state.objectCount > limits.maxObjects) {
      return { lines: state.lines, objectCount: state.objectCount, limitReached: true };
    }
  }
  return { lines: state.lines, objectCount: state.objectCount, limitReached: false };
}
