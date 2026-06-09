import { describe, expect, it } from "vitest";
import type { QualityIntelligenceFigma } from "@oscharko-dev/keiko-quality-intelligence";
import type { FigmaProvenance } from "../figmaConnector.js";
import type { FigmaHttpPort, FigmaHttpRequest } from "../figmaHttpPort.js";
import type { FigmaRenderPort, FigmaRenderRequest } from "../figmaRenderPort.js";
import { FigmaConnectorError } from "../figmaConnectorErrors.js";
import { buildFigmaSnapshot, type BuildFigmaSnapshotInput } from "../figmaSnapshotBuilder.js";

const TOKEN = "figd_unit-test-secret-pat-value-1234567890";

const at = <T>(items: readonly T[], index: number): T => {
  const value = items[index];
  if (value === undefined) throw new Error(`expected an element at index ${String(index)}`);
  return value;
};

const screen = (id: string, name: string): QualityIntelligenceFigma.ScreenIr => ({
  id,
  name,
  root: {
    id,
    name,
    type: "FRAME",
    interactionHint: "container",
    imageFills: [],
    children: [],
  },
});

const irResult = (
  screens: readonly QualityIntelligenceFigma.ScreenIr[],
): QualityIntelligenceFigma.ScreenIrResult => ({
  screens,
  tokens: { colors: [], typography: [], spacing: [], radius: [] },
  links: [],
  reduction: { inputNodeCount: 0, keptNodeCount: 0, removedNodeCount: 0, removedRatio: 0 },
});

const provenance: FigmaProvenance = {
  fileKey: "KEY123",
  nodeId: "0:1",
  version: "v-pinned-1",
  fetchedAt: "2026-06-09T00:00:00.000Z",
};

const png = (seed: number): Uint8Array =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, seed, seed + 1, seed + 2]);

interface ImagesPortStub {
  readonly port: FigmaHttpPort;
  readonly requests: FigmaHttpRequest[];
}

// Mocks `/v1/images`: returns one ephemeral url per requested id, except ids in `missing`.
const imagesPort = (missing: ReadonlySet<string> = new Set()): ImagesPortStub => {
  const requests: FigmaHttpRequest[] = [];
  const port: FigmaHttpPort = (request) => {
    requests.push(request);
    const url = new URL(request.url);
    const ids = (url.searchParams.get("ids") ?? "").split(",").filter((id) => id.length > 0);
    const images: Record<string, string | null> = {};
    for (const id of ids) images[id] = missing.has(id) ? null : `https://ephemeral/${id}.png`;
    return Promise.resolve({ status: 200, json: { err: null, images } });
  };
  return { port, requests };
};

interface RenderPortStub {
  readonly port: FigmaRenderPort;
  readonly requests: FigmaRenderRequest[];
}

// Mocks the byte download: maps each ephemeral url to bytes, with per-url status/empty overrides.
const renderPort = (
  bytesByUrl: Record<string, Uint8Array>,
  overrides: Record<string, { status?: number; empty?: boolean }> = {},
): RenderPortStub => {
  const requests: FigmaRenderRequest[] = [];
  const port: FigmaRenderPort = (request) => {
    requests.push(request);
    const override = overrides[request.url];
    if (override?.status !== undefined && override.status >= 300) {
      return Promise.resolve({ status: override.status, bytes: new Uint8Array(0) });
    }
    if (override?.empty === true) return Promise.resolve({ status: 200, bytes: new Uint8Array(0) });
    return Promise.resolve({ status: 200, bytes: bytesByUrl[request.url] ?? new Uint8Array(0) });
  };
  return { port, requests };
};

const baseInput = (
  screens: readonly QualityIntelligenceFigma.ScreenIr[],
  images: FigmaHttpPort,
  renders: FigmaRenderPort,
): BuildFigmaSnapshotInput => ({
  ir: irResult(screens),
  provenance,
  token: TOKEN,
  imagesPort: images,
  renderPort: renders,
});

