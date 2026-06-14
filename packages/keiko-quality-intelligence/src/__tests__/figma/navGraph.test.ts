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
    // A self-looping screen has an outgoing edge and is its own entry, so it is neither a dead end
    // nor unreachable — pins the fromScreenId-based outgoing-set classification (GAP7).
    expect(graph.deadEndScreenIds).toEqual([]);
    expect(graph.unreachableScreenIds).toEqual([]);
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
    // Screen names are load-bearing for human-readable flow attribution — a mutation that strips
    // them from the title is caught: the full A → B → C path names its first and last screens (GAP5).
    expect(flows.some((i) => i.title.includes('"A"') && i.title.includes('"C"'))).toBe(true);
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
    // The unreachable screen's own name must appear in the notice for attributability (GAP5).
    expect(notices[0]?.title).toContain("Orphan");
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
    // The dead-end screen's own name must appear in the notice for attributability (GAP5).
    expect(notices.some((n) => n.title.includes('"B"'))).toBe(true);
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

// ─── Fix #1: dense-graph flow cap (DoS regression) ──────────────────────────
// 12 fully-connected screens produce 773,784+ acyclic paths without the cap.

describe("deriveNavFlows / deriveNavTestItemsByScreen — MAX_NAV_FLOWS cap (Fix #1)", () => {
  // Build a fully-connected graph of N screens (every screen links to every other).
  const fullyConnected = (n: number): ScreenIrResult => {
    const screens: ScreenIr[] = [];
    const links: InterScreenLink[] = [];
    for (let i = 0; i < n; i += 1) {
      const si = String(i);
      screens.push(screen(`s${si}`, `Screen${si}`, node(`root${si}`, [node(`btn${si}`)])));
    }
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if (i !== j) links.push(link(`btn${String(i)}`, "ON_CLICK", `root${String(j)}`));
      }
    }
    return result(screens, links);
  };

  it("completes quickly and caps flow count at ≤ MAX_NAV_FLOWS for a 12-screen dense graph", () => {
    const start = Date.now();
    const graph = deriveNavGraph(fullyConnected(12));
    const flows = deriveNavFlows(graph);
    const elapsed = Date.now() - start;

    // Must finish fast (well under 2 s even on slow CI) rather than materialising 773,784 paths.
    expect(elapsed).toBeLessThan(2000);
    // The cap is 500; enumeration must not exceed it.
    expect(flows.length).toBeLessThanOrEqual(500);
    expect(flows.length).toBeGreaterThan(0);
  });

  it("emits a coverage-notice item when flow enumeration is truncated", () => {
    const graph = deriveNavGraph(fullyConnected(12));
    const byScreen = deriveNavTestItemsByScreen(graph);
    const allItems = [...byScreen.values()].flat();
    const notices = allItems.filter(
      (i) => i.category === "coverage-notice" && i.title.includes("truncated"),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.title).toContain("500");
    // The cap notice lands on the (synthetic) entry screen so it occupies a well-defined slot (GAP3).
    expect(notices[0]?.screenId).toBe(graph.entryScreenIds[0]);
  });

  it("does not emit a coverage-notice when flow count is under the cap", () => {
    // A simple 3-screen linear chain produces only a few flows.
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
    const allItems = [...byScreen.values()].flat();
    const capNotices = allItems.filter(
      (i) => i.category === "coverage-notice" && i.title.includes("truncated"),
    );
    expect(capNotices).toHaveLength(0);
  });

  it("counts parallel edges once: a duplicated-edge graph yields the same flows (CORR1)", () => {
    // Parallel edges = distinct prototype reactions from the same screen to the same target (a second
    // source node, or a second trigger). Each must still yield its own navigation item, but they must
    // NOT inflate flow enumeration: before buildAdjacency de-duplicated targets per source, walkFlows
    // traversed the identical sub-path once per duplicate, so the shared counter hit MAX_NAV_FLOWS
    // while the de-duplicated flow set stayed below the cap — silently truncating flows with NO notice.
    const base = fullyConnected(5);
    const withParallel = base.screens.map((s, i) => ({
      ...s,
      root: { ...s.root, children: [...s.root.children, node(`alt${String(i)}`)] },
    }));
    // Same trigger, different source node: the parallel edge sorts adjacent to its twin per target,
    // so the duplicate target entries interleave in the adjacency list. That is the order in which a
    // raw multiset adjacency over-counts walkFlows and truncates the de-duplicated flow set early.
    const parallelLinks: InterScreenLink[] = [];
    for (let i = 0; i < 5; i += 1) {
      for (let j = 0; j < 5; j += 1) {
        if (i !== j) parallelLinks.push(link(`alt${String(i)}`, "ON_CLICK", `root${String(j)}`));
      }
    }
    const duplicated = result(withParallel, [...base.links, ...parallelLinks]);

    const simpleGraph = deriveNavGraph(base);
    const dupGraph = deriveNavGraph(duplicated);
    // Reachability is identical, so the enumerated flow set must be byte-identical (no truncation).
    expect(deriveNavFlows(dupGraph)).toEqual(deriveNavFlows(simpleGraph));
    // Every parallel edge is still a distinct transition: 5×4 base + 5×4 parallel = 40 edges.
    expect(simpleGraph.edges).toHaveLength(20);
    expect(dupGraph.edges).toHaveLength(40);
    // The 64 reachable acyclic flows from the synthetic entry stay under the 500 cap → no notice.
    const dupNotices = [...deriveNavTestItemsByScreen(dupGraph).values()]
      .flat()
      .filter((item) => item.category === "coverage-notice" && item.title.includes("truncated"));
    expect(dupNotices).toHaveLength(0);
  });
});

