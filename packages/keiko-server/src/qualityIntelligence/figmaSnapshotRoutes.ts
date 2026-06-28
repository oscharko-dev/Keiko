// Figma Snapshot BFF routes (Epic #750, Issue #756).
//
// Two thin UI-facing routes that sit between the browser surface and the server-side
// Figma connector + snapshot store. The PAT stays ENTIRELY server-side — nothing in
// the request or response carries the token.
//
//   POST /api/figma/snapshots           — trigger a bounded snapshot-build from a board link
//   GET  /api/figma/snapshots/:runId    — load a stored snapshot summary for display
//   GET  /api/figma/snapshots/:runId/screens/:screenIndex/image
//                                       — stream a stored, token-free PNG side-file
//
// Trigger route:
//   1. Parses board link → (fileKey, nodeId) — rejects malformed / missing node-id links.
//   2. Resolves the read-only PAT server-side (vault > config > FIGMA_ACCESS_TOKEN env).
//   3. Builds a runId, runs connector → cleanScopedNodesToScreenIr → buildFigmaSnapshot → store.
//   4. Returns a minimal summary (runId, screenCount, skippedCount, reduction hint).
//      No token, no raw IR bytes, no render bytes are embedded in the JSON response.
//
// Load route reads the stored immutable evidence record and returns a browser-safe
// projection. No re-contact with Figma.
//
// Both routes honour the existing QI error-envelope convention:
//   { error: { code: string; message: string } }
//
// In-flight coalescing (item 2):
//   Concurrent POSTs for the same scope (fileKey:nodeId) share ONE build promise. The FIRST
//   caller starts the governed build, mints the runId ONCE, persists ONCE (inside the build
//   chain so a deadline-expired-but-completed build still persists and is recoverable via an
//   immediate retry POST). Subsequent callers await the same promise and receive the same
//   runId/response. The entry is removed on settle (finally). Failures propagate to all
//   waiters with the same coded error.
//
// Build deadline (item 3):
//   KEIKO_FIGMA_BUILD_DEADLINE_MS (default 600 000 ms). The awaiting handler races the
//   coalesced build promise against a deadline rejection. On deadline the handler responds
//   504 FIGMA_BUILD_TIMEOUT WITHOUT a runId. The coalesced build itself continues (other
//   waiters may exist); persist is INSIDE the build chain, so if/when the build completes
//   a subsequent POST for the same scope finds the map empty and re-coalesces cheaply.
//   The underlying build is bounded by per-fetch timeouts and pagination budgets.
//
// Client disconnect (item 4):
//   The handler listens for the 'close' event on ctx.req. On disconnect the per-waiter
//   race resolves promptly (504 FIGMA_BUILD_TIMEOUT body never sent over the wire).
//   The coalesced build continues — other waiters (if any) are unaffected and will
//   receive the result when the build settles.

import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { STREAMING, type HandlerOutcome, type RouteContext, type RouteResult } from "../routes.js";
import {
  currentGatewayConfig,
  currentGatewayEgressConfig,
  currentRedactionSecrets,
  type UiHandlerDeps,
} from "../deps.js";
import { redact } from "@oscharko-dev/keiko-security";
import type { EnvSource } from "@oscharko-dev/keiko-security";
import {
  appendFigmaConnectorAudit,
  parseFigmaTarget,
  deriveFigmaScopeRef,
  observeFigmaRevoke,
  EXPECTED_FIGMA_SCOPES,
  FigmaConnectorError,
  resolveScopedPaginationLimits,
  type FigmaConnectorErrorCode,
  type FigmaConnectorMetrics,
  type FigmaConnectorAuditCounts,
  type FigmaScopeCoverage,
  type ScopedPaginationLimits,
} from "./figma/index.js";
import {
  governedSnapshotBuild,
  figmaTokenStoreFor,
  type GovernedSnapshotResult,
} from "./figmaSnapshotOrchestration.js";
import {
  createNodeFigmaSnapshotStore,
  type FigmaSnapshotLinkRow,
  type FigmaSnapshotRecord,
  type FigmaSnapshotUserMetadata,
} from "@oscharko-dev/keiko-evidence";

// ─── Error helpers ─────────────────────────────────────────────────────────────

// Operator-facing scope hint, derived from the single source of truth (figmaConsent.EXPECTED_FIGMA_SCOPES)
// so the re-key guidance can never drift from the scopes the consent ledger records (#758 AC2).
const READ_ONLY_SCOPE_HINT = EXPECTED_FIGMA_SCOPES.join(", ");

const FIGMA_ROUTE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  FIGMA_TOKEN_MISSING: `No Figma PAT is configured. Add one in Keiko config, vault, or FIGMA_ACCESS_TOKEN (read-only scopes: ${READ_ONLY_SCOPE_HINT}).`,
  FIGMA_TOKEN_INVALID: "The configured Figma PAT is invalid. Please rotate the token.",
  FIGMA_TOKEN_EXPIRED: "The configured Figma PAT has expired. Please rotate the token.",
  FIGMA_TOKEN_REVOKED: "The configured Figma PAT has been revoked. Please mint a new token.",
  FIGMA_INSUFFICIENT_SCOPE: `The configured Figma PAT lacks the required read-only scopes (${READ_ONLY_SCOPE_HINT}).`,
  FIGMA_NOT_FOUND:
    "The Figma board was not found. Check the link and that the PAT can access this file.",
  FIGMA_NOT_READY:
    "The selected Figma scope is not release-ready. Pin a Figma version, select a Release section, or mark the frame Ready for dev before snapshotting.",
  FIGMA_UPSTREAM_UNAVAILABLE: "Figma API is temporarily unavailable. Please try again.",
  FIGMA_PROXY_EGRESS_FAILED:
    "The forward proxy rejected the Figma egress request. Check proxy configuration.",
  FIGMA_PROXY_UNREACHABLE:
    "The configured forward proxy is unreachable. Check proxy host and port settings.",
  FIGMA_PROXY_AUTH_REQUIRED:
    "The forward proxy requires authentication. Configure proxy credentials or an allow rule.",
  FIGMA_PROXY_BLOCKED_BY_POLICY:
    "The forward proxy blocked the Figma egress request. Ask the proxy operator to allow api.figma.com.",
  FIGMA_TLS_CA_FAILURE:
    "The Figma egress TLS certificate could not be verified. Check the configured CA bundle.",
  FIGMA_RATE_LIMITED:
    "Figma rate-limited the snapshot-build. Retry with a narrower Release section or lower the Figma fetch limits before re-running.",
  FIGMA_OVERSIZED_SCOPE:
    "The selected Figma board section is too large. Select a smaller section (frame or page).",
  FIGMA_RESPONSE_TOO_LARGE:
    "The Figma API response exceeded the size limit. Select a smaller section.",
  FIGMA_NETWORK_UNREACHABLE:
    "The outbound request to Figma failed. Check network connectivity and egress policy.",
  FIGMA_EGRESS_TIMEOUT:
    "The Figma request timed out. Retry or raise KEIKO_FIGMA_REQUEST_TIMEOUT_MS.",
  FIGMA_EGRESS_FAILED: "The outbound request to Figma failed before a response was received.",
  FIGMA_BUILD_TIMEOUT:
    "The snapshot build exceeded the configured deadline. No partial snapshot was stored.",
  FIGMA_INTERNAL: "An unexpected error occurred during the snapshot-build.",
  FIGMA_BAD_LINK:
    "The board link is not a valid Figma URL, or it is missing a node-id " +
    "(section/frame anchor required).",
  FIGMA_BAD_METADATA: "The snapshot metadata update is invalid.",
  FIGMA_SNAPSHOT_NOT_FOUND: "No snapshot was found for this run id.",
  FIGMA_SCREEN_NOT_FOUND: "No captured screen image was found for this snapshot.",
  FIGMA_NO_EVIDENCE_DIR: "The evidence directory is not configured; snapshots cannot be stored.",
  FIGMA_CONSENT_REQUIRED:
    "Acknowledge the read-only, least-privilege Figma scope before the first snapshot for this board.",
  FIGMA_TOKEN_REVOKED_OK: "The stored Figma PAT was removed.",
};

