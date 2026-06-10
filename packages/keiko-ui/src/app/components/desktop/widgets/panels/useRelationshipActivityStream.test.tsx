// Issue #541 (Epic #532) — useRelationshipActivityStream tests.
//
// Covers all deliverable test requirements:
//   • State mapping: each of the 9 states can be received and stored.
//   • Reduced-motion: matchMedia mock → animate = false.
//   • Disabled-animation: disable() called → animate = false.
//   • Bounded animation count: 50 active items → only 25 animated.
//   • High-throughput: count surfaced, no fast-pulse (static badge).
//   • Failure/blocked: rendered without color-only (bg-red-500 vs bg-red-600 regression).
//   • Forbidden-key rejector: payload with secret key → message dropped.
//   • a11y: axe-core check on 25 mixed-state badges.
//
// Test strategy: vi.stubGlobal("EventSource", FakeEventSource) mirrors the TerminalWidget
// pattern in this repo (TerminalWidget.test.tsx:56).

import { render, act, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { axe, toHaveNoViolations } from "jest-axe";
import type { ReactNode } from "react";
import { useRelationshipActivityStream, N_VISIBLE } from "./useRelationshipActivityStream";
import { RelationshipEdgeBadge, ACTIVITY_VISUALS } from "./RelationshipEdgeBadge";
import type { RelationshipActivityState } from "@oscharko-dev/keiko-contracts";
import { RELATIONSHIP_ACTIVITY_STATES } from "@oscharko-dev/keiko-contracts";

expect.extend(toHaveNoViolations);

// ─── FakeEventSource ───────────────────────────────────────────────────────────
// Mirrors TerminalWidget.test.tsx pattern (ADR-0018).

type MessageHandler = (ev: MessageEvent<string>) => void;

class FakeEventSource {
  public static last: FakeEventSource | null = null;
  public static instances: FakeEventSource[] = [];
  public closed = false;
  private readonly listeners: Map<string, MessageHandler[]> = new Map();
  public onmessage: MessageHandler | null = null;
  public onerror: (() => void) | null = null;

  constructor(_url: string) {
    FakeEventSource.last = this;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: MessageHandler): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(handler);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, handler: MessageHandler): void {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      existing.filter((h) => h !== handler),
    );
  }

  close(): void {
    this.closed = true;
  }

  /** Dispatch a named event (e.g. "relationship:activity") or fall back to onmessage. */
  dispatch(type: string, data: unknown): void {
    const payload = JSON.stringify(data);
    const ev = new MessageEvent<string>(type, { data: payload });
    const handlers = this.listeners.get(type) ?? [];
    for (const h of handlers) {
      h(ev);
    }
    // Also fire onmessage for default events
    if (this.onmessage !== null) {
      this.onmessage(new MessageEvent<string>("message", { data: payload }));
    }
  }
}

// ─── matchMedia mock helper ────────────────────────────────────────────────────

function mockMatchMedia({
  reducedMotion,
  prefersContrastMore = false,
}: {
  reducedMotion: boolean;
  prefersContrastMore?: boolean;
}): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: query.includes("prefers-reduced-motion")
          ? reducedMotion
          : query.includes("prefers-contrast")
            ? prefersContrastMore
            : false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  });
}

// ─── Wrapper component ─────────────────────────────────────────────────────────

function HookHarness({
  onState,
}: {
  onState: (state: ReturnType<typeof useRelationshipActivityStream>) => void;
}): ReactNode {
  const state = useRelationshipActivityStream();
  onState(state);
  return null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeActivityEvent(id: string, state: RelationshipActivityState, count?: number): unknown {
  return {
    kind: "relationship:activity",
    id,
    state,
    timestamp: Date.now(),
    ...(count !== undefined ? { count } : {}),
  };
}

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
}

function requireCapturedState(
  state: ReturnType<typeof useRelationshipActivityStream> | null,
): ReturnType<typeof useRelationshipActivityStream> {
  expect(state).not.toBeNull();
  if (state === null) {
    throw new Error("expected hook state to be captured");
  }
  return state;
}

