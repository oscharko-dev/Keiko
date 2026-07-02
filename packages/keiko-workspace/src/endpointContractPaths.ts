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

export function normalizeEndpointPath(rawPath: string): string {
  const withoutQuery = rawPath.replace(/\$\{[^}]+\}/gu, "{param}").split("?")[0] ?? "";
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