interface FigmaErrorBody {
  readonly error: { readonly code: string; readonly message: string };
  readonly scopes?: readonly string[];
}

function figmaErrorBody(code: string): FigmaErrorBody {
  const base = {
    error: { code, message: FIGMA_ROUTE_ERROR_MESSAGES[code] ?? "An error occurred." },
  };
  // The consent-required response carries the display-only least-privilege scopes (#760) so the UI
  // can show exactly what a read-only token covers before the operator acknowledges. No token, no
  // board reference — only the static scope strings.
  return code === "FIGMA_CONSENT_REQUIRED" ? { ...base, scopes: EXPECTED_FIGMA_SCOPES } : base;
}

// Codes that map to 502 (upstream/auth/egress problems, not client errors).
const FIGMA_502_CODES = new Set<FigmaConnectorErrorCode>([
  "FIGMA_TOKEN_MISSING",
  "FIGMA_TOKEN_INVALID",
  "FIGMA_TOKEN_EXPIRED",
  "FIGMA_TOKEN_REVOKED",
  "FIGMA_INSUFFICIENT_SCOPE",
  "FIGMA_PROXY_EGRESS_FAILED",
  "FIGMA_PROXY_UNREACHABLE",
  "FIGMA_PROXY_AUTH_REQUIRED",
  "FIGMA_PROXY_BLOCKED_BY_POLICY",
  "FIGMA_TLS_CA_FAILURE",
  "FIGMA_UPSTREAM_UNAVAILABLE",
  "FIGMA_NETWORK_UNREACHABLE",
  "FIGMA_EGRESS_TIMEOUT",
  "FIGMA_EGRESS_FAILED",
  "FIGMA_RESPONSE_TOO_LARGE",
]);

function figmaStatusForCode(code: FigmaConnectorErrorCode): number {
  if (FIGMA_502_CODES.has(code)) return 502;
  if (code === "FIGMA_NOT_FOUND") return 404;
  if (code === "FIGMA_NOT_READY") return 412;
  if (code === "FIGMA_RATE_LIMITED") return 429;
  if (code === "FIGMA_OVERSIZED_SCOPE") return 422;
  // Precondition Required: the operator must acknowledge the read-only scope before the build (#760).
  if (code === "FIGMA_CONSENT_REQUIRED") return 428;
  if (code === "FIGMA_BUILD_TIMEOUT") return 504;
  return 500;
}

// ─── Body reader ───────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 8 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!capped) {
          capped = true;
          reject(new Error("body_too_large"));
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

// ─── Browser-safe snapshot summary ─────────────────────────────────────────────

export interface FigmaSnapshotSummary {
  readonly runId: string;
  /** Mutable display name stored outside the immutable evidence record. */
  readonly displayName?: string;
  /** Mutable management metadata stored outside the immutable evidence record. */
  readonly management: FigmaSnapshotManagementSummary;
  readonly fileKey: string;
  readonly nodeId: string;
  readonly version: string | undefined;
  readonly fetchedAt: string;
  /** Total screens included in the snapshot. */
  readonly screenCount: number;
  /** Screens that could not be rendered (partial build). */
  readonly skippedCount: number;
  /**
   * Human-readable reduction hint, e.g. "1 screen from 1 Figma node" or
   * "3 screens from 1 section (2 skipped)".
   */
  readonly reductionHint: string;
  /** Skipped/non-rendered screens that still carry persisted structural Screen-IR JSON. */
  readonly structuralOnlyCount: number;
  /** Integrity hash over the snapshot content — deterministic for drift detection (#735). */
  readonly integrityHash: string;
  /**
   * Deep-fetch coverage telemetry (#837) — present on a freshly-built snapshot (POST response).
   * Lets the UI honestly report how much of a huge instance-heavy board was deep-fetched vs
   * truncated by the bounded per-screen budgets. Build-time only; never persisted in the snapshot.
   */
  readonly coverage?: FigmaScopeCoverage;
  /**
   * Operational metrics (#760) — present on POST and reloaded GET summaries: reduction
   * ratio, screen/render counts, design-token count, navigation-graph size (screens + transitions),
   * a11y-finding count, and the deterministic-vs-model augmentation share. All NUMBERS — never any
   * board content, screen name, token, or board id.
   */
  readonly metrics?: FigmaConnectorMetrics;
  /**
   * Per-screen summary for the UI gallery. IR display names + image metadata only. The client loads
   * the token-free PNG side-file through /api/figma/snapshots/:runId/screens/:screenIndex/image.
   */
  readonly screens: readonly FigmaScreenSummary[];
  /**
   * Screen-IR summaries for detected screens that have JSON evidence but no rendered PNG side-file.
   * These are selectable as QI sources, but the browser cannot request an image for them.
   */
  readonly structuralScreens: readonly FigmaStructuralScreenSummary[];
}

export interface FigmaSnapshotManagementSummary {
  readonly displayName?: string;
  readonly updatedAt?: string;
}

export interface FigmaScreenSummary {
  readonly screenId: string;
  /** Display name derived from the IR (ir.name). */
  readonly name: string;
  /** A brief structural description (field count, control count) for the gallery card. */
  readonly irSummary: string;
  /** Relative path of the side-file (informational). */
  readonly imageRelativePath: string;
  /** sha256 of the rendered PNG. */
  readonly imageSha256: string;
  /** Byte size of the rendered PNG. */
  readonly imageByteLength: number;
}

export interface FigmaStructuralScreenSummary {
  readonly screenId: string;
  /** Display name derived from the IR (ir.name). */
  readonly name: string;
  /** A brief structural description (field count, control count) for the gallery card. */
  readonly irSummary: string;
  /** Why no rendered PNG side-file exists for this screen. */
  readonly reason: string;
}

