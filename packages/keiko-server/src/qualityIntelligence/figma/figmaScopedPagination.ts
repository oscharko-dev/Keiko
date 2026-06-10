// Scoped, bounded depth pagination for the Figma snapshot-build (Epic #750, Issues #837, #759).
//
// PROBLEM (#837, found by live verification in #757): a single scoped `nodes?depth=4` fetch of the
// canvas captures layout + structure + design tokens but almost NO in-screen text — on real,
// component-instance-heavy enterprise boards the meaningful UI text lives DEEP inside instance
// subtrees (verified content-free: text concentrated at screen-relative depths 7–18). A naive
// deeper single fetch is not an option: one real screen alone is 17k–20k nodes, far past the
// per-fetch oversize guard (#759), and the whole canvas is hundreds of thousands of nodes.
//
// SOLUTION: per-screen scoped pagination, still strictly WITHIN the snapshot-build communication
// boundary (Figma is contacted only here, during the build; every downstream stage reads the stored
// Snapshot). After the screens are discovered structurally from one shallow fetch, each screen
// subtree is completed by a breadth-first sequence of bounded `depth=pageDepth` fetches: each fetch
// is small (one subtree, ≤ a per-fetch budget), and the assembled per-screen tree is bounded by a
// per-screen node + request budget. Breadth-first means the shallow, most-meaningful levels are
// captured first; when a budget is hit the deep tail is dropped and the screen is reported truncated
// (a coverage signal, never a crash). Figma truncates a depth-limited subtree by returning
// `children: []` on the frontier container nodes — that empty array on a container at exactly
// `pageDepth` is the re-fetch marker.
//
// Generic by construction: no screen name, layout, mask style, copy, or board-specific threshold is
// read — only structural node type and the generic budgets below. Deterministic: screens and each
// frontier are processed in Figma's stable child order, so the same board state yields the same
// assembled tree (and a budget cut-off truncates the same deterministic tail every run).

/** A raw Figma node as returned by `GET /v1/files/:key/nodes` — provider-shaped, partially typed. */
export interface RawFigmaNode {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  children?: RawFigmaNode[];
  [key: string]: unknown;
}

/** Fetches one node id's subtree at the configured `pageDepth`. Returns undefined on a hard failure
 *  (the caller keeps the shallow content rather than aborting the whole build). */
export type ScopedNodeFetcher = (nodeId: string) => Promise<RawFigmaNode | undefined>;

/**
 * Generic, board-agnostic budgets that bound the per-screen pagination. The global ceiling is the
 * deterministic product `maxScreensDeep × maxNodesPerScreen` (and `× maxFetchesPerScreen`): there is
 * NO shared, live, cross-screen counter, so screens are fully independent and the assembled tree is
 * identical regardless of how the concurrent fetches interleave (load-bearing for the drift hash,
 * #735). None of these is tuned to a sample board; all are overridable per deployment.
 */
export interface ScopedPaginationLimits {
  /** Depth of each individual scoped fetch (the discovery fetch and every per-screen fetch). A larger
   *  depth captures a whole shallow screen in one request and a deep screen in fewer rounds — the
   *  dominant lever against per-request latency — at the cost of larger individual responses. */
  readonly pageDepth: number;
  /** Per-screen raw-node budget; breadth-first expansion stops once a screen reaches it. */
  readonly maxNodesPerScreen: number;
  /** Per-screen fetch cap; bounds requests (and thus wall-clock) for one dense screen. */
  readonly maxFetchesPerScreen: number;
  /** Cap on how many discovered screens are deep-fetched; a board with more reports `capped`. */
  readonly maxScreensDeep: number;
  /**
   * Max in-flight scoped fetches across the WHOLE build (a shared gate over all screens + levels).
   * Real boards have multi-second per-subtree latency, so this pool is the dominant wall-clock lever.
   * It throttles concurrency only — the result is order-independent and deterministic. The 429
   * backoff (#759) absorbs the burst. Clamp ≥ 1.
   */
  readonly fetchConcurrency: number;
}

