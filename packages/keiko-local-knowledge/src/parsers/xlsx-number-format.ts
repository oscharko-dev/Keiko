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

// Excel caps a format code at 255 characters and shows at most 30 decimals; a layout with more
// digit placeholders than this is no real format and renders as General, so a hostile format code
// can never make the number rendering throw or allocate without bound.
const MAX_LAYOUT_DIGITS = 40;
// Excel keeps 15 significant digits of a double; whatever follows is zero.
const SIGNIFICANT_DIGITS = 15;

const MS_PER_DAY = 86_400_000;
const SECONDS_PER_DAY = 86_400;
const MAX_SERIAL = 2_958_465;

export interface NumberFormatInput {
  readonly raw: string;
  readonly numFmtId: number | undefined;
  readonly customNumFmts: ReadonlyMap<number, string>;
  readonly date1904: boolean;
}

// The unit of an elapsed-time bracket (`[h]`, `[m]`, `[s]`): the count that leads the rendering.
type ElapsedUnit = "h" | "m" | "s";

interface DateTimeShape {
  readonly kind: "date" | "time" | "date-time";
  readonly seconds: boolean;
  readonly elapsed: ElapsedUnit | undefined;
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

const ELAPSED_BRACKETS = /\[(h+|m+|s+)\]/giu;
const FIRST_ELAPSED_BRACKET = /\[(h+|m+|s+)\]/iu;

// The unit of the first elapsed bracket outside quotes: `[h]:mm` counts hours, `[mm]:ss` minutes.
function elapsedUnitOf(section: string): ElapsedUnit | undefined {
  const unquoted = section.replaceAll(/"[^"]*"/gu, "");
  const token = FIRST_ELAPSED_BRACKET.exec(unquoted)?.[1]?.toLowerCase();
  if (token === undefined) return undefined;
  if (token.startsWith("h")) return "h";
  return token.startsWith("m") ? "m" : "s";
}

// `m` is a minute only next to an hour or a second token; otherwise it is a month.
function hasMinuteToken(bare: string): boolean {
  return /h[^dmys]*m|m[^dmyh]*s/iu.test(bare);
}

function dateTimeShape(section: string): DateTimeShape | undefined {
  // An elapsed bracket is an hour, minute or second token like any other: `[h]:mm` ends in minutes.
  const tokens = section.replaceAll(ELAPSED_BRACKETS, "$1");
  const bare = bareFormat(tokens).replaceAll(/AM\/PM|A\/P/giu, "");
  const elapsed = elapsedUnitOf(section);
  const minute = hasMinuteToken(bare);
  const hasDate = /[yd]/iu.test(bare) || (elapsed === undefined && /m/iu.test(bare) && !minute);
  const hasTime = elapsed !== undefined || minute || /[hs]/iu.test(bare);
  if (!hasDate && !hasTime) return undefined;
  if (!hasTime) return { kind: "date", seconds: false, elapsed: undefined };
  return { kind: hasDate ? "date-time" : "time", seconds: /s/iu.test(bare), elapsed };
}

function builtInShape(numFmtId: number): DateTimeShape | undefined {
  if (DATE_FORMAT_IDS.has(numFmtId)) return { kind: "date", seconds: false, elapsed: undefined };
  if (DATE_TIME_FORMAT_IDS.has(numFmtId)) {
    return { kind: "date-time", seconds: false, elapsed: undefined };
  }
  if (!TIME_FORMAT_IDS.has(numFmtId)) return undefined;
  return {
    kind: "time",
    seconds: SECONDS_FORMAT_IDS.has(numFmtId),
    elapsed: ELAPSED_FORMAT_IDS.has(numFmtId) ? "h" : undefined,
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

// The elapsed time since midnight of day 0 in the unit its leading bracket counts: `[h]:mm` is
// 36:00 for a day and a half, `[mm]:ss` 720:00 for half a day, `[s]` 43200.
function elapsedClock(total: number, shape: DateTimeShape): string {
  if (shape.elapsed === "s") return String(total);
  if (shape.elapsed === "m") {
    const minutes = String(Math.floor(total / 60));
    return shape.seconds ? `${minutes}:${pad2(total % 60)}` : minutes;
  }
  return clock(total % 3600, Math.floor(total / 3600), shape.seconds);
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
  const time =
    shape.elapsed === undefined
      ? clock(secondOfDay, Math.floor(secondOfDay / 3600), shape.seconds)
      : elapsedClock(total, shape);
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
  // Commas right after the last digit placeholder: each divides the value by 1000.
  readonly thousands: number;
  readonly scientific: number | undefined;
  // The section holds text only (`"n/a"`, `"-"`): it shows `prefix` whatever the value.
  readonly literalOnly: boolean;
}

interface LayoutScan {
  prefix: string;
  suffix: string;
  integerDigits: number;
  minDecimals: number;
  maxDecimals: number;
  percent: number;
  thousands: number;
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
  scan.thousands = 0;
  if (scan.afterPoint) {
    scan.maxDecimals += 1;
    if (ch === "0") scan.minDecimals = scan.maxDecimals;
  } else if (ch === "0") {
    scan.integerDigits += 1;
  }
  if (scan.maxDecimals > MAX_LAYOUT_DIGITS || scan.integerDigits > MAX_LAYOUT_DIGITS) {
    scan.unsupported = true;
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

function newScan(): LayoutScan {
  return {
    prefix: "",
    suffix: "",
    integerDigits: 0,
    minDecimals: 0,
    maxDecimals: 0,
    percent: 0,
    thousands: 0,
    scientific: undefined,
    seenPlaceholder: false,
    afterPoint: false,
    unsupported: false,
  };
}

// Quoted text, an escaped character, a skip/fill marker or a bracket; the index of the last
// character it used, or undefined when the character is none of these.
function scanQuotedOrEscaped(scan: LayoutScan, section: string, index: number): number | undefined {
  const ch = section.charAt(index);
  if (ch === '"') {
    const quoted = scanQuoted(section, index);
    appendLiteral(scan, quoted.text);
    return quoted.next;
  }
  if (ch === "\\") {
    appendLiteral(scan, section.charAt(index + 1));
    return index + 1;
  }
  if (ch === "_" || ch === "*") return index + 1;
  if (ch !== "[") return undefined;
  const close = section.indexOf("]", index);
  const end = close < 0 ? section.length : close;
  appendLiteral(scan, currencyLiteral(section.slice(index, end + 1)));
  return end;
}

function scanSymbol(scan: LayoutScan, section: string, index: number): number {
  const ch = section.charAt(index);
  if ("0#?".includes(ch)) {
    scanPlaceholder(scan, ch);
  } else if (ch === ".") {
    scan.thousands = 0;
    if (scan.seenPlaceholder) scan.afterPoint = true;
    else appendLiteral(scan, ch);
  } else if (ch === "%") {
    scan.percent += 1;
    appendLiteral(scan, ch);
  } else if ("Ee".includes(ch)) {
    return scanExponent(scan, section, index);
  } else if ("/@".includes(ch)) {
    scan.unsupported = true;
  } else if (ch !== ",") {
    appendLiteral(scan, ch);
  } else if (scan.seenPlaceholder) {
    // A comma after the last digit placeholder divides by 1000; one between placeholders is only
    // the thousands separator, which the next placeholder resets.
    scan.thousands += 1;
  }
  return index;
}

function scanSection(section: string): NumberLayout | undefined {
  const scan = newScan();
  for (let index = 0; index < section.length; index += 1) {
    index = scanQuotedOrEscaped(scan, section, index) ?? scanSymbol(scan, section, index);
  }
  if (scan.unsupported) return undefined;
  if (scan.seenPlaceholder) return { ...scan, literalOnly: false };
  // `"n/a"`, `"-"`: a section of text only shows that text, whatever the number is.
  return scan.prefix.length > 0 ? { ...scan, literalOnly: true } : undefined;
}

// ─── Digits ───────────────────────────────────────────────────────────────────

// A magnitude as the 15 significant digits Excel keeps: `digits × 10^scale`. Everything below is
// integer arithmetic on that decimal, so no binary floating-point noise reaches the text and no
// number of requested decimals or magnitude can leave the range `toFixed` accepts.
interface Decimal {
  readonly digits: bigint;
  readonly scale: number;
}

function toDecimal(magnitude: number): Decimal {
  if (magnitude === 0) return { digits: BigInt(0), scale: 0 };
  const [mantissa = "0", exponent = "0"] = magnitude
    .toExponential(SIGNIFICANT_DIGITS - 1)
    .split("e");
  return {
    digits: BigInt(mantissa.replace(".", "")),
    scale: Number.parseInt(exponent, 10) - (SIGNIFICANT_DIGITS - 1),
  };
}

const TEN = BigInt(10);
const TWO = BigInt(2);

// The digits of `value × 10^shift` rounded half away from zero to `decimals` places, as an integer.
function scaledInteger(value: Decimal, shift: number, decimals: number): bigint {
  const places = value.scale + shift + decimals;
  if (places >= 0) return value.digits * TEN ** BigInt(places);
  const drop = -places;
  if (drop > SIGNIFICANT_DIGITS) return BigInt(0);
  const divisor = TEN ** BigInt(drop);
  return (value.digits + divisor / TWO) / divisor;
}

function fixedText(value: Decimal, shift: number, layout: NumberLayout): string {
  const { minDecimals, maxDecimals, integerDigits } = layout;
  const integer = scaledInteger(value, shift, maxDecimals)
    .toString()
    .padStart(maxDecimals + 1, "0");
  const whole = integer.slice(0, integer.length - maxDecimals).padStart(integerDigits, "0");
  const fraction = integer.slice(integer.length - maxDecimals);
  const kept =
    maxDecimals > minDecimals ? fraction.replace(/0+$/u, "").padEnd(minDecimals, "0") : fraction;
  return kept.length > 0 ? `${whole}.${kept}` : whole;
}

// The `significant` leading digits of the value, rounded half up, and whether rounding carried
// into a new leading digit (`9.99` to two digits is `10`).
function leadingDigits(digits: bigint, significant: number): { text: string; carried: boolean } {
  if (significant >= SIGNIFICANT_DIGITS) {
    const widened = digits * TEN ** BigInt(significant - SIGNIFICANT_DIGITS);
    return { text: widened.toString(), carried: false };
  }
  const divisor = TEN ** BigInt(SIGNIFICANT_DIGITS - significant);
  const text = ((digits + divisor / TWO) / divisor).toString();
  return text.length > significant
    ? { text: text.slice(0, significant), carried: true }
    : { text, carried: false };
}

function scientificText(
  value: Decimal,
  shift: number,
  layout: NumberLayout,
  exponentDigits: number,
): string {
  const significant = layout.maxDecimals + 1;
  const isZero = value.digits === BigInt(0);
  const leading = isZero
    ? { text: "0".repeat(significant), carried: false }
    : leadingDigits(value.digits, significant);
  const exponent = isZero
    ? 0
    : value.scale + SIGNIFICANT_DIGITS - 1 + shift + (leading.carried ? 1 : 0);
  const mantissa =
    layout.maxDecimals > 0 ? `${leading.text.slice(0, 1)}.${leading.text.slice(1)}` : leading.text;
  const sign = exponent < 0 ? "-" : "+";
  return `${mantissa}E${sign}${Math.abs(exponent).toString().padStart(exponentDigits, "0")}`;
}

function layoutNumber(magnitude: number, layout: NumberLayout): string {
  const value = toDecimal(magnitude);
  // Percent multiplies by 100 and each trailing comma divides by 1000, in the exponent.
  const shift = 2 * layout.percent - 3 * layout.thousands;
  return layout.scientific === undefined
    ? fixedText(value, shift, layout)
    : scientificText(value, shift, layout, layout.scientific);
}

// ─── Sections ─────────────────────────────────────────────────────────────────

interface Condition {
  readonly operator: string;
  readonly operand: number;
}

interface ChosenSection {
  readonly section: string;
  // The section writes the sign of a negative number itself (`(0)`, `-0`), so none is added.
  readonly ownsSign: boolean;
}

const CONDITION = /\[\s*(<=|>=|<>|<|>|=)\s*(-?\d+(?:\.\d+)?(?:E[+-]?\d+)?)\s*\]/iu;
const COMPARATORS: ReadonlyMap<string, (left: number, right: number) => boolean> = new Map([
  ["<", (left: number, right: number): boolean => left < right],
  ["<=", (left: number, right: number): boolean => left <= right],
  [">", (left: number, right: number): boolean => left > right],
  [">=", (left: number, right: number): boolean => left >= right],
  ["=", (left: number, right: number): boolean => left === right],
  ["<>", (left: number, right: number): boolean => left !== right],
]);

function conditionOf(section: string): Condition | undefined {
  const match = CONDITION.exec(section.replaceAll(/"[^"]*"/gu, ""));
  const operator = match?.[1];
  const operand = Number(match?.[2]);
  return operator === undefined || !Number.isFinite(operand) ? undefined : { operator, operand };
}

function holds(condition: Condition, value: number): boolean {
  return COMPARATORS.get(condition.operator)?.(value, condition.operand) === true;
}

function implicitSection(sections: readonly string[], value: number): ChosenSection {
  if (value < 0 && sections.length > 1) return { section: sections[1] ?? "", ownsSign: true };
  if (value === 0 && sections.length > 2) return { section: sections[2] ?? "", ownsSign: false };
  return { section: sections[0] ?? "", ownsSign: false };
}

// The first section whose condition holds; otherwise the first without a condition (the "all
// other numbers" section), otherwise the last.
function conditionalSection(
  sections: readonly string[],
  conditions: readonly (Condition | undefined)[],
  value: number,
): ChosenSection {
  let index = conditions.findIndex(
    (condition) => condition !== undefined && holds(condition, value),
  );
  if (index < 0) index = conditions.findIndex((condition) => condition === undefined);
  if (index < 0) index = conditions.length - 1;
  const condition = conditions[index];
  const negativeRange =
    condition !== undefined && condition.operand <= 0 && condition.operator.startsWith("<");
  return { section: sections[index] ?? "", ownsSign: value < 0 && negativeRange };
}

function chooseSection(sections: readonly string[], value: number): ChosenSection {
  const conditions = sections.slice(0, 3).map((section) => conditionOf(section));
  return conditions.some((condition) => condition !== undefined)
    ? conditionalSection(sections, conditions, value)
    : implicitSection(sections, value);
}

function formatPlainNumber(value: number, code: string): string {
  const chosen = chooseSection(splitSections(code), value);
  const layout = scanSection(chosen.section);
  if (layout === undefined) return generalNumber(value);
  if (layout.literalOnly) return layout.prefix;
  const sign = value < 0 && !chosen.ownsSign ? "-" : "";
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
