import { describe, expect, it } from "vitest";
import type { QualityIntelligenceFigma } from "@oscharko-dev/keiko-quality-intelligence";
import type { FigmaProvenance } from "../figmaConnector.js";
import type { FigmaHttpPort, FigmaHttpRequest } from "../figmaHttpPort.js";
import type { FigmaRenderPort, FigmaRenderRequest } from "../figmaRenderPort.js";
import { FigmaConnectorError } from "../figmaConnectorErrors.js";
import type { FigmaRetrySleep } from "../figmaRetry.js";
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
    return Promise.resolve({ status: 200, json: { err: null, images }, headers: {} });
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
      return Promise.resolve({ status: override.status, bytes: new Uint8Array(0), headers: {} });
    }
    if (override?.empty === true) {
      return Promise.resolve({ status: 200, bytes: new Uint8Array(0), headers: {} });
    }
    return Promise.resolve({
      status: 200,
      bytes: bytesByUrl[request.url] ?? new Uint8Array(0),
      headers: {},
    });
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
    const images: FigmaHttpPort = () => Promise.resolve({ status: 500, json: {}, headers: {} });
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

// A synchronous sleep recorder so backoff is asserted with zero real waiting.
const recordingSleep = (): { readonly sleep: FigmaRetrySleep; readonly delays: number[] } => {
  const delays: number[] = [];
  const sleep: FigmaRetrySleep = (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleep, delays };
};

const TEST_POLICY = { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 5000 } as const;

