import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MemoryReviewQueuePage, { metadata } from "./page";

vi.mock("../components/ReviewQueue", () => ({
  ReviewQueue: () => <section aria-label="Memory review queue client" />,
}));

describe("MemoryReviewQueuePage", () => {
  it("exposes the review queue route shell and mounts the queue client", () => {
    render(<MemoryReviewQueuePage />);

    expect(metadata.title).toBe("MemoriaViva Review Queue — Keiko");
    expect(screen.getByRole("main", { name: "MemoriaViva review queue" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Memory review queue client" })).toBeInTheDocument();
  });
});
