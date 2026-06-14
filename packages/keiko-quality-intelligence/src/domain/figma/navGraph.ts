// Deterministic screen navigation/flow graph from a Screen-IR (Epic #750, Issue #811).
//
// Pure domain: a Screen-IR (#752) carries `screens` (per-screen kept-node trees) and the raw
// inter-screen `links` (prototype transitions `{ sourceNodeId, trigger, targetNodeId }`). This
// module reduces them, with NO model and NO IO, to:
//   • a navigation GRAPH — nodes = screens, edges = transitions whose source AND target node ids
//     each resolve to an owning screen; links whose target resolves to no screen are recorded as
//     `unresolvedLinks` (an "edge outside any screen"); flow-entry links (a canvas source outside
//     any screen) mark `entryScreenIds` without an edge;
//   • reachability — `entryScreenIds`, `unreachableScreenIds`, `deadEndScreenIds`;
//   • framework-agnostic ROUTING HINTS (screen → outgoing transitions) for design-to-code (#755),
//     with no router/framework vocabulary;
//   • per-screen navigation/flow/coverage TEST ITEMS reusing #754's StructuralTestItem shape, so
//     they compose into the figma-snapshot QI run additively through `deriveScreenTestBaseline`'s
//     `extraItems` seam.
//
// Generic by construction: rules read only structural shape (which node ids own which screen, which
// trigger reaches which screen). No screen name, layout, mask style, or copy is special-cased.
// Deterministic: every emitted collection is stable-sorted and carries no timestamp, so the same IR
// yields a byte-identical result. Flow derivation is bounded (max depth + acyclic visited set) so a
// cycle or self-loop never produces an unbounded path set. Total flow count is also bounded by
// MAX_NAV_FLOWS so a dense fully-connected graph cannot exhaust memory during QI ingestion.

import type { InterScreenLink, IrNode, ScreenIr, ScreenIrResult } from "./irTypes.js";
import type { StructuralTestItem } from "./screenIrTestBaseline.js";

const FLOW_START_TRIGGER = "FLOW_START";
const DEFAULT_MAX_FLOW_DEPTH = 6;
// Total cap on enumerated flows: a fully-connected 12-screen graph at depth 6 yields 773,784+ paths
// and hangs/OOMs QI ingestion. The cap preserves the deterministic prefix (derivation order is
// already stable) and appends one coverage-notice when truncated. Mirrors MAX_A11Y_ITEMS_PER_SCREEN.
const MAX_NAV_FLOWS = 500;

/** A graph node: one screen. */
export interface NavNode {
  readonly screenId: string;
  readonly screenName: string;
}

/** A resolved transition between two screens (both endpoints own a screen). */
export interface NavEdge {
  readonly fromScreenId: string;
  readonly trigger: string;
  readonly toScreenId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
}

/** A raw link whose target node id resolves to no screen — an edge that leaves the known screens. */
export interface UnresolvedLink {
  readonly sourceNodeId: string;
  readonly trigger: string;
  readonly targetNodeId: string;
}

/** The deterministic navigation graph plus reachability analysis. */
export interface NavGraph {
  readonly nodes: readonly NavNode[];
  readonly edges: readonly NavEdge[];
  readonly unresolvedLinks: readonly UnresolvedLink[];
  /** Screens that are flow entry points (or the synthetic first-screen entry when none exist). */
  readonly entryScreenIds: readonly string[];
  /** Reachable-by-no-edge-or-entry screens, stable-sorted. */
  readonly unreachableScreenIds: readonly string[];
  /** Reachable screens with no outgoing edge, stable-sorted. */
  readonly deadEndScreenIds: readonly string[];
}

/** A bounded, acyclic multi-step path through the graph. */
export interface NavFlow {
  readonly screenIds: readonly string[];
}

