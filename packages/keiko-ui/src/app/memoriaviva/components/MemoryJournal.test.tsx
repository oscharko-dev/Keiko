import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { MemoryId } from "@oscharko-dev/keiko-contracts";
import type { MemoryRecentCapture, MemoryRecentCapturesResponse } from "@/lib/memory-api";
import { MemoryJournal, orderJournalCaptures } from "./MemoryJournal";

function memoryId(value: string): MemoryId {
  return value as MemoryId;
}

function makeCapture(
  id: string,
  occurredAt: number,
  overrides: Partial<MemoryRecentCapture> = {},
): MemoryRecentCapture {
  return {
    outcome: "auto-accepted",
    scope: { kind: "global" },
    mode: "autonomous-delivery",
    provenance: {
      initiatorSurface: "conversation-center",
      sourceKind: "system-default",
    },
    occurredAt,
    reason: "governance-auto-accepted",
    memoryId: memoryId(id),
    bodyExcerpt: `Memory ${id}`,
    ...overrides,
  };
}

function response(captures: readonly MemoryRecentCapture[]): MemoryRecentCapturesResponse {
  return { captures, total: captures.length, limit: 50, since: 0, order: "desc" };
}

function fetchWith(captures: readonly MemoryRecentCapture[]) {
  return vi.fn().mockResolvedValue(response(captures));
}

function renderJournal(
  captures: readonly MemoryRecentCapture[],
  overrides: Partial<React.ComponentProps<typeof MemoryJournal>> = {},
) {
  return render(
    <MemoryJournal onBack={vi.fn()} fetchRecentCapturesImpl={fetchWith(captures)} {...overrides} />,
  );
}

