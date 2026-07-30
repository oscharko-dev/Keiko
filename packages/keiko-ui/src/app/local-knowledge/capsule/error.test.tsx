// F4 — /local-knowledge/capsule previously had no error.tsx and no boundary anywhere above the
// route (`<Suspense>` only covers the loading fallback, not a thrown render error): any
// render-time throw took the whole page to a blank screen with nothing to catch it. This test
// exercises the boundary component itself the way Next.js invokes it: `{ error, reset }` props,
// no ancestor providers.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CapsuleDetailRouteError from "./error";

describe("CapsuleDetailRouteError (F4 route-level safety net)", () => {
  it("renders an actionable alert instead of nothing, and logs the crash for diagnosis", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const error = new Error("forced capsule route defect");
      render(<CapsuleDetailRouteError error={error} reset={vi.fn()} />);

      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("This Knowledge Pod page hit an error");
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
      expect(warnSpy).toHaveBeenCalledWith("[keiko] local-knowledge capsule route crashed", error);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("invokes Next.js's reset() so the segment can re-render without a full reload", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reset = vi.fn();
    try {
      render(
        <CapsuleDetailRouteError error={new Error("forced capsule route defect")} reset={reset} />,
      );
      screen.getByRole("button", { name: "Try again" }).click();
      expect(reset).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
