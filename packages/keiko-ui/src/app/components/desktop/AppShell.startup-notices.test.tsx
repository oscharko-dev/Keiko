import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { AppShellFrame, BrowserApprovalNotice, UpdateStartupNotice } from "./AppShell";

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
vi.mock("./browser/BrowserApprovalNotice", () => ({
  BrowserApprovalNotice: (): ReactNode => <button type="button">Approve browser control</button>,
}));
vi.mock("./update/UpdateStartupNotice", () => ({
  UpdateStartupNotice: ({
    ready,
    openUpdates,
  }: {
    readonly ready: boolean;
    readonly openUpdates: () => void;
  }): ReactNode =>
    ready ? (
      <button type="button" onClick={openUpdates}>
        Review update control
      </button>
    ) : null,
}));

it("retains both healthy loaded notices and the original update callback", async () => {
  const openUpdates = vi.fn();
  await act(async () => {
    render(
      <AppShellFrame>
        <button type="button">Existing desktop action</button>
        <BrowserApprovalNotice />
        <UpdateStartupNotice ready openUpdates={openUpdates} />
      </AppShellFrame>,
    );
  });
  expect(screen.getByRole("button", { name: "Existing desktop action" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Approve browser control" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Review update control" }));
  expect(openUpdates).toHaveBeenCalledOnce();
  expect(reportClientDiagnostic).not.toHaveBeenCalled();
});