describe("buildFigmaSnapshot — render URL safety (#750 SSRF)", () => {
  it("skips a screen whose render URL uses http:// (non-TLS)", async () => {
    const screens = [screen("1:1", "Home")];
    // Override the imagesPort stub to return an http:// URL.
    const images: FigmaHttpPort = () =>
      Promise.resolve({
        status: 200,
        json: { images: { "1:1": "http://127.0.0.1/render/1:1.png" } },
        headers: {},
      });
    const renders = renderPort({});

    const snapshot = await buildFigmaSnapshot(baseInput(screens, images, renders.port));

    expect(snapshot.screens).toHaveLength(0);
    expect(snapshot.skippedScreens).toEqual([{ screenId: "1:1", reason: "render-url-blocked" }]);
    expect(renders.requests).toHaveLength(0);
  });

  it("skips a screen whose render URL points at a non-Figma domain with https", async () => {
    const screens = [screen("1:1", "Home")];
    const images: FigmaHttpPort = () =>
      Promise.resolve({
        status: 200,
        json: { images: { "1:1": "https://evil.internal/leak?path=/etc/passwd" } },
        headers: {},
      });
    const renders = renderPort({});

    const snapshot = await buildFigmaSnapshot(baseInput(screens, images, renders.port));

    // evil.internal is not an IP, so it passes the IP-literal check — but it IS an https URL
    // that could resolve internally. The IP-block strategy does not block arbitrary hostnames
    // (only IP literals and localhost/.local). This test documents the current contract and
    // confirms the render call is still made for non-IP https URLs (the CDN allowlist would
    // block this; we use the IP-block strategy — see figmaSnapshotBuilder.ts comment).
    // The renderPort stub returns empty bytes for unknown URLs → render-empty skip.
    expect(snapshot.skippedScreens).toEqual([{ screenId: "1:1", reason: "render-empty" }]);
  });

  it("skips a screen whose render URL is an IPv4 loopback address (SSRF)", async () => {
    const screens = [screen("1:1", "Home")];
    const images: FigmaHttpPort = () =>
      Promise.resolve({
        status: 200,
        json: { images: { "1:1": "https://127.0.0.1:8080/internal-route" } },
        headers: {},
      });
    const renders = renderPort({});

    const snapshot = await buildFigmaSnapshot(baseInput(screens, images, renders.port));

    expect(snapshot.screens).toHaveLength(0);
    expect(snapshot.skippedScreens).toEqual([{ screenId: "1:1", reason: "render-url-blocked" }]);
    expect(renders.requests).toHaveLength(0);
  });

  it("skips a screen whose render URL is an IPv4 private-range address (SSRF)", async () => {
    const screens = [screen("1:1", "Home")];
    const images: FigmaHttpPort = () =>
      Promise.resolve({
        status: 200,
        json: { images: { "1:1": "https://169.254.169.254/latest/meta-data/" } },
        headers: {},
      });
    const renders = renderPort({});

    const snapshot = await buildFigmaSnapshot(baseInput(screens, images, renders.port));

    expect(snapshot.screens).toHaveLength(0);
    expect(snapshot.skippedScreens).toEqual([{ screenId: "1:1", reason: "render-url-blocked" }]);
    expect(renders.requests).toHaveLength(0);
  });

  it("allows a legitimate https://ephemeral/ render URL (existing fixtures still work)", async () => {
    const screens = [screen("1:1", "Home")];
    const images = imagesPort();
    const renders = renderPort({ "https://ephemeral/1:1.png": png(10) });

    const snapshot = await buildFigmaSnapshot(baseInput(screens, images.port, renders.port));

    expect(snapshot.screens).toHaveLength(1);
    expect(snapshot.skippedScreens).toHaveLength(0);
  });

  it("blocks a trailing-dot localhost URL (SSRF — trailing-dot bypass)", async () => {
    const screens = [screen("1:1", "Home")];
    const images: FigmaHttpPort = () =>
      Promise.resolve({
        status: 200,
        json: { images: { "1:1": "https://localhost./render/1:1.png" } },
        headers: {},
      });
    const renders = renderPort({});

    const snapshot = await buildFigmaSnapshot(baseInput(screens, images, renders.port));

    expect(snapshot.skippedScreens).toEqual([{ screenId: "1:1", reason: "render-url-blocked" }]);
    expect(renders.requests).toHaveLength(0);
  });

  it("blocks a *.localhost reserved-TLD subdomain (SSRF)", async () => {
    const screens = [screen("1:1", "Home")];
    const images: FigmaHttpPort = () =>
      Promise.resolve({
        status: 200,
        json: { images: { "1:1": "https://internal.localhost/render/1:1.png" } },
        headers: {},
      });
    const renders = renderPort({});

    const snapshot = await buildFigmaSnapshot(baseInput(screens, images, renders.port));

    expect(snapshot.skippedScreens).toEqual([{ screenId: "1:1", reason: "render-url-blocked" }]);
    expect(renders.requests).toHaveLength(0);
  });

  it("blocks a non-standard port (internal service, not a CDN)", async () => {
    const screens = [screen("1:1", "Home")];
    const images: FigmaHttpPort = () =>
      Promise.resolve({
        status: 200,
        json: { images: { "1:1": "https://s3.amazonaws.com:8443/bucket/1:1.png" } },
        headers: {},
      });
    const renders = renderPort({});

    const snapshot = await buildFigmaSnapshot(baseInput(screens, images, renders.port));

    expect(snapshot.skippedScreens).toEqual([{ screenId: "1:1", reason: "render-url-blocked" }]);
    expect(renders.requests).toHaveLength(0);
  });

  it("allows port 443 explicitly in the URL (standard HTTPS port)", async () => {
    const screens = [screen("1:1", "Home")];
    // Port 443 is the HTTPS default — should pass the guard.
    const images: FigmaHttpPort = () =>
      Promise.resolve({
        status: 200,
        json: { images: { "1:1": "https://ephemeral:443/1:1.png" } },
        headers: {},
      });
    const renders = renderPort({ "https://ephemeral:443/1:1.png": png(10) });

    const snapshot = await buildFigmaSnapshot(baseInput(screens, images, renders.port));

    expect(snapshot.screens).toHaveLength(1);
    expect(snapshot.skippedScreens).toHaveLength(0);
  });
});

