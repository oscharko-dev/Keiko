// Public barrel for the Quality Intelligence Figma Screen-IR sub-namespace (Epic #750, Issue #752).
//
// Pure-domain cleaner: raw scoped Figma node tree → lean per-screen IR + deduped design tokens +
// raw inter-screen links + reduction report. No IO, no network, no model. Downstream stages import
// these types: #753 (snapshot evidence), #754 (QI source), #811 (nav graph, from `links`), #812
// (a11y), #755 (codegen, from `tokens`).

export { cleanScopedNodesToScreenIr } from "./cleanToScreenIr.js";

// Structural test-baseline derivation + the defensive Screen-IR parser for the snapshot's opaque
// `irJson` (Issue #754). Deterministic, model-free: same IR → byte-identical baseline.
export {
  parseScreenIr,
  deriveScreenTestBaseline,
  renderBaselineText,
} from "./screenIrTestBaseline.js";

export type {
  ScreenTestBaseline,
  StructuralTestCategory,
  StructuralTestItem,
} from "./screenIrTestBaseline.js";

// Vision merge that structurally enforces "vision augments, never overrides the IR" (Issue #754).
export { mergeVisionHints } from "./visionAugmentation.js";
export type { VisionMergeResult } from "./visionAugmentation.js";

// Deterministic navigation/flow graph + routing hints + per-screen nav test items (Issue #811).
// Pure, model-free: derived from the IR's inter-screen links; composes into the QI run additively
// through `deriveScreenTestBaseline`'s `extraItems` seam.
export {
  deriveNavGraph,
  deriveNavFlows,
  deriveRoutingHints,
  deriveNavTestItemsByScreen,
} from "./navGraph.js";
export type {
  NavEdge,
  NavFlow,
  NavGraph,
  NavNode,
  RoutingHint,
  UnresolvedLink,
} from "./navGraph.js";

export type { FigmaSourceNode } from "./sourceNode.js";

export type {
  BoundingBox,
  ColorToken,
  DesignTokens,
  ImageFillRef,
  InteractionHint,
  InterScreenLink,
  IrNode,
  RadiusToken,
  ReductionReport,
  ScreenIr,
  ScreenIrResult,
  SpacingToken,
  TypographyToken,
} from "./irTypes.js";
