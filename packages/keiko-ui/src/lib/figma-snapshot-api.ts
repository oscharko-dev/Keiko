/**
 * Typed fetch helpers for the Figma Snapshot BFF routes (Epic #750, Issue #756).
 * Same-origin relative paths (/api/figma/...).
 *
 * Security posture: the PAT is resolved server-side only. The UI passes the plain
 * board link; the server resolves the token from env/vault, builds the snapshot,
 * and returns a token-free summary. No secret ever reaches this module.
 */

import { ApiError } from "./api";

// ─── Shared internal helpers ───────────────────────────────────────────────────

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const res = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method === "GET" || method === "HEAD" ? {} : { "X-Keiko-CSRF": "1" }),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let code = "INTERNAL";
    let message = `HTTP ${res.status.toString()}`;
    try {
      const envelope = (await res.json()) as { error: { code: string; message: string } };
      code = envelope.error.code;
      message = envelope.error.message;
    } catch {
      // parse failure — keep generic message
    }
    throw new ApiError(code, message, res.status);
  }

  return res.json() as Promise<T>;
}

// ─── Response types (mirror BFF FigmaSnapshotSummary / FigmaScreenSummary) ──────

export interface FigmaScreenSummary {
  readonly screenId: string;
  /** Display name derived from the IR. */
  readonly name: string;
  /** Brief structural description, e.g. "3 fields, 2 controls". */
  readonly irSummary: string;
  /** Relative path of the rendered PNG side-file. */
  readonly imageRelativePath: string;
  /** sha256 of the rendered PNG (tamper-evidence). */
  readonly imageSha256: string;
  /** Byte size of the rendered PNG. */
  readonly imageByteLength: number;
}

export interface FigmaSnapshotSummary {
  readonly runId: string;
  readonly fileKey: string;
  readonly nodeId: string;
  readonly version: string | undefined;
  readonly fetchedAt: string;
  /** Number of screens successfully rendered. */
  readonly screenCount: number;
  /** Number of screens that could not be rendered (partial build). */
  readonly skippedCount: number;
  /**
   * Human-readable reduction hint, e.g. "3 screens from 5 detected (2 renders skipped)".
   * Shown in the window header to surface the "huge board → N screens" story.
   */
  readonly reductionHint: string;
  /** Integrity hash for drift detection. */
  readonly integrityHash: string;
  readonly screens: readonly FigmaScreenSummary[];
}

// ─── POST /api/figma/snapshots ─────────────────────────────────────────────────

/**
 * Triggers a server-side snapshot-build from a Figma board link.
 *
 * The token is resolved server-side (vault > config > FIGMA_ACCESS_TOKEN env).
 * The browser NEVER holds or transmits the PAT.
 *
 * @param boardLink Full Figma board URL including a `node-id` param, e.g.
 *   https://www.figma.com/design/{key}/{name}?node-id=123:456
 */
export interface TriggerFigmaSnapshotOptions {
  /** Records the explicit read-only-scope acknowledgement (#760) before the first build for a scope. */
  readonly acknowledgeReadOnly?: boolean;
  /** Audits the build as a re-snapshot — a fresh, explicit, full scoped re-fetch (#759). */
  readonly isResnapshot?: boolean;
  /**
   * Optional abort signal threaded from the component's unmount cleanup.
   * Aborting cancels the in-flight fetch; the server-side build continues
   * (on-demand snapshot model) — no partial state is persisted by the client.
   */
  readonly signal?: AbortSignal;
}

export async function triggerFigmaSnapshot(
  boardLink: string,
  options: TriggerFigmaSnapshotOptions = {},
): Promise<FigmaSnapshotSummary> {
  return fetchJson<FigmaSnapshotSummary>("/api/figma/snapshots", {
    method: "POST",
    // exactOptionalPropertyTypes: RequestInit.signal is AbortSignal|null, not |undefined.
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    body: JSON.stringify({
      boardLink,
      ...(options.acknowledgeReadOnly === true ? { acknowledgeReadOnly: true } : {}),
      ...(options.isResnapshot === true ? { isResnapshot: true } : {}),
    }),
  });
}

// ─── GET /api/figma/snapshots/:runId ──────────────────────────────────────────

/**
 * Loads a stored snapshot summary by run id. No contact with Figma; reads the
 * immutable evidence record written by the snapshot-build.
 *
 * @param signal Optional abort signal for unmount cleanup.
 */
export async function loadFigmaSnapshotSummary(
  runId: string,
  signal?: AbortSignal,
): Promise<FigmaSnapshotSummary> {
  return fetchJson<FigmaSnapshotSummary>(`/api/figma/snapshots/${encodeURIComponent(runId)}`, {
    ...(signal !== undefined ? { signal } : {}),
  });
}

// ─── POST /api/figma/snapshots/:runId/code (design-to-code #755) ────────────────

/** One reviewable file in the generated code artifact. */
export interface FigmaCodeFile {
  readonly path: string;
  readonly contents: string;
}

/** The reviewable design-to-code artifact for a stored snapshot (#755). */
export interface FigmaCodegenResponse {
  readonly runId: string;
  readonly adapterName: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly screenCount: number;
  readonly files: readonly FigmaCodeFile[];
}

/**
 * Generate reviewable frontend code (semantic HTML/CSS + design tokens) from a stored snapshot.
 * Deterministic + model-free server-side: reads ONLY the stored snapshot, never Figma. The result is
 * a proposal for review, never auto-applied.
 *
 * @param signal Optional abort signal for unmount cleanup.
 */
export async function generateFigmaCode(
  runId: string,
  signal?: AbortSignal,
): Promise<FigmaCodegenResponse> {
  return fetchJson<FigmaCodegenResponse>(`/api/figma/snapshots/${encodeURIComponent(runId)}/code`, {
    method: "POST",
    ...(signal !== undefined ? { signal } : {}),
    body: JSON.stringify({}),
  });
}

// ─── DELETE /api/figma/token (#758) ───────────────────────────────────────────

export interface FigmaRevokeTokenResult {
  /** Server-side success code — always "FIGMA_TOKEN_REVOKED_OK" on 200. */
  readonly code: string;
  readonly message: string;
}

/**
 * Revokes the stored Figma PAT from the server vault (audited key removal, #758).
 * The token itself is never returned; the response is a success envelope only.
 */
export async function revokeFigmaToken(): Promise<FigmaRevokeTokenResult> {
  return fetchJson<FigmaRevokeTokenResult>("/api/figma/token", {
    method: "DELETE",
  });
}
