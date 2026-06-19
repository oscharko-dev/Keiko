/**
 * Pure projection of a generated test candidate into the diff-review model (Issue #1202, ADR-0042 D7).
 *
 * Reuses the #1195 {@link buildPatchPreview} adapter (it applies the patch's text edits in memory for
 * display only and never writes to disk) and the #1195 {@link KeikoDiffEditor} surface, so the
 * generated patch is shown before application. Patch APPLY and verification stay disabled here: they
 * are the same wave-2, egress-bounded path as test execution (ADR-0042 D7; patch apply is #1204), so a
 * v1 review can only inspect and dismiss a candidate, never apply it. Reject (dismiss the preview) is
 * always available so the editor stays usable.
 */
import { buildPatchPreview } from "./patch-preview.js";
import type { PatchPreviewLimits, PatchPreviewModel, PatchPreviewSource } from "./patch-preview.js";
import type { DiffActionAvailability } from "./components/diff-types.js";
import type { EditorTestGenerationAssurance, EditorTestGenerationResult } from "./types.js";

/**
 * The review actions available for a generated test candidate in v1. Apply and run-verification are
 * disabled (wave 2, behind the enforced egress boundary); reject (dismiss) is always available.
 */
export const TEST_GENERATION_REVIEW_ACTIONS: DiffActionAvailability = {
  canApply: false,
  canReject: true,
  canRunVerification: false,
};

/** The rendered review model for a generated candidate plus its (v1-fixed) review actions. */
export interface TestGenerationPreview {
  readonly model: PatchPreviewModel;
  readonly actions: DiffActionAvailability;
  readonly assurance: EditorTestGenerationAssurance;
}

/** Arguments for {@link buildTestGenerationPreview}. */
export interface BuildTestGenerationPreviewArgs {
  readonly result: EditorTestGenerationResult;
  readonly assurance: EditorTestGenerationAssurance;
  /** Original content keyed by file uri; required only for modified/deleted files (new files omit it). */
  readonly sources?: Readonly<Record<string, PatchPreviewSource>> | undefined;
  readonly limits?: Partial<PatchPreviewLimits> | undefined;
}

/** Projects a generated test candidate to the diff-review model with apply disabled (review-first). */
export function buildTestGenerationPreview(
  args: BuildTestGenerationPreviewArgs,
): TestGenerationPreview {
  const model = buildPatchPreview({
    patch: args.result.patch,
    ...(args.sources === undefined ? {} : { sources: args.sources }),
    ...(args.limits === undefined ? {} : { limits: args.limits }),
  });
  return { model, actions: TEST_GENERATION_REVIEW_ACTIONS, assurance: args.assurance };
}
