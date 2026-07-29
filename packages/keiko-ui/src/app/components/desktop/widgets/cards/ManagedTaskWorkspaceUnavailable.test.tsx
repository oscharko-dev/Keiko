import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ManagedTaskWorkspaceUnavailable } from "./ManagedTaskWorkspaceUnavailable";

vi.mock("@/lib/i18n", () => ({
  useTranslate:
    () =>
    (key: string): string =>
      key,
}));

describe("ManagedTaskWorkspaceUnavailable", () => {
  it("shows retry outside the checking state and invokes it", () => {
    const onRetry = vi.fn();
    render(<ManagedTaskWorkspaceUnavailable access="unavailable" onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: "editor.taskWorkspaceAccess.retry" }));

    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("hides retry while access is being checked", () => {
    render(<ManagedTaskWorkspaceUnavailable access="checking" onRetry={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "editor.taskWorkspaceAccess.retry" })).toBeNull();
    expect(screen.getByText("editor.taskWorkspaceAccess.checking")).toBeInTheDocument();
  });
});
