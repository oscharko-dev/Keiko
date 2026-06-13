import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MemoryCenterDetailPage, { metadata } from "./page";

vi.mock("../../memoriaviva/detail/MemoryDetailClient", () => ({
  MemoryDetailClient: ({
    basePath,
    surfaceLabel,
  }: {
    readonly basePath?: string;
    readonly surfaceLabel?: string;
  }) => (
    <div
      data-testid="memory-detail-client"
      data-base-path={basePath}
      data-surface-label={surfaceLabel}
    />
  ),
}));

describe("/memory/detail page", () => {
  it("wires the Memory Center detail client to the /memory route", () => {
    render(<MemoryCenterDetailPage />);

    expect(metadata.title).toBe("Memory Center Detail — Keiko");
    expect(screen.getByLabelText("Memory Center detail")).toBeInTheDocument();
    expect(screen.getByTestId("memory-detail-client")).toHaveAttribute("data-base-path", "/memory");
    expect(screen.getByTestId("memory-detail-client")).toHaveAttribute(
      "data-surface-label",
      "Memory Center",
    );
  });
});
