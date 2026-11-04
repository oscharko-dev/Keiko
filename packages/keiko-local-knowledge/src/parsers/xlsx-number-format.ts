// Renders a spreadsheet number the way its cell format shows it (#4235).
//
// A workbook stores `0.19` and a format that says "percent"; a person reads `19%`. Indexing the
// stored number would hand retrieval and the requirement inventory a value nobody sees. This module
// applies the number format as far as it is locale independent:
//
//   * dates and times render as ISO-8601 (`2026-03-05`, `08:30`, `2026-03-05 12:00`), in the 1900
//     or the 1904 date system;
//   * percent, fixed decimals, optional decimals, leading zeros, scientific notation and literal
//     prefixes/suffixes (currency symbols included) are applied;
//   * thousands separators and the decimal comma are NOT: they depend on the viewer's locale, which
//     the file does not record, and `1,234.50` read by a German reader means something else.
//
// A format this module does not understand (fractions, text sections) falls back to the plain
// General rendering, never to a guess. Pure and linear in the format and value length.

const BUILT_IN_FORMATS: ReadonlyMap<number, string> = new Map([
  [1, "0"],
  [2, "0.00"],
  [5, "0"],
  [6, "0"],
  [7, "0.00"],
  [8, "0.00"],
  [3, "#,##0"],
  [4, "#,##0.00"],
  [9, "0%"],
  [10, "0.00%"],
  [11, "0.00E+00"],
  [37, "#,##0 ;(#,##0)"],
  [38, "#,##0 ;[Red](#,##0)"],
  [39, "#,##0.00;(#,##0.00)"],
  [40, "#,##0.00;[Red](#,##0.00)"],
  [41, "#,##0"],
  [42, "#,##0"],
  [43, "#,##0.00"],
  [44, "#,##0.00"],
  [48, "##0.0E+0"],
  [49, "@"],
]);