/**
 * Defaults balanced for Figma's cost-based rate limit on real, latency-bound boards (NOT tuned to any
 * sample board's content). `pageDepth=8` keeps each request cheap enough to avoid provoking sustained
 * 429s; a small shared pool of 3 in-flight fetches parallelises across screens without bursting the
 * limit; the per-screen budgets expand the densest branches further. On a normal board (screens
 * shallower than `pageDepth`) a single per-screen fetch captures everything and no round runs. The
 * 429 backoff (#759) absorbs occasional rate-limit responses; all of these are deployment-overridable.
 */
export const DEFAULT_SCOPED_PAGINATION_LIMITS: ScopedPaginationLimits = {
  pageDepth: 8,
  maxNodesPerScreen: 10_000,
  maxFetchesPerScreen: 32,
  maxScreensDeep: 80,
  fetchConcurrency: 3,
};

/** Coverage telemetry for one deep snapshot fetch — surfaced in the snapshot summary (never a leak). */
export interface FigmaScopeCoverage {
  /** Screens discovered structurally under the scoped root. */
  readonly screenCount: number;
  /** Screens that received a per-screen deep fetch (≤ `maxScreensDeep`). */
  readonly screensDeepFetched: number;
  /** Screens whose deep content was cut short by a per-screen budget (a coverage signal). */
  readonly screensTruncated: number;
  /** Total raw nodes in the assembled deep document. */
  readonly nodeCount: number;
  /** Total per-screen scoped fetches performed (excludes the single discovery fetch). */
  readonly fetchCount: number;
  /** True when more screens were discovered than `maxScreensDeep`, so some stayed shallow. */
  readonly capped: boolean;
}

export interface DeepFetchResult {
  readonly document: RawFigmaNode;
  readonly coverage: FigmaScopeCoverage;
}

const SCREEN_TYPES: ReadonlySet<string> = new Set(["FRAME", "INSTANCE"]);
const CONTAINER_TYPES: ReadonlySet<string> = new Set(["CANVAS", "SECTION"]);
// Node types whose internals are worth a deeper fetch. Leaves (TEXT, VECTOR, RECTANGLE, …) never
// carry children, so re-fetching them would waste a request; only these container types are expanded.
const PAGINATE_CONTAINER: ReadonlySet<string> = new Set([
  "FRAME",
  "GROUP",
  "INSTANCE",
  "COMPONENT",
  "COMPONENT_SET",
  "SECTION",
]);

const typeOf = (node: RawFigmaNode): string => (typeof node.type === "string" ? node.type : "");
const idOf = (node: RawFigmaNode): string => (typeof node.id === "string" ? node.id : "");
const childrenOf = (node: RawFigmaNode): RawFigmaNode[] =>
  Array.isArray(node.children) ? node.children : [];

const countNodes = (node: RawFigmaNode): number => {
  let total = 1;
  for (const child of childrenOf(node)) total += countNodes(child);
  return total;
};

/**
 * The screen FRAME/INSTANCE nodes under a scoped root, descending only through container groupings
 * (CANVAS/SECTION) — never into a screen's own body, so a nested frame stays part of its screen.
 * Mirrors the pure-domain `detectScreens` rule (#752) at the connector (raw-node) layer. A directly
 * scoped screen root is the sole screen.
 */
export const discoverScreenNodes = (root: RawFigmaNode): readonly RawFigmaNode[] => {
  if (SCREEN_TYPES.has(typeOf(root))) return [root];
  if (!CONTAINER_TYPES.has(typeOf(root))) return [];
  const screens: RawFigmaNode[] = [];
  const walk = (node: RawFigmaNode): void => {
    for (const child of childrenOf(node)) {
      if (SCREEN_TYPES.has(typeOf(child))) screens.push(child);
      else if (CONTAINER_TYPES.has(typeOf(child))) walk(child);
    }
  };
  walk(root);
  return screens;
};