/** A framework-agnostic routing hint: one screen and its outgoing transitions. */
export interface RoutingHint {
  readonly screenId: string;
  readonly transitions: readonly { readonly trigger: string; readonly toScreenId: string }[];
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Build a nodeId → screenId index by walking every screen's IR tree once. A node id that appears in
// more than one screen (malformed input) keeps its first (stable-order) owner.
function buildNodeOwnership(screens: readonly ScreenIr[]): ReadonlyMap<string, string> {
  const owner = new Map<string, string>();
  const visit = (node: IrNode, screenId: string): void => {
    if (!owner.has(node.id)) owner.set(node.id, screenId);
    for (const child of node.children) visit(child, screenId);
  };
  for (const screen of [...screens].sort((a, b) => byString(a.id, b.id))) {
    visit(screen.root, screen.id);
  }
  return owner;
}

// Injective composite key over a field tuple. The previous NUL-delimited join was non-injective:
// a value carrying the separator byte could shift a field boundary so two distinct tuples collapse
// to one key — the exact defect #752 fixed in links.ts linkKey, and a Figma node id or trigger from
// an (untrusted) snapshot is not guaranteed separator-free. JSON.stringify escapes the quote,
// backslash, and control bytes, so the encoding is total and unambiguous for any input. Used for
// de-duplication, identity hashing, and stable total ordering so every emitted collection stays
// byte-identical for a given input.
const compositeKey = (...parts: readonly string[]): string => JSON.stringify(parts);

const edgeKey = (e: NavEdge): string =>
  compositeKey(e.fromScreenId, e.trigger, e.toScreenId, e.sourceNodeId, e.targetNodeId);

const flowKey = (screenIds: readonly string[]): string => compositeKey(...screenIds);

interface ClassifiedLinks {
  readonly edges: readonly NavEdge[];
  readonly unresolved: readonly UnresolvedLink[];
  readonly entryScreenIds: readonly string[];
}

// Classify each raw link against the node-ownership index. A target that owns a screen and a source
// that owns a screen yields an edge; a FLOW_START whose target owns a screen marks an entry; any
// link whose target owns no screen is unresolved (an edge that leaves the known screens).
function classifyLinks(
  links: readonly InterScreenLink[],
  owner: ReadonlyMap<string, string>,
): ClassifiedLinks {
  const edges = new Map<string, NavEdge>();
  const unresolved: UnresolvedLink[] = [];
  const entries = new Set<string>();
  for (const link of links) {
    const toScreenId = owner.get(link.targetNodeId);
    if (toScreenId === undefined) {
      unresolved.push({ ...link });
      continue;
    }
    const fromScreenId = owner.get(link.sourceNodeId);
    if (fromScreenId === undefined) {
      if (link.trigger === FLOW_START_TRIGGER) entries.add(toScreenId);
      continue;
    }
    const edge: NavEdge = {
      fromScreenId,
      trigger: link.trigger,
      toScreenId,
      sourceNodeId: link.sourceNodeId,
      targetNodeId: link.targetNodeId,
    };
    edges.set(edgeKey(edge), edge);
  }
  return {
    edges: [...edges.values()].sort((a, b) => byString(edgeKey(a), edgeKey(b))),
    // Total order: targetNodeId alone is not injective across unresolved links sharing a target, so
    // input order would leak into the output and break the byte-identical guarantee (DET1). The
    // full tuple key restores a deterministic total order under ties.
    unresolved: [...unresolved].sort((a, b) =>
      byString(
        compositeKey(a.targetNodeId, a.trigger, a.sourceNodeId),
        compositeKey(b.targetNodeId, b.trigger, b.sourceNodeId),
      ),
    ),
    entryScreenIds: [...entries].sort(byString),
  };
}

// Reachable set by BFS from the entry screens over the directed edges.
function reachableFrom(
  entryScreenIds: readonly string[],
  edges: readonly NavEdge[],
): ReadonlySet<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.fromScreenId) ?? [];
    list.push(edge.toScreenId);
    adjacency.set(edge.fromScreenId, list);
  }
  const reached = new Set<string>(entryScreenIds);
  const queue = [...entryScreenIds];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    for (const next of adjacency.get(current) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  return reached;
}

/**
 * Derive the deterministic navigation graph from a Screen-IR result. When the IR carries no
 * flow-entry link, the first screen in stable id order is used as the synthetic entry so reachability
 * is still well-defined. The result is byte-identical for a given input.
 */
export function deriveNavGraph(ir: ScreenIrResult): NavGraph {
  const nodes: NavNode[] = [...ir.screens]
    .map((s) => ({ screenId: s.id, screenName: s.name }))
    .sort((a, b) => byString(a.screenId, b.screenId));
  const owner = buildNodeOwnership(ir.screens);
  const { edges, unresolved, entryScreenIds } = classifyLinks(ir.links, owner);

  const effectiveEntries =
    entryScreenIds.length > 0
      ? entryScreenIds
      : nodes.length > 0 && nodes[0] !== undefined
        ? [nodes[0].screenId]
        : [];
  const reached = reachableFrom(effectiveEntries, edges);
  const withOutgoing = new Set(edges.map((e) => e.fromScreenId));

  return {
    nodes,
    edges,
    unresolvedLinks: unresolved,
    entryScreenIds: effectiveEntries,
    unreachableScreenIds: nodes.map((n) => n.screenId).filter((id) => !reached.has(id)),
    deadEndScreenIds: nodes
      .map((n) => n.screenId)
      .filter((id) => reached.has(id) && !withOutgoing.has(id)),
  };
}

