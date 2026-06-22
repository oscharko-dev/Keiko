import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDetailClient } from "./MemoryDetailClient";

const navState = vi.hoisted(() => ({ memoryId: null as string | null }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: (key: string) => (key === "id" ? navState.memoryId : null),
  }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("../components/MemoryDetail", () => ({
  MemoryDetail: ({ id }: { readonly id: string }) => (
    <div data-testid="memory-detail" data-id={id} />
  ),
}));

describe("MemoryDetailClient", () => {
  beforeEach(() => {
    navState.memoryId = null;
  });

  it("renders a MemoriaViva missing-id empty state", () => {
    render(<MemoryDetailClient />);

    expect(screen.getByText("No memory selected")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to MemoriaViva" })).toHaveAttribute(
      "href",
      "/memoriaviva",
    );
  });

  it("passes the selected id to the MemoriaViva detail component", () => {
    navState.memoryId = "mem-detail-client-1";

    render(<MemoryDetailClient />);

    expect(screen.getByTestId("memory-detail")).toHaveAttribute("data-id", "mem-detail-client-1");
  });
});
