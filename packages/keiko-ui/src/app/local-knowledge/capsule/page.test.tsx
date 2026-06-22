import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CapsuleDetailPage, { metadata } from "./page";

vi.mock("../[capsuleId]/capsule-detail", () => ({
  CapsuleDetail: () => <section aria-label="Capsule detail client" />,
}));

describe("CapsuleDetailPage", () => {
  it("exposes the static capsule detail route shell and mounts the capsule client", () => {
    render(<CapsuleDetailPage />);

    expect(metadata.title).toBe("Capsule Detail — Keiko");
    expect(screen.getByRole("main", { name: "Capsule detail" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Capsule detail client" })).toBeInTheDocument();
  });
});
