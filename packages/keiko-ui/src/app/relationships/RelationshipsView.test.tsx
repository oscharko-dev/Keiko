import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelationshipsView } from "./RelationshipsView";

vi.mock("../components/desktop/widgets/panels/useRelationshipActivityStream", () => ({
  useRelationshipActivityStream: () => ({
    activityMap: new Map([["rel-1", { level: "high" }]]),
    throughputMap: new Map([["rel-1", 3]]),
    animate: true,
  }),
}));

vi.mock("../components/desktop/widgets/panels/RelationshipListPanel", () => ({
  RelationshipListPanel: ({
    selectedId,
    onSelect,
    onFilterChange,
    animateBadges,
    highContrast,
  }: {
    readonly selectedId?: string;
    readonly onSelect: (id: string) => void;
    readonly onFilterChange: (patch: Record<string, string | undefined>) => void;
    readonly animateBadges: boolean;
    readonly highContrast: boolean;
  }) => (
    <section aria-label="relationship list">
      <span data-testid="list-selected">{selectedId ?? "none"}</span>
      <span data-testid="list-badges">{animateBadges ? "animated" : "static"}</span>
      <span data-testid="list-contrast">{highContrast ? "contrast" : "standard"}</span>
      <button type="button" onClick={() => onSelect("rel-1")}>
        Select rel 1
      </button>
      <button type="button" onClick={() => onFilterChange({ relFocus: "" })}>
        Empty focus filter
      </button>
    </section>
  ),
}));

vi.mock("../components/desktop/widgets/panels/RelationshipInspectorPanel", () => ({
  RelationshipInspectorPanel: ({
    relationshipId,
    densityMode,
    onClearFocus,
    onViewImpact,
    highContrast,
  }: {
    readonly relationshipId: string | null;
    readonly densityMode: string;
    readonly onClearFocus: () => void;
    readonly onViewImpact: (id: string) => void;
    readonly highContrast: boolean;
  }) => (
    <section aria-label="relationship inspector">
      <span data-testid="inspector-id">{relationshipId ?? "none"}</span>
      <span data-testid="inspector-density">{densityMode}</span>
      <span data-testid="inspector-contrast">{highContrast ? "contrast" : "standard"}</span>
      <button type="button" onClick={onClearFocus}>
        Clear focus
      </button>
      <button type="button" onClick={() => onViewImpact("impact-rel")}>
        View impact
      </button>
    </section>
  ),
}));

vi.mock("../components/desktop/widgets/panels/RelationshipHealthPanel", () => ({
  RelationshipHealthPanel: ({
    onSelectRelationship,
  }: {
    readonly onSelectRelationship: (id: string) => void;
  }) => (
    <section aria-label="relationship health">
      <button type="button" onClick={() => onSelectRelationship("health-rel")}>
        Select health finding
      </button>
    </section>
  ),
}));

vi.mock("../components/desktop/modals/RelationshipCreateDialog", () => ({
  RelationshipCreateDialog: ({
    onClose,
  }: {
    readonly onClose: (created: { readonly id: string } | null) => void;
  }) => (
    <div role="dialog" aria-modal="true" aria-label="create relationship">
      <button type="button" onClick={() => onClose({ id: "created-rel" })}>
        Create mocked relationship
      </button>
      <button type="button" onClick={() => onClose(null)}>
        Cancel mocked relationship
      </button>
    </div>
  ),
}));

function stubContrast(matches: boolean): void {
  vi.stubGlobal("matchMedia", () => ({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe("RelationshipsView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("coordinates selection, health findings, create-dialog completion, and focus clearing", () => {
    stubContrast(true);
    render(<RelationshipsView />);

    expect(screen.getByTestId("list-selected")).toHaveTextContent("none");
    expect(screen.getByTestId("inspector-id")).toHaveTextContent("none");
    expect(screen.getByTestId("inspector-density")).toHaveTextContent("minimal");
    expect(screen.getByTestId("list-contrast")).toHaveTextContent("contrast");

    fireEvent.click(screen.getByRole("button", { name: "Select rel 1" }));
    expect(screen.getByTestId("inspector-id")).toHaveTextContent("rel-1");

    fireEvent.click(screen.getByRole("button", { name: "View impact" }));
    expect(screen.getByTestId("list-selected")).toHaveTextContent("impact-rel");

    fireEvent.click(screen.getByRole("button", { name: "Toggle the graph health view" }));
    expect(screen.getByRole("button", { name: "Toggle the graph health view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Select health finding" }));
    expect(screen.queryByLabelText("relationship health")).toBeNull();
    expect(screen.getByTestId("inspector-id")).toHaveTextContent("health-rel");

    fireEvent.click(screen.getByRole("button", { name: "Create new relationship" }));
    fireEvent.click(screen.getByRole("button", { name: "Create mocked relationship" }));
    expect(screen.getByTestId("inspector-id")).toHaveTextContent("created-rel");

    fireEvent.click(screen.getByRole("button", { name: "Clear focus" }));
    expect(screen.getByTestId("inspector-id")).toHaveTextContent("none");
  });
});