describe("MemoryJournal loading and ordering", () => {
  it("renders the empty and error states with a single Journal status region", async () => {
    const { rerender } = renderJournal([]);
    expect(await screen.findByTestId("memory-journal-empty")).toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(1);

    rerender(
      <MemoryJournal
        onBack={vi.fn()}
        fetchRecentCapturesImpl={vi.fn().mockRejectedValue(new Error("network unavailable"))}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("network unavailable");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("sorts arbitrary input newest first and renders refused decisions without content or actions", async () => {
    const oldest = makeCapture("oldest", 100);
    const newest = makeCapture("newest", 300, { outcome: "proposed" });
    const refused: MemoryRecentCapture = {
      outcome: "rejected",
      scope: { kind: "global" },
      mode: "supervised-coding",
      provenance: {
        initiatorSurface: "conversation-center",
        sourceKind: "system-default",
      },
      occurredAt: 400,
      reason: "denied-category",
    };
    const middle = makeCapture("middle", 200);

    expect(
      orderJournalCaptures([oldest, newest, refused, middle]).map((item) => [
        item.outcome,
        item.memoryId,
      ]),
    ).toEqual([
      ["rejected", undefined],
      ["proposed", "newest"],
      ["auto-accepted", "middle"],
      ["auto-accepted", "oldest"],
    ]);
    renderJournal([oldest, newest, refused, middle]);

    const rows = await screen.findAllByTestId("memory-journal-row");
    expect(rows.map((row) => row.getAttribute("data-memory-id"))).toEqual([
      null,
      "newest",
      "middle",
      "oldest",
    ]);
    expect(
      within(rows[0]!).getByText("Capture refused by policy. No content was retained."),
    ).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Refused")).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/capture reason denied-category/i)).toBeInTheDocument();
    expect(within(rows[0]!).queryByRole("button")).not.toBeInTheDocument();
    expect(within(rows[1]!).getByText("Awaiting review")).toBeInTheDocument();
    expect(
      within(rows[1]!).getByText(/capture reason governance-auto-accepted/i),
    ).toBeInTheDocument();
  });

  it("degrades safely when the capture mode or body excerpt is absent", async () => {
    const legacy: MemoryRecentCapture = {
      outcome: "captured",
      scope: { kind: "global" },
      provenance: {
        initiatorSurface: "conversation-center",
        sourceKind: "system-default",
      },
      occurredAt: 100,
      reason: "captured-by-policy",
      memoryId: memoryId("legacy"),
    };
    renderJournal([legacy]);
    const row = await screen.findByTestId("memory-journal-row");
    expect(within(row).getByText("Mode unavailable")).toBeInTheDocument();
    expect(within(row).getByText("Memory content is unavailable")).toBeInTheDocument();
  });
});

describe("MemoryJournal Keep and Forget", () => {
  it("promotes proposed captures and acknowledges accepted captures locally", async () => {
    const user = userEvent.setup();
    const acceptImpl = vi.fn().mockResolvedValue({ memory: {} });
    renderJournal(
      [makeCapture("proposed", 200, { outcome: "proposed" }), makeCapture("accepted", 100)],
      { acceptMemoryProposalImpl: acceptImpl },
    );
    const rows = await screen.findAllByTestId("memory-journal-row");

    const proposedKeep = within(rows[0]!).getByRole("button", { name: "Keep" });
    await user.click(proposedKeep);
    await waitFor(() => expect(proposedKeep).toHaveAttribute("aria-pressed", "true"));
    expect(within(rows[0]!).getByText("Kept")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Accepted")).toBeInTheDocument();
    expect(acceptImpl).toHaveBeenCalledWith("proposed");

    const acceptedKeep = within(rows[1]!).getByRole("button", { name: "Keep" });
    await user.click(acceptedKeep);
    expect(acceptedKeep).toHaveAttribute("aria-pressed", "true");
    expect(acceptImpl).toHaveBeenCalledTimes(1);
  });

  it("preserves the original outcome when Keep acknowledges an already-decided capture", async () => {
    const user = userEvent.setup();
    renderJournal([makeCapture("captured", 100, { outcome: "captured" })]);
    const row = await screen.findByTestId("memory-journal-row");

    await user.click(within(row).getByRole("button", { name: "Keep" }));

    await waitFor(() => expect(within(row).getByText("Kept")).toBeInTheDocument());
    expect(row).toHaveAttribute("data-outcome", "captured");
  });

  it("forgets once, never resurrects the row, and focuses the next row", async () => {
    const user = userEvent.setup();
    const forgetImpl = vi
      .fn()
      .mockResolvedValue({ forgotten: true, memoryIds: ["newest"], count: 1 });
    const captures = [makeCapture("newest", 200), makeCapture("next", 100)];
    const firstFetch = fetchWith(captures);
    const { rerender } = render(
      <MemoryJournal
        onBack={vi.fn()}
        fetchRecentCapturesImpl={firstFetch}
        forgetMemoryImpl={forgetImpl}
      />,
    );
    const first = (await screen.findAllByTestId("memory-journal-row"))[0]!;
    await user.click(within(first).getByRole("button", { name: "Forget" }));

    await waitFor(() => expect(screen.getAllByTestId("memory-journal-row")).toHaveLength(1));
    const next = screen.getByTestId("memory-journal-row");
    expect(next).toHaveAttribute("data-memory-id", "next");
    expect(next).toHaveFocus();

    rerender(
      <MemoryJournal
        onBack={vi.fn()}
        fetchRecentCapturesImpl={fetchWith(captures)}
        forgetMemoryImpl={forgetImpl}
      />,
    );
    await waitFor(() => expect(screen.getAllByTestId("memory-journal-row")).toHaveLength(1));
    expect(screen.queryByText("Memory newest")).not.toBeInTheDocument();
    expect(forgetImpl).toHaveBeenCalledTimes(1);
  });

  it("focuses the heading when Forget empties the Journal", async () => {
    const user = userEvent.setup();
    renderJournal([makeCapture("only", 100)], {
      forgetMemoryImpl: vi
        .fn()
        .mockResolvedValue({ forgotten: true, memoryIds: ["only"], count: 1 }),
    });
    const row = await screen.findByTestId("memory-journal-row");
    await user.click(within(row).getByRole("button", { name: "Forget" }));

    expect(await screen.findByTestId("memory-journal-empty")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Memory Journal" })).toHaveFocus();
  });

  it("keeps a failed Forget row visible, reports a redacted alert, and retains focus", async () => {
    const user = userEvent.setup();
    renderJournal([makeCapture("stable", 100)], {
      forgetMemoryImpl: vi.fn().mockRejectedValue(new Error("raw backend detail")),
    });
    const forgetButton = within(await screen.findByTestId("memory-journal-row")).getByRole(
      "button",
      { name: "Forget" },
    );
    await user.click(forgetButton);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The memory could not be forgotten. Retry the action.",
    );
    expect(screen.getByTestId("memory-journal-row")).toBeInTheDocument();
    expect(forgetButton).toHaveFocus();
    expect(screen.getByRole("alert")).not.toHaveTextContent("raw backend detail");
  });
});

describe("MemoryJournal accessibility", () => {
  it("has no detectable accessibility violations", async () => {
    const refused: MemoryRecentCapture = {
      outcome: "rejected",
      scope: { kind: "global" },
      mode: "governed-assist",
      provenance: {
        initiatorSurface: "conversation-center",
        sourceKind: "system-default",
      },
      occurredAt: 200,
      reason: "denied-category",
    };
    const { container } = renderJournal([refused, makeCapture("accessible", 100)]);
    expect(await screen.findAllByTestId("memory-journal-row")).toHaveLength(2);
    expect(await axe(container)).toHaveNoViolations();
  });
});