// ─── Unresolved links ───────────────────────────────────────────────────────

describe("deriveNavGraph — unresolved links", () => {
  it("surfaces a target outside any screen as an unresolved link", () => {
    const unresolved: InterScreenLink = {
      sourceNodeId: "btn-ext",
      trigger: "ON_CLICK",
      targetNodeId: "ghost-node",
    };
    const graph = deriveNavGraph(
      result([screen("s-a", "A", node("a-root", [node("btn-ext")]))], [unresolved]),
    );
    expect(graph.edges).toHaveLength(0);
    expect(graph.unresolvedLinks).toHaveLength(1);
    expect(graph.unresolvedLinks[0]?.targetNodeId).toBe("ghost-node");
    expect(graph.unresolvedLinks[0]?.trigger).toBe("ON_CLICK");
  });

  it("keeps multiple unresolved links in the graph", () => {
    const links: InterScreenLink[] = [
      { sourceNodeId: "btn-a", trigger: "ON_CLICK", targetNodeId: "missing-a" },
      { sourceNodeId: "btn-b", trigger: "ON_CLICK", targetNodeId: "ghost-node" },
    ];
    const graph = deriveNavGraph(
      result([screen("s-a", "A", node("a-root", [node("btn-a"), node("btn-b")]))], links),
    );
    expect(graph.unresolvedLinks).toHaveLength(2);
    const targets = graph.unresolvedLinks.map((u) => u.targetNodeId);
    expect(targets).toContain("missing-a");
    expect(targets).toContain("ghost-node");
  });

  it("orders unresolved links deterministically under a shared targetNodeId (total order, DET1)", () => {
    // Two unresolved links to the SAME target differ only in trigger/source. Sorting by targetNodeId
    // alone is not a total order, so input order would leak; the full-tuple key restores determinism.
    const tree = (): IrNode => node("a-root", [node("btn-x"), node("btn-y")]);
    const forward = deriveNavGraph(
      result(
        [screen("s-a", "A", tree())],
        [
          { sourceNodeId: "btn-y", trigger: "ON_HOVER", targetNodeId: "ghost" },
          { sourceNodeId: "btn-x", trigger: "ON_CLICK", targetNodeId: "ghost" },
        ],
      ),
    );
    const reversed = deriveNavGraph(
      result(
        [screen("s-a", "A", tree())],
        [
          { sourceNodeId: "btn-x", trigger: "ON_CLICK", targetNodeId: "ghost" },
          { sourceNodeId: "btn-y", trigger: "ON_HOVER", targetNodeId: "ghost" },
        ],
      ),
    );
    expect(forward.unresolvedLinks).toEqual(reversed.unresolvedLinks);
    // The composite key (targetNodeId, trigger, sourceNodeId) orders ON_CLICK before ON_HOVER.
    expect(forward.unresolvedLinks.map((u) => u.trigger)).toEqual(["ON_CLICK", "ON_HOVER"]);
  });
});

// ─── Injective keys ─────────────────────────────────────────────────────────

describe("deriveNavGraph — injective transition keys", () => {
  it("keeps NUL-colliding transitions distinct (composite key, not a raw separator join, INJ2)", () => {
    // Under the previous NUL-delimited key, edgeKey for the tuples ["S","a","S","b\u0000c","d"] and
    // ["S","a","S","b","c\u0000d"] joins to the identical string, so the edge de-dup Map silently
    // drops one distinct prototype transition (and its navigation test). JSON.stringify keeps them
    // apart. A snapshot can carry such node ids — the schema does not forbid control bytes.
    const nul = String.fromCodePoint(0);
    const root = node("S-root", [node(`b${nul}c`), node("d"), node("b"), node(`c${nul}d`)]);
    const graph = deriveNavGraph(
      result(
        [screen("S", "Screen", root)],
        [link(`b${nul}c`, "a", "d"), link("b", "a", `c${nul}d`)],
      ),
    );
    expect(graph.edges).toHaveLength(2);
    const navItems = [...deriveNavTestItemsByScreen(graph).values()]
      .flat()
      .filter((item) => item.category === "navigation");
    expect(navItems).toHaveLength(2);
    expect(new Set(navItems.map((item) => item.id)).size).toBe(2);
  });
});
