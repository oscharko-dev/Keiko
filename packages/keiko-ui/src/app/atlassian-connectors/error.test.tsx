// F3 — /atlassian-connectors previously had no error.tsx and no boundary anywhere above the
// route: any render-time throw took the whole page to a blank screen with nothing to catch it
// (Next.js App Router's own default-error fallback is the only thing that would show, and this
// route rendered nothing before this file existed). This test exercises the boundary component
// itself the way Next.js invokes it: `{ error, reset }` props, no ancestor providers.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AtlassianConnectorsRouteError from "./error";

describe("AtlassianConnectorsRouteError (F3 route-level safety net)", () => {
  it("renders an actionable alert instead of nothing, and logs the crash for diagnosis", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const error = new Error("forced connector route defect");
      render(<AtlassianConnectorsRouteError error={error} reset={vi.fn()} />);

      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("Atlassian connectors hit an error");
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
      // 0.3.0 audit (Qodo review on #2869): the boundary reports the error's CLASS and nothing
      // else — a raw Error carries a stack with absolute paths and a message Keiko does not
      // control. Strengthened, not adapted: both the class and the absence of the object are pinned.
      expect(warnSpy).toHaveBeenCalledWith("[keiko] atlassian-connectors route crashed: Error");
      for (const call of warnSpy.mock.calls) {
        for (const argument of call) {
          expect(argument).not.toBeInstanceOf(Error);
          expect(String(argument)).not.toContain("defect");
        }
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("invokes Next.js's reset() so the segment can re-render without a full reload", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reset = vi.fn();
    try {
      render(
        <AtlassianConnectorsRouteError
          error={new Error("forced connector route defect")}
          reset={reset}
        />,
      );
      screen.getByRole("button", { name: "Try again" }).click();
      expect(reset).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
