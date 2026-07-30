// Issue #542 (Epic #532) — RelationshipImpactCard tests.
//
// Presentational card: verifies both walk directions render, the empty-direction message, impacted
// endpoint listing, bounded rendering with a cap note, truncation notices, the loading state, and
// click-to-inspect navigation through the relationships-on-path disclosure.

import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

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

// The wire report ALWAYS carries the origin relationship and BOTH of its endpoints (the store's
// runWalkFromOrigin appends whichever the seed did not cover). Fixtures below mirror that shape
// instead of the sanitised "endpoints[0] is the origin" shape the card used to assume.
const ORIGIN = {
  relationshipId: "rel-root",
  source: { kind: "capsule" as const, id: "cap-src" },
  target: { kind: "capsule" as const, id: "cap-tgt" },
};

function originRel(): ApiRelationship {
  return { ...rel("rel-root"), source: ORIGIN.source, target: ORIGIN.target };
}

// The smallest honest report: the origin relationship and its two endpoints, nothing else.
const ORIGIN_ONLY_REPORT = report({
  endpoints: ["cap-tgt", "cap-src"],
  relationships: [originRel()],
});

describe("RelationshipImpactCard impacted-set arithmetic", () => {
  it("excludes the origin relationship and BOTH origin endpoints from the impacted set", () => {
    render(
      <RelationshipImpactCard
        // Downstream walk: seeded from cap-tgt, reaches cap-x, then appends cap-src.
        outgoing={report({
          endpoints: ["cap-tgt", "cap-x", "cap-src"],
          relationships: [originRel(), rel("rel-x")],
        })}
        // Upstream walk: nothing beyond the origin's own endpoints — a genuine zero.
        incoming={report({ endpoints: ["cap-src", "cap-tgt"], relationships: [originRel()] })}
        origin={ORIGIN}
        error={null}
        onSelectRelationship={vi.fn()}
      />,
    );
    const downstream = within(screen.getByTestId("impact-downstream"));
    expect(downstream.getByText("capsule: cap-x")).toBeInTheDocument();
    expect(downstream.queryByText("capsule: cap-src")).toBeNull();
    expect(downstream.queryByText("capsule: cap-tgt")).toBeNull();
    // One relationship on the path — the origin itself is not on its own path.
    expect(downstream.getByText(/1 relationship on the path/i)).toBeInTheDocument();
    expect(
      within(screen.getByTestId("impact-upstream")).getByText(/No further objects are affected/i),
    ).toBeInTheDocument();
  });

  it("states that the walk failed instead of showing a permanent loading row", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(
      <RelationshipImpactCard
        outgoing={null}
        incoming={null}
        origin={ORIGIN}
        error="Server error: walk unavailable"
        onRetryImpact={onRetry}
        onSelectRelationship={vi.fn()}
      />,
    );
    expect(screen.getByText(/walk unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/Loading…/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("RelationshipImpactCard", () => {
  it("renders both walk directions", () => {
    render(
      <RelationshipImpactCard
        outgoing={ORIGIN_ONLY_REPORT}
        incoming={ORIGIN_ONLY_REPORT}
        origin={ORIGIN}
        onSelectRelationship={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: /Downstream impact/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Upstream impact/i })).toBeInTheDocument();
  });

  it("shows the empty-direction message when only the origin endpoints are present", () => {
    render(
      <RelationshipImpactCard
        outgoing={ORIGIN_ONLY_REPORT}
        incoming={ORIGIN_ONLY_REPORT}
        origin={ORIGIN}
        onSelectRelationship={vi.fn()}
      />,
    );
    expect(screen.getAllByText(/No further objects are affected/i)).toHaveLength(2);
  });

  it("lists impacted endpoints beyond the origin", () => {
    render(
      <RelationshipImpactCard
        outgoing={report({ endpoints: ["cap-tgt", "cap-x", "cap-y", "cap-src"] })}
        incoming={ORIGIN_ONLY_REPORT}
        origin={ORIGIN}
        onSelectRelationship={vi.fn()}
      />,
    );
    expect(screen.getByText("capsule: cap-x")).toBeInTheDocument();
    expect(screen.getByText("capsule: cap-y")).toBeInTheDocument();
  });

  it("states truncation when the walk hit a bound", () => {
    render(
      <RelationshipImpactCard
        outgoing={report({ endpoints: ["cap-tgt", "cap-x", "cap-src"], truncated: true })}
        incoming={ORIGIN_ONLY_REPORT}
        origin={ORIGIN}
        onSelectRelationship={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/hit a bound before the graph was fully traversed/i),
    ).toBeInTheDocument();
  });

  it("caps endpoint rendering at 50 and states the cap", () => {
    const endpoints = [
      "cap-tgt",
      ...Array.from({ length: 70 }, (_, i) => `cap-${String(i)}`),
      "cap-src",
    ];
    render(
      <RelationshipImpactCard
        outgoing={report({ endpoints })}
        incoming={ORIGIN_ONLY_REPORT}
        origin={ORIGIN}
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
        outgoing={report({
          endpoints: ["cap-tgt", "cap-x", "cap-src"],
          relationships: [originRel(), rel("rel-path-1")],
        })}
        incoming={ORIGIN_ONLY_REPORT}
        origin={ORIGIN}
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
      <RelationshipImpactCard
        outgoing={null}
        incoming={null}
        origin={ORIGIN}
        onSelectRelationship={vi.fn()}
      />,
    );
    expect(screen.getAllByText(/Loading…/i)).toHaveLength(2);
  });

  it("passes axe on a populated impact state (GEN-UI-TEST-GAP-009)", async () => {
    const { container } = render(
      <RelationshipImpactCard
        outgoing={report({
          endpoints: ["cap-tgt", "cap-x", "cap-y", "cap-src"],
          relationships: [originRel(), rel("rel-a")],
        })}
        incoming={report({ endpoints: ["cap-src", "cap-z", "cap-tgt"] })}
        origin={ORIGIN}
        onSelectRelationship={vi.fn()}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
