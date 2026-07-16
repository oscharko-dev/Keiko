import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function safeRealFile(path: string): string {
  try {
    if (!isAbsolute(path) || path.includes("\0")) invalidRequest();
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) invalidRequest();
    return realpathSync(path);
  } catch {
    return invalidRequest();
  }
}

export function safeRealDirectory(path: string): string {
  try {
    if (!isAbsolute(path) || path.includes("\0")) invalidRequest();
    const entry = lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) invalidRequest();
    return realpathSync(path);
  } catch {
    return invalidRequest();
  }
}

export function pathIsContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function resolveContained(root: string, relativePath: string): string {
  const candidate = resolve(root, relativePath);
  if (!pathIsContained(root, candidate)) invalidRequest();
  return candidate;
}

export function invalidRequest(): never {
  throw new Error("native-runtime-request-invalid");
}
