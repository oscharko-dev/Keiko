/**
 * The one gate every path that APPLIES formatting edits passes through (0.3.0 release audit).
 *
 * A formatting result is a MUTATION, not a listing. The server caps it — `maxFormattingEdits`, plus
 * the aggregate `maxDocumentBytes` ceiling on the replacement text — and reports the fact as
 * `truncated`. Applying such a result reformats the part of the document the surviving edits happen
 * to cover and leaves the rest as it was, which is not the operation the user asked for: they asked
 * for the document to be formatted, and a half-formatted document is indistinguishable from a
 * finished one once the edits are in the buffer.
 *
 * The shared outcome seam ({@link import("./components/language-intelligence.js")}) already labels
 * such a result `capped`, and a label is the right treatment for a RENDER surface — a capped
 * reference list is still a true list of real references. It is NOT enough here, for the same reason
 * a capped rename changeset refuses Accept ({@link import("./rename-preview.js").renameChangesetTruncation}):
 * a label explains a mutation the user never approved AFTER it has already happened, and on the
 * format-on-save path it has already been written to disk. So this module answers the apply question
 * instead of the reporting question, and answers it once for every caller rather than at each apply
 * site — the Monaco "Format Document" provider and the host's format-on-save both route through it.
 *
 * The refusal is deliberately narrow: only a result that STATES it is capped is refused. `truncated`
 * is optional on {@link EditorFormattingResponse} precisely so a host that cannot know stays honest by
 * omission rather than by asserting `false`, and turning "not stated" into a refusal would disable
 * formatting for such a host without any evidence that a cap ever bound. Refusing what is known to be
 * partial is the invariant; guessing about silence is not.
 *
 * Code actions are deliberately NOT in this class. Their cap drops whole ACTIONS from the offered
 * list and never trims an individual action's `edits`, so applying an offered action still applies it
 * in full — that is a render incompleteness the `capped` label covers.
 */
import type { EditorFormattingResponse, EditorTextEdit } from "./types.js";

/**
 * What a caller may do with a settled formatting result. `refused` carries no edits at all, so a
 * caller cannot reach a capped edit set without first handling the refusal.
 */
export type FormattingApplyDecision =
  | { readonly status: "apply"; readonly edits: readonly EditorTextEdit[] }
  | { readonly status: "refused"; readonly reason: "capped" };

/**
 * Decide whether a formatting result may be applied to a buffer or written to disk.
 *
 * Returns `refused` when the language service reports the reformat as capped, and `apply` with the
 * result's edits otherwise (an empty edit list is a legitimate "already formatted" answer, not a
 * refusal). Callers must surface the refusal — silently doing nothing would restore exactly the lie
 * this gate exists to prevent.
 */
export function formattingApplyDecision(
  response: EditorFormattingResponse,
): FormattingApplyDecision {
  if (response.truncated === true) {
    return { status: "refused", reason: "capped" };
  }
  return { status: "apply", edits: response.edits };
}
