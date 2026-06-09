import { describe, expect, it } from "vitest";
import type { QualityIntelligenceFigma } from "@oscharko-dev/keiko-quality-intelligence";
import type { FigmaScopedResult } from "../figmaConnector.js";
import type { FigmaHttpPort } from "../figmaHttpPort.js";
import type { FigmaRenderPort } from "../figmaRenderPort.js";
import { resnapshotFigma, type ResnapshotFigmaDeps } from "../figmaResnapshot.js";

const URL_OK = "https://www.figma.com/design/KEY123/Board?node-id=12-34&t=abc";

const png = (seed: number): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47, seed]);

const scopedResult = (): FigmaScopedResult => ({
  nodes: { id: "12:34", name: "Release", type: "FRAME", children: [] },
  provenance: {
    fileKey: "KEY123",
    nodeId: "12:34",
    version: "v1",
    fetchedAt: "1970-01-01T00:00:00.000Z",
  },
  readiness: { source: "version", ready: true, version: "v1" },
});

const ir = (screenIds: readonly string[]): QualityIntelligenceFigma.ScreenIrResult => ({
  screens: screenIds.map((id) => ({
    id,
    name: id,
    root: {
      id,
      name: id,
      type: "FRAME",
      interactionHint: "container",
      imageFills: [],
      children: [],
    },
  })),
  tokens: { colors: [], typography: [], spacing: [], radius: [] },
  links: [],
  reduction: { inputNodeCount: 0, keptNodeCount: 0, removedNodeCount: 0, removedRatio: 0 },
});

interface Harness {
  readonly deps: ResnapshotFigmaDeps;
  readonly fetchCalls: () => number;
  readonly cleanCalls: () => number;
  readonly imagesCalls: () => number;
}

const harness = (screenIds: readonly string[]): Harness => {
  let fetchCalls = 0;
  let cleanCalls = 0;
  let imagesCalls = 0;

  const imagesPort: FigmaHttpPort = (request) => {
    imagesCalls += 1;
    const ids = (new URL(request.url).searchParams.get("ids") ?? "").split(",");
    const images: Record<string, string> = {};
    for (const id of ids) images[id] = `https://ephemeral/${id}.png`;
    return Promise.resolve({ status: 200, json: { images }, headers: {} });
  };
  const renderPort: FigmaRenderPort = () =>
    Promise.resolve({ status: 200, bytes: png(1), headers: {} });

  const deps: ResnapshotFigmaDeps = {
    connector: {
      fetchScopedNodes: (_url, _options) => {
        fetchCalls += 1;
        return Promise.resolve(scopedResult());
      },
    },
    cleanToIr: (_scoped) => {
      cleanCalls += 1;
      return ir(screenIds);
    },
    token: "figd_unit-test-token",
    imagesPort,
    renderPort,
  };

  return {
    deps,
    fetchCalls: () => fetchCalls,
    cleanCalls: () => cleanCalls,
    imagesCalls: () => imagesCalls,
  };
};

describe("resnapshotFigma — explicit full re-snapshot (#759, #735)", () => {
  it("performs a FRESH full scoped fetch → clean → render on every call (no delta)", async () => {
    const h = harness(["1:1", "1:2"]);

    const first = await resnapshotFigma(URL_OK, h.deps);
    const second = await resnapshotFigma(URL_OK, h.deps);

    // Each re-snapshot re-fetches the whole scope and re-renders every screen — never reused.
    expect(h.fetchCalls()).toBe(2);
    expect(h.cleanCalls()).toBe(2);
    expect(first.screens).toHaveLength(2);
    expect(second.screens).toHaveLength(2);
  });

  it("renders all screens on a re-snapshot, not an unchanged-skipping subset (full, not incremental)", async () => {
    const h = harness(["1:1", "1:2", "1:3"]);

    const snapshot = await resnapshotFigma(URL_OK, h.deps);

    expect(snapshot.screens.map((s) => s.screenId)).toEqual(["1:1", "1:2", "1:3"]);
    // One batched images call for the whole scope — re-fetched in full.
    expect(h.imagesCalls()).toBeGreaterThanOrEqual(1);
  });

  it("produces an identical integrity hash for an unchanged design (drift-stable compare basis)", async () => {
    const h = harness(["1:1"]);

    const first = await resnapshotFigma(URL_OK, h.deps);
    const second = await resnapshotFigma(URL_OK, h.deps);

    // The drift contract (#735): re-snapshot + integrity-hash compare. Same design → same hash.
    expect(second.integrityHash).toBe(first.integrityHash);
  });

  it("forwards the explicit version pin to the scoped fetch (re-snapshot stays in scope)", async () => {
    let seenVersion: string | undefined;
    const h = harness(["1:1"]);
    const deps: ResnapshotFigmaDeps = {
      ...h.deps,
      connector: {
        fetchScopedNodes: (_url, options) => {
          seenVersion = options?.version;
          return Promise.resolve(scopedResult());
        },
      },
    };

    await resnapshotFigma(URL_OK, deps, { version: "v-pinned-2" });

    expect(seenVersion).toBe("v-pinned-2");
  });
});
