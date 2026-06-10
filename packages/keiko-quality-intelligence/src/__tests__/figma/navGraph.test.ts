// Unit tests for the deterministic screen navigation/flow graph (Epic #750, Issue #811).
// Pure domain — no IO, no model, no Date. Synthetic Screen-IR fixtures only; never a real board.
//
// Mutation-robust: edge derivation + screen resolution, multi-step flow paths, cycle bounding,
// link-to-node-outside-any-screen handling, unreachable + dead-end coverage notices, routing hints,
// per-screen attribution of the derived test items, and byte-stable determinism each have a case.

import { describe, expect, it } from "vitest";

import {
  deriveNavGraph,
  deriveNavFlows,
  deriveRoutingHints,
  deriveNavTestItemsByScreen,
  type NavGraph,
} from "../../domain/figma/navGraph.js";
import type {
  InterScreenLink,
  IrNode,
  ScreenIr,
  ScreenIrResult,
} from "../../domain/figma/irTypes.js";

// ─── Fixture builders ──────────────────────────────────────────────────────────

const node = (id: string, children: readonly IrNode[] = []): IrNode => ({
  id,
  name: id,
  type: "FRAME",
  interactionHint: "container",
  imageFills: [],
  children,
});

const screen = (id: string, name: string, root: IrNode): ScreenIr => ({ id, name, root });

const link = (sourceNodeId: string, trigger: string, targetNodeId: string): InterScreenLink => ({
  sourceNodeId,
  trigger,
  targetNodeId,
});

const result = (
  screens: readonly ScreenIr[],
  links: readonly InterScreenLink[],
): ScreenIrResult => ({
  screens,
  links,
  tokens: { colors: [], typography: [], spacing: [], radius: [] },
  reduction: { inputNodeCount: 0, keptNodeCount: 0, removedNodeCount: 0, removedRatio: 0 },
});

// A login → home flow: a button on Login navigates to Home; a link on Home returns to Login.
const loginHome = (): ScreenIrResult =>
  result(
    [
      screen("s-login", "Login", node("login-root", [node("login-btn")])),
      screen("s-home", "Home", node("home-root", [node("home-link")])),
    ],
    [link("login-btn", "ON_CLICK", "home-root"), link("home-link", "ON_CLICK", "login-root")],
  );

// ─── Graph derivation ─────────────────────────────────────────────────────────

describe("deriveNavGraph — nodes and edges", () => {
  it("derives one node per screen in stable screenId order", () => {
    const graph = deriveNavGraph(loginHome());
    expect(graph.nodes.map((n) => n.screenId)).toEqual(["s-home", "s-login"]);
    expect(graph.nodes.map((n) => n.screenName)).toEqual(["Home", "Login"]);
  });

  it("resolves a link's target node to its owning screen (descendant resolution)", () => {
    const graph = deriveNavGraph(loginHome());
    const edge = graph.edges.find((e) => e.fromScreenId === "s-login");
    expect(edge).toBeDefined();
    expect(edge?.toScreenId).toBe("s-home");
    expect(edge?.trigger).toBe("ON_CLICK");
    expect(edge?.sourceNodeId).toBe("login-btn");
    expect(edge?.targetNodeId).toBe("home-root");
  });

  it("produces exactly one edge per resolved link, stable-sorted", () => {
    const graph = deriveNavGraph(loginHome());
    expect(graph.edges).toHaveLength(2);
    // Stable structural ordering: fromScreenId, then trigger, then toScreenId, then node ids.
    const keys = graph.edges.map((e) => `${e.fromScreenId}|${e.trigger}|${e.toScreenId}`);
    expect([...keys]).toEqual([...keys].sort());
  });

  it("returns an empty graph for an empty IR (no screens, no links)", () => {
    const graph = deriveNavGraph(result([], []));
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.unresolvedLinks).toEqual([]);
    expect(graph.unreachableScreenIds).toEqual([]);
    expect(graph.deadEndScreenIds).toEqual([]);
  });

  it("produces nodes but no edges when there are no links", () => {
    const graph = deriveNavGraph(result([screen("s-a", "A", node("a"))], []));
    expect(graph.nodes.map((n) => n.screenId)).toEqual(["s-a"]);
    expect(graph.edges).toEqual([]);
  });

  it("keeps a self-loop edge (source and target resolve to the same screen)", () => {
    const graph = deriveNavGraph(
      result(
        [screen("s-a", "A", node("a-root", [node("a-btn")]))],
        [link("a-btn", "ON_CLICK", "a-root")],
      ),
    );
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]?.fromScreenId).toBe("s-a");
    expect(graph.edges[0]?.toScreenId).toBe("s-a");
  });
});

