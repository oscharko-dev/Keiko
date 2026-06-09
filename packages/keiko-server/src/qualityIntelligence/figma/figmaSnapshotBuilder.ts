// Figma Snapshot render orchestration + assembly (Epic #750, Issue #753).
//
// The SECOND and final Figma egress of the snapshot-build. For each detected screen FRAME id
// (from #752's ScreenIrResult — NEVER the canvas root, which times out on `/v1/images`), it:
//   1. requests an ephemeral render url from `GET /v1/images` (batched, minimal — heavy backoff is
//      #759), authenticated with the read-only PAT in the `X-Figma-Token` header;
//   2. downloads the PNG bytes from that ephemeral url via the injectable render port (no auth
//      header — the url is pre-signed);
//   3. assembles the immutable Snapshot value: per-screen IR + image + deterministic integrity
//      hashes + provenance, with a `skippedScreens` list for any screen that failed to render.
//
// Once this returns, the Snapshot is the communication boundary: nothing downstream contacts
// Figma. The token flows ONLY into the images-call header; it never reaches the snapshot value,
// the render-url download, an error, or a log.

import { FigmaConnectorError } from "./figmaConnectorErrors.js";
import { mapWithConcurrency } from "./figmaConcurrency.js";
import type { FigmaHttpPort } from "./figmaHttpPort.js";
import type { FigmaRenderPort } from "./figmaRenderPort.js";
import type { FigmaProvenance } from "./figmaConnector.js";
import {
  DEFAULT_FIGMA_RETRY_POLICY,
  fetchWithBackoff,
  realFigmaRetrySleep,
  type FigmaRetryPolicy,
  type FigmaRetrySleep,
} from "./figmaRetry.js";
import { hashBytes, hashScreen, hashSnapshot } from "./figmaSnapshotHash.js";
import type {
  FigmaSkippedScreen,
  FigmaSkippedScreenReason,
  FigmaSnapshot,
  FigmaSnapshotScreen,
} from "./figmaSnapshotTypes.js";
import type { QualityIntelligenceFigma } from "@oscharko-dev/keiko-quality-intelligence";

const FIGMA_API_ORIGIN = "https://api.figma.com";
const SNAPSHOT_SCHEMA_VERSION = 1 as const;
const DEFAULT_RENDER_BATCH_SIZE = 20;
const DEFAULT_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const DEFAULT_RENDER_SCALE = 1;
const DEFAULT_DOWNLOAD_CONCURRENCY = 4;

type ScreenIr = QualityIntelligenceFigma.ScreenIr;

