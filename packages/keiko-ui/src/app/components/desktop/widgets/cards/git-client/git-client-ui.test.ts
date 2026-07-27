// Unit tests for the pure presentational helpers in git-client-ui.tsx (Issue #1575, Epic #1571).
// outcomeRingColor is only ever invoked internally with the output of outcomeTone, whose input
// (GitDeliveryMutationStatus) is an exhaustive 5-member union that maps to just "success" /
// "warning" / "danger" — so its "neutral"/default ring color has no reachable real caller and is
// exercised here directly against the full PillTone contract instead.

import { describe, expect, it } from "vitest";
import { outcomeRingColor } from "./git-client-ui";

describe("outcomeRingColor", () => {
  it("rings a succeeded outcome with the ok-mixed color", () => {
    expect(outcomeRingColor("success")).toBe("color-mix(in oklch, var(--ok) 42%, var(--line))");
  });

  it("rings an approval-required/recovery-required outcome with the warn-mixed color", () => {
    expect(outcomeRingColor("warning")).toBe("color-mix(in oklch, var(--warn) 42%, var(--line))");
  });

  it("rings a blocked/failed outcome with the danger-mixed color", () => {
    expect(outcomeRingColor("danger")).toBe("color-mix(in oklch, var(--danger) 42%, var(--line))");
  });

  it("falls back to the plain line color for any other tone", () => {
    expect(outcomeRingColor("neutral")).toBe("var(--line)");
    expect(outcomeRingColor("accent")).toBe("var(--line)");
    expect(outcomeRingColor("info")).toBe("var(--line)");
  });
});
