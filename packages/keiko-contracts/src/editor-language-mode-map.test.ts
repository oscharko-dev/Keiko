import { describe, expect, it } from "vitest";

import {
  EDITOR_LANGUAGE_MODE_BY_EXTENSION,
  EDITOR_LANGUAGE_MODE_IDS,
  EDITOR_LANGUAGE_MODE_MAP,
  inferEditorLanguageModeId,
  isEditorLanguageModeId,
} from "./editor-language-mode-map.js";

describe("EDITOR_LANGUAGE_MODE_MAP", () => {
  it("enumerates exactly the 15 known source languages and excludes plaintext", () => {
    expect([...EDITOR_LANGUAGE_MODE_IDS]).toEqual([
      "typescript",
      "javascript",
      "json",
      "css",
      "scss",
      "less",
      "html",
      "markdown",
      "yaml",
      "python",
      "java",
      "go",
      "rust",
      "sql",
      "shell",
    ]);
    expect(EDITOR_LANGUAGE_MODE_IDS).not.toContain("plaintext");
  });

  it("marks every language as syntax-highlightable", () => {
    for (const mode of EDITOR_LANGUAGE_MODE_MAP) {
      expect(mode.syntaxHighlighting).toBe(true);
    }
  });

  it("freezes the map, every entry, and the derived tables (mutation is rejected)", () => {
    expect(Object.isFrozen(EDITOR_LANGUAGE_MODE_MAP)).toBe(true);
    expect(Object.isFrozen(EDITOR_LANGUAGE_MODE_IDS)).toBe(true);
    expect(Object.isFrozen(EDITOR_LANGUAGE_MODE_BY_EXTENSION)).toBe(true);
    // A frozen array silently ignores mutation in sloppy mode and throws in strict mode; assert the
    // observable invariant (length unchanged) so the test is mutation-robust either way. Push via
    // the prototype so no readonly-to-mutable cast is needed.
    const originalLength = EDITOR_LANGUAGE_MODE_MAP.length;
    try {
      Array.prototype.push.call(EDITOR_LANGUAGE_MODE_MAP, {
        languageId: "x",
        fileExtensions: [],
        syntaxHighlighting: true,
      });
    } catch {
      // strict-mode throw is acceptable
    }
    expect(EDITOR_LANGUAGE_MODE_MAP.length).toBe(originalLength);
  });

  it("deeply freezes every entry and its fileExtensions array (no consumer can mutate an entry)", () => {
    for (const mode of EDITOR_LANGUAGE_MODE_MAP) {
      expect(Object.isFrozen(mode)).toBe(true);
      expect(Object.isFrozen(mode.fileExtensions)).toBe(true);
      const originalExtensionCount = mode.fileExtensions.length;
      try {
        Array.prototype.push.call(mode.fileExtensions, "hack");
      } catch {
        // strict-mode throw is acceptable
      }
      expect(mode.fileExtensions.length).toBe(originalExtensionCount);
    }
  });
});

describe("derived-table consistency", () => {
  it("derives EDITOR_LANGUAGE_MODE_IDS as exactly the map's languageIds in order", () => {
    expect([...EDITOR_LANGUAGE_MODE_IDS]).toEqual(
      EDITOR_LANGUAGE_MODE_MAP.map((mode) => mode.languageId),
    );
  });

  it("maps every map extension to its owning languageId in EDITOR_LANGUAGE_MODE_BY_EXTENSION", () => {
    for (const mode of EDITOR_LANGUAGE_MODE_MAP) {
      for (const extension of mode.fileExtensions) {
        expect(EDITOR_LANGUAGE_MODE_BY_EXTENSION[extension]).toBe(mode.languageId);
      }
    }
  });

  it("contains no extension that points outside the known id set", () => {
    for (const id of Object.values(EDITOR_LANGUAGE_MODE_BY_EXTENSION)) {
      expect(EDITOR_LANGUAGE_MODE_IDS).toContain(id);
    }
  });

  it("has a one-to-one extension-to-map coverage (no orphan keys)", () => {
    const mapExtensions = EDITOR_LANGUAGE_MODE_MAP.flatMap((mode) => [
      ...mode.fileExtensions,
    ]).sort();
    expect(Object.keys(EDITOR_LANGUAGE_MODE_BY_EXTENSION).sort()).toEqual(mapExtensions);
  });
});

describe("inferEditorLanguageModeId", () => {
  it("infers the canonical id for representative extensions", () => {
    expect(inferEditorLanguageModeId("service.ts")).toBe("typescript");
    expect(inferEditorLanguageModeId("App.tsx")).toBe("typescript");
    expect(inferEditorLanguageModeId("index.mjs")).toBe("javascript");
    expect(inferEditorLanguageModeId("package.json")).toBe("json");
    expect(inferEditorLanguageModeId("styles.scss")).toBe("scss");
    expect(inferEditorLanguageModeId("train.py")).toBe("python");
    expect(inferEditorLanguageModeId("lib.rs")).toBe("rust");
    expect(inferEditorLanguageModeId("deploy.bash")).toBe("shell");
  });

  it("is case-insensitive on the extension and uses the final path segment", () => {
    expect(inferEditorLanguageModeId("Service.TS")).toBe("typescript");
    expect(inferEditorLanguageModeId("src/app/main.PY")).toBe("python");
    expect(inferEditorLanguageModeId("C:\\repo\\build.GO")).toBe("go");
  });

  it("returns null for unknown extensions, dotfiles, extension-less names, trailing dots, and empty", () => {
    expect(inferEditorLanguageModeId("archive.bin")).toBeNull();
    expect(inferEditorLanguageModeId(".gitignore")).toBeNull();
    expect(inferEditorLanguageModeId("Makefile")).toBeNull();
    expect(inferEditorLanguageModeId("notes.")).toBeNull();
    expect(inferEditorLanguageModeId("")).toBeNull();
    // plaintext is intentionally not a known source language id (ADR-0067 D5).
    expect(inferEditorLanguageModeId("file.plaintext")).toBeNull();
  });
});

describe("isEditorLanguageModeId", () => {
  it("accepts every canonical id and rejects everything else", () => {
    for (const id of EDITOR_LANGUAGE_MODE_IDS) {
      expect(isEditorLanguageModeId(id)).toBe(true);
    }
    expect(isEditorLanguageModeId("plaintext")).toBe(false);
    expect(isEditorLanguageModeId("typescriptreact")).toBe(false);
    expect(isEditorLanguageModeId("cobol")).toBe(false);
    expect(isEditorLanguageModeId("")).toBe(false);
  });
});
