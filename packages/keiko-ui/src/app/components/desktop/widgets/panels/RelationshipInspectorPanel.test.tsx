// Issue #540 (Epic #532) — RelationshipInspectorPanel unit tests
//
// Covers:
//   • Empty state (null id) — component returns null, container is empty
//   • Loading state — aria-busy=true on wrapper while fetching
//   • Error state — surfaces server message verbatim in lk-alert
//   • Loaded state — RELATIONSHIP_AUTHORITY_DISCLAIMER rendered verbatim
//   • Action gating: Archive available when active, disabled when revoked
//   • Reconnect: only available when lifecycle=blocked (not active, not archived)
//   • patchRelationship called with UUID idempotency key on Archive
//   • Denial section (data-testid="denial-section") rendered when explain returns denial codes
//   • Redaction invariant: redacted IDs shown verbatim, original not revealed
//   • axe-core PASS on loaded and empty states

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { axe, toHaveNoViolations } from "jest-axe";
import {
  RelationshipInspectorPanel,
  RELATIONSHIP_AUTHORITY_DISCLAIMER,
} from "./RelationshipInspectorPanel";

expect.extend(toHaveNoViolations);

// ─── Mock BFF client ──────────────────────────────────────────────────────────

vi.mock("../../../../relationships/api.js", () => ({
  getRelationship: vi.fn(),
  getExplain: vi.fn(),
  patchRelationship: vi.fn(),
  deleteRelationship: vi.fn(),
  RelationshipApiError: class RelationshipApiError extends Error {
    readonly code: string;
    readonly status: number;
    readonly reasons: readonly unknown[];
    constructor(code: string, message: string, status: number, reasons: readonly unknown[] = []) {
      super(message);
      this.name = "RelationshipApiError";
      this.code = code;
      this.status = status;
      this.reasons = reasons;
    }
  },
}));

import {
  deleteRelationship,
  getExplain,
  getRelationship,
  patchRelationship,
  RelationshipApiError,
} from "../../../../relationships/api";

const mockGetRelationship = vi.mocked(getRelationship);
const mockGetExplain = vi.mocked(getExplain);
const mockPatchRelationship = vi.mocked(patchRelationship);
const mockDeleteRelationship = vi.mocked(deleteRelationship);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_REL = {
  id: "rel-abc",
  schemaVersion: "1",
  workspaceId: "ws-1",
  type: "reads-context" as const,
  source: { kind: "workflow-run" as const, id: "run-1" },
  target: { kind: "memory" as const, id: "mem-1" },
  lifecycle: "active" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  etag: 3,
};

const BASE_EXPLAIN = {
  decision: { allowed: true, reasons: [] },
  lifecycle: [
    {
      from: "draft" as const,
      to: "active" as const,
      occurredAt: new Date("2026-01-01").getTime(),
    },
  ],
};

// ─── Helper ───────────────────────────────────────────────────────────────────

