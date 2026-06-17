// Figma Snapshot render orchestration + assembly (Epic #750, Issue #753).
//
// The SECOND and final Figma egress of the snapshot-build. For each detected screen FRAME id
// (from #752's ScreenIrResult — NEVER the canvas root, which times out on `/v1/images`), it:
//   1. requests an ephemeral render url from `GET /v1/images` (batched, minimal — heavy backoff is
//      #759), authenticated with the read-only PAT in the `X-Figma-Token` header;
//   2. downloads the PNG bytes from that ephemeral url via the injectable render port (no auth
//      header — the url is pre-signed);
//   3. assembles the immutable Snapshot value: per-screen IR + image + deterministic integrity
//      hashes + provenance, with a `skippedScreens` list plus structural-only IR rows for any
//      screen that failed to render.
//
// Once this returns, the Snapshot is the communication boundary: nothing downstream contacts
// Figma. The token flows ONLY into the images-call header; it never reaches the snapshot value,
// the render-url download, an error, or a log.

import { FigmaConnectorError } from "./figmaConnectorErrors.js";
import { mapWithConcurrency } from "./figmaConcurrency.js";
import type { FigmaHttpPort } from "./figmaHttpPort.js";
import type { FigmaRenderPort } from "./figmaRenderPort.js";
import type { FigmaProvenance } from "./figmaConnector.js";
import { classifyTokenFailure } from "./figmaTokenSource.js";
import {
  DEFAULT_FIGMA_RETRY_POLICY,
  fetchWithBackoff,
  realFigmaRetrySleep,
  type FigmaRetryPolicy,
  type FigmaRetrySleep,
} from "./figmaRetry.js";
import { hashBytes, hashScreen, hashSnapshot, hashStructuralScreen } from "./figmaSnapshotHash.js";
import {
  DEFAULT_SCOPED_PAGINATION_LIMITS,
  SCOPED_PAGINATION_LIMIT_CEILINGS,
} from "./figmaScopedPagination.js";
import type {
  FigmaSkippedScreen,
  FigmaSkippedScreenReason,
  FigmaSnapshot,
  FigmaSnapshotScreen,
  FigmaSnapshotStructuralScreen,
} from "./figmaSnapshotTypes.js";
import type { QualityIntelligenceFigma } from "@oscharko-dev/keiko-quality-intelligence";

const FIGMA_API_ORIGIN = "https://api.figma.com";
const SNAPSHOT_SCHEMA_VERSION = 1 as const;
const DEFAULT_RENDER_BATCH_SIZE = 20;
const MAX_RENDER_BATCH_SIZE = 100;
const DEFAULT_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const DEFAULT_RENDER_SCALE = 1;
const DEFAULT_DOWNLOAD_CONCURRENCY = 4;
// Bounded retries for a TRANSIENT malformed `/v1/images` body (a 2xx without an `images` map). Figma's
// render endpoint returns this intermittently when overloaded by back-to-back whole-page builds; an
// isolated retry recovers it. After this many retries the batch degrades to a skip rather than failing
// the whole build (F8).
const MAX_RENDER_BODY_RETRIES = 3;

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
  /** Max screens rendered into image side-files; excess screens remain structural-only skips. */
  readonly maxScreensRendered?: number;
  /** Deterministic 429 backoff policy; defaults to {@link DEFAULT_FIGMA_RETRY_POLICY}. */
  readonly retryPolicy?: FigmaRetryPolicy;
  /** Injectable wait seam so tests assert the backoff schedule without real delays. */
  readonly sleep?: FigmaRetrySleep;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const chunk = <T>(items: readonly T[], size: number): readonly (readonly T[])[] => {
  const safeSize = Number.isInteger(size) && size >= 1 ? size : DEFAULT_RENDER_BATCH_SIZE;
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) out.push(items.slice(i, i + safeSize));
  return out;
};

const boundedPositiveInt = (
  value: number | undefined,
  fallback: number,
  ceiling: number,
): number => {
  if (value === undefined || !Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, ceiling);
};

// Returns true when the hostname is an IP literal or a local/loopback name that must be blocked.
const isBlockedHostname = (h: string): boolean =>
  h.length === 0 ||
  /^\d+\.\d+\.\d+\.\d+$/.test(h) ||
  h.startsWith("[") ||
  h === "localhost" ||
  h.endsWith(".localhost") ||
  h.endsWith(".local");

