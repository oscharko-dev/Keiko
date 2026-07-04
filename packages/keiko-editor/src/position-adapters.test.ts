import { describe, expect, it } from "vitest";

import { fromLanguagePosition, toLanguagePosition } from "./position-adapters.js";
import type { EditorPosition } from "./types.js";
import type { LanguagePosition } from "@oscharko-dev/keiko-contracts";

describe("position-adapters", () => {
  it("renames column → character on the way to the wire", () => {
    const editor: EditorPosition = { line: 3, column: 7 };
    expect(toLanguagePosition(editor)).toEqual({ line: 3, character: 7 });
  });

  it("renames character → column on the way from the wire", () => {
    const wire: LanguagePosition = { line: 4, character: 2 };
    expect(fromLanguagePosition(wire)).toEqual({ line: 4, column: 2 });
  });

  it("round-trips an editor position through the wire spelling and back", () => {
    const editor: EditorPosition = { line: 12, column: 40 };
    expect(fromLanguagePosition(toLanguagePosition(editor))).toEqual(editor);
  });

  it("round-trips a wire position through the editor spelling and back", () => {
    const wire: LanguagePosition = { line: 0, character: 0 };
    expect(toLanguagePosition(fromLanguagePosition(wire))).toEqual(wire);
  });

  it("preserves the line field untouched (only the second field is renamed)", () => {
    expect(toLanguagePosition({ line: 99, column: 0 }).line).toBe(99);
    expect(fromLanguagePosition({ line: 99, character: 0 }).line).toBe(99);
  });
});