// Collect the container frontier nodes of a `pageDepth`-limited subtree: containers at exactly
// `pageDepth` carrying an empty `children` array (Figma's truncation marker). These are the only
// nodes worth re-fetching to descend further.
const collectFrontier = (node: RawFigmaNode, pageDepth: number): RawFigmaNode[] => {
  const out: RawFigmaNode[] = [];
  const rec = (current: RawFigmaNode, depth: number): void => {
    if (depth === pageDepth) {
      if (PAGINATE_CONTAINER.has(typeOf(current)) && childrenOf(current).length === 0) {
        out.push(current);
      }
      return;
    }
    for (const child of childrenOf(current)) rec(child, depth + 1);
  };
  rec(node, 0);
  return out;
};

// A concurrency-limited fetch wrapper shared across all screens + levels: at most `limit` scoped
// fetches are ever in flight, no matter how many screens deepen in parallel. It throttles only — it
// never reorders results a caller awaits — so it does not affect the deterministic assembled tree.
const createFetchGate = (fetchNode: ScopedNodeFetcher, limit: number): ScopedNodeFetcher => {
  const cap = Math.max(1, limit);
  let active = 0;
  const queue: (() => void)[] = [];
  const acquire = (): Promise<void> => {
    if (active < cap) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => queue.push(resolve));
  };
  const release = (): void => {
    const next = queue.shift();
    if (next !== undefined)
      next(); // hand the slot straight to the next waiter (active unchanged)
    else active -= 1;
  };
  return async (nodeId: string): Promise<RawFigmaNode | undefined> => {
    await acquire();
    try {
      return await fetchNode(nodeId);
    } finally {
      release();
    }
  };
};

interface ScreenOutcome {
  readonly node: RawFigmaNode;
  readonly deepFetched: boolean;
  readonly truncated: boolean;
  readonly fetchCount: number;
}

interface LevelResult {
  readonly nextFrontier: RawFigmaNode[];
  readonly fetchesUsed: number;
  readonly nodesAdded: number;
  /** True when the per-screen fetch budget cut this level short (deeper frontier left unexpanded). */
  readonly cut: boolean;
}

// Expand one breadth-first level: fetch the (budget-capped) frontier nodes together through the gate,
// splice their children back in stable order, and collect the next level. Pure of any cross-screen
// state — its result depends only on the inputs, so concurrent interleaving cannot change it.
const expandLevel = async (
  frontier: readonly RawFigmaNode[],
  gatedFetch: ScopedNodeFetcher,
  pageDepth: number,
  fetchBudget: number,
): Promise<LevelResult> => {
  const level = frontier.slice(0, Math.max(0, fetchBudget));
  const cut = level.length < frontier.length;
  const deeps = await Promise.all(level.map((fnode) => gatedFetch(idOf(fnode))));
  const nextFrontier: RawFigmaNode[] = [];
  let nodesAdded = 0;
  for (let k = 0; k < level.length; k += 1) {
    const frontierNode = level[k];
    const deep = deeps[k];
    if (frontierNode === undefined || deep === undefined) continue;
    const deepChildren = childrenOf(deep);
    if (deepChildren.length > 0) {
      frontierNode.children = deepChildren;
      nodesAdded += countNodes(deep) - 1;
      for (const f of collectFrontier(deep, pageDepth)) nextFrontier.push(f);
    }
  }
  return { nextFrontier, fetchesUsed: level.length, nodesAdded, cut };
};

