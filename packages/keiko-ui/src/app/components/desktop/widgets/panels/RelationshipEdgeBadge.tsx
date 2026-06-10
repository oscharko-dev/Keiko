// Issue #540 (Epic #532) — single relationship edge badge.
// Extended in Issue #541 (Epic #532) — per-state visual treatment + prefers-contrast support.
//
// Renders a labeled chip for one relationship with non-color-only state:
//   text label + ARIA aria-label + icon (activity-visualization.md per-state table).
//
// CSS variables come exclusively from globals.css tokens — no new tokens introduced.
// Motion only via app CSS classes in globals.css (activity-visualization.md §"Motion rules").
// prefers-reduced-motion: static segmented circle replaces rotation (§"Reduced-motion").
// prefers-contrast: more → high-contrast override per activity-visualization.md §"Contrast".
//
// Reuses existing keyframes: @keyframes spin (globals.css:146), @keyframes pulse (globals.css:151).
// No new @keyframes rule is introduced.
//
// #541 adds:
//   • Spec-exact ARIA descriptions from activity-state.md §6
//   • animateOverride prop (false = static; from useRelationshipActivityStream animate flag)
//   • highContrast prop (true when prefers-contrast: more)
//   • data-activity-state attribute for CSS targeting

"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type {
  RelationshipActivityState,
  RelationshipLifecycleState,
} from "@oscharko-dev/keiko-contracts";
import type { RelationshipType } from "@oscharko-dev/keiko-contracts";
import { RELATIONSHIP_TYPE_DEFINITIONS } from "@oscharko-dev/keiko-contracts";

// ─── Activity state visual binding (activity-visualization.md §"Per-state visual treatment") ─

interface ActivityVisual {
  readonly label: string;
  readonly ariaDescription: string;
  readonly iconShape:
    | "hollow-circle"
    | "clock"
    | "filled-circle"
    | "spinning-circle"
    | "check"
    | "triangle-exclamation"
    | "filled-square"
    | "broken-line"
    | "stacked-lines";
  readonly textColor: string;
  readonly bgColor: string;
  readonly borderColor?: string;
  readonly animated: boolean;
}

const ACTIVITY_VISUALS: Readonly<Record<RelationshipActivityState, ActivityVisual>> = {
  inactive: {
    label: "Inactive",
    // activity-state.md §6 exact wording
    ariaDescription: "No recent activity for this relationship.",
    iconShape: "hollow-circle",
    textColor: "var(--fg-muted)",
    bgColor: "var(--inset)",
    animated: false,
  },
  queued: {
    label: "Queued",
    ariaDescription: "A workflow run referencing this relationship is queued.",
    iconShape: "clock",
    textColor: "var(--fg-muted)",
    bgColor: "var(--inset)",
    animated: false,
  },
  active: {
    label: "Active",
    ariaDescription: "A model call referencing this relationship is in progress.",
    iconShape: "filled-circle",
    textColor: "var(--accent)",
    bgColor: "var(--accent-dim)",
    borderColor: "var(--accent-line)",
    animated: false,
  },
  processing: {
    label: "Processing",
    ariaDescription: "A tool or command referencing this relationship is executing.",
    iconShape: "spinning-circle",
    textColor: "var(--accent)",
    bgColor: "var(--accent-dim)",
    borderColor: "var(--accent-line)",
    animated: true, // @keyframes spin; gated by globals.css reduced-motion media query
  },
  completed: {
    label: "Completed",
    ariaDescription: "The most recent run referencing this relationship completed successfully.",
    iconShape: "check",
    textColor: "var(--accent)",
    bgColor: "var(--accent-dim)",
    animated: false,
  },
  failed: {
    label: "Failed",
    ariaDescription: "The most recent run referencing this relationship failed.",
    iconShape: "triangle-exclamation",
    // activity-visualization.md §"Failure, blocked, degraded" — var(--danger) on 12%-mix bg.
    // NEVER bg-red-600 (3.47:1). This CSS-variable-based danger pair passes 4.5:1 AA.
    textColor: "var(--danger)",
    bgColor: "color-mix(in oklch, var(--danger) 12%, var(--card))",
    animated: false,
  },
  blocked: {
    label: "Blocked",
    ariaDescription:
      "The validator denied a recent proposal referencing this relationship; see the inspector for the reason.",
    iconShape: "filled-square",
    textColor: "var(--warn)",
    bgColor: "color-mix(in oklch, var(--warn) 12%, var(--card))",
    animated: false,
  },
  degraded: {
    label: "Degraded",
    ariaDescription:
      "The health check flagged at least one endpoint of this relationship as not currently live.",
    iconShape: "broken-line",
    textColor: "var(--warn)",
    bgColor: "color-mix(in oklch, var(--warn) 8%, var(--card))",
    animated: false,
  },
  "high-throughput": {
    label: "High throughput",
    ariaDescription:
      "More than fifty events referenced this relationship in the last sixty seconds.",
    iconShape: "stacked-lines",
    textColor: "var(--accent)",
    bgColor: "var(--accent-dim)",
    // High-throughput is a count update, never a fast pulse — no animation.
    animated: false,
  },
};