// Shared counter passed into walkFlows so the caller can stop enumeration once the global cap is
// reached. Using an object preserves pass-by-reference semantics without module-level state.
interface FlowCounter {
  count: number;
}

// Depth-first enumeration of acyclic paths from one entry, bounded by maxDepth, the visited set, and
// the shared counter so dense graphs cannot exhaust memory or hang QI ingestion. Each path of length
// ≥ 2 is a flow; the single-screen entry path is not emitted. Paths are in deterministic edge order.
function walkFlows(
  start: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  maxDepth: number,
  cap: number,
  counter: FlowCounter,
  out: string[][],
): void {
  const recurse = (path: readonly string[]): void => {
    if (counter.count >= cap) return;
    if (path.length >= 2) {
      out.push([...path]);
      counter.count += 1;
    }
    if (path.length >= maxDepth) return;
    const last = path[path.length - 1];
    if (last === undefined) return;
    for (const next of adjacency.get(last) ?? []) {
      if (counter.count >= cap) return;
      if (!path.includes(next)) recurse([...path, next]);
    }
  };
  recurse([start]);
}

// Build the adjacency map once; edges are already stable-sorted so adjacency lists are deterministic.
// Parallel edges (distinct prototype reactions from the same screen to the same target — two buttons,
// or the same button with two triggers, both reaching A → B) must NOT push duplicate target entries:
// walkFlows would traverse the identical sub-path once per duplicate, inflating the shared flow
// counter past the number of DISTINCT flows. Because deriveNavTestItemsByScreen decides whether to
// emit the truncation notice from the post-dedup flows.length, an inflated counter can hit
// MAX_NAV_FLOWS and truncate enumeration while flows.length stays below the cap — silently dropping
// flows with NO coverage-notice (CORR1). Navigation adjacency is a reachability relation, so a
// per-source target set is the correct model and keeps the counter equal to the distinct-flow count.
// First-occurrence order is preserved (edges are stable-sorted) so the derivation stays byte-identical.
function buildAdjacency(edges: readonly NavEdge[]): ReadonlyMap<string, readonly string[]> {
  const adj = new Map<string, string[]>();
  const seen = new Map<string, Set<string>>();
  for (const edge of edges) {
    const list = adj.get(edge.fromScreenId) ?? [];
    const seenTargets = seen.get(edge.fromScreenId) ?? new Set<string>();
    if (seenTargets.has(edge.toScreenId)) continue;
    list.push(edge.toScreenId);
    seenTargets.add(edge.toScreenId);
    adj.set(edge.fromScreenId, list);
    seen.set(edge.fromScreenId, seenTargets);
  }
  return adj;
}

/**
 * Derive bounded, acyclic multi-step flow paths from the graph's entry screens. `maxDepth` caps the
 * number of screens per path (default {@link DEFAULT_MAX_FLOW_DEPTH}); the per-path visited set makes
 * every path acyclic, so a cycle or self-loop never yields an unbounded path set. Total flows are
 * capped at {@link MAX_NAV_FLOWS} so a dense fully-connected graph cannot exhaust memory. Stable-sorted.
 */
export function deriveNavFlows(
  graph: NavGraph,
  maxDepth: number = DEFAULT_MAX_FLOW_DEPTH,
): readonly NavFlow[] {
  const adjacency = buildAdjacency(graph.edges);
  const collected: string[][] = [];
  const counter: FlowCounter = { count: 0 };
  for (const entry of graph.entryScreenIds) {
    if (counter.count >= MAX_NAV_FLOWS) break;
    walkFlows(entry, adjacency, maxDepth, MAX_NAV_FLOWS, counter, collected);
  }
  const byKey = new Map<string, NavFlow>();
  for (const screenIds of collected) byKey.set(flowKey(screenIds), { screenIds });
  return [...byKey.values()].sort((a, b) => byString(flowKey(a.screenIds), flowKey(b.screenIds)));
}

/**
 * Framework-agnostic routing hints for design-to-code (#755): every screen mapped to its outgoing
 * transitions (`trigger` + `toScreenId`). No router, path, or framework vocabulary — a neutral
 * structure the target adapter shapes into its own routing. Stable-sorted per screen and transition.
 */
export function deriveRoutingHints(graph: NavGraph): readonly RoutingHint[] {
  return graph.nodes.map((node) => ({
    screenId: node.screenId,
    transitions: graph.edges
      .filter((e) => e.fromScreenId === node.screenId)
      .map((e) => ({ trigger: e.trigger, toScreenId: e.toScreenId }))
      .sort((a, b) =>
        byString(compositeKey(a.trigger, a.toScreenId), compositeKey(b.trigger, b.toScreenId)),
      ),
  }));
}

