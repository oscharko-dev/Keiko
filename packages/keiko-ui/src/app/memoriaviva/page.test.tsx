import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MemoryCenterPage, { metadata } from "./page";

vi.mock("./components/MemoryList", () => ({
  MemoryList: () => <section aria-label="Memory list client" />,
}));

describe("MemoryCenterPage", () => {
  it("exposes the MemoriaViva route shell and mounts the memory list client", () => {
    render(<MemoryCenterPage />);

    expect(metadata.title).toBe("MemoriaViva — Keiko");
    expect(screen.getByRole("main", { name: "MemoriaViva" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Memory list client" })).toBeInTheDocument();
  });
});