interface FigmaSnapshotScreenJsonResponse {
  readonly runId: string;
  readonly fileKey: string;
  readonly nodeId: string;
  readonly version: string | undefined;
  readonly fetchedAt: string;
  readonly source: {
    readonly kind: "figma-snapshot";
    readonly snapshotRunId: string;
    readonly screenIds: readonly string[];
  };
  readonly snapshot: {
    readonly screenCount: number;
    readonly skippedCount: number;
    readonly structuralOnlyCount: number;
    readonly integrityHash: string;
    readonly redactionSummary: FigmaSnapshotRecord["redactionSummary"];
    readonly metrics?: FigmaSnapshotRecord["metrics"];
    readonly tokens?: unknown;
  };
  readonly screen: {
    readonly kind: "rendered" | "structural";
    readonly screenId: string;
    readonly name: string;
    readonly irSummary: string;
    readonly integrityHash: string;
    readonly irJson: unknown;
    readonly image?:
      | {
          readonly mimeType: "image/png";
          readonly relativePath: string;
          readonly sha256: string;
          readonly byteLength: number;
        }
      | undefined;
    readonly structuralReason?: string | undefined;
  };
  readonly relatedLinks: readonly FigmaSnapshotLinkRow[];
}

type FigmaSnapshotScreenJsonSnapshot = FigmaSnapshotScreenJsonResponse["snapshot"];
type FigmaSnapshotRenderedScreen = FigmaSnapshotRecord["screens"][number];
type FigmaSnapshotStructuralScreen = NonNullable<FigmaSnapshotRecord["structuralScreens"]>[number];

export interface FigmaSnapshotListEntry {
  readonly runId: string;
  readonly displayName?: string;
  readonly management: FigmaSnapshotManagementSummary;
  readonly fileKey: string;
  readonly nodeId: string;
  readonly version: string | undefined;
  readonly fetchedAt: string;
  readonly screenCount: number;
  readonly skippedCount: number;
  readonly structuralOnlyCount: number;
  readonly reductionHint: string;
  readonly integrityHash: string;
}

export interface FigmaSnapshotListResponse {
  readonly snapshots: readonly FigmaSnapshotListEntry[];
}

function buildReductionHint(
  screenCount: number,
  skippedCount: number,
  structuralOnlyCount = 0,
): string {
  const total = screenCount + skippedCount;
  if (skippedCount === 0) {
    return `${screenCount.toString()} screen${screenCount !== 1 ? "s" : ""} from ${total.toString()} detected`;
  }
  const structuralClause =
    structuralOnlyCount > 0
      ? `${structuralOnlyCount.toString()} structural-only`
      : `${skippedCount.toString()} render${skippedCount !== 1 ? "s" : ""} skipped`;
  const missingIrCount = Math.max(0, skippedCount - structuralOnlyCount);
  const missingClause =
    structuralOnlyCount > 0 && missingIrCount > 0
      ? `; ${missingIrCount.toString()} without structural IR`
      : "";
  return `${screenCount.toString()} rendered screen${screenCount !== 1 ? "s" : ""} from ${total.toString()} detected (${structuralClause}${missingClause})`;
}

// Counts interaction-hint roles over a stored ScreenIr node tree (`{ root: { interactionHint,
// children } }`). Duck-typed: it does NOT import the IR domain, only walks the serialised shape the
// snapshot persists. Bounded by the tree size already capped at fetch time.
function countRoles(irJson: unknown): { fields: number; controls: number; texts: number } {
  const counts = { fields: 0, controls: 0, texts: 0 };
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    const n = node as Record<string, unknown>;
    const hint = typeof n.interactionHint === "string" ? n.interactionHint : "";
    if (hint === "input") counts.fields += 1;
    else if (hint === "button" || hint === "link") counts.controls += 1;
    else if (hint === "text") counts.texts += 1;
    if (Array.isArray(n.children)) for (const child of n.children) visit(child);
  };
  const ir =
    typeof irJson === "object" && irJson !== null ? (irJson as Record<string, unknown>) : {};
  visit(ir.root);
  return counts;
}

// Produces a brief structural summary string from a ScreenIr value (duck-typed — keeps this
// module honest: it does NOT import the IR domain or depend on its internal shape). Walks the IR
// node tree (`root`) to count fields/controls/text, which is where the structure actually lives —
// the previous flat `ir.fields`/`ir.controls` lookup never matched the persisted shape and always
// returned the bare "screen" fallback.
function irSummaryFromJson(irJson: unknown): string {
  const { fields, controls, texts } = countRoles(irJson);
  const parts: string[] = [];
  if (fields > 0) parts.push(`${fields.toString()} field${fields !== 1 ? "s" : ""}`);
  if (controls > 0) parts.push(`${controls.toString()} control${controls !== 1 ? "s" : ""}`);
  if (texts > 0) parts.push(`${texts.toString()} text${texts !== 1 ? "s" : ""}`);
  return parts.length > 0 ? parts.join(", ") : "screen";
}

function screenNameFromIrJson(irJson: unknown): string {
  if (typeof irJson !== "object" || irJson === null) return "Screen";
  const ir = irJson as Record<string, unknown>;
  const name = ir.name;
  return typeof name === "string" && name.length > 0 ? name : "Screen";
}

function managementSummaryFromMetadata(
  metadata: FigmaSnapshotUserMetadata | undefined,
): FigmaSnapshotManagementSummary {
  return {
    ...(metadata?.displayName !== undefined ? { displayName: metadata.displayName } : {}),
    ...(metadata?.updatedAt !== undefined ? { updatedAt: metadata.updatedAt } : {}),
  };
}

