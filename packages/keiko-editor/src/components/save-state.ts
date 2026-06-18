/**
 * Pure save-lifecycle helpers (Issue #1194).
 *
 * The host owns the file model and drives the save lifecycle; this module models that lifecycle as
 * a pure {@link EditorSaveStatus} transition reducer plus small render-only predicates, and builds
 * the {@link EditorSaveRequest} payload. It reuses the frozen #1192 {@link editorFileModelReducer}
 * for dirty bookkeeping and never duplicates it.
 */
import type { FileContent } from "@oscharko-dev/keiko-contracts";

import type { EditorDocumentIdentity, EditorSaveRequest } from "../index.js";
import type { EditorSaveStatus } from "./types.js";

/** Lifecycle transitions the host signals. */
export type EditorSaveAction =
  | { readonly type: "request" }
  | { readonly type: "succeeded" }
  | { readonly type: "failed" }
  | { readonly type: "conflicted" }
  | { readonly type: "retry" }
  | { readonly type: "reloaded" }
  | { readonly type: "edited" };

/**
 * Pure transition for the save status.
 *
 * `any --request--> saving`; `saving --succeeded--> saved`; `saving --failed--> error`;
 * `saving --conflicted--> conflict`; `error|conflict --retry--> saving`; `conflict --reloaded-->
 * idle`; `saved --edited--> idle`. `request` is intentionally unconditional — the host is the source
 * of truth and may replay a save from any state. Any other action that does not apply in the current
 * state leaves it unchanged.
 */
type SaveTransition = (state: EditorSaveStatus) => EditorSaveStatus;

const SAVE_TRANSITIONS: Readonly<Record<EditorSaveAction["type"], SaveTransition>> = {
  request: () => "saving",
  succeeded: (state) => (state === "saving" ? "saved" : state),
  failed: (state) => (state === "saving" ? "error" : state),
  conflicted: (state) => (state === "saving" ? "conflict" : state),
  retry: (state) => (state === "error" || state === "conflict" ? "saving" : state),
  reloaded: (state) => (state === "conflict" ? "idle" : state),
  edited: (state) => (state === "saved" ? "idle" : state),
};

export function saveStatusReducer(
  state: EditorSaveStatus,
  action: EditorSaveAction,
): EditorSaveStatus {
  return SAVE_TRANSITIONS[action.type](state);
}

/**
 * A save conflict exists when the version the editor saved against is older than the version now
 * observed in storage — another writer advanced the file. The host detects this from an
 * out-of-band concurrency token and surfaces it as a `conflict` save status.
 */
export function detectSaveConflict(
  requestedVersion: number,
  observedStorageVersion: number,
): boolean {
  return observedStorageVersion > requestedVersion;
}

/**
 * Build the save request payload, rebuilding {@link FileContent} with the byte length of the new
 * text. `sizeBytes` is the UTF-8 byte count (not the UTF-16 string length) so it matches how the
 * host counts bytes at the IO boundary. A save always carries the full, non-truncated buffer.
 */
export function buildSaveRequest(
  identity: EditorDocumentIdentity,
  text: string,
  relativePath: string,
): EditorSaveRequest {
  const content: FileContent = {
    relativePath,
    sizeBytes: new TextEncoder().encode(text).length,
    text,
    truncated: false,
  };
  return { identity, content };
}

/** Inputs that determine whether the editor is effectively read-only. */
export interface EffectiveReadOnlyArgs {
  /** The host file model's read-only flag. */
  readonly modelReadOnly: boolean;
  /** Explicit per-render override (e.g. a prop the host passes). */
  readonly override?: boolean | undefined;
  /** Whether the loaded buffer is truncated (a partial view of a too-large file). */
  readonly truncated: boolean;
  /** True while the document is not `ready` — still loading or failed to load. */
  readonly notReady: boolean;
}

/**
 * The editor is read-only when the model says so, when the override forces it, when the buffer is
 * truncated (a truncated buffer must never be saved over the full file), or while the document is
 * not ready (a load that is still in flight or has failed has no valid content to edit). A save
 * failure or conflict is deliberately NOT read-only: the buffer stays editable so the user can
 * adjust and retry.
 */
export function effectiveReadOnly(args: EffectiveReadOnlyArgs): boolean {
  return args.modelReadOnly || args.override === true || args.truncated || args.notReady;
}

/** Whether `content` exceeds `maxBytes` either by an explicit truncation flag or by byte size. */
export function isMaxSizeExceeded(content: FileContent, maxBytes: number): boolean {
  return content.truncated || content.sizeBytes > maxBytes;
}
