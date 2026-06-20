/**
 * Pure dirty-state reducer for an editor file model (Issue #1192).
 *
 * The host drives the document version; this reducer derives the saved/dirty bookkeeping from a
 * small action set without mutating its input. `dirty` is kept consistent with the canonical
 * predicate {@link isDocumentDirty} (`identity.version !== savedVersion`).
 */
import type { EditorChangeOrigin, EditorDocumentIdentity, EditorFileModel } from "./types.js";

export type EditorFileModelAction =
  | { type: "edited"; origin: EditorChangeOrigin }
  | { type: "saved" }
  | { type: "reloaded"; identity: EditorDocumentIdentity }
  | { type: "set-read-only"; readOnly: boolean };

export function createFileModel(
  identity: EditorDocumentIdentity,
  options?: { readonly readOnly?: boolean },
): EditorFileModel {
  return {
    identity,
    savedVersion: identity.version,
    dirty: false,
    readOnly: options?.readOnly ?? false,
    lastChangeOrigin: null,
  };
}

export function editorFileModelReducer(
  state: EditorFileModel,
  action: EditorFileModelAction,
): EditorFileModel {
  switch (action.type) {
    case "edited": {
      const identity: EditorDocumentIdentity = {
        ...state.identity,
        version: state.identity.version + 1,
      };
      return {
        identity,
        savedVersion: state.savedVersion,
        dirty: true,
        readOnly: state.readOnly,
        lastChangeOrigin: action.origin,
      };
    }
    case "saved": {
      return {
        identity: state.identity,
        savedVersion: state.identity.version,
        dirty: false,
        readOnly: state.readOnly,
        lastChangeOrigin: state.lastChangeOrigin,
      };
    }
    case "reloaded": {
      return createFileModel(action.identity, { readOnly: state.readOnly });
    }
    case "set-read-only": {
      return {
        identity: state.identity,
        savedVersion: state.savedVersion,
        dirty: state.dirty,
        readOnly: action.readOnly,
        lastChangeOrigin: state.lastChangeOrigin,
      };
    }
  }
}

/** Canonical dirtiness predicate; the model's `dirty` field is kept in lockstep with this. */
export function isDocumentDirty(model: EditorFileModel): boolean {
  return model.identity.version !== model.savedVersion;
}
