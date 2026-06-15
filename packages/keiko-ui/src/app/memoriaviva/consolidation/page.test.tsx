import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MemoryConsolidationPage, { metadata } from "./page";

vi.mock("../components/MemoryConsolidation", () => ({
  MemoryConsolidation: () => <section aria-label="Memory consolidation client" />,
}));

describe("MemoryConsolidationPage", () => {
  it("exposes the consolidation route shell and mounts the consolidation client", () => {
    render(<MemoryConsolidationPage />);

    expect(metadata.title).toBe("MemoriaViva Consolidation — Keiko");
    expect(screen.getByRole("main", { name: "MemoriaViva consolidation" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Memory consolidation client" })).toBeInTheDocument();
  });
});
