// Epic #1941 — shared UI client for the native OS file/folder dialog (ADR-0118).
//
// Every Browse surface goes through this module so the outcome handling is uniform: cancellation
// is a non-event, a concurrent dialog (409) and an unsupported platform (501) are typed outcomes
// the caller can render calmly, and unexpected failures become a generic, content-free message.
// Selected paths flow only into the same state the manual path inputs already own — never into
// logs or diagnostics.

import { ApiError, fetchNativeFileDialogCapability, openNativeFileDialog } from "./api";
import type { NativeFileDialogRequest } from "./types";

let cachedSupport: boolean | undefined;
let pendingSupport: Promise<boolean> | undefined;

// Whether the BFF host platform can open native dialogs. Success is memoized for the session
// (platform support cannot change under a running BFF); failures are NOT cached so a transient
// fetch problem does not permanently hide the Browse buttons.
export async function nativeFileDialogSupported(): Promise<boolean> {
  if (cachedSupport !== undefined) return cachedSupport;
  pendingSupport ??= fetchNativeFileDialogCapability()
    .then((capability) => {
      cachedSupport = capability.supported;
      return capability.supported;
    })
    .catch(() => false)
    .finally(() => {
      pendingSupport = undefined;
    });
  return pendingSupport;
}

// Test seam: capability caching is module state, so hermetic tests reset it between cases.
export function resetNativeFileDialogCapabilityCacheForTests(): void {
  cachedSupport = undefined;
  pendingSupport = undefined;
}

export type NativeDialogPickOutcome =
  | { readonly kind: "picked"; readonly paths: readonly string[] }
  | { readonly kind: "cancelled" }
  | { readonly kind: "busy" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "error"; readonly message: string };

function lastSeparatorIndex(path: string): number {
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

// Parent directory of a native absolute path, handling both platform separators (the browser tier
// has no node:path). Returns the input unchanged when no separator is found past the root.
export function nativeParentDirectory(path: string): string {
  const index = lastSeparatorIndex(path);
  return index > 0 ? path.slice(0, index) : path;
}

// Folds a native multi-file selection into the {shared root, relative files} shape the
// local-knowledge "files" scope expects. Both platform dialogs multi-select within a single
// folder, so the shared parent is the common case; the guard keeps any outlier path whole rather
// than fabricating a wrong relative path.
export function nativePathsToRootAndFiles(paths: readonly string[]): {
  readonly rootPath: string;
  readonly files: readonly string[];
} {
  const first = paths[0];
  if (first === undefined) return { rootPath: "", files: [] };
  const rootPath = nativeParentDirectory(first);
  const prefixLength = rootPath.length;
  const files = paths.map((path) => {
    const next = path.charAt(prefixLength);
    if (!path.startsWith(rootPath) || (next !== "/" && next !== "\\")) return path;
    return path.slice(prefixLength + 1);
  });
  return { rootPath, files };
}

// Opens the native dialog and folds the transport outcomes into a closed, render-ready set.
// Never throws: Browse click handlers must not crash the window over a dialog problem.
export async function pickWithNativeDialog(
  request: NativeFileDialogRequest,
): Promise<NativeDialogPickOutcome> {
  try {
    const response = await openNativeFileDialog(request);
    if (response.cancelled) return { kind: "cancelled" };
    return { kind: "picked", paths: response.selections.map((selection) => selection.path) };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === "NATIVE_DIALOG_ALREADY_OPEN") return { kind: "busy" };
      if (error.code === "NATIVE_DIALOG_UNSUPPORTED") return { kind: "unsupported" };
      return { kind: "error", message: error.message };
    }
    return { kind: "error", message: "The native dialog request failed." };
  }
}
