// Screen-IR, design-token, and inter-screen-link types (Epic #750, Issue #752).
//
// The IR is the lean structural ground truth a scoped Figma board reduces to: per-screen kept-node
// trees plus deduped design tokens and the raw inter-screen transitions. These types are the
// import surface for downstream stages — #753 (snapshot evidence), #754 (QI source), #811 (nav
// graph, from `links`), #812 (a11y), #755 (codegen, from `tokens`). All emitted collections are
// stable-ordered; the structure carries no timestamps so the same input yields a byte-identical IR.

/** A best-effort structural/role hint for a kept node. Never load-bearing downstream. */
export type InteractionHint = "button" | "input" | "link" | "text" | "image" | "container";

export interface BoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A reference to an image fill on a node (the imageRef the provider assigns to the fill). */
export interface ImageFillRef {
  readonly imageRef: string;
}

/** A kept node in a screen's normalized structural tree. */
export interface IrNode {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly interactionHint: InteractionHint;
  readonly text?: string;
  readonly boundingBox?: BoundingBox;
  /**
   * The node's solid text-fill colour as normalized `#RRGGBB[AA]`, for a TEXT node (Issue #812).
   * Optional and additive: absent when the node carries no solid text fill. NEVER folded into the
   * snapshot integrity hash (#753/#735) — it is a11y-derivation metadata, not structural identity.
   */
  readonly textColor?: string;
  /**
   * The node's solid background-fill colour as normalized `#RRGGBB[AA]` (Issue #812). Used as the
   * nearest-ancestor background when computing deterministic text-vs-background contrast. Optional,
   * additive, and hash-neutral like {@link IrNode.textColor}.
   */
  readonly backgroundColor?: string;
  readonly imageFills: readonly ImageFillRef[];
  readonly children: readonly IrNode[];
}

export interface ScreenIr {
  readonly id: string;
  readonly name: string;
  readonly root: IrNode;
}

export interface ColorToken {
  readonly id: string;
  readonly kind: "color";
  readonly value: string;
}

export interface TypographyToken {
  readonly id: string;
  readonly kind: "typography";
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontWeight: number;
  readonly lineHeight: number;
}

export interface SpacingToken {
  readonly id: string;
  readonly kind: "spacing";
  readonly value: number;
}

export interface RadiusToken {
  readonly id: string;
  readonly kind: "radius";
  readonly value: number;
}

/** Deduped, stable-ordered design tokens — emitted as part of and alongside the IR (for #755). */
export interface DesignTokens {
  readonly colors: readonly ColorToken[];
  readonly typography: readonly TypographyToken[];
  readonly spacing: readonly SpacingToken[];
  readonly radius: readonly RadiusToken[];
}

/** A raw inter-screen transition. The flow graph is derived downstream (#811); we carry the link. */
export interface InterScreenLink {
  readonly sourceNodeId: string;
  readonly trigger: string;
  readonly targetNodeId: string;
}

/** How much of the raw subtree was dropped. `removedRatio` is rounded deterministically. */
export interface ReductionReport {
  readonly inputNodeCount: number;
  readonly keptNodeCount: number;
  readonly removedNodeCount: number;
  readonly removedRatio: number;
}

/** The full per-board result of cleaning a scoped Figma node subtree. */
export interface ScreenIrResult {
  readonly screens: readonly ScreenIr[];
  readonly tokens: DesignTokens;
  readonly links: readonly InterScreenLink[];
  readonly reduction: ReductionReport;
}
