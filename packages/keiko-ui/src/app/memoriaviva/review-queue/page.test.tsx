import { describe, expect, it, vi } from "vitest";
import MemoryReviewQueuePage, { metadata } from "./page";

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((path: string): never => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

describe("MemoryReviewQueuePage", () => {
  it("redirects to the Workspace because review queue opens inside the MemoriaViva window", () => {
    expect(metadata.title).toBe("Keiko");
    expect(() => MemoryReviewQueuePage()).toThrow("redirect:/");
    expect(redirectMock).toHaveBeenCalledWith("/");
  });
});
