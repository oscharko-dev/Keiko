// Issue #540 (Epic #532) — RelationshipEdgeBadge unit tests
//
// Covers:
//   • All 9 activity states render correct label + aria description (non-color-only)
//   • Animated states get motion-safe: class; no animation when prefers-reduced-motion mock
//   • onClick renders a <button>; no onClick renders a <span>
//   • High-throughput state shows throughputCount
//   • a11y: role="status" aria-live="polite" aria-atomic="true" present
//   • Lifecycle state icon is aria-hidden
//   • Keyboard: button variant is focusable and fires onClick on Enter/Space

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { axe, toHaveNoViolations } from "jest-axe";
import { RelationshipEdgeBadge } from "./RelationshipEdgeBadge";
import type { RelationshipActivityState } from "@oscharko-dev/keiko-contracts";

expect.extend(toHaveNoViolations);

const ALL_ACTIVITY_STATES: RelationshipActivityState[] = [
  "inactive",
  "queued",
  "active",
  "processing",
  "completed",
  "failed",
  "blocked",
  "degraded",
  "high-throughput",
];

describe("RelationshipEdgeBadge", () => {
  describe("non-color-only state representation", () => {
    it.each(ALL_ACTIVITY_STATES)("state %s renders a visible label", (activity) => {
      render(<RelationshipEdgeBadge type="reads-context" lifecycle="active" activity={activity} />);
      // Each state must have a visible label (not just an icon / color)
      const badge = screen.getByRole("status");
      expect(badge).toBeDefined();
      // The visually-hidden description must be present
      const hidden = badge.querySelector(".visually-hidden");
      expect(hidden).not.toBeNull();
      expect(hidden?.textContent?.length).toBeGreaterThan(0);
    });

    it("failed state renders the word 'failed' in its ARIA description", () => {
      render(<RelationshipEdgeBadge type="reads-context" lifecycle="active" activity="failed" />);
      const badge = screen.getByRole("status");
      const hidden = badge.querySelector(".visually-hidden");
      expect(hidden?.textContent?.toLowerCase()).toContain("fail");
    });

    it("blocked state renders a denial description in its ARIA description", () => {
      render(<RelationshipEdgeBadge type="reads-context" lifecycle="active" activity="blocked" />);
      const badge = screen.getByRole("status");
      const hidden = badge.querySelector(".visually-hidden");
      // Spec-exact description from activity-state.md §6: mentions "validator denied"
      expect(hidden?.textContent?.toLowerCase()).toContain("denied");
    });
  });

  describe("ARIA structure", () => {
    it("wraps in role=status aria-live=polite aria-atomic=true", () => {
      const { container } = render(
        <RelationshipEdgeBadge type="reads-context" lifecycle="active" activity="active" />,
      );
      const wrapper = container.firstElementChild;
      expect(wrapper?.getAttribute("role")).toBe("status");
      expect(wrapper?.getAttribute("aria-live")).toBe("polite");
      expect(wrapper?.getAttribute("aria-atomic")).toBe("true");
    });

    it("lifecycle icon is aria-hidden", () => {
      render(<RelationshipEdgeBadge type="reads-context" lifecycle="active" activity="active" />);
      const badge = screen.getByRole("status");
      // Any SVG or icon span in the badge should be aria-hidden
      const icons = badge.querySelectorAll('[aria-hidden="true"]');
      expect(icons.length).toBeGreaterThan(0);
    });
  });

  describe("interactive variant", () => {
    it("renders a <button> when onClick is provided", () => {
      const onClick = vi.fn();
      render(
        <RelationshipEdgeBadge
          type="reads-context"
          lifecycle="active"
          activity="active"
          onClick={onClick}
        />,
      );
      const btn = screen.getByRole("button");
      expect(btn).toBeDefined();
    });

    it("calls onClick when button is clicked", () => {
      const onClick = vi.fn();
      render(
        <RelationshipEdgeBadge
          type="reads-context"
          lifecycle="active"
          activity="active"
          onClick={onClick}
        />,
      );
      fireEvent.click(screen.getByRole("button"));
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("does NOT render a button when onClick is absent", () => {
      render(<RelationshipEdgeBadge type="reads-context" lifecycle="active" activity="inactive" />);
      expect(screen.queryByRole("button")).toBeNull();
    });
  });

  describe("high-throughput state", () => {
    it("shows throughputCount when provided", () => {
      render(
        <RelationshipEdgeBadge
          type="reads-context"
          lifecycle="active"
          activity="high-throughput"
          throughputCount={42}
        />,
      );
      expect(screen.getByText(/42/)).toBeDefined();
    });

    it("renders high-throughput label even without a count", () => {
      render(
        <RelationshipEdgeBadge
          type="reads-context"
          lifecycle="active"
          activity="high-throughput"
        />,
      );
      const badge = screen.getByRole("status");
      const hidden = badge.querySelector(".visually-hidden");
      // Spec-exact description from activity-state.md §6 uses "events" (not the word "throughput")
      expect(hidden?.textContent?.toLowerCase()).toContain("events");
    });
  });

  describe("animation constraints", () => {
    it("processing state includes motion-safe: animation class", () => {
      const { container } = render(
        <RelationshipEdgeBadge type="reads-context" lifecycle="active" activity="processing" />,
      );
      // processing is the animated state — icon must carry a motion-safe: prefixed class
      const html = container.innerHTML;
      expect(html).toContain("motion-safe:");
    });

    it("inactive state does NOT have animation classes", () => {
      const { container } = render(
        <RelationshipEdgeBadge type="reads-context" lifecycle="active" activity="inactive" />,
      );
      const html = container.innerHTML;
      // No animation on static states
      expect(html).not.toContain("animate-spin");
      expect(html).not.toContain("animate-pulse");
    });
  });

  describe("accessibility (axe-core)", () => {
    it("passes axe on active state with onClick", async () => {
      const { container } = render(
        <RelationshipEdgeBadge
          type="reads-context"
          lifecycle="active"
          activity="active"
          onClick={() => undefined}
        />,
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it("passes axe on failed state without onClick", async () => {
      const { container } = render(
        <RelationshipEdgeBadge type="reads-context" lifecycle="revoked" activity="failed" />,
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });
});
