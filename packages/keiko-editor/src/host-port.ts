import type { FileContent, VerificationKind } from "@oscharko-dev/keiko-contracts";

import type { EditorLanguageId } from "./languages.js";
import type { EditorGitGutterResolver } from "./components/git-gutter-bridge.js";
import type { EditorBlameHost } from "./components/blame-bridge.js";
import type {
  EditorCompletionRequest,
  EditorCompletionResponse,
  EditorContextRequest,
  EditorContextResult,
  EditorDiagnostic,
  EditorDocumentIdentity,
  EditorFormattingQuery,
  EditorFormattingResponse,
  EditorInlineCompletionRequest,
  EditorInlineCompletionResponse,
  EditorPatchApplyResult,
  EditorPreviewPatchResult,
  EditorPatchReviewDecision,
  EditorSaveRequest,
  EditorSaveResult,
  EditorTestGenerationOutcome,
  EditorTestGenerationRequest,
} from "./types.js";

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
 * Issue #2212 (ADR-0126) — a general run-affordance request. `targetPath` names the workspace-relative
 * file for a `targeted-test` run; the workspace-wide kinds (`typecheck`/`lint`/`build`) omit it.
 */
export interface EditorVerificationRunIntent {
  readonly kind: VerificationKind;
  readonly targetPath?: string | undefined;
}

/**
 * The typed seam the host (`keiko-ui` + `keiko-server`) implements and injects into the editor.
 *
 * The editor owns rendering and lifecycle only; every capability that requires repository access,
 * retrieval, model routing, diagnostics, or evidence is reached exclusively through host-injected
 * callbacks declared here, never by the editor importing a Node-domain package (ADR-0042). v1
 * declared only the buffer-loading surface; #1192 adds the governed capability ports below.
 *
 * Every capability port is optional: a host implements only what it supports, and the command layer
 * gates each command on the matching {@link import("./command-types.js").EditorHostCapability} being
 * present. The optional `AbortSignal` is an in-process cancel handle for local abort only and is
 * never serialized — cross-boundary cancellation travels through `EditorRequestIdentity` instead.
 * Owning issues continue to wire concrete implementations (#1198/#1199/#1200/#1195).
 */
export interface EditorHostPort {
  /** Resolve the buffer the editor should display for a host-defined resource identifier. */
  readonly loadBuffer: (uri: string) => Promise<EditorBuffer>;
  readonly saveDocument?: (request: EditorSaveRequest) => Promise<EditorSaveResult>;
  readonly provideCompletions?: (
    request: EditorCompletionRequest,
    signal?: AbortSignal,
  ) => Promise<EditorCompletionResponse>;
  readonly provideInlineCompletions?: (
    request: EditorInlineCompletionRequest,
    signal?: AbortSignal,
  ) => Promise<EditorInlineCompletionResponse>;
  readonly provideDiagnostics?: (
    document: EditorDocumentIdentity,
    signal?: AbortSignal,
  ) => Promise<readonly EditorDiagnostic[]>;
  readonly provideContext?: (
    request: EditorContextRequest,
    signal?: AbortSignal,
  ) => Promise<EditorContextResult>;
  readonly generateTests?: (
    request: EditorTestGenerationRequest,
    signal?: AbortSignal,
  ) => Promise<EditorTestGenerationOutcome>;
  readonly provideFormatting?: (
    query: EditorFormattingQuery,
    signal?: AbortSignal,
  ) => Promise<EditorFormattingResponse>;
  readonly previewPatch?: (patchId: string) => Promise<EditorPreviewPatchResult>;
  readonly applyPatchReview?: (
    decision: EditorPatchReviewDecision,
  ) => Promise<EditorPatchApplyResult>;
  // Issue #2212 (ADR-0126) — verify the current pending patch (activates the previously-unwired
  // `runVerification` capability for the patch-review case). The host owns the run identity end to end.
  readonly runVerification?: () => void;
  // Issue #2212 (ADR-0126) — start a general run affordance (file-targeted tests, or a workspace
  // typecheck/lint/build) through Issue #2211's governed route. The host tracks the server-assigned run
  // id so `cancelVerification` reaches the server-side run rather than merely aborting a local fetch —
  // the cross-boundary cancellation convention, not a bare AbortSignal (see the header note above).
  readonly runWorkspaceVerification?: (intent: EditorVerificationRunIntent) => void;
  readonly cancelVerification?: () => void;
  /** Read-only, host-owned structured Git changes for the active editor buffer (ADR-0127). */
  readonly fetchGitChanges?: EditorGitGutterResolver;
  /** On-demand, read-only blame capability for a saved active file (ADR-0127). */
  readonly fetchGitBlame?: EditorBlameHost["resolve"];
}