// Validates that a render URL returned by the Figma API is safe to follow. Blocks http:
// (plaintext) and IP-literal hostnames (RFC-1918, loopback, link-local) to prevent SSRF via
// a compromised or MITM'd API response. A broad IP-block is preferred over a tight CDN
// allowlist because Figma's pre-signed render URLs span multiple AWS S3 regions/CDN fronts.
const isRenderUrlSafe = (raw: string): boolean => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  // Normalise: lowercase + strip exactly one trailing dot so "localhost." == "localhost".
  const h = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isBlockedHostname(h)) return false;
  if (!isAllowedFigmaRenderUrl(url, h)) return false;
  // Only allow the default HTTPS port (443 or implicit) — non-standard ports indicate an
  // internal service, not a CDN. url.port is "" when the port is the scheme default.
  if (url.port !== "" && url.port !== "443") return false;
  return true;
};

const isAllowedFigmaRenderUrl = (url: URL, host: string): boolean => {
  if (host === "s3-alpha-sig.figma.com") return true;
  if (host === "cdn.figma.com" || host === "static.figma.com") return true;
  if (host.endsWith(".figma.com")) return true;
  // Multi-region S3 bucket allowlist: accepts any globally-unique bucket whose NAME starts with
  // "figma" (e.g. figma-prod.s3.eu-west-1.amazonaws.com). The residual risk is that an attacker
  // who can create an S3 bucket named figma-anything could serve a crafted render response. In
  // practice the risk is low: (a) render URLs are returned by the authenticated Figma API over
  // TLS, so a MITM or API compromise is a prerequisite; (b) the URLs are short-lived/pre-signed
  // and carry no Figma auth header (the token is injected only into the /v1/images API call);
  // (c) the byte-cap + oversized-skip guard limits the blast radius of a poisoned response.
  // Tightening to a fixed bucket list would break legitimate Figma render fronts that span many
  // regions; revisit if Figma publishes an authoritative set of render origins.
  if (/^figma[-a-z0-9]*\.s3[.-][a-z0-9-]+\.amazonaws\.com$/u.test(host)) return true;
  if (
    (host === "s3-us-west-2.amazonaws.com" || host === "s3.us-west-2.amazonaws.com") &&
    /^\/figma[-_/a-z0-9]*/iu.test(url.pathname)
  ) {
    return true;
  }
  return false;
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

const extractFigmaReason = (body: unknown): string | undefined => {
  if (!isRecord(body)) return undefined;
  const reason = body.err ?? body.message;
  return typeof reason === "string" ? reason : undefined;
};

const statusToError = (status: number, body: unknown): FigmaConnectorError =>
  classifyTokenFailure(status, extractFigmaReason(body));

// Extracts the `{ images: { id: url|null } }` map from one `/v1/images` response, or `null` when the
// body is a non-standard 2xx WITHOUT an `images` map. Figma's render endpoint returns such a body
// intermittently when it is overloaded by back-to-back whole-page builds (#750 F8 — observed live).
// `null` is a TRANSIENT, retriable signal — the caller retries the batch, then degrades the affected
// screens to a skip (coverage notice) if it persists, rather than failing the whole build.
const extractImageUrls = (json: unknown): Readonly<Record<string, string | null>> | null => {
  if (!isRecord(json) || !isRecord(json.images)) return null;
  const out: Record<string, string | null> = {};
  for (const [id, value] of Object.entries(json.images)) {
    out[id] = typeof value === "string" && value.length > 0 ? value : null;
  }
  return out;
};

// Figma's render endpoint can reject a subset of otherwise readable screen node ids with a client
// status (observed on large boards where some detected screen frames cannot be rendered). That is a
// renderability problem, not an auth/egress/build integrity problem: keep the snapshot usable by
// returning an empty render-url map for that batch so the affected screens become structural-only.
// Auth/scope/proxy/rate-limit/upstream failures remain hard coded errors below.
const isRenderEndpointSoftFailure = (status: number): boolean =>
  status === 400 || status === 404 || status === 422;

// Resolve one `/v1/images` batch to its ephemeral-url map. The fetch is wrapped in the deterministic
// 429 backoff; auth/scope/upstream non-2xx responses are hard coded errors, while renderability
// client failures degrade this batch to structural-only. A 2xx with a malformed body is a transient
// render-overload signal that is retried up to MAX_RENDER_BODY_RETRIES, then degrades to an empty map
// so the affected screens skip (render-url-missing) instead of aborting the build (F8).
const resolveRenderBatch = async (
  input: BuildFigmaSnapshotInput,
  batch: readonly string[],
  policy: FigmaRetryPolicy,
  sleep: FigmaRetrySleep,
): Promise<Readonly<Record<string, string | null>>> => {
  const requestUrl = buildImagesUrl(input.provenance.fileKey, batch, input.provenance.version);
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchWithBackoff(
      () => input.imagesPort({ url: requestUrl, headers: { "X-Figma-Token": input.token } }),
      policy,
      sleep,
    );
    if (response.status < 200 || response.status >= 300) {
      if (isRenderEndpointSoftFailure(response.status)) return {};
      throw statusToError(response.status, response.json);
    }
    const map = extractImageUrls(response.json);
    if (map !== null) return map;
    if (attempt >= MAX_RENDER_BODY_RETRIES) return {};
    await sleep(Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs));
  }
};

