import { createHash } from "node:crypto";
import {
  MAX_SUPPORT_REPORT_DEPTH,
  MAX_SUPPORT_REPORT_RECORDS,
  MAX_SUPPORT_REPORT_BYTES,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/version";

export type SupportReportFailure =
  "corrupt-report" | "unsafe-report" | "unsupported-report" | "report-budget-exceeded";

export class SupportReportError extends Error {
  public readonly reason: SupportReportFailure;
  public readonly minimumAnalyzerVersion: string;
  public constructor(
    reason: SupportReportFailure,
    minimumAnalyzerVersion: string = KEIKO_PRODUCT_VERSION,
  ) {
    super(`support report rejected: ${reason}`);
    this.name = "SupportReportError";
    this.reason = reason;
    this.minimumAnalyzerVersion = minimumAnalyzerVersion;
  }
}

function isUnsafeControl(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
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

function canonicalValue(value: unknown, depth: number): unknown {
  if (depth > MAX_SUPPORT_REPORT_DEPTH) throw new SupportReportError("report-budget-exceeded");
  if (typeof value === "string") return safeString(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === null || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_SUPPORT_REPORT_RECORDS)
      throw new SupportReportError("report-budget-exceeded");
    return value.map((entry: unknown) => canonicalValue(entry, depth + 1));
  }
  if (!reportObject(value)) throw new SupportReportError("unsafe-report");
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareSupportKeys)
      .map((key) => [safeString(key), canonicalValue(value[key], depth + 1)]),
  );
}

function safeString(value: string): string {
  for (const character of value) {
    if (isUnsafeControl(character.codePointAt(0) ?? 0))
      throw new SupportReportError("unsafe-report");
  }
  if (Buffer.byteLength(value) > MAX_SUPPORT_REPORT_BYTES)
    throw new SupportReportError("report-budget-exceeded");
  return value;
}

export function canonicalSupportJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, 0));
}

export function supportReportDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function jsonDepthDelta(character: string): number {
  if (character === "{" || character === "[") return 1;
  return character === "}" || character === "]" ? -1 : 0;
}

/** Bounds nesting before JSON.parse allocates a hostile object graph. */
function checkJsonDepth(text: string): void {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    depth += jsonDepthDelta(character);
    if (depth > MAX_SUPPORT_REPORT_DEPTH) throw new SupportReportError("report-budget-exceeded");
  }
}

export function parseCanonicalSupportJson(text: string, maxBytes: number): unknown {
  if (Buffer.byteLength(text) > maxBytes) throw new SupportReportError("report-budget-exceeded");
  checkJsonDepth(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SupportReportError("corrupt-report");
  }
  // A duplicate key, extra whitespace, noncanonical number or invalid Unicode changes the bytes.
  if (canonicalSupportJson(value) !== text) throw new SupportReportError("corrupt-report");
  return value;
}
