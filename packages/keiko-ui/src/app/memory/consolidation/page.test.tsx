import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MemoryCenterConsolidationPage, { metadata } from "./page";

vi.mock("../../memoriaviva/components/MemoryConsolidation", () => ({
  MemoryConsolidation: ({
    basePath,
    surfaceLabel,
  }: {
    readonly basePath?: string;
    readonly surfaceLabel?: string;
  }) => (
    <div
      data-testid="memory-consolidation"
      data-base-path={basePath}
      data-surface-label={surfaceLabel}
    />
  ),
}));

describe("/memory/consolidation page", () => {
  it("wires the consolidation surface to the /memory route", () => {
    render(<MemoryCenterConsolidationPage />);

    expect(metadata.title).toBe("Memory Center Consolidation — Keiko");
    expect(screen.getByLabelText("Memory Center consolidation")).toBeInTheDocument();
    expect(screen.getByTestId("memory-consolidation")).toHaveAttribute("data-base-path", "/memory");
    expect(screen.getByTestId("memory-consolidation")).toHaveAttribute(
      "data-surface-label",
      "Memory Center",
    );
  });
});