// Calls `/v1/images` in bounded batches and merges the ephemeral-url map. The token authenticates
// each batch via the header only. Each batch is 429-backoff retried AND malformed-body retried
// (resolveRenderBatch), so a rate-limited or transiently-overloaded huge-board render survives.
const requestRenderUrls = async (
  input: BuildFigmaSnapshotInput,
  screenIds: readonly string[],
): Promise<Map<string, string | null>> => {
  const policy = input.retryPolicy ?? DEFAULT_FIGMA_RETRY_POLICY;
  const sleep = input.sleep ?? realFigmaRetrySleep;
  const batchSize = boundedPositiveInt(
    input.batchSize,
    DEFAULT_RENDER_BATCH_SIZE,
    MAX_RENDER_BATCH_SIZE,
  );
  const urls = new Map<string, string | null>();
  for (const batch of chunk(screenIds, batchSize)) {
    const map = await resolveRenderBatch(input, batch, policy, sleep);
    for (const id of batch) urls.set(id, map[id] ?? null);
  }
  return urls;
};

interface ScreenOutcome {
  readonly screen?: FigmaSnapshotScreen;
  readonly skipped?: FigmaSkippedScreen;
  readonly structuralScreen?: FigmaSnapshotStructuralScreen;
}

const structuralOnly = (ir: ScreenIr, reason: FigmaSkippedScreenReason): ScreenOutcome => ({
  skipped: { screenId: ir.id, reason },
  structuralScreen: {
    screenId: ir.id,
    ir,
    reason,
    integrityHash: hashStructuralScreen(ir.id, ir),
  },
});

// Classifies a finished render download into a skip reason, or null when the bytes are usable.
const renderSkipReason = (
  response: { readonly status: number; readonly bytes: Uint8Array } | null,
  maxBytes: number,
): FigmaSkippedScreenReason | null => {
  if (response === null) return "render-fetch-failed";
  if (response.status < 200 || response.status >= 300) return "render-fetch-failed";
  if (response.bytes.length === 0) return "render-empty";
  if (response.bytes.length > maxBytes) return "render-oversized";
  return null;
};

// Hard-egress codes for the render-byte download host (S3/CDN — a DIFFERENT host than
// api.figma.com). If the render port throws a FigmaConnectorError in this family, it means
// TLS or proxy is misconfigured for the render CDN; swallowing it would yield a "successful"
// snapshot with every screen skipped while hiding the root cause. Re-throw to abort the build,
// consistent with the DEEP_FETCH_ABORT_CODES discipline in figmaScopedPagination.ts.
// Using ReadonlySet<string> so this set is forward-compatible with the new codes
// (FIGMA_PROXY_AUTH_REQUIRED, FIGMA_PROXY_BLOCKED_BY_POLICY) landing in a parallel change to
// figmaConnectorErrors.ts without requiring a re-touch of this file.
const RENDER_EGRESS_ABORT_CODES: ReadonlySet<string> = new Set([
  "FIGMA_TLS_CA_FAILURE",
  "FIGMA_PROXY_UNREACHABLE",
  "FIGMA_PROXY_EGRESS_FAILED",
  "FIGMA_PROXY_AUTH_REQUIRED",
  "FIGMA_PROXY_BLOCKED_BY_POLICY",
]);

// Classifies a render-port throw into a re-throw (hard egress abort) or a coded skip outcome.
// Hard-egress errors abort the whole build — they affect every screen on the same host so
// swallowing them would silently produce an empty snapshot.
const classifyRenderError = (screenId: string, err: unknown): ScreenOutcome => {
  if (err instanceof FigmaConnectorError) {
    if (RENDER_EGRESS_ABORT_CODES.has(err.code)) throw err;
    return { skipped: { screenId, reason: `render-fetch-failed:${err.code}` } };
  }
  return { skipped: { screenId, reason: "render-fetch-failed" } };
};