function recordToSummary(
  record: FigmaSnapshotRecord,
  coverage?: FigmaScopeCoverage,
  metrics?: FigmaConnectorMetrics,
  metadata?: FigmaSnapshotUserMetadata,
): FigmaSnapshotSummary {
  const screenCount = record.screens.length;
  const skippedCount = record.skippedScreens.length;
  const structuralOnlyCount = record.structuralScreens?.length ?? 0;
  const management = managementSummaryFromMetadata(metadata);
  const truncatedClause =
    coverage !== undefined && (coverage.screensTruncated > 0 || coverage.capped)
      ? `; ${coverage.screensTruncated.toString()} partially captured (deep content bounded)`
      : "";
  return {
    runId: record.runId,
    ...(management.displayName !== undefined ? { displayName: management.displayName } : {}),
    management,
    fileKey: record.provenance.fileKey,
    nodeId: record.provenance.nodeId,
    version: record.provenance.version,
    fetchedAt: record.provenance.fetchedAt,
    screenCount,
    skippedCount,
    structuralOnlyCount,
    reductionHint: `${buildReductionHint(screenCount, skippedCount, structuralOnlyCount)}${truncatedClause}`,
    integrityHash: record.integrityHash,
    ...(coverage !== undefined ? { coverage } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
    screens: record.screens.map((s) => ({
      screenId: s.screenId,
      name: screenNameFromIrJson(s.irJson),
      irSummary: irSummaryFromJson(s.irJson),
      imageRelativePath: s.image.relativePath,
      imageSha256: s.image.sha256,
      imageByteLength: s.image.byteLength,
    })),
    structuralScreens: (record.structuralScreens ?? []).map((s) => ({
      screenId: s.screenId,
      name: screenNameFromIrJson(s.irJson),
      irSummary: irSummaryFromJson(s.irJson),
      reason: s.reason,
    })),
  };
}

function decodeRouteParam(raw: string | undefined): string {
  if (raw === undefined || raw.length === 0) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

function collectIrIds(value: unknown, out: Set<string> = new Set<string>()): Set<string> {
  if (typeof value !== "object" || value === null) return out;
  if (Array.isArray(value)) {
    for (const entry of value) collectIrIds(entry, out);
    return out;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && record.id.length > 0) out.add(record.id);
  for (const entry of Object.values(record)) collectIrIds(entry, out);
  return out;
}

function relatedLinksForScreen(
  irJson: unknown,
  links: readonly FigmaSnapshotLinkRow[] | undefined,
): readonly FigmaSnapshotLinkRow[] {
  if (links === undefined || links.length === 0) return [];
  const ids = collectIrIds(irJson);
  return links.filter((link) => ids.has(link.sourceNodeId) || ids.has(link.targetNodeId));
}

function screenJsonSnapshot(record: FigmaSnapshotRecord): FigmaSnapshotScreenJsonSnapshot {
  return {
    screenCount: record.screens.length,
    skippedCount: record.skippedScreens.length,
    structuralOnlyCount: record.structuralScreens?.length ?? 0,
    integrityHash: record.integrityHash,
    redactionSummary: record.redactionSummary,
    ...(record.metrics !== undefined ? { metrics: record.metrics } : {}),
    ...(record.tokens !== undefined ? { tokens: record.tokens } : {}),
  };
}

function renderedScreenJsonResponse(
  record: FigmaSnapshotRecord,
  rendered: FigmaSnapshotRenderedScreen,
): FigmaSnapshotScreenJsonResponse {
  return {
    runId: record.runId,
    fileKey: record.provenance.fileKey,
    nodeId: record.provenance.nodeId,
    version: record.provenance.version,
    fetchedAt: record.provenance.fetchedAt,
    source: {
      kind: "figma-snapshot",
      snapshotRunId: record.runId,
      screenIds: [rendered.screenId],
    },
    snapshot: screenJsonSnapshot(record),
    screen: {
      kind: "rendered",
      screenId: rendered.screenId,
      name: screenNameFromIrJson(rendered.irJson),
      irSummary: irSummaryFromJson(rendered.irJson),
      integrityHash: rendered.integrityHash,
      irJson: rendered.irJson,
      image: rendered.image,
    },
    relatedLinks: relatedLinksForScreen(rendered.irJson, record.links),
  };
}

function structuralScreenJsonResponse(
  record: FigmaSnapshotRecord,
  structural: FigmaSnapshotStructuralScreen,
): FigmaSnapshotScreenJsonResponse {
  return {
    runId: record.runId,
    fileKey: record.provenance.fileKey,
    nodeId: record.provenance.nodeId,
    version: record.provenance.version,
    fetchedAt: record.provenance.fetchedAt,
    source: {
      kind: "figma-snapshot",
      snapshotRunId: record.runId,
      screenIds: [structural.screenId],
    },
    snapshot: screenJsonSnapshot(record),
    screen: {
      kind: "structural",
      screenId: structural.screenId,
      name: screenNameFromIrJson(structural.irJson),
      irSummary: irSummaryFromJson(structural.irJson),
      integrityHash: structural.integrityHash,
      irJson: structural.irJson,
      structuralReason: structural.reason,
    },
    relatedLinks: relatedLinksForScreen(structural.irJson, record.links),
  };
}

function screenJsonResponse(
  record: FigmaSnapshotRecord,
  screenId: string,
): FigmaSnapshotScreenJsonResponse | undefined {
  const rendered = record.screens.find((screen) => screen.screenId === screenId);
  if (rendered !== undefined) return renderedScreenJsonResponse(record, rendered);
  const structural = record.structuralScreens?.find((screen) => screen.screenId === screenId);
  return structural === undefined ? undefined : structuralScreenJsonResponse(record, structural);
}

function recordToListEntry(
  record: FigmaSnapshotRecord,
  metadata?: FigmaSnapshotUserMetadata,
): FigmaSnapshotListEntry {
  const structuralOnlyCount = record.structuralScreens?.length ?? 0;
  const management = managementSummaryFromMetadata(metadata);
  return {
    runId: record.runId,
    ...(management.displayName !== undefined ? { displayName: management.displayName } : {}),
    management,
    fileKey: record.provenance.fileKey,
    nodeId: record.provenance.nodeId,
    version: record.provenance.version,
    fetchedAt: record.provenance.fetchedAt,
    screenCount: record.screens.length,
    skippedCount: record.skippedScreens.length,
    structuralOnlyCount,
    reductionHint: buildReductionHint(
      record.screens.length,
      record.skippedScreens.length,
      structuralOnlyCount,
    ),
    integrityHash: record.integrityHash,
  };
}

function persistedAuditCounts(
  record: FigmaSnapshotRecord,
  metrics: FigmaConnectorMetrics,
): FigmaConnectorAuditCounts {
  return {
    screens: metrics.screenCount,
    renders: metrics.renderCount,
    skipped: record.skippedScreens.length,
    designTokens: metrics.designTokenCount,
    ...(metrics.navGraph !== undefined ? { navTransitions: metrics.navGraph.transitions } : {}),
  };
}

function appendPersistedSnapshotAudit(
  evidenceDir: string,
  result: GovernedSnapshotResult,
  record: FigmaSnapshotRecord,
  isResnapshot: boolean,
): void {
  appendFigmaConnectorAudit({
    scopeRef: result.scopeRef,
    evidenceDir,
    action: isResnapshot ? "resnapshot" : "snapshot",
    outcome: "ok",
    counts: persistedAuditCounts(record, result.metrics),
    now: result.provenance.fetchedAt,
  });
}

function appendSnapshotRouteFailureAudit(
  evidenceDir: string,
  result: GovernedSnapshotResult,
  isResnapshot: boolean,
  errorCode: FigmaConnectorErrorCode,
): void {
  appendFigmaConnectorAudit({
    scopeRef: result.scopeRef,
    evidenceDir,
    action: isResnapshot ? "resnapshot" : "snapshot",
    outcome: "error",
    errorCode,
    now: result.provenance.fetchedAt,
  });
}

// ─── POST /api/figma/snapshots — parse + validate ─────────────────────────────

function parseTriggerJson(raw: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function parseTriggerBoardLink(body: Record<string, unknown>): string | undefined {
  const boardLink = typeof body.boardLink === "string" ? body.boardLink.trim() : "";
  return boardLink.length > 0 && parseFigmaTarget(boardLink) !== null ? boardLink : undefined;
}

/** Reads and validates the POST body, returning the board link or an error result. */
async function parseTriggerBody(req: IncomingMessage): Promise<ParsedTriggerBody | RouteResult> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    return { status: 400, body: figmaErrorBody("FIGMA_BAD_LINK") };
  }
  const body = parseTriggerJson(raw);
  if (body === undefined) {
    return { status: 400, body: figmaErrorBody("FIGMA_BAD_LINK") };
  }
  const boardLink = parseTriggerBoardLink(body);
  if (boardLink === undefined) {
    return { status: 400, body: figmaErrorBody("FIGMA_BAD_LINK") };
  }
  const requestedVersion =
    typeof body.version === "string" ? parseFigmaVersion(body.version) : undefined;
  const linkVersion = parseFigmaVersionFromLink(boardLink);
  const version = requestedVersion ?? linkVersion;
  return {
    boardLink,
    ...(version !== undefined ? { version } : {}),
    // Explicit read-only-scope acknowledgement (#760): records consent BEFORE the first fetch.
    acknowledgeReadOnly: body.acknowledgeReadOnly === true,
    // Audited as a re-snapshot (#759): a fresh, explicit, full scoped re-fetch — never a delta.
    isResnapshot: body.isResnapshot === true,
  };
}

interface ParsedTriggerBody {
  readonly boardLink: string;
  readonly version?: string;
  readonly acknowledgeReadOnly: boolean;
  readonly isResnapshot: boolean;
}

const FIGMA_VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;

function parseFigmaVersion(raw: string): string | undefined {
  const value = raw.trim();
  return FIGMA_VERSION_PATTERN.test(value) ? value : undefined;
}

function parseFigmaVersionFromLink(boardLink: string): string | undefined {
  try {
    const url = new URL(boardLink);
    const raw = url.searchParams.get("version-id") ?? url.searchParams.get("version");
    return raw === null ? undefined : parseFigmaVersion(raw);
  } catch {
    return undefined;
  }
}

// Deployment-overridable deep scoped-pagination budgets (#837). Operators on a tighter Figma plan can
// dial concurrency/depth/screen-count down (or up) via env without a code change; an unset or
// non-positive value falls back to the connector default. Mirrors the #532 KEIKO_GROUNDING_* pattern.
export function figmaPaginationFromEnv(env: EnvSource): ScopedPaginationLimits {
  const readPositiveInt = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  };
  const overrides: Record<string, number> = {};
  const apply = (key: keyof ScopedPaginationLimits, envName: string): void => {
    const value = readPositiveInt(env[envName]);
    if (value !== undefined) overrides[key] = value;
  };
  apply("pageDepth", "KEIKO_FIGMA_PAGE_DEPTH");
  apply("maxNodesPerScreen", "KEIKO_FIGMA_MAX_NODES_PER_SCREEN");
  apply("maxFetchesPerScreen", "KEIKO_FIGMA_MAX_FETCHES_PER_SCREEN");
  apply("maxScreensDeep", "KEIKO_FIGMA_MAX_SCREENS_DEEP");
  apply("fetchConcurrency", "KEIKO_FIGMA_FETCH_CONCURRENCY");
  return resolveScopedPaginationLimits(overrides);
}

