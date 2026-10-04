import { act, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { createSupportReport, createSupportReportDownload } from "@/lib/support-report-api";
import { canonicalSupportReportFixture } from "@/test-utils/support-report-fixture";
import { SupportReportButton, resetSupportReportOutcomesForTests } from "./SupportReportButton";

vi.mock("@/lib/support-report-api", async (original) => ({
  ...(await original<typeof import("@/lib/support-report-api")>()),
  createSupportReport: vi.fn(),
  createSupportReportDownload: vi.fn(() => ({ href: "blob:prepared", dispose: vi.fn() })),
}));
vi.mock("@/lib/client-diagnostics", () => ({
  reportClientDiagnostic: vi.fn(),
  retainedClientDiagnosticFailure: vi.fn(() => undefined),
}));
afterEach(() => {
  act(() => resetSupportReportOutcomesForTests());
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function click(view: ReturnType<typeof render>, name: string): Promise<void> {
  await act(async () => within(view.container).getByRole("button", { name }).click());
}

it("keeps a successfully regenerated report newest under retained-entry pressure", async () => {
  const canonical = await canonicalSupportReportFixture();
  vi.mocked(createSupportReport).mockResolvedValue(canonical);
  const firstDispose = vi.fn();
  const secondDispose = vi.fn();
  const replacementDispose = vi.fn();
  vi.mocked(createSupportReportDownload)
    .mockReturnValueOnce({ href: "blob:first", dispose: firstDispose })
    .mockReturnValueOnce({ href: "blob:second", dispose: secondDispose });
  for (let index = 0; index < 128; index++) {
    const view = render(<SupportReportButton correlationId={`recency-${String(index)}`} />);
    await click(view, "Create error report");
    expect(within(view.container).getByRole("link", { name: "Download report" })).toBeVisible();
    view.unmount();
  }
  const first = render(<SupportReportButton correlationId="recency-0" />);
  vi.mocked(createSupportReportDownload).mockReturnValueOnce({
    href: "blob:regenerated",
    dispose: replacementDispose,
  });
  await click(first, "Regenerate report");
  const newest = render(<SupportReportButton correlationId="recency-new" />);
  await click(newest, "Create error report");
  expect(firstDispose).toHaveBeenCalledOnce();
  expect(secondDispose).toHaveBeenCalledOnce();
  expect(replacementDispose).not.toHaveBeenCalled();
  expect(within(first.container).getByRole("link", { name: "Download report" })).toHaveAttribute(
    "href",
    "blob:regenerated",
  );
});

it("does not count unfulfilled requests against retained-report capacity", async () => {
  const canonical = await canonicalSupportReportFixture();
  vi.mocked(createSupportReport).mockResolvedValueOnce(canonical);
  const dispose = vi.fn();
  vi.mocked(createSupportReportDownload).mockReturnValueOnce({ href: "blob:retained", dispose });
  const retained = render(<SupportReportButton correlationId="retained-among-pending" />);
  await click(retained, "Create error report");
  vi.mocked(createSupportReport).mockImplementation(() => new Promise(() => undefined));
  const pending = [];
  for (let index = 0; index < 128; index++) {
    const view = render(<SupportReportButton correlationId={`pending-only-${String(index)}`} />);
    pending.push(view);
    await click(view, "Create error report");
    expect(within(view.container).getByRole("button", { name: "Creating report…" })).toBeDisabled();
  }
  vi.mocked(createSupportReport).mockResolvedValueOnce(canonical);
  const another = render(<SupportReportButton correlationId="another-retained" />);
  await click(another, "Create error report");
  expect(dispose).not.toHaveBeenCalled();
  expect(within(retained.container).getByRole("link", { name: "Download report" })).toHaveAttribute(
    "href",
    "blob:retained",
  );
  for (const view of pending) view.unmount();
});

it("does not abort the successfully completing regeneration when replacing its old download", async () => {
  const canonical = await canonicalSupportReportFixture();
  vi.mocked(createSupportReport).mockResolvedValue(canonical);
  const dispose = vi.fn();
  vi.mocked(createSupportReportDownload).mockReturnValueOnce({ href: "blob:prior", dispose });
  const view = render(<SupportReportButton correlationId="successful-regeneration-signal" />);
  await click(view, "Create error report");
  await click(view, "Regenerate report");
  expect(vi.mocked(createSupportReport).mock.calls.at(-1)?.[1]?.aborted).toBe(false);
  expect(dispose).toHaveBeenCalledOnce();
  expect(screen.getByRole("link", { name: "Download report" })).toBeVisible();
});

it("shows a new failed regeneration after expiry without reviving the expired link", async () => {
  const canonical = await canonicalSupportReportFixture();
  vi.useFakeTimers();
  vi.mocked(createSupportReport).mockResolvedValueOnce(canonical);
  const dispose = vi.fn();
  vi.mocked(createSupportReportDownload).mockReturnValueOnce({
    href: "/api/prior-expired",
    expiresAtMs: Date.now() + 1_000,
    dispose,
  });
  const view = render(<SupportReportButton correlationId="retry-after-expiry" />);
  await click(view, "Create error report");
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(screen.getByRole("status")).toHaveTextContent("Download link expired");
  vi.mocked(createSupportReport).mockRejectedValueOnce(
    new ApiError("RATE_LIMITED", "private", 429),
  );
  await click(view, "Regenerate report");
  expect(screen.getByRole("status")).toHaveTextContent("Please wait a minute");
  expect(screen.queryByRole("link", { name: "Download report" })).toBeNull();
  expect(dispose).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Regenerate report" })).toBeEnabled();
});
