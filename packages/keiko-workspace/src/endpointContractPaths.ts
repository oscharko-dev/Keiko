import { createHash } from "node:crypto";
import { posix as path } from "node:path";

export function hashEndpointContractId(prefix: string, shape: readonly unknown[]): string {
  return `${prefix}-${createHash("sha256").update(JSON.stringify(shape)).digest("hex")}`;
}

export function lineNumberOf(text: string, charIndex: number): number {
  let line = 1;
  for (let index = 0; index < charIndex && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

export function normalizeScopePath(scopePath: string): string {
  return path.normalize(scopePath.split("\\").join("/")).replace(/^\.\//u, "");
}

function replaceTemplateExpressions(rawPath: string): string {
  let normalized = "";
  let cursor = 0;
  while (cursor < rawPath.length) {
    if (rawPath.charCodeAt(cursor) === 36 && rawPath.charCodeAt(cursor + 1) === 123) {
      const end = rawPath.indexOf("}", cursor + 2);
      if (end !== -1) {
        normalized += "{param}";
        cursor = end + 1;
        continue;
      }
    }
    normalized += rawPath[cursor] ?? "";
    cursor += 1;
  }
  return normalized;
}

function endpointPathBeforeQuery(rawPath: string): string {
  const queryStart = rawPath.indexOf("?");
  return queryStart === -1 ? rawPath : rawPath.slice(0, queryStart);
}

function isAsciiAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isParamIdentifierStart(code: number): boolean {
  return isAsciiAlpha(code) || code === 95 || code === 36;
}

function isParamIdentifierPart(code: number): boolean {
  return isParamIdentifierStart(code) || (code >= 48 && code <= 57) || code === 45;
}

function isBraceParamSegment(segment: string): boolean {
  return segment.length > 2 && segment.startsWith("{") && segment.endsWith("}");
}

function isColonParamSegment(segment: string): boolean {
  if (segment.length < 2 || segment.charCodeAt(0) !== 58) {
    return false;
  }
  if (!isParamIdentifierStart(segment.charCodeAt(1))) {
    return false;
  }
  for (let index = 2; index < segment.length; index += 1) {
    if (!isParamIdentifierPart(segment.charCodeAt(index))) {
      return false;
    }
  }
  return true;
}

function normalizeEndpointSegment(segment: string): string {
  return isBraceParamSegment(segment) || isColonParamSegment(segment) ? ":param" : segment;
}

export function normalizeEndpointPath(rawPath: string): string {
  const withoutQuery = endpointPathBeforeQuery(replaceTemplateExpressions(rawPath));
  const segments: string[] = [];
  let segment = "";
  for (const char of withoutQuery) {
    if (char === "/") {
      if (segment.length > 0) {
        segments.push(normalizeEndpointSegment(segment));
        segment = "";
      }
    } else {
      segment += char;
    }
  }
  if (segment.length > 0) {
    segments.push(normalizeEndpointSegment(segment));
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`.toLowerCase();
}

export function joinEndpointPaths(basePath: string, childPath: string): string {
  return normalizeEndpointPath(`${basePath}/${childPath}`);
}

export function unquote(value: string): string {
  return value.slice(1, -1);
}
