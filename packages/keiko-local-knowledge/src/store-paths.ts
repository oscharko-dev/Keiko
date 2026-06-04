// Pure path arithmetic for the local-knowledge capsule store. Resolves the on-disk DB path
// from a runtime-state directory + optional namespace, with hard fail-closed rules:
//   * runtimeStateDir must be non-empty.
//   * namespace (when provided) must be non-empty, must not contain NUL, must not start with
//     `~`, must not be absolute, must not contain `..` segments, and must reduce to a single
//     path segment (no slashes in either direction).
//   * The resolved path is asserted to live inside `runtimeStateDir` — caller code that
//     trusts a runtime-state root for path containment must never receive a value outside it.
//
// This module performs NO filesystem access (no `node:fs` import). The runtime opener in
// store.ts owns directory creation and atomic operations.

import { isAbsolute, join, resolve, sep } from "node:path";

import { KnowledgePathError } from "./errors.js";

export interface ResolveKnowledgeStorePathOptions {
  readonly runtimeStateDir: string;
  readonly namespace?: string;
}

const DEFAULT_NAMESPACE = "default";
const DB_FILE_NAME = "capsules.db";
const SUBSYSTEM_DIR = "local-knowledge";

function rejectInvalidNamespace(namespace: string): void {
  if (namespace.length === 0) {
    throw new KnowledgePathError("namespace must not be empty when provided.");
  }
  if (namespace.includes("\0")) {
    throw new KnowledgePathError("namespace must not contain NUL bytes.");
  }
  if (namespace.startsWith("~")) {
    throw new KnowledgePathError(
      "namespace must not start with `~`; resolve home directories at the caller.",
    );
  }
  if (isAbsolute(namespace)) {
    throw new KnowledgePathError("namespace must not be an absolute path.");
  }
  if (namespace.includes("/") || namespace.includes("\\")) {
    throw new KnowledgePathError("namespace must be a single path segment.");
  }
  if (namespace === "." || namespace === "..") {
    throw new KnowledgePathError("namespace must not be `.` or `..`.");
  }
}

function assertContained(resolvedPath: string, base: string): void {
  // resolve() normalises away `.`/`..` segments. If the result is not a strict descendant of
  // the resolved base, the input escaped the root via some path the prior segment-level
  // rejections missed and we MUST fail closed.
  const normalisedBase = resolve(base);
  const normalisedPath = resolve(resolvedPath);
  if (normalisedPath !== normalisedBase && !normalisedPath.startsWith(normalisedBase + sep)) {
    throw new KnowledgePathError(
      "Resolved knowledge-store path escaped its runtimeStateDir; refusing to open.",
    );
  }
}

export function resolveKnowledgeStorePath(opts: ResolveKnowledgeStorePathOptions): string {
  if (opts.runtimeStateDir.length === 0) {
    throw new KnowledgePathError("runtimeStateDir must not be empty.");
  }
  if (opts.runtimeStateDir.includes("\0")) {
    throw new KnowledgePathError("runtimeStateDir must not contain NUL bytes.");
  }
  const namespace = opts.namespace ?? DEFAULT_NAMESPACE;
  if (opts.namespace !== undefined) {
    rejectInvalidNamespace(namespace);
  }
  const candidate = join(opts.runtimeStateDir, SUBSYSTEM_DIR, namespace, DB_FILE_NAME);
  assertContained(candidate, opts.runtimeStateDir);
  return candidate;
}
