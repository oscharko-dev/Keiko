/**
 * Public prop types for {@link import("./KeikoDiffEditor.js").KeikoDiffEditor} (Issue #1195).
 *
 * Pure, type-only module. The component is a controlled, host-agnostic renderer of a
 * {@link PatchPreviewModel} (built host-side via {@link import("../patch-preview.js")
 * .buildPatchPreview}). It renders original/modified pairs read-only and emits review *intent*; every
 * side-effecting decision — applying a patch to disk, recording evidence, running verification — is
 * owned by the host and reached through the optional callbacks here, never by the editor (ADR-0042
 * D1/D7). Apply/reject availability is host-computed (it gates on capabilities and the wave-2,
 * flag-gated apply path), so the component only decides whether to render and enable an action.
 */
import type { EditorThemeVariant } from "../monaco/theme.js";
import type { PatchPreviewModel } from "../patch-preview.js";
import type { KeikoEditorLoadState } from "./types.js";

/** Host-computed availability of the review actions; absent actions render disabled. */
export interface DiffActionAvailability {
  readonly canApply: boolean;
  readonly canReject: boolean;
  readonly canRunVerification: boolean;
}

export interface KeikoDiffEditorProps {
  /** The render-only patch projection; build it host-side with `buildPatchPreview`. */
  readonly model: PatchPreviewModel;
  /** Whether the Monaco runtime is loading, ready, or failed (host-owned, render-only). */
  readonly loadState: KeikoEditorLoadState;
  /** Theme variant for the diff editor; matches the registered Keiko theme. */
  readonly themeVariant?: EditorThemeVariant | undefined;
  /** Which review actions the host currently permits; omitted ⇒ all disabled. */
  readonly actions?: DiffActionAvailability | undefined;
  /** Notified when the user selects a different file to review. */
  readonly onSelectFile?: ((uri: string) => void) | undefined;
  /** Host-owned: the user requested the patch be applied (the host builds and routes the decision). */
  readonly onApply?: (() => void) | undefined;
  /** Host-owned: the user rejected the patch. */
  readonly onReject?: (() => void) | undefined;
  /** Host-owned: open the file behind the current change in the workspace. */
  readonly onOpenFile?: ((uri: string) => void) | undefined;
  /** Host-owned: run verification against the previewed patch. */
  readonly onRunVerification?: (() => void) | undefined;
  /** Reports a non-fatal runtime error (e.g. theme-token resolution failed). */
  readonly onRuntimeError?: ((message: string) => void) | undefined;
}
