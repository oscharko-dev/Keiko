import {
  MAX_SUPPORT_REPORT_BYTES,
  MAX_SUPPORT_REPORT_CONTAINERS,
  MAX_SUPPORT_REPORT_DEPTH,
  MAX_SUPPORT_REPORT_OBJECT_KEYS,
  MAX_SUPPORT_REPORT_RECORDS,
  MAX_SUPPORT_REPORT_VALUES,
  type SupportReportFailure,
} from "./support-report.js";

export class SupportReportError extends Error {
  public readonly reason: SupportReportFailure;
  /** Set only when a report declares that it needs a newer analyzer than this one. */
  public readonly minimumAnalyzerVersion: string | undefined;
  public constructor(reason: SupportReportFailure, minimumAnalyzerVersion?: string) {
    super(`support report rejected: ${reason}`);
    this.name = "SupportReportError";
    this.reason = reason;
    this.minimumAnalyzerVersion = minimumAnalyzerVersion;
  }
}

function budgetExceeded(): SupportReportError {
  return new SupportReportError("report-budget-exceeded");
}

export function reportObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function reportKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

export function reportCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Locale-independent UTF-16 ordering is part of the canonical byte contract.
function compareSupportKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

// The writer and the parser charge one shared budget, so the producer never emits a report the
// analyzer refuses. Object keys count as values, exactly as the parser's scan sees them.
interface JsonShapeBudget {
  values: number;
  containers: number;
}

function charge(budget: JsonShapeBudget, container: boolean): void {
  budget.values += 1;
  if (container) budget.containers += 1;
  if (budget.values > MAX_SUPPORT_REPORT_VALUES) throw budgetExceeded();
  if (budget.containers > MAX_SUPPORT_REPORT_CONTAINERS) throw budgetExceeded();
}

function isCanonicalScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function canonicalValue(value: unknown, depth: number, budget: JsonShapeBudget): unknown {
  if (isCanonicalScalar(value)) {
    charge(budget, false);
    return typeof value === "string" ? safeString(value) : value;
  }
  // `depth` counts the enclosing containers; the root container is nesting level one.
  if (depth >= MAX_SUPPORT_REPORT_DEPTH) throw budgetExceeded();
  charge(budget, true);
  if (Array.isArray(value)) {
    if (value.length > MAX_SUPPORT_REPORT_RECORDS) throw budgetExceeded();
    return value.map((entry: unknown) => canonicalValue(entry, depth + 1, budget));
  }
  return canonicalObject(value, depth, budget);
}

function canonicalObject(
  value: unknown,
  depth: number,
  budget: JsonShapeBudget,
): Record<string, unknown> {
  if (!reportObject(value)) throw new SupportReportError("unsafe-report");
  const keys = Object.keys(value).sort(compareSupportKeys);
  if (keys.length > MAX_SUPPORT_REPORT_OBJECT_KEYS) throw budgetExceeded();
  return Object.fromEntries(
    keys.map((key) => {
      charge(budget, false);
      return [safeString(key), canonicalValue(value[key], depth + 1, budget)];
    }),
  );
}

// Every value a report legitimately carries is a printable-ASCII machine token: the body-free
// registry admits nothing else. Anything outside that range is refused rather than filtered, so
// no control, escape, bidirectional, zero-width or surrogate code point can reach a renderer.
const UNSAFE_REPORT_CHARACTER = /[^\x20-\x7e]/u;

function safeString(value: string): string {
  if (UNSAFE_REPORT_CHARACTER.test(value)) throw new SupportReportError("unsafe-report");
  if (value.length > MAX_SUPPORT_REPORT_BYTES) throw budgetExceeded();
  return value;
}

export function canonicalSupportJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, 0, { values: 0, containers: 0 }));
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;

function stringEnd(text: string, start: number): number {
  let index = start + 1;
  let code = text.codePointAt(index);
  while (code !== undefined) {
    if (code === QUOTE) return index + 1;
    index += code === BACKSLASH ? 2 : 1;
    code = text.codePointAt(index);
  }
  return index;
}

function isScalarStart(code: number): boolean {
  // `-`, a digit, or the first letter of true, false or null.
  return (
    code === 0x2d ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x74 ||
    code === 0x66 ||
    code === 0x6e
  );
}

function scalarEnd(text: string, start: number): number {
  let index = start + 1;
  let code = text.codePointAt(index);
  while (code !== undefined) {
    if (code === 0x2c || code === CLOSE_OBJECT || code === CLOSE_ARRAY || code <= 0x20) break;
    index += 1;
    code = text.codePointAt(index);
  }
  return index;
}

/** The entries of every open container, charged against the shared shape budget. */
class JsonShapeScan {
  readonly #entries: number[] = [];
  readonly #limits: number[] = [];
  readonly #budget: JsonShapeBudget = { values: 0, containers: 0 };

  value(container: boolean): void {
    charge(this.#budget, container);
    const top = this.#entries.length - 1;
    if (top < 0) return;
    const entries = (this.#entries[top] ?? 0) + 1;
    this.#entries[top] = entries;
    if (entries > (this.#limits[top] ?? 0)) throw budgetExceeded();
  }

  open(object: boolean): void {
    this.value(true);
    if (this.#entries.length >= MAX_SUPPORT_REPORT_DEPTH) throw budgetExceeded();
    this.#entries.push(0);
    // An object's keys and values both start an entry.
    this.#limits.push(object ? 2 * MAX_SUPPORT_REPORT_OBJECT_KEYS : MAX_SUPPORT_REPORT_RECORDS);
  }

  close(): void {
    this.#entries.pop();
    this.#limits.pop();
  }
}

/**
 * Bounds the shape of untrusted JSON before JSON.parse allocates it: nesting depth, the total
 * number of values and containers, and the entries of any one array or object. Malformed text is
 * left to JSON.parse; this linear pass only guarantees that no input can expand unboundedly.
 */
function checkJsonShape(text: string): void {
  const scan = new JsonShapeScan();
  let index = 0;
  let code = text.codePointAt(index);
  while (code !== undefined) {
    if (code === QUOTE) {
      scan.value(false);
      index = stringEnd(text, index);
    } else if (code === OPEN_OBJECT || code === OPEN_ARRAY) {
      scan.open(code === OPEN_OBJECT);
      index += 1;
    } else if (code === CLOSE_OBJECT || code === CLOSE_ARRAY) {
      scan.close();
      index += 1;
    } else if (isScalarStart(code)) {
      scan.value(false);
      index = scalarEnd(text, index);
    } else {
      index += 1;
    }
    code = text.codePointAt(index);
  }
}

export function parseCanonicalSupportJson(text: string, maxBytes: number): unknown {
  if (text.length > maxBytes || new TextEncoder().encode(text).byteLength > maxBytes)
    throw budgetExceeded();
  checkJsonShape(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SupportReportError("corrupt-report");
  }
  // A duplicate key, extra whitespace, noncanonical number or escape sequence changes the bytes.
  if (canonicalSupportJson(value) !== text) throw new SupportReportError("corrupt-report");
  return value;
}
