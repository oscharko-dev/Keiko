import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCOPED_PAGINATION_LIMITS,
  discoverScreenNodes,
  paginateScopedDocument,
  type RawFigmaNode,
  type ScopedNodeFetcher,
  type ScopedPaginationLimits,
} from "../figmaScopedPagination.js";

// ─── Synthetic fixtures (NO customer data) ──────────────────────────────────────

interface BuildNode {
  readonly id: string;
  readonly type: string;
  readonly text?: string;
  readonly children?: readonly BuildNode[];
}

const node = (
  id: string,
  type: string,
  children: readonly BuildNode[] = [],
  text?: string,
): BuildNode => ({ id, type, ...(text !== undefined ? { text } : {}), children });

const toRaw = (b: BuildNode): RawFigmaNode => ({
  id: b.id,
  name: b.id,
  type: b.type,
  ...(b.text !== undefined ? { characters: b.text } : {}),
  children: (b.children ?? []).map(toRaw),
});

// Truncate a full raw tree at `pageDepth` the way Figma's `depth=` param does: nodes at exactly
// `pageDepth` get `children: []` (the truncation marker), shallower nodes keep their children.
const truncate = (root: RawFigmaNode, pageDepth: number): RawFigmaNode => {
  const rec = (n: RawFigmaNode, depth: number): RawFigmaNode => {
    const kids = Array.isArray(n.children) ? n.children : [];
    return {
      ...n,
      children: depth >= pageDepth ? [] : kids.map((k) => rec(k, depth + 1)),
    };
  };
  return rec(root, 0);
};

interface Fetcher {
  readonly fetch: ScopedNodeFetcher;
  readonly calls: () => readonly string[];
}

// A fetcher that serves any node id from the full tree, truncated to `pageDepth` — exactly what the
// real `GET /v1/files/:key/nodes?ids=&depth=` returns. `failIds` simulate a per-node soft failure.
const fetcherFor = (
  full: RawFigmaNode,
  pageDepth: number,
  failIds: ReadonlySet<string> = new Set(),
): Fetcher => {
  const byId = new Map<string, RawFigmaNode>();
  const index = (n: RawFigmaNode): void => {
    byId.set(String(n.id), n);
    for (const c of Array.isArray(n.children) ? n.children : []) index(c);
  };
  index(full);
  const calls: string[] = [];
  const fetch: ScopedNodeFetcher = (id) => {
    calls.push(id);
    if (failIds.has(id)) return Promise.resolve(undefined);
    const target = byId.get(id);
    return Promise.resolve(target === undefined ? undefined : truncate(target, pageDepth));
  };
  return { fetch, calls: () => calls };
};

const countText = (n: RawFigmaNode): number =>
  (n.type === "TEXT" ? 1 : 0) +
  (Array.isArray(n.children) ? n.children.reduce((s, c) => s + countText(c), 0) : 0);

const countNodes = (n: RawFigmaNode): number =>
  1 + (Array.isArray(n.children) ? n.children.reduce((s, c) => s + countNodes(c), 0) : 0);

// pageDepth=2 matches the fetcher's truncation depth and is shallower than the depth-3 fixtures, so
// each screen needs exactly one pagination round — the behaviour under test. (A pageDepth ≥ tree depth
// would capture everything in the single base fetch with no pagination, which is also correct but not
// what these cases exercise.)
const limits = (over: Partial<ScopedPaginationLimits> = {}): ScopedPaginationLimits => ({
  ...DEFAULT_SCOPED_PAGINATION_LIMITS,
  pageDepth: 2,
  ...over,
});

// A canvas with `n` screens, each a narrow-deep frame whose meaningful TEXT sits at screen-depth 3
// (below a shallow page-depth-2 frontier) — the #837 shape in miniature.
const deepScreen = (id: string): BuildNode =>
  node(id, "FRAME", [
    node(`${id}-a`, "FRAME", [
      node(`${id}-b`, "FRAME", [
        node(`${id}-label`, "TEXT", [], "label"),
        node(`${id}-btn`, "FRAME"),
      ]),
    ]),
  ]);

const canvasOf = (screenIds: readonly string[]): RawFigmaNode =>
  toRaw(node("canvas", "CANVAS", screenIds.map(deepScreen)));

// ─── discoverScreenNodes ─────────────────────────────────────────────────────────