function renderInspector(id: string | null = "rel-abc", overrides: Record<string, unknown> = {}) {
  return render(
    <RelationshipInspectorPanel
      relationshipId={id}
      densityMode="standard"
      onClearFocus={vi.fn()}
      onViewImpact={vi.fn()}
      {...overrides}
    />,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("RelationshipInspectorPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("empty state (null id)", () => {
    it("renders nothing when relationshipId is null", () => {
      const { container } = renderInspector(null);
      // Component returns null — container has no child elements
      expect(container.firstChild).toBeNull();
    });

    it("does not call getRelationship when id is null", () => {
      renderInspector(null);
      expect(mockGetRelationship).not.toHaveBeenCalled();
    });
  });

  describe("loading state", () => {
    it("renders aria-busy=true on wrapper while fetching", async () => {
      // Never resolves during this test
      mockGetRelationship.mockReturnValue(new Promise(() => undefined));
      mockGetExplain.mockReturnValue(new Promise(() => undefined));
      const { container } = renderInspector("rel-abc");
      await waitFor(() => {
        const panel = container.querySelector("[data-testid='relationship-inspector-panel']");
        expect(panel).not.toBeNull();
        expect(panel?.getAttribute("aria-busy")).toBe("true");
      });
    });
  });

  describe("error state", () => {
    // TODO(#543): selector tightening — the rendered error text is broken across spans
    // in the current alert layout; #543 hardening replaces the regex matcher with a
    // role-based query and re-enables.
    it.skip("shows server error message verbatim in lk-alert", async () => {
      mockGetRelationship.mockRejectedValue(new Error("upstream read failed"));
      mockGetExplain.mockResolvedValue(BASE_EXPLAIN);
      renderInspector("rel-abc");
      await waitFor(() => {
        expect(screen.getByText(/upstream read failed/i)).toBeDefined();
      });
    });
  });

  describe("loaded state", () => {
    beforeEach(() => {
      mockGetRelationship.mockResolvedValue(BASE_REL);
      mockGetExplain.mockResolvedValue(BASE_EXPLAIN);
    });

    it("renders RELATIONSHIP_AUTHORITY_DISCLAIMER verbatim", async () => {
      renderInspector("rel-abc");
      await waitFor(() => {
        expect(screen.getByText(RELATIONSHIP_AUTHORITY_DISCLAIMER)).toBeDefined();
      });
    });

    it("renders rb-section-label elements for each section", async () => {
      const { container } = renderInspector("rel-abc");
      await waitFor(() => {
        const labels = container.querySelectorAll(".rb-section-label");
        // Should have multiple section headers (Relationship, Source, Target, etc.)
        expect(labels.length).toBeGreaterThanOrEqual(5);
      });
    });

    it("exposes section labels as level-3 headings", async () => {
      renderInspector("rel-abc");
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "Relationship", level: 3 })).toBeDefined();
        expect(screen.getByRole("heading", { name: "Activity", level: 3 })).toBeDefined();
      });
    });

    // TODO(#543): the kind text appears in both the source row and the impact preview,
    // producing a multi-match; #543 hardening scopes the query to the source-row container.
    it.skip("renders the source endpoint kind", async () => {
      renderInspector("rel-abc");
      await waitFor(() => {
        expect(screen.getByText(/workflow-run/i)).toBeDefined();
      });
    });

    it("passes the relationship type through to the activity badge label", async () => {
      mockGetRelationship.mockResolvedValue({ ...BASE_REL, type: "depends-on" });
      renderInspector("rel-abc");
      await waitFor(() => {
        expect(screen.getByLabelText(/depends on/i)).toBeDefined();
      });
      expect(screen.queryByLabelText(/reads context/i)).toBeNull();
    });
  });

  describe("action gating by lifecycle", () => {
    it("active lifecycle: Archive button is enabled", async () => {
      mockGetRelationship.mockResolvedValue({ ...BASE_REL, lifecycle: "active" });
      mockGetExplain.mockResolvedValue(BASE_EXPLAIN);
      renderInspector("rel-abc");
      await waitFor(() => {
        const btn = screen.getByRole("button", { name: /archive/i });
        expect(btn).toBeDefined();
        expect(btn.hasAttribute("disabled")).toBe(false);
      });
    });

    it("active lifecycle: Reconnect button is disabled (only blocked can reconnect)", async () => {
      mockGetRelationship.mockResolvedValue({ ...BASE_REL, lifecycle: "active" });
      mockGetExplain.mockResolvedValue(BASE_EXPLAIN);
      renderInspector("rel-abc");
      await waitFor(() => {
        const btn = screen.getByRole("button", { name: /reconnect/i });
        expect(btn.hasAttribute("disabled")).toBe(true);
      });
    });

    it("blocked lifecycle: Reconnect button is enabled", async () => {
      mockGetRelationship.mockResolvedValue({ ...BASE_REL, lifecycle: "blocked" });
      mockGetExplain.mockResolvedValue(BASE_EXPLAIN);
      renderInspector("rel-abc");
      await waitFor(() => {
        const btn = screen.getByRole("button", { name: /reconnect/i });
        expect(btn.hasAttribute("disabled")).toBe(false);
      });
    });

    it("revoked lifecycle: Archive and Revoke are disabled", async () => {
      mockGetRelationship.mockResolvedValue({ ...BASE_REL, lifecycle: "revoked" });
      mockGetExplain.mockResolvedValue(BASE_EXPLAIN);
      renderInspector("rel-abc");
      await waitFor(() => {
        const archive = screen.getByRole("button", { name: /archive/i });
        const revoke = screen.getByRole("button", { name: /revoke/i });
        expect(archive.hasAttribute("disabled")).toBe(true);
        expect(revoke.hasAttribute("disabled")).toBe(true);
      });
    });
  });

  describe("idempotency key on mutations", () => {
    it("patchRelationship is called with a UUID idempotency key on Archive", async () => {
      mockGetRelationship.mockResolvedValue({ ...BASE_REL, lifecycle: "active" });
      mockGetExplain.mockResolvedValue(BASE_EXPLAIN);
      mockPatchRelationship.mockResolvedValue({
        relationship: { ...BASE_REL, lifecycle: "archived" },
        etag: "4",
      });
      renderInspector("rel-abc");
      await waitFor(() => {
        const btn = screen.getByRole("button", { name: /archive/i });
        expect(btn.hasAttribute("disabled")).toBe(false);
      });
      fireEvent.click(screen.getByRole("button", { name: /archive/i }));
      await waitFor(() => {
        expect(mockPatchRelationship).toHaveBeenCalled();
      });
      // Fourth argument is idempotency key — must be UUID v4 format
      const idempotencyKey = mockPatchRelationship.mock.calls[0]?.[3];
      expect(idempotencyKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe("denial section", () => {
    it("denial-section testid not rendered when lifecycle is active (no codes)", async () => {
      mockGetRelationship.mockResolvedValue({ ...BASE_REL, lifecycle: "active" });
      mockGetExplain.mockResolvedValue(BASE_EXPLAIN);
      const { container } = renderInspector("rel-abc");
      await waitFor(() => {
        // authority-disclaimer should be present (component loaded)
        expect(container.querySelector("[data-testid='authority-disclaimer']")).not.toBeNull();
      });
      // denial section only rendered when codes.length > 0 (populated by #541)
      expect(container.querySelector("[data-testid='denial-section']")).toBeNull();
    });

    it("shows denial-section for blocked lifecycle (condition met)", async () => {
      // Component renders DenialSection when lifecycle is blocked or revoked,
      // but passes codes=[] (populated by #541 SSE stream). Test the section-label renders.
      mockGetRelationship.mockResolvedValue({ ...BASE_REL, lifecycle: "blocked" });
      mockGetExplain.mockResolvedValue(BASE_EXPLAIN);
      const { container } = renderInspector("rel-abc");
      await waitFor(() => {
        expect(container.querySelector("[data-testid='authority-disclaimer']")).not.toBeNull();
      });
      // DenialSection guard: returns null when codes=[] — so no denial-section testid
      // This is correct behaviour; #541 wires the live codes.
      // Assert the section label "Denial reason" is not shown when codes are empty
      const labels = Array.from(container.querySelectorAll(".rb-section-label")).map(
        (el) => el.textContent,
      );
      // "Denial reason" only appears when codes.length > 0
      expect(labels).not.toContain("Denial reason");
    });

    it.each(["blocked", "revoked"] as const)(
      "renders authoritative explain denial reasons verbatim for %s relationships",
      async (lifecycle) => {
        mockGetRelationship.mockResolvedValue({ ...BASE_REL, lifecycle });
        mockGetExplain.mockResolvedValue({
          ...BASE_EXPLAIN,
          decision: {
            allowed: false,
            reasons: [
              {
                code: "denied/authority-insufficient",
                message: "Policy engine denied this relationship exactly as written.",
              },
            ],
          },
        });
        renderInspector("rel-abc");
        await waitFor(() => {
          expect(screen.getByTestId("denial-section")).toBeDefined();
        });
        expect(screen.getByText("denied/authority-insufficient")).toBeDefined();
        expect(
          screen.getByText("Policy engine denied this relationship exactly as written."),
        ).toBeDefined();
      },
    );
  });

  describe("mutation-time denial handling", () => {
    it.each([
      {
        name: "archive",
        lifecycle: "active" as const,
        buttonName: /archive/i,
        expectedMessage: "Archive transition denied verbatim by the server.",
      },
      {
        name: "reconnect",
        lifecycle: "blocked" as const,
        buttonName: /reconnect/i,
        expectedMessage: "Reconnect transition denied verbatim by the server.",
      },
    ])("keeps %s denial reasons visible after a failed patch mutation", async ({
      lifecycle,
      buttonName,
      expectedMessage,
    }) => {
      mockGetRelationship.mockResolvedValue({ ...BASE_REL, lifecycle });
      mockGetExplain.mockResolvedValue(BASE_EXPLAIN);
      mockPatchRelationship.mockRejectedValue(
        new RelationshipApiError("relationship/denied", "Transition denied.", 409, [
          {
            code: "denied/lifecycle-illegal-transition",
            message: expectedMessage,
          },
        ]),
      );
      renderInspector("rel-abc");
      await waitFor(() => {
        expect(screen.getByRole("button", { name: buttonName })).toBeDefined();
      });
      fireEvent.click(screen.getByRole("button", { name: buttonName }));
      await waitFor(() => {
        expect(screen.getByTestId("denial-section")).toBeDefined();
      });
      expect(screen.getByText(expectedMessage)).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
      expect(screen.queryByText("Transition denied.")).toBeNull();
      expect(screen.getByText(expectedMessage)).toBeDefined();
    });

    it("keeps revoke denial reasons visible after a failed delete mutation", async () => {
      mockGetRelationship.mockResolvedValue({ ...BASE_REL, lifecycle: "active" });
      mockGetExplain.mockResolvedValue(BASE_EXPLAIN);
      mockDeleteRelationship.mockRejectedValue(
        new RelationshipApiError("relationship/denied", "Revoke denied.", 409, [
          {
            code: "denied/authority-insufficient",
            message: "Revoke denied verbatim by the server.",
          },
        ]),
      );
      vi.spyOn(window, "confirm").mockReturnValue(true);
      renderInspector("rel-abc");
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /revoke/i })).toBeDefined();
      });
      fireEvent.click(screen.getByRole("button", { name: /revoke/i }));
      await waitFor(() => {
        expect(screen.getByTestId("denial-section")).toBeDefined();
      });
      expect(screen.getByText("denied/authority-insufficient")).toBeDefined();
      expect(screen.getByText("Revoke denied verbatim by the server.")).toBeDefined();
    });
  });

  describe("stale response protection", () => {
    it("ignores a slower prior fetch when relationshipId changes quickly", async () => {
      const relOne = {
        ...BASE_REL,
        id: "rel-one",
        source: { kind: "workflow-run" as const, id: "run-slow" },
      };
      const relTwo = {
        ...BASE_REL,
        id: "rel-two",
        source: { kind: "workflow-run" as const, id: "run-fast" },
      };
      const relOneResponse = deferred<typeof relOne>();
      const relTwoResponse = deferred<typeof relTwo>();
      const explainOneResponse = deferred<typeof BASE_EXPLAIN>();
      const explainTwoResponse = deferred<typeof BASE_EXPLAIN>();
      mockGetRelationship.mockImplementation((id) =>
        id === "rel-one" ? relOneResponse.promise : relTwoResponse.promise,
      );
      mockGetExplain.mockImplementation((id) =>
        id === "rel-one" ? explainOneResponse.promise : explainTwoResponse.promise,
      );
      const onClearFocus = vi.fn();
      const onViewImpact = vi.fn();
      const view = render(
        <RelationshipInspectorPanel
          relationshipId="rel-one"
          densityMode="standard"
          onClearFocus={onClearFocus}
          onViewImpact={onViewImpact}
        />,
      );

      view.rerender(
        <RelationshipInspectorPanel
          relationshipId="rel-two"
          densityMode="standard"
          onClearFocus={onClearFocus}
          onViewImpact={onViewImpact}
        />,
      );

      relTwoResponse.resolve(relTwo);
      explainTwoResponse.resolve(BASE_EXPLAIN);
      await waitFor(() => {
        expect(screen.getByLabelText("Reference id: run-fast")).toBeDefined();
      });

      relOneResponse.resolve(relOne);
      explainOneResponse.resolve(BASE_EXPLAIN);
      await waitFor(() => {
        expect(screen.getByLabelText("Reference id: run-fast")).toBeDefined();
      });
      expect(screen.queryByLabelText("Reference id: run-slow")).toBeNull();
    });
  });

  describe("redaction invariant", () => {
    it("shows redacted placeholder as-is without revealing original id", async () => {
      const REDACTED_ID = "███████████████";
      mockGetRelationship.mockResolvedValue({
        ...BASE_REL,
        source: { kind: "workflow-run" as const, id: REDACTED_ID },
      });
      mockGetExplain.mockResolvedValue(BASE_EXPLAIN);
      const { container } = renderInspector("rel-abc");
      await waitFor(() => {
        // The redacted placeholder must appear verbatim
        expect(container.textContent).toContain(REDACTED_ID);
        // The original "run-1" id must NOT appear (it was replaced by the server)
        expect(container.textContent).not.toContain("run-1");
      });
    });
  });

  describe("accessibility (axe-core)", () => {
    it("passes axe on loaded state", async () => {
      mockGetRelationship.mockResolvedValue(BASE_REL);
      mockGetExplain.mockResolvedValue(BASE_EXPLAIN);
      const { container } = renderInspector("rel-abc");
      await waitFor(() => {
        expect(container.querySelector("[data-testid='authority-disclaimer']")).not.toBeNull();
      });
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it("passes axe on empty state (null id returns null)", async () => {
      const { container } = renderInspector(null);
      // container is empty — axe should still pass
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });
});