describe("deriveNavGraph — links outside any screen", () => {
  it("records a link whose target resolves to no screen as unresolved, not an edge", () => {
    const graph = deriveNavGraph(
      result(
        [screen("s-a", "A", node("a-root", [node("a-btn")]))],
        [link("a-btn", "ON_CLICK", "ghost-node")],
      ),
    );
    expect(graph.edges).toEqual([]);
    expect(graph.unresolvedLinks).toHaveLength(1);
    expect(graph.unresolvedLinks[0]?.targetNodeId).toBe("ghost-node");
  });

  it("resolves a flow-entry link whose source is the canvas (outside any screen)", () => {
    const graph = deriveNavGraph(
      result(
        [screen("s-home", "Home", node("home-root"))],
        [link("canvas-1", "FLOW_START", "home-root")],
      ),
    );
    // Source outside any screen does not block target resolution: the entry edge has no fromScreen.
    expect(graph.edges).toEqual([]);
    expect(graph.entryScreenIds).toEqual(["s-home"]);
  });
});

// ─── Reachability ───────────────────────────────────────────────────────────────

describe("deriveNavGraph — reachability", () => {
  it("reports a screen unreachable when no edge or flow-entry reaches it", () => {
    const graph = deriveNavGraph(
      result(
        [
          screen("s-a", "A", node("a-root", [node("a-btn")])),
          screen("s-b", "B", node("b-root")),
          screen("s-orphan", "Orphan", node("orphan-root")),
        ],
        [link("canvas", "FLOW_START", "a-root"), link("a-btn", "ON_CLICK", "b-root")],
      ),
    );
    expect(graph.unreachableScreenIds).toEqual(["s-orphan"]);
  });

  it("reports a dead-end screen (reachable but with no outgoing edge)", () => {
    const graph = deriveNavGraph(loginHome());
    // Both screens have outgoing edges → no dead ends.
    expect(graph.deadEndScreenIds).toEqual([]);

    const g2 = deriveNavGraph(
      result(
        [screen("s-a", "A", node("a-root", [node("a-btn")])), screen("s-b", "B", node("b-root"))],
        [link("a-btn", "ON_CLICK", "b-root")],
      ),
    );
    expect(g2.deadEndScreenIds).toEqual(["s-b"]);
  });

  it("falls back to the first screen (stable order) as entry when no flow-entry exists", () => {
    const graph = deriveNavGraph(
      result(
        [screen("s-b", "B", node("b-root", [node("b-btn")])), screen("s-a", "A", node("a-root"))],
        [link("b-btn", "ON_CLICK", "a-root")],
      ),
    );
    // Stable order makes s-a the first screen; it is the synthetic entry, so it is reachable and
    // s-b is reachable only if an edge leads to it. No edge leads to s-b → s-b is unreachable.
    expect(graph.entryScreenIds).toEqual(["s-a"]);
    expect(graph.unreachableScreenIds).toEqual(["s-b"]);
  });
});

// ─── Flow paths (multi-step, cycle-bounded) ──────────────────────────────────────

describe("deriveNavFlows — multi-step paths", () => {
  it("derives a multi-step flow path across two edges", () => {
    const graph = deriveNavGraph(
      result(
        [
          screen("s-a", "A", node("a-root", [node("a-btn")])),
          screen("s-b", "B", node("b-root", [node("b-btn")])),
          screen("s-c", "C", node("c-root")),
        ],
        [
          link("canvas", "FLOW_START", "a-root"),
          link("a-btn", "ON_CLICK", "b-root"),
          link("b-btn", "ON_CLICK", "c-root"),
        ],
      ),
    );
    const flows = deriveNavFlows(graph);
    const longest = flows.find((f) => f.screenIds.length === 3);
    expect(longest?.screenIds).toEqual(["s-a", "s-b", "s-c"]);
  });

  it("bounds path length and never loops forever on a cycle", () => {
    const graph = deriveNavGraph(
      result(
        [
          screen("s-a", "A", node("a-root", [node("a-btn")])),
          screen("s-b", "B", node("b-root", [node("b-btn")])),
        ],
        [
          link("canvas", "FLOW_START", "a-root"),
          link("a-btn", "ON_CLICK", "b-root"),
          link("b-btn", "ON_CLICK", "a-root"),
        ],
      ),
    );
    // A↔B is a cycle. Derivation must terminate; every path is acyclic (no repeated screen).
    const flows = deriveNavFlows(graph, 4);
    expect(flows.length).toBeGreaterThan(0);
    for (const flow of flows) {
      expect(new Set(flow.screenIds).size).toBe(flow.screenIds.length);
      expect(flow.screenIds.length).toBeLessThanOrEqual(4);
    }
  });

  it("respects an explicit maxDepth cap on path length", () => {
    const graph = deriveNavGraph(
      result(
        [
          screen("s-a", "A", node("a-root", [node("a-btn")])),
          screen("s-b", "B", node("b-root", [node("b-btn")])),
          screen("s-c", "C", node("c-root", [node("c-btn")])),
          screen("s-d", "D", node("d-root")),
        ],
        [
          link("canvas", "FLOW_START", "a-root"),
          link("a-btn", "ON_CLICK", "b-root"),
          link("b-btn", "ON_CLICK", "c-root"),
          link("c-btn", "ON_CLICK", "d-root"),
        ],
      ),
    );
    const flows = deriveNavFlows(graph, 2);
    for (const flow of flows) expect(flow.screenIds.length).toBeLessThanOrEqual(2);
  });
});

// ─── Routing hints (framework-agnostic) ──────────────────────────────────────────