const DATE_FORMAT_IDS: ReadonlySet<number> = new Set([
  14, 15, 16, 17, 27, 28, 29, 30, 31, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);
const DATE_TIME_FORMAT_IDS: ReadonlySet<number> = new Set([22]);
const TIME_FORMAT_IDS: ReadonlySet<number> = new Set([18, 19, 20, 21, 32, 33, 34, 35, 45, 46, 47]);
const ELAPSED_FORMAT_IDS: ReadonlySet<number> = new Set([46]);
const SECONDS_FORMAT_IDS: ReadonlySet<number> = new Set([19, 21, 33, 35, 45, 46, 47]);

const MS_PER_DAY = 86_400_000;
const SECONDS_PER_DAY = 86_400;
const MAX_SERIAL = 2_958_465;

export interface NumberFormatInput {
  readonly raw: string;
  readonly numFmtId: number | undefined;
  readonly customNumFmts: ReadonlyMap<number, string>;
  readonly date1904: boolean;
}

interface DateTimeShape {
  readonly kind: "date" | "time" | "date-time";
  readonly seconds: boolean;
  readonly elapsed: boolean;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

// ─── Format code analysis ─────────────────────────────────────────────────────

interface SplitState {
  readonly sections: string[];
  current: string;
  quoted: boolean;
  bracketed: boolean;
}

function trackDelimiters(state: SplitState, ch: string): void {
  if (ch === '"') state.quoted = !state.quoted;
  else if (!state.quoted && ch === "[") state.bracketed = true;
  else if (!state.quoted && ch === "]") state.bracketed = false;
}

/** Splits a format code at `;` outside quotes and brackets. */
function splitSections(code: string): readonly string[] {
  const state: SplitState = { sections: [], current: "", quoted: false, bracketed: false };
  for (let index = 0; index < code.length; index += 1) {
    const ch = code.charAt(index);
    if (ch === "\\" && !state.quoted) {
      state.current += ch + code.charAt(index + 1);
      index += 1;
      continue;
    }
    trackDelimiters(state, ch);
    if (ch === ";" && !state.quoted && !state.bracketed) {
      state.sections.push(state.current);
      state.current = "";
    } else {
      state.current += ch;
    }
  }
  state.sections.push(state.current);
  return state.sections;
}

/** The format code with quoted text, escapes, skip/fill markers and brackets removed. */
function bareFormat(section: string): string {
  return section
    .replaceAll(/"[^"]*"/gu, "")
    .replaceAll(/\\./gu, "")
    .replaceAll(/_./gu, "")
    .replaceAll(/\*./gu, "")
    .replaceAll(/\[[^\]]*\]/gu, "");
}

function hasElapsedBracket(section: string): boolean {
  return /\[(?:h+|m+|s+)\]/iu.test(section.replaceAll(/"[^"]*"/gu, ""));
}

// `m` is a minute only next to an hour or a second token; otherwise it is a month.
function hasMinuteToken(bare: string): boolean {
  return /h[^dmys]*m|m[^dmyh]*s/iu.test(bare);
}

function dateTimeShape(section: string): DateTimeShape | undefined {
  const bare = bareFormat(section).replaceAll(/AM\/PM|A\/P/giu, "");
  const elapsed = hasElapsedBracket(section);
  const minute = hasMinuteToken(bare);
  const hasDate = /[yd]/iu.test(bare) || (/m/iu.test(bare) && !minute);
  const hasTime = elapsed || minute || /[hs]/iu.test(bare);
  if (!hasDate && !hasTime) return undefined;
  if (!hasTime) return { kind: "date", seconds: false, elapsed: false };
  const seconds = /s/iu.test(bare) || /\[s+\]/iu.test(section);
  return { kind: hasDate ? "date-time" : "time", seconds, elapsed };
}

function builtInShape(numFmtId: number): DateTimeShape | undefined {
  if (DATE_FORMAT_IDS.has(numFmtId)) return { kind: "date", seconds: false, elapsed: false };
  if (DATE_TIME_FORMAT_IDS.has(numFmtId)) {
    return { kind: "date-time", seconds: false, elapsed: false };
  }
  if (!TIME_FORMAT_IDS.has(numFmtId)) return undefined;
  return {
    kind: "time",
    seconds: SECONDS_FORMAT_IDS.has(numFmtId),
    elapsed: ELAPSED_FORMAT_IDS.has(numFmtId),
  };
}

// ─── Dates and times ──────────────────────────────────────────────────────────

function isoDate(days: number, date1904: boolean): string {
  if (!date1904 && days === 60) return "1900-02-29";
  // Excel's 1900 system counts a leap day that never existed: from serial 61 on, day 1 is
  // 1899-12-31 + 1, before it the epoch sits one day later.
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, days < 60 ? 31 : 30);
  const date = new Date(epoch + days * MS_PER_DAY);
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${pad2(date.getUTCMonth() + 1)}-${pad2(
    date.getUTCDate(),
  )}`;
}

function clock(secondOfDay: number, hours: number, seconds: boolean): string {
  const minutes = Math.floor((secondOfDay % 3600) / 60);
  const base = `${pad2(hours)}:${pad2(minutes)}`;
  return seconds ? `${base}:${pad2(secondOfDay % 60)}` : base;
}

function renderDateTime(
  serial: number,
  shape: DateTimeShape,
  date1904: boolean,
): string | undefined {
  if (!(serial >= 0 && serial <= MAX_SERIAL)) return undefined;
  const unit = shape.seconds ? 1 : 60;
  const total = Math.round((serial * SECONDS_PER_DAY) / unit) * unit;
  const days = Math.floor(total / SECONDS_PER_DAY);
  const secondOfDay = total - days * SECONDS_PER_DAY;
  if (shape.kind === "date") return isoDate(Math.floor(serial), date1904);
  const hours = shape.elapsed ? Math.floor(total / 3600) : Math.floor(secondOfDay / 3600);
  const time = clock(shape.elapsed ? total % 3600 : secondOfDay, hours, shape.seconds);
  return shape.kind === "time" ? time : `${isoDate(days, date1904)} ${time}`;
}

// ─── Plain numbers ────────────────────────────────────────────────────────────

/** Excel's General: 15 significant digits, so binary noise (`0.30000000000000004`) disappears. */
function generalNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return String(Number(value.toPrecision(15))).replace("e", "E");
}

interface NumberLayout {
  readonly prefix: string;
  readonly suffix: string;
  readonly integerDigits: number;
  readonly minDecimals: number;
  readonly maxDecimals: number;
  readonly percent: number;
  readonly scientific: number | undefined;
}

interface LayoutScan {
  prefix: string;
  suffix: string;
  integerDigits: number;
  minDecimals: number;
  maxDecimals: number;
  percent: number;
  scientific: number | undefined;
  seenPlaceholder: boolean;
  afterPoint: boolean;
  unsupported: boolean;
}

function currencyLiteral(bracket: string): string {
  if (!bracket.startsWith("[$")) return "";
  const body = bracket.slice(2, -1);
  const dash = body.indexOf("-");
  return dash < 0 ? body : body.slice(0, dash);
}

function appendLiteral(scan: LayoutScan, text: string): void {
  if (scan.seenPlaceholder) scan.suffix += text;
  else scan.prefix += text;
}

function scanPlaceholder(scan: LayoutScan, ch: string): void {
  scan.seenPlaceholder = true;
  if (scan.afterPoint) {
    scan.maxDecimals += 1;
    if (ch === "0") scan.minDecimals = scan.maxDecimals;
  } else if (ch === "0") {
    scan.integerDigits += 1;
  }
}

function scanExponent(scan: LayoutScan, section: string, index: number): number {
  const sign = section.charAt(index + 1);
  if (sign !== "+" && sign !== "-") {
    appendLiteral(scan, section.charAt(index));
    return index;
  }
  let digits = 0;
  let cursor = index + 2;
  while (section.charAt(cursor) === "0") {
    digits += 1;
    cursor += 1;
  }
  scan.scientific = Math.max(digits, 1);
  return cursor - 1;
}

function scanQuoted(section: string, index: number): { text: string; next: number } {
  const close = section.indexOf('"', index + 1);
  const end = close < 0 ? section.length : close;
  return { text: section.slice(index + 1, end), next: end };
}

// eslint-disable-next-line complexity
function scanSection(section: string): NumberLayout | undefined {
  const scan: LayoutScan = {
    prefix: "",
    suffix: "",
    integerDigits: 0,
    minDecimals: 0,
    maxDecimals: 0,
    percent: 0,
    scientific: undefined,
    seenPlaceholder: false,
    afterPoint: false,
    unsupported: false,
  };
  for (let index = 0; index < section.length; index += 1) {
    const ch = section.charAt(index);
    if (ch === '"') {
      const quoted = scanQuoted(section, index);
      appendLiteral(scan, quoted.text);
      index = quoted.next;
    } else if (ch === "\\") {
      appendLiteral(scan, section.charAt(index + 1));
      index += 1;
    } else if (ch === "_" || ch === "*") {
      index += 1;
    } else if (ch === "[") {
      const close = section.indexOf("]", index);
      const end = close < 0 ? section.length : close;
      appendLiteral(scan, currencyLiteral(section.slice(index, end + 1)));
      index = end;
    } else if (ch === "0" || ch === "#" || ch === "?") {
      scanPlaceholder(scan, ch);
    } else if (ch === ".") {
      if (scan.seenPlaceholder) scan.afterPoint = true;
      else appendLiteral(scan, ch);
    } else if (ch === "%") {
      scan.percent += 1;
      appendLiteral(scan, ch);
    } else if (ch === "E" || ch === "e") {
      index = scanExponent(scan, section, index);
    } else if (ch === "/" || ch === "@") {
      scan.unsupported = true;
    } else if (ch !== ",") {
      appendLiteral(scan, ch);
    }
  }
  if (scan.unsupported || !scan.seenPlaceholder) return undefined;
  return scan;
}

function roundedDecimal(value: number, maxDecimals: number, minDecimals: number): string {
  const factor = 10 ** maxDecimals;
  const rounded = Math.round(Number((value * factor).toPrecision(15))) / factor;
  let text = rounded.toFixed(maxDecimals);
  if (maxDecimals > minDecimals) {
    const [whole = "0", fraction = ""] = text.split(".");
    const kept = fraction.replace(/0+$/u, "").padEnd(minDecimals, "0");
    text = kept.length > 0 ? `${whole}.${kept}` : whole;
  }
  return text;
}

function scientificText(value: number, layout: NumberLayout, exponentDigits: number): string {
  const [mantissa = "0", exponent = "0"] = value.toExponential(layout.maxDecimals).split("e");
  const exp = Number.parseInt(exponent, 10);
  const sign = exp < 0 ? "-" : "+";
  return `${mantissa}E${sign}${Math.abs(exp).toString().padStart(exponentDigits, "0")}`;
}

function layoutNumber(magnitude: number, layout: NumberLayout): string {
  const scaled = magnitude * 100 ** layout.percent;
  if (layout.scientific !== undefined) return scientificText(scaled, layout, layout.scientific);
  const text = roundedDecimal(scaled, layout.maxDecimals, layout.minDecimals);
  const [whole = "0", fraction] = text.split(".");
  const padded = whole.padStart(layout.integerDigits, "0");
  return fraction === undefined ? padded : `${padded}.${fraction}`;
}

function chooseSection(sections: readonly string[], value: number): string {
  if (value < 0 && sections.length > 1) return sections[1] ?? "";
  if (value === 0 && sections.length > 2) return sections[2] ?? "";
  return sections[0] ?? "";
}

function formatPlainNumber(value: number, code: string): string {
  const sections = splitSections(code);
  const section = chooseSection(sections, value);
  const layout = scanSection(section);
  if (layout === undefined) return generalNumber(value);
  const ownsSign = value < 0 && sections.length > 1;
  const sign = value < 0 && !ownsSign ? "-" : "";
  return `${sign}${layout.prefix}${layoutNumber(Math.abs(value), layout)}${layout.suffix}`;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

// Excel limits a format code to 255 characters; a longer one is not a format, and the bracket and
// quote scans below are only linear for bounded input.
const MAX_FORMAT_CODE_CHARS = 255;

function resolveCode(input: NumberFormatInput): string | undefined {
  if (input.numFmtId === undefined) return undefined;
  const code = input.customNumFmts.get(input.numFmtId) ?? BUILT_IN_FORMATS.get(input.numFmtId);
  return code !== undefined && code.length <= MAX_FORMAT_CODE_CHARS ? code : undefined;
}

function classify(
  input: NumberFormatInput,
  code: string | undefined,
): "number" | "text" | DateTimeShape {
  const builtIn = input.numFmtId === undefined ? undefined : builtInShape(input.numFmtId);
  if (builtIn !== undefined && !input.customNumFmts.has(input.numFmtId ?? -1)) return builtIn;
  if (code === undefined) return "number";
  if (code === "@") return "text";
  const shape = dateTimeShape(splitSections(code)[0] ?? "");
  return shape ?? "number";
}

/**
 * The text a person reads in the cell for a numeric payload. `raw` is the decoded `<v>` text; a
 * payload that is not a finite number is returned unchanged.
 */
export function formatNumericCell(input: NumberFormatInput): string {
  const value = Number(input.raw);
  if (input.raw.trim() === "" || !Number.isFinite(value)) return input.raw;
  const code = resolveCode(input);
  const kind = classify(input, code);
  if (kind === "text") return input.raw;
  if (kind === "number") {
    return code === undefined || code.toLowerCase() === "general"
      ? generalNumber(value)
      : formatPlainNumber(value, code);
  }
  return renderDateTime(value, kind, input.date1904) ?? input.raw;
}
