import { describe, expect, it } from "vitest";

import { createFileModel, editorFileModelReducer, isDocumentDirty } from "./file-model.js";
import type { EditorDocumentIdentity } from "./types.js";

const identity = (version: number): EditorDocumentIdentity => ({
  uri: "file:///src/a.ts",
  language: "typescript",
  version,
});

describe("createFileModel", () => {
  it("starts clean with savedVersion equal to the identity version", () => {
    const model = createFileModel(identity(7));
    expect(model.dirty).toBe(false);
    expect(model.savedVersion).toBe(7);
    expect(model.lastChangeOrigin).toBeNull();
    expect(model.readOnly).toBe(false);
    expect(isDocumentDirty(model)).toBe(false);
  });

  it("honours the readOnly option", () => {
    expect(createFileModel(identity(1), { readOnly: true }).readOnly).toBe(true);
  });
});

describe("editorFileModelReducer", () => {
  it("marks the model dirty, bumps the version, and records the origin on edit", () => {
    const model = editorFileModelReducer(createFileModel(identity(3)), {
      type: "edited",
      origin: "human",
    });
    expect(model.identity.version).toBe(4);
    expect(model.dirty).toBe(true);
    expect(model.lastChangeOrigin).toBe("human");
    expect(isDocumentDirty(model)).toBe(true);
  });

  it("clears dirty and advances savedVersion on save, retaining the origin", () => {
    const edited = editorFileModelReducer(createFileModel(identity(3)), {
      type: "edited",
      origin: "applied-patch",
    });
    const saved = editorFileModelReducer(edited, { type: "saved" });
    expect(saved.dirty).toBe(false);
    expect(saved.savedVersion).toBe(4);
    expect(saved.lastChangeOrigin).toBe("applied-patch");
    expect(isDocumentDirty(saved)).toBe(false);
  });

  it("accumulates multiple edits before a save", () => {
    let model = createFileModel(identity(0));
    model = editorFileModelReducer(model, { type: "edited", origin: "human" });
    model = editorFileModelReducer(model, {
      type: "edited",
      origin: "ai-inline-completion",
    });
    expect(model.identity.version).toBe(2);
    expect(model.savedVersion).toBe(0);
    expect(model.lastChangeOrigin).toBe("ai-inline-completion");
    model = editorFileModelReducer(model, { type: "saved" });
    expect(model.savedVersion).toBe(2);
    expect(isDocumentDirty(model)).toBe(false);
  });

  it("resets to a clean model on reload while preserving readOnly", () => {
    const start = editorFileModelReducer(createFileModel(identity(1), { readOnly: true }), {
      type: "edited",
      origin: "human",
    });
    const reloaded = editorFileModelReducer(start, { type: "reloaded", identity: identity(9) });
    expect(reloaded.identity.version).toBe(9);
    expect(reloaded.savedVersion).toBe(9);
    expect(reloaded.dirty).toBe(false);
    expect(reloaded.lastChangeOrigin).toBeNull();
    expect(reloaded.readOnly).toBe(true);
  });

  it("toggles readOnly without affecting dirtiness", () => {
    const dirty = editorFileModelReducer(createFileModel(identity(2)), {
      type: "edited",
      origin: "human",
    });
    const locked = editorFileModelReducer(dirty, { type: "set-read-only", readOnly: true });
    expect(locked.readOnly).toBe(true);
    expect(locked.dirty).toBe(true);
    expect(locked.identity.version).toBe(dirty.identity.version);
    expect(isDocumentDirty(locked)).toBe(true);
  });

  it("does not mutate its input state", () => {
    const before = createFileModel(identity(5));
    const snapshot = structuredClone(before);
    editorFileModelReducer(before, { type: "edited", origin: "human" });
    expect(before).toEqual(snapshot);
  });

  it("keeps an already-clean model clean when saved (save is idempotent on a clean model)", () => {
    const saved = editorFileModelReducer(createFileModel(identity(5)), { type: "saved" });
    expect(saved.dirty).toBe(false);
    expect(saved.savedVersion).toBe(5);
    expect(saved.identity.version).toBe(5);
    expect(isDocumentDirty(saved)).toBe(false);
  });

  it("preserves cleanliness when toggling readOnly on a never-edited model", () => {
    const locked = editorFileModelReducer(createFileModel(identity(3)), {
      type: "set-read-only",
      readOnly: true,
    });
    expect(locked.readOnly).toBe(true);
    expect(locked.dirty).toBe(false);
    expect(isDocumentDirty(locked)).toBe(false);
  });
});

describe("isDocumentDirty", () => {
  it("matches version !== savedVersion exactly", () => {
    const clean = createFileModel(identity(4));
    expect(isDocumentDirty(clean)).toBe(false);
    const edited = editorFileModelReducer(clean, { type: "edited", origin: "human" });
    expect(isDocumentDirty(edited)).toBe(true);
  });
});
