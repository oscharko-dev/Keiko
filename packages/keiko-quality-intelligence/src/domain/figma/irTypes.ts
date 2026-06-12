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

/** Auto-layout direction for a flex container. */
export type LayoutMode = "row" | "column";

/** Simplified alignment shorthand for a flex axis. */
export type AlignItems = "start" | "center" | "end" | "space-between";

/**
 * Auto-layout properties for a FRAME/COMPONENT/INSTANCE that has `layoutMode` set. Optional and
 * additive: absent when the node has no auto-layout. NEVER folded into the snapshot integrity hash
 * (#753/#735) — it is codegen metadata, not structural drift identity.
 */
export interface IrLayout {
  /** Flex direction derived from Figma `layoutMode` (HORIZONTAL → row, VERTICAL → column). */
  readonly mode: LayoutMode;
  /** Gap between children, from `itemSpacing`. */
  readonly itemSpacing?: number;
  /** Padding: [top, right, bottom, left]. Absent when all four are zero/absent. */
  readonly padding?: readonly [number, number, number, number];
  /** Primary-axis alignment (Figma `primaryAxisAlignItems`). */
  readonly primaryAlign?: AlignItems;
  /** Cross-axis alignment (Figma `counterAxisAlignItems`). */
  readonly counterAlign?: AlignItems;
}

/** Whether a dimension is fixed, fills available space, or hugs content. */
export type LayoutSizing = "fixed" | "hug" | "fill";

/**
 * Per-axis sizing mode (Figma `layoutSizingHorizontal` / `layoutSizingVertical`). Optional and
 * additive; absent when the node has no auto-layout parent or when sizing is not explicitly set.
 * Hash-neutral like {@link IrLayout}.
 */
export interface IrSizing {
  readonly horizontal?: LayoutSizing;
  readonly vertical?: LayoutSizing;
}

/**
 * Per-TEXT-node typography properties, only present on TEXT nodes. Matches what `tokens.ts`
 * already extracts globally (fontFamily, fontSize, fontWeight). Optional and additive; absent for
 * non-TEXT nodes or when the `style` block is missing. Hash-neutral like {@link IrLayout}.
 */
export interface IrTypography {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontWeight: number;
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
  /**
   * Auto-layout properties (direction, gap, padding, alignment). Optional and additive: absent when
   * the node has no auto-layout. Hash-neutral — codegen metadata, not structural drift identity.
   */
  readonly layout?: IrLayout;
  /**
   * Per-axis sizing mode. Optional and additive: absent when no sizing context exists.
   * Hash-neutral like {@link IrNode.layout}.
   */
  readonly sizing?: IrSizing;
  /**
   * Corner radius in pixels. Optional and additive: absent when zero or absent from source.
   * Hash-neutral like {@link IrNode.layout}.
   */
  readonly cornerRadius?: number;
  /**
   * Per-TEXT typography (fontFamily, fontSize, fontWeight). Optional and additive: absent for
   * non-TEXT nodes or when the style block is missing. Hash-neutral like {@link IrNode.layout}.
   */
  readonly typography?: IrTypography;
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
