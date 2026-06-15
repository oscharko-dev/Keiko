import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AuditResultEntry } from "@/lib/types";
import { ResourceLimitDecisionsTable } from "./ResourceLimitDecisionsTable";

function result(patch: Partial<AuditResultEntry>): AuditResultEntry {
  return {
    kind: "command",
    command: "npm test",
    status: "passed",
    durationMs: 100,
    output: "",
    appliedLimits: [],
    ...patch,
  } as AuditResultEntry;
}

describe("ResourceLimitDecisionsTable", () => {
  it("renders nothing when verification results do not carry applied limits", () => {
    const { container } = render(
      <ResourceLimitDecisionsTable results={[result({ command: "npm test" })]} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders enforced, unenforced and breached resource-limit decisions accessibly", () => {
    render(
      <ResourceLimitDecisionsTable
        results={[
          result({
            command: "npm test",
            appliedLimits: [
              { dimension: "wall-time", limit: 30_000, enforced: true, breached: false },
              {
                dimension: "output-size",
                limit: 2_000,
                enforced: true,
                breached: true,
                note: "truncated",
              },
            ],
          }),
          result({
            command: "npm run lint",
            appliedLimits: [
              { dimension: "memory", limit: 512, enforced: false, breached: undefined },
            ],
          }),
        ]}
      />,
    );

    expect(screen.getByText("Resource-limit decisions")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Step",
      "Dimension",
      "Limit",
      "Enforced",
      "Breached",
    ]);

    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(4);

    expect(within(rows[1] as HTMLElement).getByText("npm test")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("wall-time")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("30000")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("Yes")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("No")).toBeInTheDocument();

    expect(within(rows[2] as HTMLElement).getByText("output-size")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("Yes (breached)")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText(/truncated/)).toBeInTheDocument();
    expect(rows[2]).toHaveClass("bg-red-950/20");

    expect(within(rows[3] as HTMLElement).getByText("npm run lint")).toBeInTheDocument();
    expect(within(rows[3] as HTMLElement).getByText("memory")).toBeInTheDocument();
    expect(within(rows[3] as HTMLElement).getAllByText("No")).toHaveLength(2);
  });
});
