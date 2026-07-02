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

export function normalizeEndpointPath(rawPath: string): string {
  const withoutQuery = replaceTemplateExpressions(rawPath).split("?")[0] ?? "";
  const prefixed = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  const normalized = prefixed
    .replace(/\{[^}/]+\}/gu, ":param")
    .replace(/:[A-Za-z_$][\w$-]*/gu, ":param")
    .replace(/\/+/gu, "/")
    .replace(/\/$/u, "");
  return normalized.length === 0 ? "/" : normalized.toLowerCase();
}

export function joinEndpointPaths(basePath: string, childPath: string): string {
  const base = basePath === "/" ? "" : basePath.replace(/\/$/u, "");
  const child = childPath === "/" ? "" : childPath.replace(/^\//u, "");
  return normalizeEndpointPath(`${base}/${child}`);
}

export function unquote(value: string): string {
  return value.slice(1, -1);
}
