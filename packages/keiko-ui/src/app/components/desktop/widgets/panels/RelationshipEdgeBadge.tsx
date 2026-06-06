// Issue #540 (Epic #532) — single relationship edge badge.
//
// Renders a labeled chip for one relationship with non-color-only state:
//   text label + ARIA aria-label + icon (activity-visualization.md per-state table).
//
// CSS variables come exclusively from globals.css tokens — no new tokens introduced.
// Motion only via `motion-safe` Tailwind prefix (activity-visualization.md §"Motion rules").
// prefers-reduced-motion: static segmented circle replaces rotation (§"Reduced-motion").
//
// Reuses existing keyframes: @keyframes spin (globals.css:146), @keyframes pulse (globals.css:151).
// No new @keyframes rule is introduced.

"use client";

import type { ReactNode } from "react";
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
    ariaDescription: "Relationship is inactive",
    iconShape: "hollow-circle",
    textColor: "var(--fg-muted)",
    bgColor: "var(--inset)",
    animated: false,
  },
  queued: {
    label: "Queued",
    ariaDescription: "Relationship is queued",
    iconShape: "clock",
    textColor: "var(--fg-muted)",
    bgColor: "var(--inset)",
    animated: false,
  },
  active: {
    label: "Active",
    ariaDescription: "Relationship is active",
    iconShape: "filled-circle",
    textColor: "var(--accent)",
    bgColor: "var(--accent-dim)",
    borderColor: "var(--accent-line)",
    animated: false,
  },
  processing: {
    label: "Processing",
    ariaDescription: "Relationship is processing",
    iconShape: "spinning-circle",
    textColor: "var(--accent)",
    bgColor: "var(--accent-dim)",
    borderColor: "var(--accent-line)",
    animated: true, // @keyframes spin; gated motion-safe
  },
  completed: {
    label: "Completed",
    ariaDescription: "Relationship completed",
    iconShape: "check",
    textColor: "var(--accent)",
    bgColor: "var(--accent-dim)",
    animated: false,
  },
  failed: {
    label: "Failed",
    ariaDescription: "Relationship failed",
    iconShape: "triangle-exclamation",
    textColor: "var(--danger)",
    bgColor: "color-mix(in oklch, var(--danger) 12%, var(--card))",
    animated: false,
  },
  blocked: {
    label: "Blocked",
    ariaDescription: "Relationship is blocked",
    iconShape: "filled-square",
    textColor: "var(--warn)",
    bgColor: "color-mix(in oklch, var(--warn) 12%, var(--card))",
    animated: false,
  },
  degraded: {
    label: "Degraded",
    ariaDescription: "Relationship is degraded",
    iconShape: "broken-line",
    textColor: "var(--warn)",
    bgColor: "color-mix(in oklch, var(--warn) 8%, var(--card))",
    animated: false,
  },
  "high-throughput": {
    label: "High throughput",
    ariaDescription: "Relationship is processing high throughput",
    iconShape: "stacked-lines",
    textColor: "var(--accent)",
    bgColor: "var(--accent-dim)",
    animated: false,
  },
};

// ─── Icon renderers (inline SVG; no new library) ───────────────────────────────

function ActivityIcon({
  shape,
  color,
  animated,
}: {
  shape: ActivityVisual["iconShape"];
  color: string;
  animated: boolean;
}): ReactNode {
  // animated prop maps to CSS animation class; motion-safe:animate-spin applies
  // @keyframes spin from globals.css:146 only when prefers-reduced-motion: no-preference.
  const spinClass = animated ? "motion-safe:animate-spin" : "";
  const svgProps = {
    width: 12,
    height: 12,
    viewBox: "0 0 12 12",
    "aria-hidden": true as const,
    fill: "currentColor",
    style: { color },
  };

  switch (shape) {
    case "hollow-circle":
      return (
        <svg {...svgProps}>
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case "clock":
      return (
        <svg {...svgProps}>
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M6 3v3l2 1"
            stroke="currentColor"
            strokeWidth="1.5"
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
        <svg {...svgProps} className={spinClass}>
          <circle
            cx="6"
            cy="6"
            r="4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
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
            strokeWidth="1.8"
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
            strokeWidth="1.5"
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
            strokeWidth="1.5"
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
  readonly throughputCount?: number;
  /** Called when the badge is clicked (e.g. to focus the inspector). */
  readonly onClick?: () => void;
  /** Additional CSS class names. */
  readonly className?: string;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function RelationshipEdgeBadge({
  type,
  lifecycle,
  activity,
  throughputCount,
  onClick,
  className = "",
}: RelationshipEdgeBadgeProps): ReactNode {
  const visual = ACTIVITY_VISUALS[activity];
  const def = RELATIONSHIP_TYPE_DEFINITIONS[type];
  const displayLabel =
    activity === "high-throughput" && throughputCount !== undefined
      ? `${visual.label} (${String(throughputCount)})`
      : visual.label;

  // aria-label combines relationship type + activity description for screen readers.
  const ariaLabel = `${def.displayName} — ${visual.ariaDescription}`;

  const badgeStyle: React.CSSProperties = {
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
              animated={visual.animated}
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
              animated={visual.animated}
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
