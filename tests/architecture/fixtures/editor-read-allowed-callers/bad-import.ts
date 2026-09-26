/**
 * INTENTIONAL ADR-0165 VIOLATION FIXTURE
 *
 * Proves production callers outside the editor lane cannot import the raw,
 * unredacted editor-read subpath. Legitimate production callers are
 * packages/keiko-server/src/editor/** and packages/keiko-workspace/src/**;
 * every other caller must go through the redacting default export.
 */
import { readWorkspaceFileForEditing } from "../../../../packages/keiko-workspace/src/editorRead.js";

export const violation: string =
  typeof readWorkspaceFileForEditing === "function"
    ? "intentional ADR-0165 violation fixture (editor read allowed callers)"
    : "unreachable";