describe("deriveRoutingHints — framework-agnostic", () => {
  it("emits screen → outgoing transitions with no router/framework specifics", () => {
    const hints = deriveRoutingHints(deriveNavGraph(loginHome()));
    const loginHint = hints.find((h) => h.screenId === "s-login");
    expect(loginHint?.transitions).toEqual([{ trigger: "ON_CLICK", toScreenId: "s-home" }]);

    const serialised = JSON.stringify(hints);
    for (const term of ["react-router", "Route", "useNavigate", "href", "path:"]) {
      expect(serialised).not.toContain(term);
    }
  });

  it("emits an empty transitions list for a dead-end screen", () => {
    const graph = deriveNavGraph(
      result(
        [screen("s-a", "A", node("a-root", [node("a-btn")])), screen("s-b", "B", node("b-root"))],
        [link("a-btn", "ON_CLICK", "b-root")],
      ),
    );
    const hints = deriveRoutingHints(graph);
    expect(hints.find((h) => h.screenId === "s-b")?.transitions).toEqual([]);
  });
});

// ─── Per-screen test items (composable through #754's extraItems) ────────────────

describe("deriveNavTestItemsByScreen — per-screen attribution", () => {
  it("emits a navigation test per edge attributed to its source screen", () => {
    const byScreen = deriveNavTestItemsByScreen(deriveNavGraph(loginHome()));
    const loginItems = byScreen.get("s-login") ?? [];
    const nav = loginItems.filter((i) => i.category === "navigation");
    expect(nav).toHaveLength(1);
    expect(nav[0]?.screenId).toBe("s-login");
    expect(nav[0]?.sourceNodeId).toBe("login-btn");
    expect(nav[0]?.title).toContain("Login");
    expect(nav[0]?.title).toContain("Home");
    // The trigger is load-bearing in the navigation test case — a mutation that drops it is caught.
    expect(nav[0]?.title).toContain("ON_CLICK");
  });

  it("emits a flow test attributed to the flow's entry screen", () => {
    const graph = deriveNavGraph(
      result(
        [
          screen("s-a", "A", node("a-root", [node("a-btn")])),
          screen("s-b", "B", node("b-root", [node("b-btn")])),
          screen("s-c", "C", node("c-root")),
        ],
        [
          link("canvas", "FLOW_START", "a-root"),
          link("a-btn", "ON_CLICK", "b-root"),
          link("b-btn", "ON_CLICK", "c-root"),
        ],
      ),
    );
    const byScreen = deriveNavTestItemsByScreen(graph);
    const flows = (byScreen.get("s-a") ?? []).filter((i) => i.category === "flow");
    expect(flows.length).toBeGreaterThan(0);
    expect(flows.every((i) => i.screenId === "s-a")).toBe(true);
  });

  it("emits a coverage-notice item for an unreachable screen", () => {
    const graph = deriveNavGraph(
      result(
        [
          screen("s-a", "A", node("a-root", [node("a-btn")])),
          screen("s-b", "B", node("b-root")),
          screen("s-orphan", "Orphan", node("orphan-root")),
        ],
        [link("canvas", "FLOW_START", "a-root"), link("a-btn", "ON_CLICK", "b-root")],
      ),
    );
    const notices = (deriveNavTestItemsByScreen(graph).get("s-orphan") ?? []).filter(
      (i) => i.category === "coverage-notice",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.title.toLowerCase()).toContain("unreachable");
  });

  it("emits a coverage-notice item for a dead-end screen", () => {
    const graph = deriveNavGraph(
      result(
        [screen("s-a", "A", node("a-root", [node("a-btn")])), screen("s-b", "B", node("b-root"))],
        [link("a-btn", "ON_CLICK", "b-root")],
      ),
    );
    const notices = (deriveNavTestItemsByScreen(graph).get("s-b") ?? []).filter(
      (i) => i.category === "coverage-notice",
    );
    expect(notices.some((n) => n.title.toLowerCase().includes("dead end"))).toBe(true);
  });
});

// ─── Determinism ─────────────────────────────────────────────────────────────────

describe("navigation derivation — determinism", () => {
  it("produces a byte-identical graph + items for the same input", () => {
    const a = JSON.stringify(serialiseAll(deriveNavGraph(loginHome())));
    const b = JSON.stringify(serialiseAll(deriveNavGraph(loginHome())));
    expect(a).toBe(b);
  });

  it("is insensitive to input screen/link ordering (stable sort)", () => {
    const ordered = loginHome();
    const shuffled = result([...ordered.screens].reverse(), [...ordered.links].reverse());
    expect(JSON.stringify(serialiseAll(deriveNavGraph(ordered)))).toBe(
      JSON.stringify(serialiseAll(deriveNavGraph(shuffled))),
    );
  });
});

function serialiseAll(graph: NavGraph): unknown {
  const byScreen = deriveNavTestItemsByScreen(graph);
  return {
    graph,
    flows: deriveNavFlows(graph),
    hints: deriveRoutingHints(graph),
    items: [...byScreen.entries()].map(([id, items]) => [id, items]),
  };
}