// Downloads one screen's render bytes and classifies the result into a kept screen or a skip.
// A single screen failing after retries degrades to a skip (partial render), never aborting.
// Exception: hard egress errors (TLS/proxy misconfiguration) abort via classifyRenderError.
const resolveScreen = async (
  input: BuildFigmaSnapshotInput,
  ir: ScreenIr,
  renderUrl: string | null,
): Promise<ScreenOutcome> => {
  if (renderUrl === null) return structuralOnly(ir, "render-url-missing");
  if (!isRenderUrlSafe(renderUrl)) return structuralOnly(ir, "render-url-blocked");
  const maxBytes = input.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const policy = input.retryPolicy ?? DEFAULT_FIGMA_RETRY_POLICY;
  const sleep = input.sleep ?? realFigmaRetrySleep;
  let response: { readonly status: number; readonly bytes: Uint8Array };
  try {
    response = await fetchWithBackoff(
      () => input.renderPort({ url: renderUrl, headers: {} }),
      policy,
      sleep,
    );
  } catch (err) {
    const classified = classifyRenderError(ir.id, err);
    if (classified.skipped !== undefined) {
      return structuralOnly(ir, classified.skipped.reason);
    }
    return classified;
  }
  const reason = renderSkipReason(response, maxBytes);
  if (reason !== null) return structuralOnly(ir, reason);
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

interface SnapshotRows {
  readonly screens: readonly FigmaSnapshotScreen[];
  readonly skippedScreens: readonly FigmaSkippedScreen[];
  readonly structuralScreens: readonly FigmaSnapshotStructuralScreen[];
}

function collectSnapshotRows(
  outcomes: readonly ScreenOutcome[],
  cappedScreens: readonly ScreenIr[],
): SnapshotRows {
  const screens: FigmaSnapshotScreen[] = [];
  const skippedScreens: FigmaSkippedScreen[] = [];
  const structuralScreens: FigmaSnapshotStructuralScreen[] = [];
  for (const outcome of outcomes) {
    if (outcome.screen !== undefined) screens.push(outcome.screen);
    if (outcome.skipped !== undefined) skippedScreens.push(outcome.skipped);
    if (outcome.structuralScreen !== undefined) structuralScreens.push(outcome.structuralScreen);
  }
  for (const ir of cappedScreens) {
    const outcome = structuralOnly(ir, "render-screen-cap-exceeded");
    if (outcome.skipped !== undefined) skippedScreens.push(outcome.skipped);
    if (outcome.structuralScreen !== undefined) structuralScreens.push(outcome.structuralScreen);
  }
  return { screens, skippedScreens, structuralScreens };
}

/**
 * Render the screens and assemble the immutable Figma Snapshot. Render failures degrade to a
 * `skippedScreens` entry plus structural-only IR (partial render); a non-2xx `/v1/images` call is
 * a hard coded error.
 */
export const buildFigmaSnapshot = async (
  input: BuildFigmaSnapshotInput,
): Promise<FigmaSnapshot> => {
  const maxScreensRendered = boundedPositiveInt(
    input.maxScreensRendered,
    DEFAULT_SCOPED_PAGINATION_LIMITS.maxScreensDeep,
    SCOPED_PAGINATION_LIMIT_CEILINGS.maxScreensDeep,
  );
  const renderableScreens = input.ir.screens.slice(0, maxScreensRendered);
  const cappedScreens = input.ir.screens.slice(maxScreensRendered);
  const screenIds = renderableScreens.map((screen) => screen.id);
  const renderUrls =
    screenIds.length === 0
      ? new Map<string, string | null>()
      : await requestRenderUrls(input, screenIds);

  const concurrency = boundedPositiveInt(
    input.downloadConcurrency,
    DEFAULT_DOWNLOAD_CONCURRENCY,
    Number.MAX_SAFE_INTEGER,
  );
  const outcomes = await mapWithConcurrency(renderableScreens, concurrency, (ir) =>
    resolveScreen(input, ir, renderUrls.get(ir.id) ?? null),
  );
  const { screens, skippedScreens, structuralScreens } = collectSnapshotRows(
    outcomes,
    cappedScreens,
  );

  return {
    snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
    provenance: input.provenance,
    screens,
    skippedScreens,
    structuralScreens,
    // Carried verbatim from the Screen-IR (#752) for the navigation/flow graph (#811). NOT folded
    // into the integrity hash below — `links` is non-identity metadata, so drift (#735) is stable.
    links: input.ir.links,
    integrityHash: hashSnapshot(SNAPSHOT_SCHEMA_VERSION, input.provenance.version, [
      ...screens,
      ...structuralScreens,
    ]),
  };
};
