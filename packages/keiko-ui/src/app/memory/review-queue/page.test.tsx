import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MemoryCenterReviewQueuePage, { metadata } from "./page";

vi.mock("../../memoriaviva/components/ReviewQueue", () => ({
  ReviewQueue: ({
    basePath,
    surfaceLabel,
  }: {
    readonly basePath?: string;
    readonly surfaceLabel?: string;
  }) => (
    <div
      data-testid="memory-review-queue"
      data-base-path={basePath}
      data-surface-label={surfaceLabel}
    />
  ),
}));

describe("/memory/review-queue page", () => {
  it("wires the review queue to the /memory route", () => {
    render(<MemoryCenterReviewQueuePage />);

    expect(metadata.title).toBe("Memory Center Review Queue — Keiko");
    expect(screen.getByLabelText("Memory Center review queue")).toBeInTheDocument();
    expect(screen.getByTestId("memory-review-queue")).toHaveAttribute("data-base-path", "/memory");
    expect(screen.getByTestId("memory-review-queue")).toHaveAttribute(
      "data-surface-label",
      "Memory Center",
    );
  });
});