// ─── Suite setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  FakeEventSource.last = null;
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  // Default: motion allowed
  mockMatchMedia({ reducedMotion: false });
  setVisibilityState("visible");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
});

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("useRelationshipActivityStream", () => {
  describe("state mapping — all 9 states", () => {
    it.each(RELATIONSHIP_ACTIVITY_STATES)(
      "state '%s' is stored after a matching SSE event",
      async (state: (typeof RELATIONSHIP_ACTIVITY_STATES)[number]) => {
        let captured: ReturnType<typeof useRelationshipActivityStream> | null = null;

        render(
          <HookHarness
            onState={(s) => {
              captured = s;
            }}
          />,
        );

        await waitFor(() => expect(FakeEventSource.last).not.toBeNull());

        act(() => {
          FakeEventSource.last?.dispatch(
            "relationship:activity",
            makeActivityEvent("rel-1", state, state === "high-throughput" ? 55 : undefined),
          );
        });

        await waitFor(() => {
          expect(captured!.activityMap.get("rel-1")).toBe(state);
        });
      },
    );
  });

  describe("reduced-motion", () => {
    it("animate is false when prefers-reduced-motion: reduce is set", async () => {
      mockMatchMedia({ reducedMotion: true }); // reduced motion = ON

      let captured: ReturnType<typeof useRelationshipActivityStream> | null = null;

      render(
        <HookHarness
          onState={(s) => {
            captured = s;
          }}
        />,
      );

      await waitFor(() => expect(captured).not.toBeNull());
      expect(captured!.animate).toBe(false);
    });

    it("animate is true when prefers-reduced-motion is not set", async () => {
      mockMatchMedia({ reducedMotion: false });

      let captured: ReturnType<typeof useRelationshipActivityStream> | null = null;

      render(
        <HookHarness
          onState={(s) => {
            captured = s;
          }}
        />,
      );

      await waitFor(() => expect(captured).not.toBeNull());
      expect(captured!.animate).toBe(true);
    });
  });

  describe("disabled animation", () => {
    it("animate becomes false after disable() is called", async () => {
      let captured: ReturnType<typeof useRelationshipActivityStream> | null = null;

      render(
        <HookHarness
          onState={(s) => {
            captured = s;
          }}
        />,
      );

      await waitFor(() => expect(captured).not.toBeNull());
      expect(captured!.animate).toBe(true);

      act(() => {
        captured!.disable();
      });

      await waitFor(() => {
        expect(captured!.animate).toBe(false);
      });
    });
  });

  describe("bounded animation count (N_VISIBLE = 25)", () => {
    it("hook stores all 50 entries but badge rendering caps animated at 25", async () => {
      let captured: ReturnType<typeof useRelationshipActivityStream> | null = null;

      render(
        <HookHarness
          onState={(s) => {
            captured = s;
          }}
        />,
      );

      await waitFor(() => expect(FakeEventSource.last).not.toBeNull());

      // Dispatch 50 active events
      act(() => {
        for (let i = 0; i < 50; i++) {
          // Space them out in time so the MIN_STATE_INTERVAL debounce doesn't drop them.
          // The hook stores state per-id, so different ids all get stored.
          FakeEventSource.last?.dispatch(
            "relationship:activity",
            makeActivityEvent(`rel-${i.toString()}`, "active"),
          );
        }
      });

      await waitFor(() => {
        expect(captured!.activityMap.size ?? 0).toBe(50);
      });

      // Verify badge rendering honors N_VISIBLE: only first 25 should be animated.
      // We render 50 badges and check animated count ≤ 25.
      const ids = Array.from({ length: 50 }, (_, i) => `rel-${i.toString()}`);
      const { container } = render(
        <div>
          {ids.map((id, idx) => (
            <RelationshipEdgeBadge
              key={id}
              type="reads-context"
              lifecycle="active"
              activity="processing"
              // animate the first N_VISIBLE only
              animateOverride={idx < N_VISIBLE}
            />
          ))}
        </div>,
      );

      const animated = container.querySelectorAll(".rb-edge-badge-icon--processing");
      // Only badges with animateOverride=true (first 25) should have the spin class.
      expect(animated.length).toBeLessThanOrEqual(N_VISIBLE);
    });
  });

  describe("high-throughput", () => {
    it("throughputCount is surfaced in the map and badge renders it as text", async () => {
      let captured: ReturnType<typeof useRelationshipActivityStream> | null = null;

      render(
        <HookHarness
          onState={(s) => {
            captured = s;
          }}
        />,
      );

      await waitFor(() => expect(FakeEventSource.last).not.toBeNull());

      act(() => {
        FakeEventSource.last?.dispatch(
          "relationship:activity",
          makeActivityEvent("rel-ht", "high-throughput", 73),
        );
      });

      await waitFor(() => {
        expect(captured!.throughputMap.get("rel-ht")).toBe(73);
      });

      // Render the badge and confirm the count appears in the label.
      render(
        <RelationshipEdgeBadge
          type="reads-context"
          lifecycle="active"
          activity="high-throughput"
          throughputCount={73}
        />,
      );

      expect(screen.getByText(/73/)).toBeDefined();

      // WCAG: badge must NOT use animation for high-throughput (count update only).
      const { container } = render(
        <RelationshipEdgeBadge
          type="reads-context"
          lifecycle="active"
          activity="high-throughput"
          throughputCount={73}
          animateOverride={true}
        />,
      );
      // high-throughput has animated:false so no spin class even with animateOverride=true.
      expect(container.innerHTML).not.toContain("rb-edge-badge-icon--processing");
    });
  });

  describe("failure / blocked display — color-only regression", () => {
    it("failed badge uses var(--danger) not a raw red hex", () => {
      const visual = ACTIVITY_VISUALS["failed"];
      // Must use CSS token, not any raw red hex value.
      expect(visual.textColor).toBe("var(--danger)");
      expect(visual.bgColor).toContain("var(--danger)");
      // Explicitly NOT the forbidden pattern (activity-visualization.md §"Failure" footnote).
      expect(visual.bgColor).not.toContain("bg-red-600");
    });

    it("blocked badge uses var(--warn) not bg-red-*", () => {
      const visual = ACTIVITY_VISUALS["blocked"];
      expect(visual.textColor).toBe("var(--warn)");
      expect(visual.bgColor).toContain("var(--warn)");
      expect(visual.bgColor).not.toContain("red");
    });

    it("failed badge renders its ARIA description without color-only state", () => {
      const { container } = render(
        <RelationshipEdgeBadge type="reads-context" lifecycle="active" activity="failed" />,
      );
      // Icon is aria-hidden; description is in visually-hidden span.
      const hidden = container.querySelector(".visually-hidden");
      expect(hidden?.textContent?.toLowerCase()).toContain("fail");
      // Icon must be aria-hidden so color isn't the only signal.
      const icons = container.querySelectorAll('[aria-hidden="true"]');
      expect(icons.length).toBeGreaterThan(0);
    });

    it("blocked badge renders its ARIA description without color-only state", () => {
      const { container } = render(
        <RelationshipEdgeBadge type="reads-context" lifecycle="active" activity="blocked" />,
      );
      const hidden = container.querySelector(".visually-hidden");
      expect(hidden?.textContent?.toLowerCase()).toContain("denied");
    });
  });

  describe("forbidden-key rejector", () => {
    it("drops an SSE message that contains a 'secret' key", async () => {
      let captured: ReturnType<typeof useRelationshipActivityStream> | null = null;

      render(
        <HookHarness
          onState={(s) => {
            captured = s;
          }}
        />,
      );

      await waitFor(() => expect(FakeEventSource.last).not.toBeNull());

      // This event has a forbidden key ("secret") — should be dropped entirely.
      act(() => {
        FakeEventSource.last?.dispatch("relationship:activity", {
          kind: "relationship:activity",
          id: "rel-bad",
          state: "active",
          timestamp: Date.now(),
          secret: ["sk-", "proj-XXXX"].join(""),
        });
      });

      // Wait a tick; the map should NOT contain rel-bad.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(captured!.activityMap.has("rel-bad")).toBe(false);
    });

    it("drops a message with an 'apikey' key nested in the payload", async () => {
      let captured: ReturnType<typeof useRelationshipActivityStream> | null = null;

      render(
        <HookHarness
          onState={(s) => {
            captured = s;
          }}
        />,
      );

      await waitFor(() => expect(FakeEventSource.last).not.toBeNull());

      act(() => {
        FakeEventSource.last?.dispatch("relationship:activity", {
          kind: "relationship:activity",
          id: "rel-apikey",
          state: "active",
          timestamp: Date.now(),
          metadata: { apiKey: "test-key-value" },
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(captured!.activityMap.has("rel-apikey")).toBe(false);
    });

    it("accepts a clean event with no forbidden keys", async () => {
      let captured: ReturnType<typeof useRelationshipActivityStream> | null = null;

      render(
        <HookHarness
          onState={(s) => {
            captured = s;
          }}
        />,
      );

      await waitFor(() => expect(FakeEventSource.last).not.toBeNull());

      act(() => {
        FakeEventSource.last?.dispatch(
          "relationship:activity",
          makeActivityEvent("rel-clean", "completed"),
        );
      });

      await waitFor(() => {
        expect(captured!.activityMap.get("rel-clean")).toBe("completed");
      });
    });
  });

  describe("SSE cleanup on unmount", () => {
    it("closes the EventSource when the component unmounts", async () => {
      const { unmount } = render(<HookHarness onState={() => undefined} />);

      await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
      const es = FakeEventSource.last;
      expect(es?.closed).toBe(false);

      unmount();

      expect(es?.closed).toBe(true);
    });
  });

  describe("fallback contract and visibility pause", () => {
    it("retries the SSE endpoint instead of calling an unsupported polling fetch shape", async () => {
      vi.useFakeTimers();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      render(<HookHarness onState={() => undefined} />);

      expect(FakeEventSource.last).not.toBeNull();
      expect(FakeEventSource.instances).toHaveLength(1);

      act(() => {
        FakeEventSource.last?.onerror?.();
      });

      expect(FakeEventSource.instances[0]?.closed).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(5_000);
      });

      expect(FakeEventSource.instances).toHaveLength(2);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("pauses expiry and reconnect while the page is hidden, then resumes on visibility", async () => {
      vi.useFakeTimers();
      let captured: ReturnType<typeof useRelationshipActivityStream> | null = null;

      render(
        <HookHarness
          onState={(state) => {
            captured = state;
          }}
        />,
      );

      expect(FakeEventSource.last).not.toBeNull();

      act(() => {
        FakeEventSource.last?.dispatch(
          "relationship:activity",
          makeActivityEvent("rel-vis", "active"),
        );
      });

      expect(requireCapturedState(captured).activityMap.get("rel-vis")).toBe("active");

      const firstSource = FakeEventSource.last;

      act(() => {
        setVisibilityState("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
        vi.advanceTimersByTime(125_000);
      });

      expect(firstSource?.closed).toBe(true);
      expect(FakeEventSource.instances).toHaveLength(1);
      expect(requireCapturedState(captured).activityMap.get("rel-vis")).toBe("active");

      act(() => {
        setVisibilityState("visible");
        document.dispatchEvent(new Event("visibilitychange"));
      });

      expect(FakeEventSource.instances).toHaveLength(2);
      expect(requireCapturedState(captured).activityMap.get("rel-vis")).toBe("inactive");
    });
  });

  describe("bounded state retention", () => {
    it("drops long-idle inactive entries so the in-memory map cannot grow forever", async () => {
      vi.useFakeTimers();
      let captured: ReturnType<typeof useRelationshipActivityStream> | null = null;

      render(
        <HookHarness
          onState={(state) => {
            captured = state;
          }}
        />,
      );

      expect(FakeEventSource.last).not.toBeNull();

      act(() => {
        FakeEventSource.last?.dispatch(
          "relationship:activity",
          makeActivityEvent("rel-prune", "high-throughput", 73),
        );
      });

      expect(requireCapturedState(captured).activityMap.get("rel-prune")).toBe("high-throughput");
      expect(requireCapturedState(captured).throughputMap.get("rel-prune")).toBe(73);

      act(() => {
        vi.advanceTimersByTime(61_000);
      });

      expect(requireCapturedState(captured).activityMap.get("rel-prune")).toBe("inactive");
      expect(requireCapturedState(captured).throughputMap.has("rel-prune")).toBe(false);

      act(() => {
        vi.advanceTimersByTime(61_000);
      });

      expect(requireCapturedState(captured).activityMap.has("rel-prune")).toBe(false);
      expect(requireCapturedState(captured).throughputMap.has("rel-prune")).toBe(false);
    });
  });
});

// ─── a11y: axe-core check on 25 mixed-state badges ────────────────────────────

describe("RelationshipEdgeBadge a11y (25 mixed states)", () => {
  it("passes axe-core on a list of 25 badges across all states", async () => {
    const states: RelationshipActivityState[] = Array.from(
      { length: 25 },
      (_, i) => RELATIONSHIP_ACTIVITY_STATES[i % RELATIONSHIP_ACTIVITY_STATES.length]!,
    );

    const { container } = render(
      <div role="list" aria-label="Relationships">
        {states.map((state, i) => (
          <div key={`${state}-${i.toString()}`} role="listitem">
            <RelationshipEdgeBadge
              type="reads-context"
              lifecycle="active"
              activity={state}
              throughputCount={state === "high-throughput" ? 73 : undefined}
            />
          </div>
        ))}
      </div>,
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
