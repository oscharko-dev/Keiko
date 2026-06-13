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
  MemoryDetail: ({
    id,
    basePath,
    surfaceLabel,
  }: {
    readonly id: string;
    readonly basePath?: string;
    readonly surfaceLabel?: string;
  }) => (
    <div
      data-testid="memory-detail"
      data-id={id}
      data-base-path={basePath}
      data-surface-label={surfaceLabel}
    />
  ),
}));

describe("MemoryDetailClient", () => {
  beforeEach(() => {
    navState.memoryId = null;
  });

  it("renders a route-aware missing-id empty state", () => {
    render(<MemoryDetailClient basePath="/memory" surfaceLabel="Memory Center" />);

    expect(screen.getByText("No memory selected")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Memory Center" })).toHaveAttribute(
      "href",
      "/memory",
    );
  });

  it("passes the route configuration to MemoryDetail when an id is present", () => {
    navState.memoryId = "mem-detail-client-1";

    render(<MemoryDetailClient basePath="/memory" surfaceLabel="Memory Center" />);

    expect(screen.getByTestId("memory-detail")).toHaveAttribute("data-id", "mem-detail-client-1");
    expect(screen.getByTestId("memory-detail")).toHaveAttribute("data-base-path", "/memory");
    expect(screen.getByTestId("memory-detail")).toHaveAttribute(
      "data-surface-label",
      "Memory Center",
    );
  });
});
