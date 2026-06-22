import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KeikoDesktop } from "./KeikoDesktop";

vi.mock("./AppShell", () => ({
  AppShell: () => <section aria-label="Mock app shell" />,
}));

describe("KeikoDesktop", () => {
  it("mounts the workspace app shell", () => {
    render(<KeikoDesktop />);

    expect(screen.getByRole("region", { name: "Mock app shell" })).toBeInTheDocument();
  });
});
