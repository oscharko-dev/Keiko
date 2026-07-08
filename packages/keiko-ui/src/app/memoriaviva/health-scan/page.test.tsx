import { describe, expect, it, vi } from "vitest";
import MemoryHealthScanPage, { metadata } from "./page";

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((path: string): never => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

describe("MemoryHealthScanPage", () => {
  it("redirects to the Workspace because the health scan opens inside the MemoriaViva window", () => {
    expect(metadata.title).toBe("Keiko");
    expect(() => MemoryHealthScanPage()).toThrow("redirect:/");
    expect(redirectMock).toHaveBeenCalledWith("/");
  });
});
