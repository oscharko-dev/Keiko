// Figma Snapshot BFF routes (Epic #750, Issue #756).
//
// Two thin UI-facing routes that sit between the browser surface and the server-side
// Figma connector + snapshot store. The PAT stays ENTIRELY server-side — nothing in
// the request or response carries the token.
//
//   POST /api/figma/snapshots           — trigger a bounded snapshot-build from a board link
//   GET  /api/figma/snapshots/:runId    — load a stored snapshot summary for display
//
// Trigger route:
//   1. Parses board link → (fileKey, nodeId) — rejects malformed / missing node-id links.
//   2. Resolves the read-only PAT server-side (vault > config > FIGMA_ACCESS_TOKEN env).
//   3. Builds a runId, runs connector → cleanScopedNodesToScreenIr → buildFigmaSnapshot → store.
//   4. Returns a minimal summary (runId, screenCount, skippedCount, reduction hint).
//      No token, no raw IR bytes, no render bytes reach the browser.
//
// Load route reads the stored immutable evidence record and returns a browser-safe
// projection. No re-contact with Figma.
//
// Both routes honour the existing QI error-envelope convention:
//   { error: { code: string; message: string } }

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { RouteContext, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import type { EnvSource } from "@oscharko-dev/keiko-security";
import {
  parseFigmaTarget,
  deriveFigmaScopeRef,
  observeFigmaRevoke,
  EXPECTED_FIGMA_SCOPES,
  FigmaConnectorError,
  type FigmaConnectorErrorCode,
  type FigmaConnectorMetrics,
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
  type FigmaSnapshotRecord,
} from "@oscharko-dev/keiko-evidence";

// ─── Error helpers ─────────────────────────────────────────────────────────────

const FIGMA_ROUTE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  FIGMA_TOKEN_MISSING:
    "No Figma PAT is configured. Set FIGMA_ACCESS_TOKEN in the server environment (read-only scopes: file_read, files:read).",
  FIGMA_TOKEN_INVALID: "The configured Figma PAT is invalid. Please rotate the token.",
  FIGMA_TOKEN_EXPIRED: "The configured Figma PAT has expired. Please rotate the token.",
  FIGMA_TOKEN_REVOKED: "The configured Figma PAT has been revoked. Please mint a new token.",
  FIGMA_INSUFFICIENT_SCOPE:
    "The configured Figma PAT lacks the required read-only scopes (file_read, files:read).",
  FIGMA_NOT_FOUND:
    "The Figma board was not found. Check the link and that the PAT can access this file.",
  FIGMA_UPSTREAM_UNAVAILABLE: "Figma API is temporarily unavailable. Please try again.",
  FIGMA_PROXY_EGRESS_FAILED:
    "The forward proxy rejected the Figma egress request. Check proxy configuration.",
  FIGMA_RATE_LIMITED: "Figma rate-limited the snapshot-build. Please wait a moment and try again.",
  FIGMA_OVERSIZED_SCOPE:
    "The selected Figma board section is too large. Select a smaller section (frame or page).",
  FIGMA_INTERNAL: "An unexpected error occurred during the snapshot-build.",
  FIGMA_BAD_LINK:
    "The board link is not a valid Figma URL, or it is missing a node-id " +
    "(section/frame anchor required).",
  FIGMA_SNAPSHOT_NOT_FOUND: "No snapshot was found for this run id.",
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

// Codes that map to 502 (upstream/auth problems, not client errors).
const FIGMA_502_CODES = new Set<FigmaConnectorErrorCode>([
  "FIGMA_TOKEN_MISSING",
  "FIGMA_TOKEN_INVALID",
  "FIGMA_TOKEN_EXPIRED",
  "FIGMA_TOKEN_REVOKED",
  "FIGMA_INSUFFICIENT_SCOPE",
  "FIGMA_PROXY_EGRESS_FAILED",
  "FIGMA_UPSTREAM_UNAVAILABLE",
]);

function figmaStatusForCode(code: FigmaConnectorErrorCode): number {
  if (FIGMA_502_CODES.has(code)) return 502;
  if (code === "FIGMA_NOT_FOUND") return 404;
  if (code === "FIGMA_RATE_LIMITED") return 429;
  if (code === "FIGMA_OVERSIZED_SCOPE") return 422;
  // Precondition Required: the operator must acknowledge the read-only scope before the build (#760).
  if (code === "FIGMA_CONSENT_REQUIRED") return 428;
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
  /** Integrity hash over the snapshot content — deterministic for drift detection (#735). */
  readonly integrityHash: string;
  /**
   * Deep-fetch coverage telemetry (#837) — present on a freshly-built snapshot (POST response).
   * Lets the UI honestly report how much of a huge instance-heavy board was deep-fetched vs
   * truncated by the bounded per-screen budgets. Build-time only; never persisted in the snapshot.
   */
  readonly coverage?: FigmaScopeCoverage;
  /**
   * Operational metrics (#760) — present on a freshly-built snapshot (POST response): reduction
   * ratio, screen/render counts, design-token count, navigation-graph size (screens + transitions),
   * a11y-finding count, and the deterministic-vs-model augmentation share. All NUMBERS — never any
   * board content, screen name, token, or board id. Build-time only; not persisted in the snapshot.
   */
  readonly metrics?: FigmaConnectorMetrics;
  /**
   * Per-screen summary for the UI gallery. IR display names + image metadata only.
   * PNG bytes are NOT returned — the client shows a placeholder pending a future
   * screen-image route (/{runId}/screens/:index).
   */
  readonly screens: readonly FigmaScreenSummary[];
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

function buildReductionHint(screenCount: number, skippedCount: number): string {
  const total = screenCount + skippedCount;
  const skippedClause =
    skippedCount > 0
      ? ` (${skippedCount.toString()} render${skippedCount !== 1 ? "s" : ""} skipped)`
      : "";
  return `${screenCount.toString()} screen${screenCount !== 1 ? "s" : ""} from ${total.toString()} detected${skippedClause}`;
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

function recordToSummary(
  record: FigmaSnapshotRecord,
  coverage?: FigmaScopeCoverage,
  metrics?: FigmaConnectorMetrics,
): FigmaSnapshotSummary {
  const screenCount = record.screens.length;
  const skippedCount = record.skippedScreens.length;
  const truncatedClause =
    coverage !== undefined && (coverage.screensTruncated > 0 || coverage.capped)
      ? `; ${coverage.screensTruncated.toString()} partially captured (deep content bounded)`
      : "";
  return {
    runId: record.runId,
    fileKey: record.provenance.fileKey,
    nodeId: record.provenance.nodeId,
    version: record.provenance.version,
    fetchedAt: record.provenance.fetchedAt,
    screenCount,
    skippedCount,
    reductionHint: `${buildReductionHint(screenCount, skippedCount)}${truncatedClause}`,
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
  };
}

// ─── POST /api/figma/snapshots — parse + validate ─────────────────────────────

/** Reads and validates the POST body, returning the board link or an error result. */
async function parseTriggerBody(req: IncomingMessage): Promise<ParsedTriggerBody | RouteResult> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    return { status: 400, body: figmaErrorBody("FIGMA_BAD_LINK") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 400, body: figmaErrorBody("FIGMA_BAD_LINK") };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { status: 400, body: figmaErrorBody("FIGMA_BAD_LINK") };
  }
  const body = parsed as Record<string, unknown>;
  const boardLink = typeof body.boardLink === "string" ? body.boardLink.trim() : "";
  if (boardLink.length === 0 || parseFigmaTarget(boardLink) === null) {
    return { status: 400, body: figmaErrorBody("FIGMA_BAD_LINK") };
  }
  return {
    boardLink,
    // Explicit read-only-scope acknowledgement (#760): records consent BEFORE the first fetch.
    acknowledgeReadOnly: body.acknowledgeReadOnly === true,
    // Audited as a re-snapshot (#759): a fresh, explicit, full scoped re-fetch — never a delta.
    isResnapshot: body.isResnapshot === true,
  };
}

interface ParsedTriggerBody {
  readonly boardLink: string;
  readonly acknowledgeReadOnly: boolean;
  readonly isResnapshot: boolean;
}

// Deployment-overridable deep scoped-pagination budgets (#837). Operators on a tighter Figma plan can
// dial concurrency/depth/screen-count down (or up) via env without a code change; an unset or
// non-positive value falls back to the connector default. Mirrors the #532 KEIKO_GROUNDING_* pattern.
function figmaPaginationFromEnv(env: EnvSource): Partial<ScopedPaginationLimits> {
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
  return overrides;
}

// Map a thrown error from the governed build to a coded route result: a coded connector error maps to
// its status (consent-required → 428, auth → 502, rate-limit → 429, …); anything else is a safe 500.
function figmaErrorResult(err: unknown): RouteResult {
  if (err instanceof FigmaConnectorError) {
    return { status: figmaStatusForCode(err.code), body: figmaErrorBody(err.code) };
  }
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
      skippedScreens: result.snapshot.skippedScreens.map((ss) => ({
        screenId: ss.screenId,
        reason: ss.reason,
      })),
      ...(result.snapshot.links !== undefined ? { links: result.snapshot.links } : {}),
      tokens: result.ir.tokens,
    });
  } catch {
    return { status: 500, body: figmaErrorBody("FIGMA_INTERNAL") };
  }
  const record = store.load(runId);
  if (record === undefined) return { status: 500, body: figmaErrorBody("FIGMA_INTERNAL") };
  return record;
}

