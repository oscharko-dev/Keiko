// Issue #542 (Epic #532) — RelationshipImpactCard tests.
//
// Presentational card: verifies both walk directions render, the empty-direction message, impacted
// endpoint listing, bounded rendering with a cap note, truncation notices, the loading state, and
// click-to-inspect navigation through the relationships-on-path disclosure.

import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RelationshipImpactCard } from "./RelationshipImpactCard";
import type { DependencyReport, ApiRelationship } from "../../../../relationships/api";

function node(id: string) {
  return { kind: "capsule" as const, id };
}

function rel(id: string): ApiRelationship {
  return {
    id,
    schemaVersion: "1",
    workspaceId: "local",
    type: "depends-on",
    source: { kind: "capsule", id: "cap-src" },
    target: { kind: "capsule", id: "cap-tgt" },
    lifecycle: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    etag: 1,
  };
}

function report(opts: {
  endpoints: string[];
  relationships?: ApiRelationship[];
  truncated?: boolean;
}): DependencyReport {
  return {
    rootRelationshipId: "rel-root",
    depthReached: 1,
    truncated: opts.truncated ?? false,
    relationships: opts.relationships ?? [],
    endpoints: opts.endpoints.map(node),
  };
}

describe("RelationshipImpactCard", () => {
  it("renders both walk directions", () => {
    render(
      <RelationshipImpactCard
        outgoing={report({ endpoints: ["origin"] })}
        incoming={report({ endpoints: ["origin"] })}
        onSelectRelationship={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: /Downstream impact/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Upstream impact/i })).toBeInTheDocument();
  });

  it("shows the empty-direction message when only the origin endpoint is present", () => {
    render(
      <RelationshipImpactCard
        outgoing={report({ endpoints: ["origin"] })}
        incoming={report({ endpoints: ["origin"] })}
        onSelectRelationship={vi.fn()}
      />,
    );
    expect(screen.getAllByText(/No further objects are affected/i).length).toBe(2);
  });

  it("lists impacted endpoints beyond the origin", () => {
    render(
      <RelationshipImpactCard
        outgoing={report({ endpoints: ["origin", "cap-x", "cap-y"] })}
        incoming={report({ endpoints: ["origin"] })}
        onSelectRelationship={vi.fn()}
      />,
    );
    expect(screen.getByText("capsule: cap-x")).toBeInTheDocument();
    expect(screen.getByText("capsule: cap-y")).toBeInTheDocument();
  });

  it("states truncation when the walk hit a bound", () => {
    render(
      <RelationshipImpactCard
        outgoing={report({ endpoints: ["origin", "cap-x"], truncated: true })}
        incoming={report({ endpoints: ["origin"] })}
        onSelectRelationship={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/hit a bound before the graph was fully traversed/i),
    ).toBeInTheDocument();
  });

  it("caps endpoint rendering at 50 and states the cap", () => {
    const endpoints = ["origin", ...Array.from({ length: 70 }, (_, i) => `cap-${String(i)}`)];
    render(
      <RelationshipImpactCard
        outgoing={report({ endpoints })}
        incoming={report({ endpoints: ["origin"] })}
        onSelectRelationship={vi.fn()}
      />,
    );
    expect(screen.getByText(/Showing the first 50 of 70 objects/i)).toBeInTheDocument();
  });

  it("navigates to a relationship on the path when clicked", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <RelationshipImpactCard
        outgoing={report({ endpoints: ["origin", "cap-x"], relationships: [rel("rel-path-1")] })}
        incoming={report({ endpoints: ["origin"] })}
        onSelectRelationship={onSelect}
      />,
    );
    // The relationships are behind a <details> disclosure; open it, then click the item.
    const downstream = screen
      .getByRole("heading", { name: /Downstream impact/i })
      .closest("section");
    expect(downstream).not.toBeNull();
    const summary = within(downstream as HTMLElement).getByText(/1 relationship on the path/i);
    await user.click(summary);
    await user.click(
      within(downstream as HTMLElement).getByRole("button", {
        name: /Inspect depends-on relationship/i,
      }),
    );
    expect(onSelect).toHaveBeenCalledWith("rel-path-1");
  });

  it("renders a loading state when a report is not yet available", () => {
    render(
      <RelationshipImpactCard outgoing={null} incoming={null} onSelectRelationship={vi.fn()} />,
    );
    expect(screen.getAllByText(/Loading…/i).length).toBe(2);
  });
});
