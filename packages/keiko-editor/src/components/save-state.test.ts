import { describe, expect, it } from "vitest";

import { createFileModel, editorFileModelReducer, isDocumentDirty } from "../index.js";
import type { EditorDocumentIdentity } from "../index.js";
import {
  buildSaveRequest,
  detectSaveConflict,
  effectiveReadOnly,
  isMaxSizeExceeded,
  saveStatusReducer,
} from "./save-state.js";

const identity: EditorDocumentIdentity = {
  uri: "keiko://doc/a",
  language: "typescript",
  version: 3,
};

describe("saveStatusReducer", () => {
  it("moves idle -> saving on request", () => {
    expect(saveStatusReducer("idle", { type: "request" })).toBe("saving");
  });

  it("moves saving -> saved on success", () => {
    expect(saveStatusReducer("saving", { type: "succeeded" })).toBe("saved");
  });

  it("moves saving -> error on failure", () => {
    expect(saveStatusReducer("saving", { type: "failed" })).toBe("error");
  });

  it("moves saving -> conflict on a concurrency conflict", () => {
    expect(saveStatusReducer("saving", { type: "conflicted" })).toBe("conflict");
  });

  it("retries from error and from conflict back to saving", () => {
    expect(saveStatusReducer("error", { type: "retry" })).toBe("saving");
    expect(saveStatusReducer("conflict", { type: "retry" })).toBe("saving");
  });

  it("clears a conflict to idle on reload", () => {
    expect(saveStatusReducer("conflict", { type: "reloaded" })).toBe("idle");
  });

  it("returns saved -> idle on the next edit", () => {
    expect(saveStatusReducer("saved", { type: "edited" })).toBe("idle");
  });

  it("ignores inapplicable transitions (idempotent replay)", () => {
    expect(saveStatusReducer("idle", { type: "succeeded" })).toBe("idle");
    expect(saveStatusReducer("saved", { type: "request" })).toBe("saving");
    expect(saveStatusReducer("idle", { type: "retry" })).toBe("idle");
  });

  it("collapses only saved -> idle on edit; every other state is unchanged", () => {
    expect(saveStatusReducer("idle", { type: "edited" })).toBe("idle");
    expect(saveStatusReducer("saving", { type: "edited" })).toBe("saving");
    expect(saveStatusReducer("saved", { type: "edited" })).toBe("idle");
    expect(saveStatusReducer("error", { type: "edited" })).toBe("error");
    expect(saveStatusReducer("conflict", { type: "edited" })).toBe("conflict");
  });

  it("keeps failed, conflicted, and reloaded transitions scoped to their source states", () => {
    expect(saveStatusReducer("idle", { type: "failed" })).toBe("idle");
    expect(saveStatusReducer("saved", { type: "conflicted" })).toBe("saved");
    expect(saveStatusReducer("idle", { type: "reloaded" })).toBe("idle");
  });
});

describe("detectSaveConflict", () => {
  it("flags a conflict when storage advanced past the requested version", () => {
    expect(detectSaveConflict(3, 4)).toBe(true);
  });

  it("does not flag equal or stale-observed versions", () => {
    expect(detectSaveConflict(3, 3)).toBe(false);
    expect(detectSaveConflict(5, 3)).toBe(false);
  });
});

describe("buildSaveRequest", () => {
  it("carries the identity and a non-truncated full FileContent", () => {
    const request = buildSaveRequest(identity, "const a = 1;\n", "src/a.ts");
    expect(request.identity).toBe(identity);
    expect(request.content.relativePath).toBe("src/a.ts");
    expect(request.content.text).toBe("const a = 1;\n");
    expect(request.content.truncated).toBe(false);
  });

  it("counts sizeBytes in UTF-8 bytes (not UTF-16 units)", () => {
    const request = buildSaveRequest(identity, "café — €", "src/a.ts");
    expect(request.content.sizeBytes).toBe(new TextEncoder().encode("café — €").length);
    expect(request.content.sizeBytes).toBeGreaterThan("café — €".length);
  });

  it("optionally carries the saved-version baseline expected by the host", () => {
    const request = buildSaveRequest(identity, "const a = 1;\n", "src/a.ts", 2);
    expect(request.expectedSavedVersion).toBe(2);
    expect(request.identity).toBe(identity);
    expect(request.content.text).toBe("const a = 1;\n");
  });
});

