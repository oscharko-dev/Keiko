import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MemoryDetailPage, { metadata } from "./page";

vi.mock("./MemoryDetailClient", () => ({
  MemoryDetailClient: () => <section aria-label="Memory detail client" />,
}));

describe("MemoryDetailPage", () => {
  it("exposes the detail route shell and mounts the detail client", () => {
    render(<MemoryDetailPage />);

    expect(metadata.title).toBe("MemoriaViva Detail — Keiko");
    expect(screen.getByRole("main", { name: "MemoriaViva detail" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Memory detail client" })).toBeInTheDocument();
  });
});