describe("discoverScreenNodes", () => {
  it("collects FRAME/INSTANCE screens directly under a CANVAS", () => {
    const root = canvasOf(["s1", "s2", "s3"]);
    expect(discoverScreenNodes(root).map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("descends through SECTION groupings but never into a screen body", () => {
    const root = toRaw(
      node("canvas", "CANVAS", [
        node("sec", "SECTION", [node("s1", "FRAME", [node("nested", "FRAME")])]),
        node("s2", "INSTANCE"),
      ]),
    );
    // s1 + s2 are screens; `nested` (inside s1) is NOT a separate screen.
    expect(discoverScreenNodes(root).map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("returns the root itself when the scope IS a single screen", () => {
    const root = toRaw(node("s1", "FRAME", [node("x", "TEXT")]));
    expect(discoverScreenNodes(root).map((s) => s.id)).toEqual(["s1"]);
  });

  it("returns no screens for a non-screen, non-container root", () => {
    expect(discoverScreenNodes(toRaw(node("t", "TEXT")))).toEqual([]);
  });
});

// ─── paginateScopedDocument ───────────────────────────────────────────────────────

describe("paginateScopedDocument — deep capture (#837)", () => {
  it("recovers in-screen text that lives below the shallow frontier", async () => {
    const full = canvasOf(["s1", "s2"]);
    const shallow = truncate(full, 2); // discovery: text at depth 3 is NOT present
    expect(countText(shallow)).toBe(0);

    const f = fetcherFor(full, 2);
    const { document, coverage } = await paginateScopedDocument(shallow, f.fetch, limits());

    expect(countText(document)).toBe(2); // both screens' labels recovered
    expect(coverage.screenCount).toBe(2);
    expect(coverage.screensDeepFetched).toBe(2);
    expect(coverage.screensTruncated).toBe(0);
    expect(coverage.capped).toBe(false);
  });

  it("never re-fetches leaf nodes (only container frontier nodes)", async () => {
    const full = canvasOf(["s1"]);
    const f = fetcherFor(full, 2);
    await paginateScopedDocument(truncate(full, 2), f.fetch, limits());
    // The TEXT leaf id must never be requested.
    expect(f.calls()).not.toContain("s1-label");
  });

  it("is deterministic — identical document + coverage across runs", async () => {
    const full = canvasOf(["s1", "s2", "s3"]);
    const shallow = truncate(full, 2);
    const a = await paginateScopedDocument(shallow, fetcherFor(full, 2).fetch, limits());
    const b = await paginateScopedDocument(truncate(full, 2), fetcherFor(full, 2).fetch, limits());
    expect(JSON.stringify(a.document)).toBe(JSON.stringify(b.document));
    expect(a.coverage).toEqual(b.coverage);
  });
});

describe("paginateScopedDocument — bounds + coverage", () => {
  it("caps the number of screens deep-fetched and reports capped", async () => {
    const full = canvasOf(["s1", "s2", "s3", "s4", "s5"]);
    const f = fetcherFor(full, 2);
    const { coverage } = await paginateScopedDocument(
      truncate(full, 2),
      f.fetch,
      limits({ maxScreensDeep: 2 }),
    );
    expect(coverage.screenCount).toBe(5);
    expect(coverage.screensDeepFetched).toBe(2);
    expect(coverage.capped).toBe(true);
  });

  it("truncates a screen when the per-screen fetch budget is exhausted", async () => {
    const full = canvasOf(["s1"]);
    // maxFetchesPerScreen=1 → only the base fetch, no frontier expansion → truncated.
    const { document, coverage } = await paginateScopedDocument(
      truncate(full, 2),
      fetcherFor(full, 2).fetch,
      limits({ maxFetchesPerScreen: 1 }),
    );
    expect(coverage.screensTruncated).toBe(1);
    expect(countText(document)).toBe(0); // depth-3 text not reached within 1 fetch
  });

  it("truncates a screen when the per-screen node budget is exhausted", async () => {
    const full = canvasOf(["s1"]);
    const { coverage } = await paginateScopedDocument(
      truncate(full, 2),
      fetcherFor(full, 2).fetch,
      limits({ maxNodesPerScreen: 1 }),
    );
    expect(coverage.screensTruncated).toBe(1);
  });

  it("reports an accurate assembled node + fetch count", async () => {
    const full = canvasOf(["s1"]);
    const { document, coverage } = await paginateScopedDocument(
      truncate(full, 2),
      fetcherFor(full, 2).fetch,
      limits(),
    );
    expect(coverage.nodeCount).toBe(countNodes(document));
    expect(coverage.fetchCount).toBeGreaterThanOrEqual(1);
  });
});

describe("paginateScopedDocument — fail-soft", () => {
  it("keeps a screen's shallow content (no crash) when its deep fetch fails", async () => {
    const full = canvasOf(["s1", "s2"]);
    const shallow = truncate(full, 2);
    const f = fetcherFor(full, 2, new Set(["s1"])); // s1 base fetch returns undefined
    const { document, coverage } = await paginateScopedDocument(shallow, f.fetch, limits());
    // s1 stays shallow (its discovery subtree), s2 deep-fetched.
    expect(coverage.screensDeepFetched).toBe(1);
    expect(countText(document)).toBe(1); // only s2's label
  });

  it("returns the shallow root unchanged for a non-screen scope (zero-screen coverage)", async () => {
    const shallow = toRaw(node("t", "TEXT"));
    const f = fetcherFor(shallow, 2);
    const { document, coverage } = await paginateScopedDocument(shallow, f.fetch, limits());
    expect(coverage.screenCount).toBe(0);
    expect(coverage.screensDeepFetched).toBe(0);
    expect(f.calls()).toEqual([]); // nothing to deepen
    expect(document).toEqual(shallow);
  });
});
