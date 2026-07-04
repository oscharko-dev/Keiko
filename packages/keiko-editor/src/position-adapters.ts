/**
 * Adapters between the two field-name-incompatible spellings of the same zero-based editor position
 * (GEN-MAINT-NAMING-002).
 *
 * The wire/language-service tier uses the LSP spelling {@link LanguagePosition} `{ line, character }`
 * (`@oscharko-dev/keiko-contracts`); the browser editor uses the Monaco/VS Code spelling
 * {@link EditorPosition} `{ line, column }` (`./types`). Both are `{ line: number, x: number }` in
 * UTF-16 code units, so a hand-written `{ line, character: p.column }` map is one transposition away
 * from a silently wrong offset that no type checker can catch. These two functions are the single
 * seam that renames the field, so every editor↔wire crossing goes through a tested primitive.
 *
 * Dependency direction: the editor (`EditorPosition`) may reference the contracts wire type; the
 * contracts tier must NEVER import `EditorPosition` — that would invert the browser→contracts edge
 * (ADR-0019 direction rule 8; ADR-0042).
 */
import type { LanguagePosition } from "@oscharko-dev/keiko-contracts";

import type { EditorPosition } from "./types.js";

/** Rename an editor `{ line, column }` position to the LSP wire `{ line, character }` spelling. */
export function toLanguagePosition(position: EditorPosition): LanguagePosition {
  return { line: position.line, character: position.column };
}

/** Rename an LSP wire `{ line, character }` position to the editor `{ line, column }` spelling. */
export function fromLanguagePosition(position: LanguagePosition): EditorPosition {
  return { line: position.line, column: position.character };
}