// Complete one screen subtree by breadth-first bounded pagination. Each level's frontier fetches are
// dispatched together through the shared gate (so they run in parallel with other screens' fetches),
// then applied in stable order. Bounded by the per-screen node + fetch budgets only — independent of
// every other screen — so the result is deterministic regardless of concurrent interleaving.
const completeScreen = async (
  shallow: RawFigmaNode,
  gatedFetch: ScopedNodeFetcher,
  limits: ScopedPaginationLimits,
): Promise<ScreenOutcome> => {
  const base = await gatedFetch(idOf(shallow));
  if (base === undefined) {
    // Could not deepen this screen — keep the shallow content (no crash, no fabrication).
    return { node: shallow, deepFetched: false, truncated: false, fetchCount: 1 };
  }
  let screenNodes = countNodes(base);
  let fetches = 1;
  let truncated = false;
  let frontier = collectFrontier(base, limits.pageDepth);

  while (frontier.length > 0) {
    if (screenNodes >= limits.maxNodesPerScreen || fetches >= limits.maxFetchesPerScreen) {
      truncated = true;
      break;
    }
    const level = await expandLevel(
      frontier,
      gatedFetch,
      limits.pageDepth,
      limits.maxFetchesPerScreen - fetches,
    );
    fetches += level.fetchesUsed;
    screenNodes += level.nodesAdded;
    if (level.cut) {
      truncated = true;
      break;
    }
    frontier = level.nextFrontier;
  }
  if (frontier.length > 0) truncated = true;
  return { node: base, deepFetched: true, truncated, fetchCount: fetches };
};

// Rebuild the scoped document with each screen subtree replaced by its deep-fetched version, keeping
// the surrounding container structure (CANVAS/SECTION) intact. Screen nodes are matched by id.
const rebuildWithDeepScreens = (
  root: RawFigmaNode,
  deepById: ReadonlyMap<string, RawFigmaNode>,
): RawFigmaNode => {
  const rewrite = (node: RawFigmaNode): RawFigmaNode => {
    const replacement = deepById.get(idOf(node));
    if (replacement !== undefined) return replacement;
    const kids = childrenOf(node);
    if (kids.length === 0) return node;
    return { ...node, children: kids.map(rewrite) };
  };
  return rewrite(root);
};

/**
 * Deepen a shallow scoped document into a per-screen-paginated one, bounded by {@link limits}.
 * `fetchNode` performs one bounded `depth=pageDepth` scoped fetch (with the connector's 429 backoff).
 * Stays inside the snapshot-build boundary: it issues only scoped node fetches, returns the assembled
 * raw document for the existing deterministic IR cleaner, and reports coverage. A board with no
 * discoverable screen (a directly-scoped non-screen, non-container node) returns the shallow root
 * unchanged with zero-screen coverage.
 */
export const paginateScopedDocument = async (
  shallowRoot: RawFigmaNode,
  fetchNode: ScopedNodeFetcher,
  limits: ScopedPaginationLimits = DEFAULT_SCOPED_PAGINATION_LIMITS,
): Promise<DeepFetchResult> => {
  const screens = discoverScreenNodes(shallowRoot);
  const deepable = screens.slice(0, limits.maxScreensDeep);
  const gatedFetch = createFetchGate(fetchNode, limits.fetchConcurrency);

  // All deep-fetchable screens run concurrently; the shared gate bounds total in-flight fetches.
  // Each screen's result depends only on its own budgets, so order-of-completion never changes it.
  const outcomes = await Promise.all(
    deepable.map((screen) => completeScreen(screen, gatedFetch, limits)),
  );

  const deepById = new Map<string, RawFigmaNode>();
  let screensDeepFetched = 0;
  let screensTruncated = 0;
  let fetchCount = 0;
  deepable.forEach((screen, index) => {
    const outcome = outcomes[index];
    if (outcome === undefined) return;
    deepById.set(idOf(screen), outcome.node);
    if (outcome.deepFetched) screensDeepFetched += 1;
    if (outcome.truncated) screensTruncated += 1;
    fetchCount += outcome.fetchCount;
  });

  // When the root IS the single screen, the rebuild replaces the root itself with its deep version.
  const document = rebuildWithDeepScreens(shallowRoot, deepById);
  return {
    document,
    coverage: {
      screenCount: screens.length,
      screensDeepFetched,
      screensTruncated,
      nodeCount: countNodes(document),
      fetchCount,
      capped: deepable.length < screens.length,
    },
  };
};