describe("buildFigmaSnapshot", () => {
  it("assembles one screen per render with IR + image + per-screen hash", async () => {
    const screens = [screen("1:1", "Home"), screen("1:2", "Detail")];
    const images = imagesPort();
    const renders = renderPort({
      "https://ephemeral/1:1.png": png(10),
      "https://ephemeral/1:2.png": png(20),
    });

    const snapshot = await buildFigmaSnapshot(baseInput(screens, images.port, renders.port));

    expect(snapshot.screens).toHaveLength(2);
    expect(snapshot.skippedScreens).toHaveLength(0);
    expect(snapshot.screens.map((s) => s.screenId)).toEqual(["1:1", "1:2"]);
    expect(Array.from(at(snapshot.screens, 0).image.bytes)).toEqual(Array.from(png(10)));
    expect(at(snapshot.screens, 0).image.mimeType).toBe("image/png");
    expect(at(snapshot.screens, 0).integrityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(at(snapshot.screens, 0).integrityHash).not.toBe(at(snapshot.screens, 1).integrityHash);
  });

  it("renders ONLY screen frame ids and NEVER the canvas root node id", async () => {
    const screens = [screen("1:1", "Home")];
    const images = imagesPort();
    const renders = renderPort({ "https://ephemeral/1:1.png": png(10) });

    await buildFigmaSnapshot(baseInput(screens, images.port, renders.port));

    const requestedIds = images.requests.flatMap((r) =>
      (new URL(r.url).searchParams.get("ids") ?? "").split(","),
    );
    expect(requestedIds).toEqual(["1:1"]);
    expect(requestedIds).not.toContain(provenance.nodeId); // never the canvas root "0:1"
  });

  it("authenticates the /v1/images call with the token header but never the byte download", async () => {
    const screens = [screen("1:1", "Home")];
    const images = imagesPort();
    const renders = renderPort({ "https://ephemeral/1:1.png": png(10) });

    await buildFigmaSnapshot(baseInput(screens, images.port, renders.port));

    expect(at(images.requests, 0).headers["X-Figma-Token"]).toBe(TOKEN);
    expect(JSON.stringify(at(renders.requests, 0).headers)).not.toContain(TOKEN);
  });

  it("skips a screen whose render url is missing and keeps the rest (partial)", async () => {
    const screens = [screen("1:1", "Home"), screen("1:2", "Detail")];
    const images = imagesPort(new Set(["1:2"]));
    const renders = renderPort({ "https://ephemeral/1:1.png": png(10) });

    const snapshot = await buildFigmaSnapshot(baseInput(screens, images.port, renders.port));

    expect(snapshot.screens.map((s) => s.screenId)).toEqual(["1:1"]);
    expect(snapshot.skippedScreens).toEqual([{ screenId: "1:2", reason: "render-url-missing" }]);
  });

  it("skips a screen whose byte download fails", async () => {
    const screens = [screen("1:1", "Home")];
    const images = imagesPort();
    const renders = renderPort({}, { "https://ephemeral/1:1.png": { status: 500 } });

    const snapshot = await buildFigmaSnapshot(baseInput(screens, images.port, renders.port));

    expect(snapshot.screens).toHaveLength(0);
    expect(snapshot.skippedScreens).toEqual([{ screenId: "1:1", reason: "render-fetch-failed" }]);
  });

  it("skips a screen with empty render bytes", async () => {
    const screens = [screen("1:1", "Home")];
    const images = imagesPort();
    const renders = renderPort({}, { "https://ephemeral/1:1.png": { empty: true } });

    const snapshot = await buildFigmaSnapshot(baseInput(screens, images.port, renders.port));

    expect(snapshot.skippedScreens).toEqual([{ screenId: "1:1", reason: "render-empty" }]);
  });

  it("skips a screen whose render exceeds the byte cap", async () => {
    const screens = [screen("1:1", "Home")];
    const images = imagesPort();
    const big = new Uint8Array(64);
    const renders = renderPort({ "https://ephemeral/1:1.png": big });

    const snapshot = await buildFigmaSnapshot({
      ...baseInput(screens, images.port, renders.port),
      maxImageBytes: 16,
    });

    expect(snapshot.skippedScreens).toEqual([{ screenId: "1:1", reason: "render-oversized" }]);
  });

  it("produces a valid empty snapshot when there are no screens (no Figma call)", async () => {
    const images = imagesPort();
    const renders = renderPort({});

    const snapshot = await buildFigmaSnapshot(baseInput([], images.port, renders.port));

    expect(snapshot.screens).toHaveLength(0);
    expect(snapshot.skippedScreens).toHaveLength(0);
    expect(images.requests).toHaveLength(0);
    expect(snapshot.integrityHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maps a non-2xx /v1/images response to a coded connector error", async () => {
    const screens = [screen("1:1", "Home")];
    const images: FigmaHttpPort = () => Promise.resolve({ status: 500, json: {} });
    const renders = renderPort({});

    await expect(
      buildFigmaSnapshot(baseInput(screens, images, renders.port)),
    ).rejects.toBeInstanceOf(FigmaConnectorError);
  });

  it("never embeds the token anywhere in the assembled snapshot value", async () => {
    const screens = [screen("1:1", "Home")];
    const images = imagesPort();
    const renders = renderPort({ "https://ephemeral/1:1.png": png(10) });

    const snapshot = await buildFigmaSnapshot(baseInput(screens, images.port, renders.port));

    const serialisable = {
      ...snapshot,
      screens: snapshot.screens.map((s) => ({ ...s, image: { ...s.image, bytes: undefined } })),
    };
    expect(JSON.stringify(serialisable)).not.toContain(TOKEN);
  });

  it("snapshot integrity hash is DETERMINISTIC and independent of fetchedAt (drift-stable)", async () => {
    const screens = [screen("1:1", "Home"), screen("1:2", "Detail")];
    const bytes = {
      "https://ephemeral/1:1.png": png(10),
      "https://ephemeral/1:2.png": png(20),
    };

    const first = await buildFigmaSnapshot(
      baseInput(screens, imagesPort().port, renderPort(bytes).port),
    );
    const second = await buildFigmaSnapshot({
      ...baseInput(screens, imagesPort().port, renderPort(bytes).port),
      provenance: { ...provenance, fetchedAt: "2030-12-31T23:59:59.000Z" },
    });

    expect(second.integrityHash).toBe(first.integrityHash);
    expect(at(second.screens, 0).integrityHash).toBe(at(first.screens, 0).integrityHash);
  });

  it("snapshot integrity hash changes when the pinned version changes (drift signal)", async () => {
    const screens = [screen("1:1", "Home")];
    const bytes = { "https://ephemeral/1:1.png": png(10) };

    const first = await buildFigmaSnapshot(
      baseInput(screens, imagesPort().port, renderPort(bytes).port),
    );
    const second = await buildFigmaSnapshot({
      ...baseInput(screens, imagesPort().port, renderPort(bytes).port),
      provenance: { ...provenance, version: "v-pinned-2" },
    });

    expect(second.integrityHash).not.toBe(first.integrityHash);
  });
});