/** Default total snapshot-build deadline in milliseconds (10 minutes). */
const DEFAULT_BUILD_DEADLINE_MS = 600_000;

/** Default per-fetch request timeout in milliseconds (1 minute). */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

// Parses a positive-integer env var, returning the default when the value is absent or invalid.
function readPositiveIntEnv(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : defaultValue;
}

/** KEIKO_FIGMA_BUILD_DEADLINE_MS — total build deadline used by the coalesced promise race. */
function figmaBuildDeadlineMsFromEnv(env: EnvSource): number {
  return readPositiveIntEnv(env.KEIKO_FIGMA_BUILD_DEADLINE_MS, DEFAULT_BUILD_DEADLINE_MS);
}

/** KEIKO_FIGMA_REQUEST_TIMEOUT_MS — per-fetch timeout threaded into the transport ports. */
function figmaRequestTimeoutMsFromEnv(env: EnvSource): number {
  return readPositiveIntEnv(env.KEIKO_FIGMA_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS);
}

// F9 observability: a `FIGMA_INTERNAL` 500 is the catch-all for an UNEXPECTED build/persist failure;
// the coded body is content-free, so on its own an operator cannot tell a transient render-body
// malformation from a filesystem failure from a genuine bug. Log the redacted cause (class + message,
// secrets scrubbed) so the incident is diagnosable without ever leaking a token or provider body.
// Matches the redacted-console.error convention (memory-salience.ts). Only fires for FIGMA_INTERNAL —
// expected coded errors (consent/auth/rate-limit) stay quiet (they are already audited).
function logFigmaInternal(stage: string, err: unknown, deps: UiHandlerDeps): void {
  const name = err instanceof Error ? err.constructor.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(
    `figma snapshot-build failed (${stage}): ${name}`,
    redact(message, currentRedactionSecrets(deps)),
  );
}

// Map a thrown error from the governed build to a coded route result: a coded connector error maps to
// its status (consent-required → 428, auth → 502, rate-limit → 429, …); anything else is a safe 500.
function figmaErrorResult(err: unknown, deps: UiHandlerDeps): RouteResult {
  if (err instanceof FigmaConnectorError) {
    if (err.code === "FIGMA_INTERNAL") logFigmaInternal("build", err, deps);
    return { status: figmaStatusForCode(err.code), body: figmaErrorBody(err.code) };
  }
  logFigmaInternal("build", err, deps);
  return { status: 500, body: figmaErrorBody("FIGMA_INTERNAL") };
}

/**
 * Persist the governed snapshot to the evidence store. Now carries BOTH the inter-screen prototype
 * transitions (#811 navigation graph) and the deterministic design-tokens artifact (#752, consumed by
 * design-to-code #755) — both hash-neutral and both previously dropped by the route.
 */
function persistSnapshot(
  evidenceDir: string,
  runId: string,
  result: GovernedSnapshotResult,
  deps: UiHandlerDeps,
): FigmaSnapshotRecord | RouteResult {
  const store = createNodeFigmaSnapshotStore(evidenceDir);
  try {
    store.record({
      runId,
      provenance: result.provenance,
      integrityHash: result.snapshot.integrityHash,
      screens: result.snapshot.screens.map((s) => ({
        screenId: s.screenId,
        irJson: s.ir,
        integrityHash: s.integrityHash,
        image: { mimeType: "image/png" as const, bytes: s.image.bytes },
      })),
      ...(result.snapshot.structuralScreens !== undefined
        ? {
            structuralScreens: result.snapshot.structuralScreens.map((s) => ({
              screenId: s.screenId,
              reason: s.reason,
              irJson: s.ir,
              integrityHash: s.integrityHash,
            })),
          }
        : {}),
      skippedScreens: result.snapshot.skippedScreens.map((ss) => ({
        screenId: ss.screenId,
        reason: ss.reason,
      })),
      ...(result.snapshot.links !== undefined ? { links: result.snapshot.links } : {}),
      tokens: result.ir.tokens,
      metrics: result.metrics,
    });
  } catch (e) {
    logFigmaInternal("persist.record", e, deps);
    return { status: 500, body: figmaErrorBody("FIGMA_INTERNAL") };
  }
  let record: FigmaSnapshotRecord | undefined;
  try {
    record = store.load(runId);
  } catch (e) {
    logFigmaInternal("persist.load", e, deps);
    return { status: 500, body: figmaErrorBody("FIGMA_INTERNAL") };
  }
  if (record === undefined) return { status: 500, body: figmaErrorBody("FIGMA_INTERNAL") };
  return record;
}

