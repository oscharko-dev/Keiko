import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CapsuleDetailPage, { metadata } from "./page";

vi.mock("../[capsuleId]/capsule-detail", () => ({
  CapsuleDetail: () => <section aria-label="Knowledge Pod detail client" />,
}));

describe("CapsuleDetailPage", () => {
  it("exposes the static Knowledge Pod detail route shell and mounts the client", () => {
    render(<CapsuleDetailPage />);

    expect(metadata.title).toBe("Knowledge Pod Detail — Keiko");
    expect(screen.getByRole("main", { name: "Knowledge Pod detail" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Knowledge Pod detail client" })).toBeInTheDocument();
  });
});
