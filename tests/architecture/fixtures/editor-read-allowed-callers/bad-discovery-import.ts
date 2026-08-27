/**
 * INTENTIONAL ADR-0165 VIOLATION FIXTURE — discovery.ts deep-import path.
 *
 * `readWorkspaceFileForEditing` is defined in discovery.ts and re-exported from
 * editorRead.ts. A caller that deep-imports `../keiko-workspace/dist/discovery.js`
 * reaches the same raw function without going through the `./internal/editor-read`
 * subpath, so the gate must guard discovery.ts as well as editorRead.ts. This
 * fixture proves that path is denied by name.
 */
import { readWorkspaceFileForEditing } from "../../../../packages/keiko-workspace/src/discovery.js";

export const violation: string =
  typeof readWorkspaceFileForEditing === "function"
    ? "intentional ADR-0165 violation fixture (discovery.ts deep-import path)"
    : "unreachable";
