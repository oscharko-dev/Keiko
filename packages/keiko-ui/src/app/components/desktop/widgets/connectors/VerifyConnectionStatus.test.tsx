// Issue #2245 (AC) — each closed verify status renders distinct, actionable copy and a tone; no raw
// provider error path exists (the component only accepts the closed union).

import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";
import { VerifyConnectionStatus } from "./VerifyConnectionStatus";
import { ATLASSIAN_CONNECTOR_VERIFY_STATUSES } from "@/lib/atlassian-connectors-api";

const EXPECTED: Record<string, { readonly label: string; readonly tone: string }> = {
  ok: { label: "Connection verified", tone: "ok" },
  "auth-failed": { label: "Authentication failed", tone: "danger" },
  forbidden: { label: "Access forbidden", tone: "danger" },
  unreachable: { label: "Site unreachable", tone: "warning" },
  timeout: { label: "Connection timed out", tone: "warning" },
};

describe("VerifyConnectionStatus", () => {
  it("renders each closed status with distinct label + tone", () => {
    const seen = new Set<string>();
    for (const status of ATLASSIAN_CONNECTOR_VERIFY_STATUSES) {
      const { unmount } = render(<VerifyConnectionStatus status={status} />);
      const el = screen.getByTestId("acx-verify-status");
      const expected = EXPECTED[status];
      expect(expected).toBeDefined();
      expect(el).toHaveAttribute("data-status", status);
      expect(el).toHaveAttribute("data-tone", expected?.tone ?? "");
      expect(el).toHaveTextContent(expected?.label ?? "");
      expect(el).toHaveAttribute("role", "status");
      seen.add(el.textContent ?? "");
      unmount();
    }
    // Every status produced a distinct rendered string.
    expect(seen.size).toBe(ATLASSIAN_CONNECTOR_VERIFY_STATUSES.length);
  });

  it("has no axe violations (light and dark)", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.setAttribute("data-theme", theme);
      const { container, unmount } = render(<VerifyConnectionStatus status="forbidden" />);
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});
