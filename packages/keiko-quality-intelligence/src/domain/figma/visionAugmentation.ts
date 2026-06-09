// Vision augmentation merge for the Figma-snapshot QI source (Epic #750, Issue #754).
//
// Capability-routed vision (a multimodal model reading the rendered screen, selected via #810) may
// add image-derived semantics the structural IR cannot reveal. This module enforces the load-bearing
// invariant STRUCTURALLY: vision augments, it never OVERRIDES the IR. The deterministic baseline
// text is preserved byte-for-byte and the vision hints are appended as a clearly-labelled, separate,
// additive section — there is no code path by which a vision hint can mutate or remove a baseline
// line. With no hints (no multimodal capability, or a garbage/thrown result the caller drops to an
// empty list), the output IS the baseline text unchanged.

const MAX_HINTS = 24;
const MAX_HINT_CHARS = 500;

const VISION_SECTION_HEADER =
  "Vision-derived semantic hints (additive — cross-check against the structural baseline above; " +
  "never overrides it):";

// Drop empties and over-long entries, normalise whitespace, and de-duplicate while preserving order.
// A model that returns garbage (empty strings, an over-long blob) contributes nothing rather than
// corrupting the atom.
function sanitiseHints(hints: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of hints) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.replace(/\s+/gu, " ").trim();
    if (trimmed.length === 0 || trimmed.length > MAX_HINT_CHARS) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_HINTS) break;
  }
  return out;
}

export interface VisionMergeResult {
  /** Baseline text with the additive vision section appended; equals `baselineText` when no hints. */
  readonly text: string;
  /** How many vision hints survived sanitisation and were appended. */
  readonly augmentedCount: number;
}

/**
 * Merge vision hints into the deterministic baseline text WITHOUT overriding it. The baseline text is
 * always the prefix of the result; hints (if any survive sanitisation) follow under a labelled
 * section. When no hint survives, the result text is identical to `baselineText`, so the structural
 * baseline always ships and the vision contribution is provably additive.
 */
export function mergeVisionHints(
  baselineText: string,
  hints: readonly string[],
): VisionMergeResult {
  const clean = sanitiseHints(hints);
  if (clean.length === 0) {
    return { text: baselineText, augmentedCount: 0 };
  }
  const section = [VISION_SECTION_HEADER, ...clean.map((hint) => `- ${hint}`)].join("\n");
  return { text: `${baselineText}\n\n${section}`, augmentedCount: clean.length };
}
