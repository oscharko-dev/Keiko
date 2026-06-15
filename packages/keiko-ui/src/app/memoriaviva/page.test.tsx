import { describe, expect, it, vi } from "vitest";
import MemoryCenterPage, { metadata } from "./page";

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((path: string): never => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

describe("MemoryCenterPage", () => {
  it("redirects to the Workspace because MemoriaViva opens as a Workspace window", () => {
    expect(metadata.title).toBe("Keiko");
    expect(() => MemoryCenterPage()).toThrow("redirect:/");
    expect(redirectMock).toHaveBeenCalledWith("/");
  });
});
