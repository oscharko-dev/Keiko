import { describe, expect, it, vi } from "vitest";
import MemoryConsolidationPage, { metadata } from "./page";

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((path: string): never => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

describe("MemoryConsolidationPage", () => {
  it("redirects to the Workspace because consolidation opens inside the MemoriaViva window", () => {
    expect(metadata.title).toBe("Keiko");
    expect(() => MemoryConsolidationPage()).toThrow("redirect:/");
    expect(redirectMock).toHaveBeenCalledWith("/");
  });
});
