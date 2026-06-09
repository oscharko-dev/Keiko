// Public barrel for the Quality Intelligence Figma Screen-IR sub-namespace (Epic #750, Issue #752).
//
// Pure-domain cleaner: raw scoped Figma node tree → lean per-screen IR + deduped design tokens +
// raw inter-screen links + reduction report. No IO, no network, no model. Downstream stages import
// these types: #753 (snapshot evidence), #754 (QI source), #811 (nav graph, from `links`), #812
// (a11y), #755 (codegen, from `tokens`).

export { cleanScopedNodesToScreenIr } from "./cleanToScreenIr.js";

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