// ─── POST /api/figma/snapshots ─────────────────────────────────────────────────

export async function handleFigmaTriggerSnapshot(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined || evidenceDir.length === 0) {
    return { status: 503, body: figmaErrorBody("FIGMA_NO_EVIDENCE_DIR") };
  }
  const bodyResult = await parseTriggerBody(ctx.req);
  if ("status" in bodyResult) return bodyResult;
  const body: ParsedTriggerBody = bodyResult;

  let result: GovernedSnapshotResult;
  try {
    // The governed build resolves the vault>config>env PAT (#758), gates on recorded read-only
    // consent before any egress + audits the action + computes metrics (#760), and deep-fetches +
    // renders within the snapshot boundary (#837/#759). Errors (incl. consent-required) are coded.
    result = await governedSnapshotBuild(
      body.boardLink,
      {
        evidenceDir,
        env: deps.env,
        now: new Date().toISOString(),
        acknowledgeReadOnly: body.acknowledgeReadOnly,
        pagination: figmaPaginationFromEnv(deps.env),
      },
      body.isResnapshot,
    );
  } catch (err) {
    return figmaErrorResult(err);
  }

  const runId = `fs-${randomUUID()}`;
  const stored = persistSnapshot(evidenceDir, runId, result);
  if ("status" in stored) return stored;
  return { status: 201, body: recordToSummary(stored, result.coverage, result.metrics) };
}

// ─── DELETE /api/figma/token — revoke the stored PAT (#758 rotation/revocation, #760 audit) ───

export function handleFigmaRevokeToken(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
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
    return figmaErrorResult(err);
  }
  return {
    status: 200,
    body: {
      code: "FIGMA_TOKEN_REVOKED_OK",
      message: FIGMA_ROUTE_ERROR_MESSAGES.FIGMA_TOKEN_REVOKED_OK,
    },
  };
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
    record = store.load(runId);
  } catch {
    return { status: 500, body: figmaErrorBody("FIGMA_INTERNAL") };
  }

  if (record === undefined) {
    return { status: 404, body: figmaErrorBody("FIGMA_SNAPSHOT_NOT_FOUND") };
  }

  return { status: 200, body: recordToSummary(record) };
}