// ─── In-flight coalescing ──────────────────────────────────────────────────────
//
// Keyed by "fileKey:nodeId:operation:consent" (the snapshot scope plus flags that affect auditing or
// consent). The FIRST POST starts the governed build, mints the runId ONCE, and persists ONCE
// (inside the build chain — see header comment for the persist-inside-build design decision).
// Subsequent POSTs for the same scope and same flags await the SAME promise and receive the same
// runId and response. The entry is removed on settle (finally) so a retry POSTing after the build
// completes always starts fresh. Re-snapshot requests intentionally do not coalesce with first-
// snapshot requests because #756/#759 require an explicit re-snapshot to be audited and fetched as a
// fresh full scoped build; consent-acknowledged requests also stay separate from unacknowledged ones
// so the first caller cannot mask a later operator acknowledgement.

interface CoalescedBuildEntry {
  readonly promise: Promise<RouteResult>;
}

// The map is module-level so it is shared across concurrent requests on the same server instance.
// It is exposed via makeInFlightMap so tests can inject a fresh map (isolation without mocking).
let defaultInFlightMap = new Map<string, CoalescedBuildEntry>();

/** Injectable for tests — returns the module-level map by default. */
export function makeInFlightMap(): Map<string, CoalescedBuildEntry> {
  return defaultInFlightMap;
}

/** Reset the module-level coalescing map. Used by tests to ensure isolation. */
export function resetInFlightMap(): void {
  defaultInFlightMap = new Map<string, CoalescedBuildEntry>();
}

/** Derive the coalescing key (fileKey:nodeId:operation:consent) for the in-flight map. */
function coalescingKeyFor(
  boardLink: string,
  acknowledgeReadOnly: boolean,
  isResnapshot: boolean,
  version?: string,
): string | undefined {
  const target = parseFigmaTarget(boardLink);
  if (target === null) return undefined;
  return `${target.fileKey}:${target.nodeId}:${version ?? "latest"}:${isResnapshot ? "resnapshot" : "snapshot"}:${acknowledgeReadOnly ? "ack" : "noack"}`;
}

// Starts the governed build + persist and removes the map entry on settle.
// Persist is INSIDE this chain: if a caller's deadline fires but the build later completes,
// the record is stored and an immediate retry POST coalesces or finds it via the GET route.
function startCoalescedBuild(
  scopeKey: string,
  inFlight: Map<string, CoalescedBuildEntry>,
  boardLink: string,
  body: ParsedTriggerBody,
  evidenceDir: string,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const buildAndPersist = async (): Promise<RouteResult> => {
    let result: GovernedSnapshotResult;
    try {
      // The governed build resolves the vault>config>env PAT (#758), gates on recorded read-only
      // consent before any egress + audits the action + computes metrics (#760), and deep-fetches +
      // renders within the snapshot boundary (#837/#759). Errors (incl. consent-required) are coded.
      result = await governedSnapshotBuild(
        boardLink,
        {
          evidenceDir,
          env: deps.env,
          now: new Date().toISOString(),
          acknowledgeReadOnly: body.acknowledgeReadOnly,
          version: body.version,
          pagination: figmaPaginationFromEnv(deps.env),
          egress: currentGatewayEgressConfig(deps),
          configToken: currentGatewayConfig(deps)?.figma?.accessToken,
          portOptions: { timeoutMs: figmaRequestTimeoutMsFromEnv(deps.env) },
          deferSuccessAudit: true,
        },
        body.isResnapshot,
      );
    } catch (err) {
      return figmaErrorResult(err, deps);
    }

    const runId = `fs-${randomUUID()}`;
    const stored = persistSnapshot(evidenceDir, runId, result, deps);
    if ("status" in stored) {
      appendSnapshotRouteFailureAudit(evidenceDir, result, body.isResnapshot, "FIGMA_INTERNAL");
      return stored;
    }
    appendPersistedSnapshotAudit(evidenceDir, result, stored, body.isResnapshot);
    return { status: 201, body: recordToSummary(stored, result.coverage, stored.metrics) };
  };

  const promise = buildAndPersist().finally(() => {
    inFlight.delete(scopeKey);
  });
  inFlight.set(scopeKey, { promise });
  return promise;
}

// Returns a clearable deadline: promise rejects with FIGMA_BUILD_TIMEOUT after `ms` ms.
// `.unref()` ensures a stray pending timer never blocks event-loop / test teardown.
// Always call `.clear()` in a finally block after the race settles.
interface Deadline {
  readonly promise: Promise<never>;
  readonly clear: () => void;
}
function makeDeadline(ms: number): Deadline {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timerId = setTimeout(() => {
      reject(new FigmaConnectorError("FIGMA_BUILD_TIMEOUT"));
    }, ms);
    timerId.unref();
  });
  return {
    promise,
    clear: (): void => {
      clearTimeout(timerId);
    },
  };
}

// ─── POST /api/figma/snapshots ─────────────────────────────────────────────────

export async function handleFigmaTriggerSnapshot(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  inFlight: Map<string, CoalescedBuildEntry> = defaultInFlightMap,
): Promise<RouteResult> {
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined || evidenceDir.length === 0) {
    return { status: 503, body: figmaErrorBody("FIGMA_NO_EVIDENCE_DIR") };
  }
  const bodyResult = await parseTriggerBody(ctx.req);
  if ("status" in bodyResult) return bodyResult;
  const body: ParsedTriggerBody = bodyResult;

  const scopeKey = coalescingKeyFor(
    body.boardLink,
    body.acknowledgeReadOnly,
    body.isResnapshot,
    body.version,
  );
  if (scopeKey === undefined) {
    // parseTriggerBody already validates the board link; this is a belt-and-suspenders guard.
    return { status: 400, body: figmaErrorBody("FIGMA_BAD_LINK") };
  }

  // Coalesce: join an existing build for this scope, or start a new one.
  const existing = inFlight.get(scopeKey);
  const buildPromise =
    existing !== undefined
      ? existing.promise
      : startCoalescedBuild(scopeKey, inFlight, body.boardLink, body, evidenceDir, deps);

  const deadlineMs = figmaBuildDeadlineMsFromEnv(deps.env);
  const deadline = makeDeadline(deadlineMs);

  // Per-waiter race: deadline + client-disconnect both resolve this waiter promptly while the
  // coalesced build (and its persist) continues uninterrupted for other waiters.
  // Named handler so removeListener can target it precisely in the finally block.
  let onClose!: () => void;
  const disconnectPromise = new Promise<never>((_resolve, reject) => {
    onClose = (): void => {
      reject(new FigmaConnectorError("FIGMA_BUILD_TIMEOUT"));
    };
    ctx.req.once("close", onClose);
  });

  try {
    return await Promise.race([buildPromise, deadline.promise, disconnectPromise]);
  } catch (err) {
    return figmaErrorResult(err, deps);
  } finally {
    deadline.clear();
    ctx.req.removeListener("close", onClose);
  }
}

