import { describe, expect, it, vi } from "vitest";
import MemoryDetailPage, { metadata } from "./page";

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((path: string): never => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

describe("MemoryDetailPage", () => {
  it("redirects to the Workspace because MemoriaViva detail opens inside the Workspace window", () => {
    expect(metadata.title).toBe("Keiko");
    expect(() => MemoryDetailPage()).toThrow("redirect:/");
    expect(redirectMock).toHaveBeenCalledWith("/");
  });
});
