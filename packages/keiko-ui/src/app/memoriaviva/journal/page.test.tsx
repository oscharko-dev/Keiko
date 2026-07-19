import { describe, expect, it, vi } from "vitest";
import MemoryJournalPage, { metadata } from "./page";

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((path: string): never => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

describe("MemoryJournalPage", () => {
  it("redirects to the Workspace because the Journal opens inside MemoriaViva", () => {
    expect(metadata.title).toBe("Keiko");
    expect(() => MemoryJournalPage()).toThrow("redirect:/");
    expect(redirectMock).toHaveBeenCalledWith("/");
  });
});