// ─── DELETE /api/figma/token — revoke the stored PAT (#758 rotation/revocation, #760 audit) ───

export function handleFigmaRevokeToken(_ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined || evidenceDir.length === 0) {
    return { status: 503, body: figmaErrorBody("FIGMA_NO_EVIDENCE_DIR") };
  }
  // Revoke is operator key removal (#758): delete the encrypted vault entry. Audited as a connector
  // action (#760) via the observed wrapper. The env/config token (if any) is untouched — revocation
  // only removes the highest-precedence vault key, so the operator can fall back or re-key.
  const scopeRef = deriveFigmaScopeRef("vault", "token");
  try {
    const store = figmaTokenStoreFor({ env: deps.env, evidenceDir });
    observeFigmaRevoke({
      ctx: { evidenceDir, now: new Date().toISOString() },
      scopeRef,
      run: () => {
        store.revoke();
      },
    });
  } catch (err) {
    return figmaErrorResult(err, deps);
  }
  return {
    status: 200,
    body: {
      code: "FIGMA_TOKEN_REVOKED_OK",
      message: FIGMA_ROUTE_ERROR_MESSAGES.FIGMA_TOKEN_REVOKED_OK,
    },
  };
}

// ─── GET /api/figma/snapshots — list stored snapshots for dashboard/history ────────────────

const DEFAULT_FIGMA_SNAPSHOT_LIST_LIMIT = 12;
const MAX_FIGMA_SNAPSHOT_LIST_LIMIT = 50;
const FIGMA_SNAPSHOT_RECORD_SUFFIX = ".figma-snapshot.json";
const FIGMA_EVIDENCE_SUBDIR = "qi";

function parseSnapshotListLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw.length === 0) return DEFAULT_FIGMA_SNAPSHOT_LIST_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_FIGMA_SNAPSHOT_LIST_LIMIT;
  return Math.min(parsed, MAX_FIGMA_SNAPSHOT_LIST_LIMIT);
}

function parseSnapshotListScope(
  url: URL,
): { readonly fileKey: string; readonly nodeId: string } | undefined {
  const fileKey = (url.searchParams.get("fileKey") ?? "").trim();
  const nodeId = (url.searchParams.get("nodeId") ?? "").trim();
  return fileKey.length > 0 && nodeId.length > 0 ? { fileKey, nodeId } : undefined;
}

function loadSnapshotListEntries(
  store: ReturnType<typeof createNodeFigmaSnapshotStore>,
  runIds: readonly string[],
): readonly FigmaSnapshotListEntry[] {
  const entries: FigmaSnapshotListEntry[] = [];
  for (const runId of runIds) {
    let record: FigmaSnapshotRecord | undefined;
    try {
      record = store.loadMetadata(runId);
    } catch {
      continue;
    }
    if (record !== undefined)
      entries.push(recordToListEntry(record, store.loadUserMetadata(runId)));
  }
  return entries;
}

function readSnapshotFetchedAt(qiDir: string, fileName: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(qiDir, fileName), "utf8")) as Record<
      string,
      unknown
    >;
    const provenance =
      typeof parsed.provenance === "object" && parsed.provenance !== null
        ? (parsed.provenance as Record<string, unknown>)
        : undefined;
    const fetchedAt = provenance?.fetchedAt;
    return typeof fetchedAt === "string" && fetchedAt.length > 0 ? fetchedAt : undefined;
  } catch {
    return undefined;
  }
}

function listRecentSnapshotRunIds(evidenceDir: string, limit: number): readonly string[] {
  const qiDir = join(evidenceDir, FIGMA_EVIDENCE_SUBDIR);
  const stat = lstatSync(qiDir, { throwIfNoEntry: false });
  if (stat?.isDirectory() !== true) return [];
  const records: { runId: string; fetchedAt: string }[] = [];
  for (const entry of readdirSync(qiDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(FIGMA_SNAPSHOT_RECORD_SUFFIX)) continue;
    const runId = entry.name.slice(0, -FIGMA_SNAPSHOT_RECORD_SUFFIX.length);
    const fetchedAt = readSnapshotFetchedAt(qiDir, entry.name);
    if (fetchedAt !== undefined) records.push({ runId, fetchedAt });
  }
  records.sort((a, b) => (a.fetchedAt > b.fetchedAt ? -1 : a.fetchedAt < b.fetchedAt ? 1 : 0));
  return records.slice(0, limit).map((record) => record.runId);
}

export function handleFigmaListSnapshots(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined || evidenceDir.length === 0) {
    return { status: 503, body: figmaErrorBody("FIGMA_NO_EVIDENCE_DIR") };
  }

  const limit = parseSnapshotListLimit(ctx.url);
  const scope = parseSnapshotListScope(ctx.url);
  const store = createNodeFigmaSnapshotStore(evidenceDir);

  try {
    if (scope !== undefined) {
      const snapshots = store
        .listByScope(scope.fileKey, scope.nodeId)
        .slice(0, limit)
        .flatMap((entry) => {
          const record = store.loadMetadata(entry.runId);
          return record === undefined
            ? []
            : [recordToListEntry(record, store.loadUserMetadata(entry.runId))];
        });
      return { status: 200, body: { snapshots } satisfies FigmaSnapshotListResponse };
    }

    const snapshots = loadSnapshotListEntries(store, listRecentSnapshotRunIds(evidenceDir, limit));
    return { status: 200, body: { snapshots } satisfies FigmaSnapshotListResponse };
  } catch {
    return { status: 500, body: figmaErrorBody("FIGMA_INTERNAL") };
  }
}

// ─── GET /api/figma/snapshots/:runId ──────────────────────────────────────────

export function handleFigmaLoadSnapshot(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined || evidenceDir.length === 0) {
    return { status: 503, body: figmaErrorBody("FIGMA_NO_EVIDENCE_DIR") };
  }

  const runId = ctx.params.runId ?? "";
  if (runId.length === 0) {
    return { status: 400, body: figmaErrorBody("FIGMA_SNAPSHOT_NOT_FOUND") };
  }

  const store = createNodeFigmaSnapshotStore(evidenceDir);
  let record: FigmaSnapshotRecord | undefined;
  try {
    record = store.loadMetadata(runId);
  } catch {
    return { status: 500, body: figmaErrorBody("FIGMA_INTERNAL") };
  }

  if (record === undefined) {
    return { status: 404, body: figmaErrorBody("FIGMA_SNAPSHOT_NOT_FOUND") };
  }

  return {
    status: 200,
    body: recordToSummary(record, undefined, record.metrics, store.loadUserMetadata(runId)),
  };
}

// ─── PATCH /api/figma/snapshots/:runId — mutable management metadata ────────

const MAX_SNAPSHOT_DISPLAY_NAME_LENGTH = 120;

interface ParsedSnapshotMetadataPatch {
  readonly displayName: string | null;
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function parseSnapshotMetadataJson(raw: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function normalizePatchDisplayName(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\s+/gu, " ");
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_SNAPSHOT_DISPLAY_NAME_LENGTH) return undefined;
  if (hasControlCharacter(trimmed)) return undefined;
  return trimmed;
}