describe("buildFigmaSnapshot — render egress abort codes (#750 audit)", () => {
  it("re-throws a FIGMA_TLS_CA_FAILURE from the render port (abort the build)", async () => {
    const screens = [screen("1:1", "Home"), screen("1:2", "Detail")];
    const images = imagesPort();
    const tlsError = new FigmaConnectorError("FIGMA_TLS_CA_FAILURE");
    const renders: FigmaRenderPort = () => Promise.reject(tlsError);

    await expect(
      buildFigmaSnapshot(baseInput(screens, images.port, renders)),
    ).rejects.toMatchObject({ code: "FIGMA_TLS_CA_FAILURE" });
  });

  it("re-throws a FIGMA_PROXY_UNREACHABLE from the render port (abort the build)", async () => {
    const screens = [screen("1:1", "Home")];
    const images = imagesPort();
    const renders: FigmaRenderPort = () =>
      Promise.reject(new FigmaConnectorError("FIGMA_PROXY_UNREACHABLE"));

    await expect(
      buildFigmaSnapshot(baseInput(screens, images.port, renders)),
    ).rejects.toMatchObject({ code: "FIGMA_PROXY_UNREACHABLE" });
  });

  it("skips with coded reason for a non-abort coded error (FIGMA_RATE_LIMITED)", async () => {
    const screens = [screen("1:1", "Home")];
    const images = imagesPort();
    // After all retries are exhausted the render port throws FIGMA_RATE_LIMITED.
    // That is NOT in the abort set, so it should produce a skip with the code in the reason.
    const renders: FigmaRenderPort = () =>
      Promise.reject(new FigmaConnectorError("FIGMA_RATE_LIMITED"));
    const { sleep } = recordingSleep();

    const snapshot = await buildFigmaSnapshot({
      ...baseInput(screens, images.port, renders),
      retryPolicy: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
      sleep,
    });

    expect(snapshot.screens).toHaveLength(0);
    expect(snapshot.skippedScreens[0]?.screenId).toBe("1:1");
    expect(snapshot.skippedScreens[0]?.reason).toBe("render-fetch-failed:FIGMA_RATE_LIMITED");
  });

  it("skips with plain reason for an unclassified (non-FigmaConnectorError) throw", async () => {
    const screens = [screen("1:1", "Home")];
    const images = imagesPort();
    const renders: FigmaRenderPort = () => Promise.reject(new Error("network blip"));
    const { sleep } = recordingSleep();

    const snapshot = await buildFigmaSnapshot({
      ...baseInput(screens, images.port, renders),
      retryPolicy: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
      sleep,
    });

    expect(snapshot.screens).toHaveLength(0);
    expect(snapshot.skippedScreens[0]?.reason).toBe("render-fetch-failed");
  });
});