export interface BuildFigmaSnapshotInput {
  readonly ir: QualityIntelligenceFigma.ScreenIrResult;
  readonly provenance: FigmaProvenance;
  readonly token: string;
  readonly imagesPort: FigmaHttpPort;
  readonly renderPort: FigmaRenderPort;
  /** `/v1/images` ids-per-call cap — bounds each render batch. */
  readonly batchSize?: number;
  readonly maxImageBytes?: number;
  /** Max simultaneous byte-downloads — bounds burst on huge boards. */
  readonly downloadConcurrency?: number;
  /** Deterministic 429 backoff policy; defaults to {@link DEFAULT_FIGMA_RETRY_POLICY}. */
  readonly retryPolicy?: FigmaRetryPolicy;
  /** Injectable wait seam so tests assert the backoff schedule without real delays. */
  readonly sleep?: FigmaRetrySleep;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const chunk = <T>(items: readonly T[], size: number): readonly (readonly T[])[] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const buildImagesUrl = (
  fileKey: string,
  ids: readonly string[],
  version: string | undefined,
): string => {
  const url = new URL(`${FIGMA_API_ORIGIN}/v1/images/${encodeURIComponent(fileKey)}`);
  url.searchParams.set("ids", ids.join(","));
  url.searchParams.set("format", "png");
  url.searchParams.set("scale", String(DEFAULT_RENDER_SCALE));
  if (version !== undefined && version.length > 0) url.searchParams.set("version", version);
  return url.toString();
};

const statusToError = (status: number): FigmaConnectorError => {
  if (status === 404) return new FigmaConnectorError("FIGMA_NOT_FOUND");
  if (status === 401 || status === 403) return new FigmaConnectorError("FIGMA_INSUFFICIENT_SCOPE");
  if (status >= 500) return new FigmaConnectorError("FIGMA_UPSTREAM_UNAVAILABLE");
  return new FigmaConnectorError("FIGMA_INTERNAL");
};

// Extracts the `{ images: { id: url|null } }` map from one `/v1/images` response.
const extractImageUrls = (json: unknown): Readonly<Record<string, string | null>> => {
  if (!isRecord(json) || !isRecord(json.images)) throw new FigmaConnectorError("FIGMA_INTERNAL");
  const out: Record<string, string | null> = {};
  for (const [id, value] of Object.entries(json.images)) {
    out[id] = typeof value === "string" && value.length > 0 ? value : null;
  }
  return out;
};

// Calls `/v1/images` in bounded batches and merges the ephemeral-url map. The token authenticates
// each batch via the header only. Each batch call is wrapped in deterministic 429 backoff so a
// rate-limited huge-board render retries within Figma's limits instead of failing.
const requestRenderUrls = async (
  input: BuildFigmaSnapshotInput,
  screenIds: readonly string[],
): Promise<Map<string, string | null>> => {
  const batchSize = input.batchSize ?? DEFAULT_RENDER_BATCH_SIZE;
  const policy = input.retryPolicy ?? DEFAULT_FIGMA_RETRY_POLICY;
  const sleep = input.sleep ?? realFigmaRetrySleep;
  const urls = new Map<string, string | null>();
  for (const batch of chunk(screenIds, batchSize)) {
    const requestUrl = buildImagesUrl(input.provenance.fileKey, batch, input.provenance.version);
    const response = await fetchWithBackoff(
      () => input.imagesPort({ url: requestUrl, headers: { "X-Figma-Token": input.token } }),
      policy,
      sleep,
    );
    if (response.status < 200 || response.status >= 300) throw statusToError(response.status);
    const map = extractImageUrls(response.json);
    for (const id of batch) urls.set(id, map[id] ?? null);
  }
  return urls;
};

interface ScreenOutcome {
  readonly screen?: FigmaSnapshotScreen;
  readonly skipped?: FigmaSkippedScreen;
}

const skip = (screenId: string, reason: FigmaSkippedScreenReason): ScreenOutcome => ({
  skipped: { screenId, reason },
});

// Downloads one screen's render bytes and classifies the result into a kept screen or a skip. The
// pre-signed byte download is wrapped in the same deterministic 429 backoff; a single screen still
// failing after retries degrades to a skip (partial render), never aborting the whole build.
const resolveScreen = async (
  input: BuildFigmaSnapshotInput,
  ir: ScreenIr,
  renderUrl: string | null,
): Promise<ScreenOutcome> => {
  if (renderUrl === null) return skip(ir.id, "render-url-missing");
  const maxBytes = input.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const policy = input.retryPolicy ?? DEFAULT_FIGMA_RETRY_POLICY;
  const sleep = input.sleep ?? realFigmaRetrySleep;
  const response = await fetchWithBackoff(
    () => input.renderPort({ url: renderUrl, headers: {} }),
    policy,
    sleep,
  ).catch(() => null);
  if (response === null) return skip(ir.id, "render-fetch-failed");
  if (response.status < 200 || response.status >= 300) return skip(ir.id, "render-fetch-failed");
  if (response.bytes.length === 0) return skip(ir.id, "render-empty");
  if (response.bytes.length > maxBytes) return skip(ir.id, "render-oversized");
  const sha256 = hashBytes(response.bytes);
  const screen: FigmaSnapshotScreen = {
    screenId: ir.id,
    ir,
    image: {
      mimeType: "image/png",
      bytes: response.bytes,
      byteLength: response.bytes.length,
      sha256,
    },
    integrityHash: hashScreen(ir.id, ir, sha256),
  };
  return { screen };
};

/**
 * Render the screens and assemble the immutable Figma Snapshot. Render failures degrade to a
 * `skippedScreens` entry (partial render); a non-2xx `/v1/images` call is a hard coded error.
 */
export const buildFigmaSnapshot = async (
  input: BuildFigmaSnapshotInput,
): Promise<FigmaSnapshot> => {
  const screenIds = input.ir.screens.map((screen) => screen.id);
  const renderUrls =
    screenIds.length === 0
      ? new Map<string, string | null>()
      : await requestRenderUrls(input, screenIds);

  const concurrency = input.downloadConcurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY;
  const outcomes = await mapWithConcurrency(input.ir.screens, concurrency, (ir) =>
    resolveScreen(input, ir, renderUrls.get(ir.id) ?? null),
  );

  const screens: FigmaSnapshotScreen[] = [];
  const skippedScreens: FigmaSkippedScreen[] = [];
  for (const outcome of outcomes) {
    if (outcome.screen !== undefined) screens.push(outcome.screen);
    if (outcome.skipped !== undefined) skippedScreens.push(outcome.skipped);
  }

  return {
    snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
    provenance: input.provenance,
    screens,
    skippedScreens,
    integrityHash: hashSnapshot(SNAPSHOT_SCHEMA_VERSION, input.provenance.version, screens),
  };
};