async function parseSnapshotMetadataPatch(
  req: IncomingMessage,
): Promise<ParsedSnapshotMetadataPatch | RouteResult> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    return { status: 400, body: figmaErrorBody("FIGMA_BAD_METADATA") };
  }
  const body = parseSnapshotMetadataJson(raw);
  if (body === undefined || !Object.prototype.hasOwnProperty.call(body, "displayName")) {
    return { status: 400, body: figmaErrorBody("FIGMA_BAD_METADATA") };
  }
  const displayName = normalizePatchDisplayName(body.displayName);
  return displayName === undefined
    ? { status: 400, body: figmaErrorBody("FIGMA_BAD_METADATA") }
    : { displayName };
}

export async function handleFigmaUpdateSnapshotMetadata(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined || evidenceDir.length === 0) {
    return { status: 503, body: figmaErrorBody("FIGMA_NO_EVIDENCE_DIR") };
  }

  const runId = ctx.params.runId ?? "";
  if (runId.length === 0) {
    return { status: 400, body: figmaErrorBody("FIGMA_SNAPSHOT_NOT_FOUND") };
  }

  const patch = await parseSnapshotMetadataPatch(ctx.req);
  if ("status" in patch) return patch;

  const store = createNodeFigmaSnapshotStore(evidenceDir);
  let record: FigmaSnapshotRecord | undefined;
  try {
    record = store.loadMetadata(runId);
  } catch {
    return { status: 500, body: figmaErrorBody("FIGMA_INTERNAL") };
  }
  if (record === undefined) {
    return { status: 404, body: figmaErrorBody("FIGMA_SNAPSHOT_NOT_FOUND") };
  }

  let metadata: FigmaSnapshotUserMetadata;
  try {
    metadata = store.updateUserMetadata(runId, {
      displayName: patch.displayName,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    return { status: 500, body: figmaErrorBody("FIGMA_INTERNAL") };
  }

  return {
    status: 200,
    body: recordToSummary(record, undefined, record.metrics, metadata),
  };
}

// ─── DELETE /api/figma/snapshots/:runId — explicit snapshot deletion ─────────

export function handleFigmaDeleteSnapshot(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined || evidenceDir.length === 0) {
    return { status: 503, body: figmaErrorBody("FIGMA_NO_EVIDENCE_DIR") };
  }

  const runId = ctx.params.runId ?? "";
  if (runId.length === 0) {
    return { status: 400, body: figmaErrorBody("FIGMA_SNAPSHOT_NOT_FOUND") };
  }

  const store = createNodeFigmaSnapshotStore(evidenceDir);
  let record: FigmaSnapshotRecord | undefined;
  try {
    record = store.loadMetadata(runId);
  } catch {
    return { status: 500, body: figmaErrorBody("FIGMA_INTERNAL") };
  }
  if (record === undefined) {
    return { status: 404, body: figmaErrorBody("FIGMA_SNAPSHOT_NOT_FOUND") };
  }

  try {
    const deleted = store.deleteSnapshot(runId);
    return {
      status: 200,
      body: {
        runId,
        deleted: deleted.recordDeleted,
        sideFileDirDeleted: deleted.sideFileDirDeleted,
        metadataDeleted: deleted.metadataDeleted,
      },
    };
  } catch {
    return { status: 500, body: figmaErrorBody("FIGMA_INTERNAL") };
  }
}

// ─── GET /api/figma/snapshots/:runId/screens/:screenId/json ───────────────────

export function handleFigmaInspectSnapshotScreenJson(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined || evidenceDir.length === 0) {
    return { status: 503, body: figmaErrorBody("FIGMA_NO_EVIDENCE_DIR") };
  }

  const runId = decodeRouteParam(ctx.params.runId);
  const screenId = decodeRouteParam(ctx.params.screenId);
  if (runId.length === 0 || screenId.length === 0) {
    return { status: 404, body: figmaErrorBody("FIGMA_SCREEN_NOT_FOUND") };
  }

  const store = createNodeFigmaSnapshotStore(evidenceDir);
  let record: FigmaSnapshotRecord | undefined;
  try {
    record = store.loadMetadata(runId);
  } catch {
    return { status: 500, body: figmaErrorBody("FIGMA_INTERNAL") };
  }

  if (record === undefined) {
    return { status: 404, body: figmaErrorBody("FIGMA_SNAPSHOT_NOT_FOUND") };
  }

  const body = screenJsonResponse(record, screenId);
  return body === undefined
    ? { status: 404, body: figmaErrorBody("FIGMA_SCREEN_NOT_FOUND") }
    : { status: 200, body };
}

// ─── GET /api/figma/snapshots/:runId/screens/:screenIndex/image ──────────────

function parseScreenIndex(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 && String(parsed) === raw ? parsed : undefined;
}

type FigmaSnapshotStore = ReturnType<typeof createNodeFigmaSnapshotStore>;

interface LoadedSnapshotRecord {
  readonly store: FigmaSnapshotStore;
  readonly record: FigmaSnapshotRecord;
}

function loadSnapshotRecordForImage(
  evidenceDir: string,
  runId: string,
): LoadedSnapshotRecord | RouteResult {
  const store = createNodeFigmaSnapshotStore(evidenceDir);
  let record: FigmaSnapshotRecord | undefined;
  try {
    record = store.load(runId);
  } catch {
    return { status: 500, body: figmaErrorBody("FIGMA_INTERNAL") };
  }
  return record === undefined
    ? { status: 404, body: figmaErrorBody("FIGMA_SCREEN_NOT_FOUND") }
    : { store, record };
}

export function handleFigmaLoadSnapshotImage(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): HandlerOutcome {
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined || evidenceDir.length === 0) {
    return { status: 503, body: figmaErrorBody("FIGMA_NO_EVIDENCE_DIR") };
  }

  const runId = ctx.params.runId ?? "";
  const screenIndex = parseScreenIndex(ctx.params.screenIndex);
  if (runId.length === 0 || screenIndex === undefined) {
    return { status: 404, body: figmaErrorBody("FIGMA_SCREEN_NOT_FOUND") };
  }

  const loaded = loadSnapshotRecordForImage(evidenceDir, runId);
  if ("status" in loaded) return loaded;

  const screen = loaded.record.screens[screenIndex];
  if (screen === undefined) {
    return { status: 404, body: figmaErrorBody("FIGMA_SCREEN_NOT_FOUND") };
  }

  try {
    const image = loaded.store.loadImage(runId, screen.image);
    ctx.res.statusCode = 200;
    ctx.res.setHeader("Content-Type", image.mimeType);
    ctx.res.setHeader("Content-Length", String(image.byteLength));
    ctx.res.setHeader("Cache-Control", "no-store");
    ctx.res.setHeader("ETag", `"sha256-${image.sha256}"`);
    ctx.res.end(image.bytes);
    return STREAMING;
  } catch {
    return { status: 500, body: figmaErrorBody("FIGMA_INTERNAL") };
  }
}
