import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MemoryCenterPage, { metadata } from "./page";

vi.mock("../memoriaviva/components/MemoryList", () => ({
  MemoryList: ({
    basePath,
    surfaceLabel,
  }: {
    readonly basePath?: string;
    readonly surfaceLabel?: string;
  }) => (
    <div data-testid="memory-list" data-base-path={basePath} data-surface-label={surfaceLabel} />
  ),
}));

describe("/memory page", () => {
  it("wires the Memory Center surface label and route base path", () => {
    render(<MemoryCenterPage />);

    expect(metadata.title).toBe("Memory Center — Keiko");
    expect(screen.getByLabelText("Memory Center")).toBeInTheDocument();
    expect(screen.getByTestId("memory-list")).toHaveAttribute("data-base-path", "/memory");
    expect(screen.getByTestId("memory-list")).toHaveAttribute(
      "data-surface-label",
      "Memory Center",
    );
  });
});
