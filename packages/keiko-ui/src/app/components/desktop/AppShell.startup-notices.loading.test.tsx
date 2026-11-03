import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { AppShellFrame, BrowserApprovalNotice, UpdateStartupNotice } from "./AppShell";

// Match Next's App Router compiler alias, using the installed framework implementation.
vi.mock("next/dynamic", async () => {
  const appDynamic = await vi.importActual<typeof import("next/dynamic")>(
    "next/dist/shared/lib/app-dynamic",
  );
  return { default: appDynamic.default };
});
vi.mock("@/lib/client-diagnostics", async (original) => ({
  ...(await original<typeof import("@/lib/client-diagnostics")>()),
  reportClientDiagnostic: vi.fn(),
}));
vi.mock("./browser/BrowserApprovalNotice", () => {
  throw new TypeError("Synthetic private browser chunk failure40");
});
vi.mock("./update/UpdateStartupNotice", () => {
  throw new TypeError("Synthetic private update chunk failure40");
});

it("keeps the desktop mounted and reports both unavailable startup modules without their bodies", async () => {
  const noise = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await act(async () => {
      render(
        <AppShellFrame>
          <button type="button">Existing desktop action</button>
          <BrowserApprovalNotice />
          <UpdateStartupNotice ready={false} openUpdates={vi.fn()} />
        </AppShellFrame>,
      );
    });
    expect(screen.getByRole("button", { name: "Existing desktop action" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    for (const moduleLoadFailure of ["browser-approval", "update-startup"]) {
      expect(reportClientDiagnostic).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          moduleLoadFailure,
          errorKind: "unavailable",
          correlationId: expect.any(String),
          errorEvidence: expect.any(Object),
        }),
      );
    }
    expect(JSON.stringify(vi.mocked(reportClientDiagnostic).mock.calls)).not.toContain(
      "Synthetic private",
    );
  } finally {
    noise.mockRestore();
  }
});