const screenNameOf = (graph: NavGraph, screenId: string): string =>
  graph.nodes.find((n) => n.screenId === screenId)?.screenName ?? screenId;

function navItemId(prefix: string, key: string): string {
  // Deterministic non-cryptographic id (FNV-1a) — stable across runs, no IO. Mirrors #754's scheme.
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function navigationItem(graph: NavGraph, edge: NavEdge): StructuralTestItem {
  const from = screenNameOf(graph, edge.fromScreenId);
  const to = screenNameOf(graph, edge.toScreenId);
  return {
    id: navItemId("fnav", edgeKey(edge)),
    category: "navigation",
    screenId: edge.fromScreenId,
    screenName: from,
    sourceNodeId: edge.sourceNodeId,
    title: `From screen "${from}", trigger "${edge.trigger}" reaches screen "${to}"`,
  };
}

function flowItem(graph: NavGraph, flow: NavFlow): StructuralTestItem {
  const entry = flow.screenIds[0] ?? "";
  const names = flow.screenIds.map((id) => `"${screenNameOf(graph, id)}"`).join(" → ");
  return {
    id: navItemId("fflow", flowKey(flow.screenIds)),
    category: "flow",
    screenId: entry,
    screenName: screenNameOf(graph, entry),
    title: `Flow ${names} completes end to end`,
  };
}

function coverageItem(
  graph: NavGraph,
  screenId: string,
  kind: "unreachable" | "dead end",
): StructuralTestItem {
  const name = screenNameOf(graph, screenId);
  const title =
    kind === "unreachable"
      ? `Screen "${name}" is unreachable: no navigation reaches it`
      : `Screen "${name}" is a dead end: no navigation leaves it`;
  return {
    id: navItemId("fcov", compositeKey(kind, screenId)),
    category: "coverage-notice",
    screenId,
    screenName: name,
    title,
  };
}

// Emitted as a coverage-notice when flow enumeration was truncated by MAX_NAV_FLOWS. Attributed to
// the synthetic entry screen (stable: first entry id) so it appears in a well-defined byScreen slot.
function flowCapNoticeItem(graph: NavGraph, totalEnumerated: number): StructuralTestItem {
  const entryId = graph.entryScreenIds[0] ?? graph.nodes[0]?.screenId ?? "";
  const name = screenNameOf(graph, entryId);
  return {
    id: navItemId("fnavcap", compositeKey("cap", entryId)),
    category: "coverage-notice",
    screenId: entryId,
    screenName: name,
    title: `Flow enumeration was truncated at ${String(MAX_NAV_FLOWS)} paths (${String(totalEnumerated)} emitted); denser graphs may have additional flows`,
  };
}

function pushItem(byScreen: Map<string, StructuralTestItem[]>, item: StructuralTestItem): void {
  const list = byScreen.get(item.screenId) ?? [];
  list.push(item);
  byScreen.set(item.screenId, list);
}

/**
 * Derive per-screen navigation/flow/coverage test items, keyed by the screen they are attributed to.
 * Reuses #754's StructuralTestItem shape so the items compose additively through
 * `deriveScreenTestBaseline(screen, extraItems)`. Every edge → a navigation item on its source
 * screen; every multi-step flow → a flow item on its entry screen; every unreachable/dead-end screen
 * → a coverage-notice item. When flow enumeration is truncated by MAX_NAV_FLOWS, one additional
 * coverage-notice records the omission. Deterministic: items are emitted in the graph's stable order.
 */
export function deriveNavTestItemsByScreen(
  graph: NavGraph,
  maxFlowDepth: number = DEFAULT_MAX_FLOW_DEPTH,
): ReadonlyMap<string, readonly StructuralTestItem[]> {
  const byScreen = new Map<string, StructuralTestItem[]>();
  for (const edge of graph.edges) pushItem(byScreen, navigationItem(graph, edge));
  const flows = deriveNavFlows(graph, maxFlowDepth);
  for (const flow of flows) pushItem(byScreen, flowItem(graph, flow));
  if (flows.length >= MAX_NAV_FLOWS) {
    pushItem(byScreen, flowCapNoticeItem(graph, flows.length));
  }
  for (const id of graph.unreachableScreenIds)
    pushItem(byScreen, coverageItem(graph, id, "unreachable"));
  for (const id of graph.deadEndScreenIds) pushItem(byScreen, coverageItem(graph, id, "dead end"));
  return byScreen;
}