describe("buildFigmaSnapshot — resilience (#759)", () => {
  it("retries a 429 on /v1/images then succeeds, sleeping the deterministic schedule", async () => {
    const screens = [screen("1:1", "Home")];
    let imagesCalls = 0;
    const images: FigmaHttpPort = (request) => {
      imagesCalls += 1;
      if (imagesCalls === 1) return Promise.resolve({ status: 429, json: {}, headers: {} });
      const url = new URL(request.url);
      const ids = (url.searchParams.get("ids") ?? "").split(",");
      const map: Record<string, string> = {};
      for (const id of ids) map[id] = `https://ephemeral/${id}.png`;
      return Promise.resolve({ status: 200, json: { images: map }, headers: {} });
    };
    const renders = renderPort({ "https://ephemeral/1:1.png": png(10) });
    const { sleep, delays } = recordingSleep();

    const snapshot = await buildFigmaSnapshot({
      ...baseInput(screens, images, renders.port),
      retryPolicy: TEST_POLICY,
      sleep,
    });

    expect(imagesCalls).toBe(2);
    expect(delays).toEqual([100]);
    expect(snapshot.screens.map((s) => s.screenId)).toEqual(["1:1"]);
  });

  it("honours a Retry-After header on a 429 images response", async () => {
    const screens = [screen("1:1", "Home")];
    let imagesCalls = 0;
    const images: FigmaHttpPort = (request) => {
      imagesCalls += 1;
      if (imagesCalls === 1) {
        return Promise.resolve({ status: 429, json: {}, headers: { "retry-after": "3" } });
      }
      const ids = (new URL(request.url).searchParams.get("ids") ?? "").split(",");
      const map: Record<string, string> = {};
      for (const id of ids) map[id] = `https://ephemeral/${id}.png`;
      return Promise.resolve({ status: 200, json: { images: map }, headers: {} });
    };
    const renders = renderPort({ "https://ephemeral/1:1.png": png(10) });
    const { sleep, delays } = recordingSleep();

    await buildFigmaSnapshot({
      ...baseInput(screens, images, renders.port),
      retryPolicy: TEST_POLICY,
      sleep,
    });

    expect(delays).toEqual([3000]);
  });

  it("raises FIGMA_RATE_LIMITED when /v1/images 429s exhaust the bounded retries", async () => {
    const screens = [screen("1:1", "Home")];
    const images: FigmaHttpPort = () => Promise.resolve({ status: 429, json: {}, headers: {} });
    const renders = renderPort({});
    const { sleep } = recordingSleep();

    await expect(
      buildFigmaSnapshot({
        ...baseInput(screens, images, renders.port),
        retryPolicy: TEST_POLICY,
        sleep,
      }),
    ).rejects.toMatchObject({ code: "FIGMA_RATE_LIMITED" });
  });

  it("retries a 429 on a byte download then keeps the screen", async () => {
    const screens = [screen("1:1", "Home")];
    const images = imagesPort();
    let renderCalls = 0;
    const renders: FigmaRenderPort = () => {
      renderCalls += 1;
      if (renderCalls === 1) {
        return Promise.resolve({ status: 429, bytes: new Uint8Array(0), headers: {} });
      }
      return Promise.resolve({ status: 200, bytes: png(10), headers: {} });
    };
    const { sleep, delays } = recordingSleep();

    const snapshot = await buildFigmaSnapshot({
      ...baseInput(screens, images.port, renders),
      retryPolicy: TEST_POLICY,
      sleep,
    });

    expect(renderCalls).toBe(2);
    expect(delays).toEqual([100]);
    expect(snapshot.screens.map((s) => s.screenId)).toEqual(["1:1"]);
  });

  it("skips a screen whose byte download 429s past exhaustion (partial), keeping the rest", async () => {
    const screens = [screen("1:1", "Home"), screen("1:2", "Detail")];
    const images = imagesPort();
    const renders: FigmaRenderPort = (request) => {
      if (request.url === "https://ephemeral/1:2.png") {
        return Promise.resolve({ status: 429, bytes: new Uint8Array(0), headers: {} });
      }
      return Promise.resolve({ status: 200, bytes: png(10), headers: {} });
    };
    const { sleep } = recordingSleep();

    const snapshot = await buildFigmaSnapshot({
      ...baseInput(screens, images.port, renders),
      retryPolicy: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
      sleep,
    });

    expect(snapshot.screens.map((s) => s.screenId)).toEqual(["1:1"]);
    // After retry exhaustion fetchWithBackoff throws FIGMA_RATE_LIMITED — the code is appended
    // to the skip reason so metrics distinguish rate-limit misconfigurations from network flakes.
    expect(snapshot.skippedScreens).toEqual([
      { screenId: "1:2", reason: "render-fetch-failed:FIGMA_RATE_LIMITED" },
    ]);
  });

  it("never runs more than `downloadConcurrency` byte downloads at once", async () => {
    const screens = Array.from({ length: 6 }, (_unused, i) =>
      screen(`1:${String(i)}`, `S${String(i)}`),
    );
    const images = imagesPort();
    let active = 0;
    let peak = 0;
    const renders: FigmaRenderPort = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      await Promise.resolve();
      active -= 1;
      return { status: 200, bytes: png(1), headers: {} };
    };

    const snapshot = await buildFigmaSnapshot({
      ...baseInput(screens, images.port, renders),
      downloadConcurrency: 2,
    });

    expect(peak).toBeLessThanOrEqual(2);
    expect(snapshot.screens).toHaveLength(6);
  });

  it("preserves screen order even when downloads complete out of order", async () => {
    const screens = [screen("1:1", "Home"), screen("1:2", "Detail"), screen("1:3", "Settings")];
    const images = imagesPort();
    const delayByUrl: Record<string, number> = {
      "https://ephemeral/1:1.png": 3,
      "https://ephemeral/1:2.png": 1,
      "https://ephemeral/1:3.png": 2,
    };
    const renders: FigmaRenderPort = async (request) => {
      const ticks = delayByUrl[request.url] ?? 0;
      for (let i = 0; i < ticks; i += 1) await Promise.resolve();
      return { status: 200, bytes: png(1), headers: {} };
    };

    const snapshot = await buildFigmaSnapshot({
      ...baseInput(screens, images.port, renders),
      downloadConcurrency: 3,
    });

    expect(snapshot.screens.map((s) => s.screenId)).toEqual(["1:1", "1:2", "1:3"]);
  });
});