describe("effectiveReadOnly", () => {
  it("is read-only when the model is read-only", () => {
    expect(
      effectiveReadOnly({
        modelReadOnly: true,
        bufferReadOnly: false,
        truncated: false,
        overLimit: false,
        notReady: false,
      }),
    ).toBe(true);
  });

  it("is read-only when the buffer is read-only", () => {
    expect(
      effectiveReadOnly({
        modelReadOnly: false,
        bufferReadOnly: true,
        truncated: false,
        overLimit: false,
        notReady: false,
      }),
    ).toBe(true);
  });

  it("is read-only when the override forces it", () => {
    expect(
      effectiveReadOnly({
        modelReadOnly: false,
        bufferReadOnly: false,
        override: true,
        truncated: false,
        overLimit: false,
        notReady: false,
      }),
    ).toBe(true);
  });

  it("is read-only when the buffer is truncated", () => {
    expect(
      effectiveReadOnly({
        modelReadOnly: false,
        bufferReadOnly: false,
        truncated: true,
        overLimit: true,
        notReady: false,
      }),
    ).toBe(true);
  });

  it("is read-only when the buffer exceeds the max editable size without truncation", () => {
    expect(
      effectiveReadOnly({
        modelReadOnly: false,
        bufferReadOnly: false,
        truncated: false,
        overLimit: true,
        notReady: false,
      }),
    ).toBe(true);
  });

  it("is read-only while the document is not ready (loading or load error)", () => {
    expect(
      effectiveReadOnly({
        modelReadOnly: false,
        bufferReadOnly: false,
        override: false,
        truncated: false,
        overLimit: false,
        notReady: true,
      }),
    ).toBe(true);
  });

  it("is editable when nothing forces read-only", () => {
    expect(
      effectiveReadOnly({
        modelReadOnly: false,
        bufferReadOnly: false,
        override: false,
        truncated: false,
        overLimit: false,
        notReady: false,
      }),
    ).toBe(false);
  });
});

describe("isMaxSizeExceeded", () => {
  const base = { relativePath: "a.ts", text: "x" };

  it("is true when the content is flagged truncated", () => {
    expect(isMaxSizeExceeded({ ...base, sizeBytes: 1, truncated: true }, 262_144)).toBe(true);
  });

  it("is true when sizeBytes exceeds the limit", () => {
    expect(isMaxSizeExceeded({ ...base, sizeBytes: 300_000, truncated: false }, 262_144)).toBe(
      true,
    );
  });

  it("is false within the limit", () => {
    expect(isMaxSizeExceeded({ ...base, sizeBytes: 100, truncated: false }, 262_144)).toBe(false);
  });
});

describe("dirty bookkeeping reuses the #1192 reducer", () => {
  it("becomes dirty after a human edit and clean after save", () => {
    const initial = createFileModel(identity);
    expect(isDocumentDirty(initial)).toBe(false);
    const edited = editorFileModelReducer(initial, { type: "edited", origin: "human" });
    expect(isDocumentDirty(edited)).toBe(true);
    const saved = editorFileModelReducer(edited, { type: "saved" });
    expect(isDocumentDirty(saved)).toBe(false);
  });

  it("stays dirty across a failed/conflicted save (model unchanged) and clears on reload", () => {
    const initial = createFileModel(identity);
    const edited = editorFileModelReducer(initial, { type: "edited", origin: "human" });
    // A failed or conflicted save does NOT dispatch `saved`, so the model stays dirty.
    expect(isDocumentDirty(edited)).toBe(true);
    const reloaded = editorFileModelReducer(edited, {
      type: "reloaded",
      identity: { ...identity, version: 9 },
    });
    expect(isDocumentDirty(reloaded)).toBe(false);
  });
});