// ─── Icon renderers (inline SVG; no new library) ───────────────────────────────

function ActivityIcon({
  shape,
  color,
  animated,
  highContrast,
}: {
  shape: ActivityVisual["iconShape"];
  color: string;
  animated: boolean;
  highContrast: boolean;
}): ReactNode {
  const iconClassName = [
    "rb-edge-badge-icon",
    animated ? "rb-edge-badge-icon--processing" : "",
    highContrast ? "rb-edge-badge-icon--high-contrast" : "",
  ]
    .filter((value) => value.length > 0)
    .join(" ");
  const strokeWidth = highContrast ? 2 : 1.5;
  const svgProps = {
    width: 12,
    height: 12,
    viewBox: "0 0 12 12",
    "aria-hidden": true as const,
    fill: "currentColor",
    className: iconClassName,
    style: { color },
  };

  switch (shape) {
    case "hollow-circle":
      return (
        <svg {...svgProps}>
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth={strokeWidth} />
        </svg>
      );
    case "clock":
      return (
        <svg {...svgProps}>
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth={strokeWidth} />
          <path
            d="M6 3v3l2 1"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      );
    case "filled-circle":
      return (
        <svg {...svgProps}>
          <circle cx="6" cy="6" r="5" />
        </svg>
      );
    case "spinning-circle":
      // Segmented circle: static when reduced-motion, animated when allowed
      return (
        <svg {...svgProps}>
          <circle
            cx="6"
            cy="6"
            r="4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeDasharray="8 4"
          />
        </svg>
      );
    case "check":
      return (
        <svg {...svgProps}>
          <path
            d="M2 6l3 3 5-5"
            stroke="currentColor"
            strokeWidth={highContrast ? 2.2 : 1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      );
    case "triangle-exclamation":
      return (
        <svg {...svgProps}>
          <path d="M6 1 L11 10 L1 10 Z" fill="currentColor" />
          <path
            d="M6 5v2.5"
            stroke="var(--card)"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            fill="none"
          />
          <circle cx="6" cy="9" r="0.7" fill="var(--card)" />
        </svg>
      );
    case "filled-square":
      return (
        <svg {...svgProps}>
          <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" />
        </svg>
      );
    case "broken-line":
      return (
        <svg {...svgProps}>
          <path
            d="M1 6h2.5l1.5-2 2 4 1.5-2H11"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      );
    case "stacked-lines":
      return (
        <svg {...svgProps}>
          <rect x="2" y="2.5" width="8" height="1.5" rx="0.75" />
          <rect x="2" y="5.25" width="8" height="1.5" rx="0.75" />
          <rect x="2" y="8" width="8" height="1.5" rx="0.75" />
        </svg>
      );
  }
}

// ─── Lifecycle chip icon (inspector-spec.md §4) ────────────────────────────────

function LifecycleIcon({ state }: { state: RelationshipLifecycleState }): ReactNode {
  const svgProps = {
    width: 10,
    height: 10,
    viewBox: "0 0 10 10",
    "aria-hidden": true as const,
    fill: "currentColor",
  };
  switch (state) {
    case "draft":
      return (
        <svg {...svgProps}>
          <circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case "active":
      return (
        <svg {...svgProps}>
          <circle cx="5" cy="5" r="4.5" />
        </svg>
      );
    case "archived":
      return (
        <svg {...svgProps}>
          <rect x="1" y="1" width="8" height="8" rx="1" />
        </svg>
      );
    case "superseded":
      return (
        <svg {...svgProps}>
          <path
            d="M2 5h6M6 3l2 2-2 2"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      );
    case "revoked":
      return (
        <svg {...svgProps}>
          <path
            d="M2 2l6 6M8 2L2 8"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      );
    case "blocked":
      return (
        <svg {...svgProps}>
          <rect x="1" y="1" width="8" height="8" rx="1" />
          <path
            d="M5 3v3"
            stroke="var(--card)"
            strokeWidth="1.5"
            strokeLinecap="round"
            fill="none"
          />
          <circle cx="5" cy="7.5" r="0.6" fill="var(--card)" />
        </svg>
      );
    case "stale":
      return (
        <svg {...svgProps}>
          <rect
            x="1"
            y="1"
            width="8"
            height="8"
            rx="1"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
      );
  }
}

// ─── Props ─────────────────────────────────────────────────────────────────────

export interface RelationshipEdgeBadgeProps {
  /** The relationship type drives the display label. */
  readonly type: RelationshipType;
  /** Current durable lifecycle state. */
  readonly lifecycle: RelationshipLifecycleState;
  /** Transient derived activity state (not persisted). */
  readonly activity: RelationshipActivityState;
  /** Optional count for high-throughput aggregate display. */
  readonly throughputCount?: number | undefined;
  /**
   * Override from useRelationshipActivityStream.animate.
   * When false, the processing spinning-circle is rendered statically
   * (prefers-reduced-motion or user disabled animations).
   * Defaults to true (animate if the state supports it).
   */
  readonly animateOverride?: boolean | undefined;
  /**
   * When true, renders high-contrast variant: drops color-mix backgrounds,
   * uses full-opacity state color + border. For prefers-contrast: more.
   * Defaults to false.
   */
  readonly highContrast?: boolean | undefined;
  /** Called when the badge is clicked (e.g. to focus the inspector). */
  readonly onClick?: (() => void) | undefined;
  /** Additional CSS class names. */
  readonly className?: string;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function RelationshipEdgeBadge({
  type,
  lifecycle,
  activity,
  throughputCount,
  animateOverride = true,
  highContrast,
  onClick,
  className = "",
}: RelationshipEdgeBadgeProps): ReactNode {
  const [prefersMoreContrast, setPrefersMoreContrast] = useState(false);

  useEffect(() => {
    if (highContrast !== undefined || typeof window === "undefined") return;
    const mediaQuery = window.matchMedia("(prefers-contrast: more)");
    const update = (matches: boolean): void => {
      setPrefersMoreContrast(matches);
    };

    update(mediaQuery.matches);
    const handleChange = (event: MediaQueryListEvent): void => {
      update(event.matches);
    };
    mediaQuery.addEventListener("change", handleChange);
    return (): void => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, [highContrast]);

  const visual = ACTIVITY_VISUALS[activity] ?? ACTIVITY_VISUALS.inactive;
  const def = RELATIONSHIP_TYPE_DEFINITIONS[type];
  const effectiveHighContrast = highContrast ?? prefersMoreContrast;

  // High-throughput label includes the numeric count (activity-state.md §5.4).
  const displayLabel =
    activity === "high-throughput" && throughputCount !== undefined
      ? `${visual.label} (${String(throughputCount)})`
      : visual.label;

  // aria-label combines relationship type + activity description for screen readers.
  const ariaLabel = `${def.displayName} — ${visual.ariaDescription}`;

  // Whether this badge should actually animate: visual says animated AND caller allows it.
  const shouldAnimate = visual.animated && animateOverride;

  // High-contrast override (activity-visualization.md §"prefers-contrast: more"):
  //   • Drop color-mix background → use var(--card) + full-opacity border in the state color.
  //   • Keep text in the state's color token.
  const badgeStyle: CSSProperties = effectiveHighContrast
    ? {
        color: visual.textColor,
        background: "var(--card)",
        border: `1px solid ${visual.textColor}`,
      }
    : {
        color: visual.textColor,
        background: visual.bgColor,
        border: visual.borderColor !== undefined ? `1px solid ${visual.borderColor}` : undefined,
      };

  return (
    // role="status" aria-live="polite" aria-atomic="true" per activity-visualization.md §"Per-state ARIA wiring"
    <span
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={`rb-edge-badge ${className}`.trim()}
      data-activity-state={activity}
      data-high-contrast={effectiveHighContrast ? "true" : undefined}
    >
      {onClick !== undefined ? (
        <button
          type="button"
          className="rb-edge-badge-btn"
          style={badgeStyle}
          aria-label={ariaLabel}
          onClick={onClick}
        >
          <span aria-hidden="true">
            <ActivityIcon
              shape={visual.iconShape}
              color={visual.textColor}
              animated={shouldAnimate}
              highContrast={effectiveHighContrast}
            />
          </span>
          {/* visually-hidden aria description per activity-visualization.md §"Per-state ARIA wiring" */}
          <span className="visually-hidden">{visual.ariaDescription}</span>
          <span aria-hidden="true" className="rb-edge-badge-label">
            {displayLabel}
          </span>
          <span className="rb-edge-badge-type">{def.displayName}</span>
          <LifecycleIcon state={lifecycle} />
        </button>
      ) : (
        <span className="rb-edge-badge-static" style={badgeStyle} aria-label={ariaLabel}>
          <span aria-hidden="true">
            <ActivityIcon
              shape={visual.iconShape}
              color={visual.textColor}
              animated={shouldAnimate}
              highContrast={effectiveHighContrast}
            />
          </span>
          <span className="visually-hidden">{visual.ariaDescription}</span>
          <span aria-hidden="true" className="rb-edge-badge-label">
            {displayLabel}
          </span>
          <span className="rb-edge-badge-type">{def.displayName}</span>
          <LifecycleIcon state={lifecycle} />
        </span>
      )}
    </span>
  );
}

// Export visual binding table for #541 consumer
export { ACTIVITY_VISUALS };
export type { ActivityVisual };
