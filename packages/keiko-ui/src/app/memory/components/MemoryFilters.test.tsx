// Issue #211 — tests for MemoryFilters: chip rendering, toggle behaviour, axis independence.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_FILTERS, MemoryFilters } from "./MemoryFilters";
import type { MemoryFilterState } from "./MemoryFilters";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderFilters(filters: MemoryFilterState = EMPTY_FILTERS, onChange = vi.fn()) {
  render(<MemoryFilters filters={filters} onChange={onChange} />);
  return { onChange };
}

// ---------------------------------------------------------------------------
// 1. ChipGroup landmark presence
// ---------------------------------------------------------------------------

describe("MemoryFilters — landmark groups", () => {
  it("renders four ChipGroup role=group landmarks", () => {
    renderFilters();
    const groups = screen.getAllByRole("group");
    expect(groups).toHaveLength(4);
  });

  it('scope group has aria-label "Filter by Scope"', () => {
    renderFilters();
    expect(screen.getByRole("group", { name: "Filter by Scope" })).toBeInTheDocument();
  });

  it('type group has aria-label "Filter by Type"', () => {
    renderFilters();
    expect(screen.getByRole("group", { name: "Filter by Type" })).toBeInTheDocument();
  });

  it('status group has aria-label "Filter by Status"', () => {
    renderFilters();
    expect(screen.getByRole("group", { name: "Filter by Status" })).toBeInTheDocument();
  });

  it('sensitivity group has aria-label "Filter by Sensitivity"', () => {
    renderFilters();
    expect(screen.getByRole("group", { name: "Filter by Sensitivity" })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 2. Inactive chip has aria-pressed=false
// ---------------------------------------------------------------------------

describe("MemoryFilters — inactive chip state", () => {
  it('status chip "Proposed" has aria-pressed=false when status filter is empty', () => {
    renderFilters();
    const btn = screen.getByRole("button", { name: "Proposed" });
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });

  it('scope chip "User" has aria-pressed=false when scope filter is empty', () => {
    renderFilters();
    const btn = screen.getByRole("button", { name: "User" });
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });

  it('sensitivity chip "Public" has aria-pressed=false when sensitivity filter is empty', () => {
    renderFilters();
    const btn = screen.getByRole("button", { name: "Public" });
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });
});

// ---------------------------------------------------------------------------
// 3. Toggle ON — clicking adds chip value to the axis
// ---------------------------------------------------------------------------

describe("MemoryFilters — toggle on", () => {
  it("clicking status chip 'Proposed' calls onChange with status=['proposed']", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderFilters(EMPTY_FILTERS, onChange);

    await user.click(screen.getByRole("button", { name: "Proposed" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const [next] = onChange.mock.calls[0] as [MemoryFilterState];
    expect(next.status).toContain("proposed");
    expect(next.status).toHaveLength(1);
  });

  it("clicking scope chip 'Global' calls onChange with scope=['global']", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderFilters(EMPTY_FILTERS, onChange);

    await user.click(screen.getByRole("button", { name: "Global" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const [next] = onChange.mock.calls[0] as [MemoryFilterState];
    expect(next.scope).toContain("global");
    expect(next.scope).toHaveLength(1);
  });

  it("clicking sensitivity chip 'Confidential' calls onChange with sensitivity=['confidential']", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderFilters(EMPTY_FILTERS, onChange);

    await user.click(screen.getByRole("button", { name: "Confidential" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const [next] = onChange.mock.calls[0] as [MemoryFilterState];
    expect(next.sensitivity).toContain("confidential");
    expect(next.sensitivity).toHaveLength(1);
  });

  it("clicking type chip 'Preference' calls onChange with type=['preference']", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderFilters(EMPTY_FILTERS, onChange);

    await user.click(screen.getByRole("button", { name: "Preference" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const [next] = onChange.mock.calls[0] as [MemoryFilterState];
    expect(next.type).toContain("preference");
    expect(next.type).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Toggle OFF — clicking an active chip removes it
// ---------------------------------------------------------------------------

describe("MemoryFilters — toggle off", () => {
  it("clicking active status chip 'Proposed' calls onChange with status=[]", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderFilters({ ...EMPTY_FILTERS, status: ["proposed"] }, onChange);

    await user.click(screen.getByRole("button", { name: "Proposed" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const [next] = onChange.mock.calls[0] as [MemoryFilterState];
    expect(next.status).not.toContain("proposed");
    expect(next.status).toHaveLength(0);
  });

  it("clicking active scope chip 'User' removes it from scope", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderFilters({ ...EMPTY_FILTERS, scope: ["user"] }, onChange);

    await user.click(screen.getByRole("button", { name: "User" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const [next] = onChange.mock.calls[0] as [MemoryFilterState];
    expect(next.scope).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Axis independence — toggling one axis does not perturb others
// ---------------------------------------------------------------------------

describe("MemoryFilters — axis independence", () => {
  it("toggling a status chip preserves scope, type, and sensitivity axes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const initial: MemoryFilterState = {
      scope: ["global"],
      type: ["preference"],
      status: [],
      sensitivity: ["public"],
    };
    renderFilters(initial, onChange);

    await user.click(screen.getByRole("button", { name: "Accepted" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const [next] = onChange.mock.calls[0] as [MemoryFilterState];
    expect(next.scope).toEqual(["global"]);
    expect(next.type).toEqual(["preference"]);
    expect(next.sensitivity).toEqual(["public"]);
    expect(next.status).toContain("accepted");
  });

  it("toggling a scope chip preserves status, type, and sensitivity axes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const initial: MemoryFilterState = {
      scope: [],
      type: ["episodic"],
      status: ["proposed"],
      sensitivity: ["confidential"],
    };
    renderFilters(initial, onChange);

    await user.click(screen.getByRole("button", { name: "Workspace" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const [next] = onChange.mock.calls[0] as [MemoryFilterState];
    expect(next.type).toEqual(["episodic"]);
    expect(next.status).toEqual(["proposed"]);
    expect(next.sensitivity).toEqual(["confidential"]);
    expect(next.scope).toContain("workspace");
  });

  it("toggling a sensitivity chip preserves all other axes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const initial: MemoryFilterState = {
      scope: ["user"],
      type: ["decision"],
      status: ["accepted"],
      sensitivity: [],
    };
    renderFilters(initial, onChange);

    await user.click(screen.getByRole("button", { name: "Restricted" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const [next] = onChange.mock.calls[0] as [MemoryFilterState];
    expect(next.scope).toEqual(["user"]);
    expect(next.type).toEqual(["decision"]);
    expect(next.status).toEqual(["accepted"]);
    expect(next.sensitivity).toContain("restricted");
  });
});

// ---------------------------------------------------------------------------
// 6. Active chip visual state — aria-pressed=true and data-active="true"
// ---------------------------------------------------------------------------

describe("MemoryFilters — active chip visual state", () => {
  it('active status chip renders with aria-pressed="true"', () => {
    renderFilters({ ...EMPTY_FILTERS, status: ["proposed"] });
    const btn = screen.getByRole("button", { name: "Proposed" });
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });

  it('active status chip renders with data-active="true"', () => {
    renderFilters({ ...EMPTY_FILTERS, status: ["accepted"] });
    const btn = screen.getByRole("button", { name: "Accepted" });
    expect(btn).toHaveAttribute("data-active", "true");
  });

  it('inactive chip renders with data-active="false"', () => {
    renderFilters({ ...EMPTY_FILTERS, status: ["proposed"] });
    const btn = screen.getByRole("button", { name: "Accepted" });
    expect(btn).toHaveAttribute("data-active", "false");
  });

  it('active scope chip renders with aria-pressed="true"', () => {
    renderFilters({ ...EMPTY_FILTERS, scope: ["workspace"] });
    const btn = screen.getByRole("button", { name: "Workspace" });
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });

  it('active sensitivity chip renders with aria-pressed="true"', () => {
    renderFilters({ ...EMPTY_FILTERS, sensitivity: ["public"] });
    const btn = screen.getByRole("button", { name: "Public" });
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });
});

// ---------------------------------------------------------------------------
// 7. Multi-select within one axis
// ---------------------------------------------------------------------------

describe("MemoryFilters — multi-select", () => {
  it("clicking 'Accepted' when status=['proposed'] yields status containing both values", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderFilters({ ...EMPTY_FILTERS, status: ["proposed"] }, onChange);

    await user.click(screen.getByRole("button", { name: "Accepted" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const [next] = onChange.mock.calls[0] as [MemoryFilterState];
    expect(next.status).toHaveLength(2);
    expect(next.status).toContain("proposed");
    expect(next.status).toContain("accepted");
  });

  it("clicking two scope chips yields both in scope axis", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<MemoryFilters filters={EMPTY_FILTERS} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "User" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const [afterFirst] = onChange.mock.calls[0] as [MemoryFilterState];
    expect(afterFirst.scope).toContain("user");

    rerender(<MemoryFilters filters={afterFirst} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Global" }));
    expect(onChange).toHaveBeenCalledTimes(2);
    const [afterSecond] = onChange.mock.calls[1] as [MemoryFilterState];
    expect(afterSecond.scope).toContain("user");
    expect(afterSecond.scope).toContain("global");
    expect(afterSecond.scope).toHaveLength(2);
  });

  it("clicking all three sensitivity chips results in three values", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderFilters({ ...EMPTY_FILTERS, sensitivity: ["public", "confidential"] }, onChange);

    await user.click(screen.getByRole("button", { name: "Restricted" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const [next] = onChange.mock.calls[0] as [MemoryFilterState];
    expect(next.sensitivity).toHaveLength(3);
    expect(next.sensitivity).toContain("public");
    expect(next.sensitivity).toContain("confidential");
    expect(next.sensitivity).toContain("restricted");
  });
});

// ---------------------------------------------------------------------------
// 8. Edge case — onChange NOT called on mount
// ---------------------------------------------------------------------------

describe("MemoryFilters — no fire on render", () => {
  it("does not call onChange on initial render with EMPTY_FILTERS", () => {
    const onChange = vi.fn();
    renderFilters(EMPTY_FILTERS, onChange);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not call onChange on initial render with pre-populated filters", () => {
    const onChange = vi.fn();
    renderFilters(
      { scope: ["global"], type: ["preference"], status: ["accepted"], sensitivity: ["public"] },
      onChange,
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 9. All chip labels are rendered
// ---------------------------------------------------------------------------

describe("MemoryFilters — chip label rendering", () => {
  it("renders all scope chip labels", () => {
    renderFilters();
    expect(screen.getByRole("button", { name: "User" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Workflow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Global" })).toBeInTheDocument();
  });

  it("renders all status chip labels", () => {
    renderFilters();
    expect(screen.getByRole("button", { name: "Proposed" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accepted" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rejected" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Superseded" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archived" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Forgotten" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Conflicted" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expired" })).toBeInTheDocument();
  });

  it("renders all sensitivity chip labels", () => {
    renderFilters();
    expect(screen.getByRole("button", { name: "Public" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confidential" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restricted" })).toBeInTheDocument();
  });
});
