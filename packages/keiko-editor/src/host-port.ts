import type { FileContent } from "@oscharko-dev/keiko-contracts";

import type { EditorLanguageId } from "./languages.js";

/**
 * A buffer the host asks the editor to render.
 *
 * `content` is the existing workspace `FileContent` contract — text that has already been redacted
 * at the IO boundary; the editor receives it, it never reads files itself. Monaco model and runtime
 * wiring (creating the editor instance from this descriptor) lands in #1193+.
 */
export interface EditorBuffer {
  readonly language: EditorLanguageId;
  readonly content: FileContent;
  readonly readOnly: boolean;
}

/**
 * The typed seam the host (`keiko-ui` + `keiko-server`) implements and injects into the editor.
 *
 * The editor owns rendering and lifecycle only; every capability that requires repository access,
 * retrieval, model routing, diagnostics, or evidence is reached exclusively through host-injected
 * callbacks declared here, never by the editor importing a Node-domain package (ADR-0042). v1
 * declares only the buffer-loading surface; governed completion, diagnostics, and diff/patch ports
 * are added by their owning issues (#1198/#1199/#1200/#1195) as this interface grows.
 */
export interface EditorHostPort {
  /** Resolve the buffer the editor should display for a host-defined resource identifier. */
  readonly loadBuffer: (uri: string) => Promise<EditorBuffer>;
}
