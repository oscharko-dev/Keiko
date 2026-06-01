// Data shapes for the browser tool (ADR-0017). Pure types: no runtime imports.

export interface NormalizedNavigateUrl {
  // The URL as the CDP client should send it: scheme + literal-IP authority + path/query/fragment.
  // `localhost` is rewritten to `127.0.0.1` BEFORE this struct is constructed so the OS resolver is
  // never consulted by Keiko (defends against /etc/hosts manipulation).
  readonly url: string;
  // The literal IP host: `127.0.0.1`, `::1`, or rejected. Never `localhost`.
  readonly host: string;
  // Scheme + authority only — NEVER includes path, query, or fragment. Used in audit events so
  // tokens that might appear in a URL querystring never reach the SSE stream.
  readonly originOnly: string;
  readonly port: number;
}

export interface BrowserViewportPx {
  readonly width: number;
  readonly height: number;
}

export type BrowserSessionStatus = "open" | "closed";

export interface BrowserSessionMeta {
  readonly sessionId: string;
  readonly cdpPort: number;
  readonly targetId: string;
  readonly status: BrowserSessionStatus;
  readonly createdAt: number;
}

export interface BrowserNavigateResult {
  readonly originOnly: string;
  readonly httpStatus: number | null;
}

export interface BrowserScreenshotPreview {
  readonly seq: number;
  readonly viewportPx: BrowserViewportPx;
  // Base64 PNG, in-memory only when persisted=false. Removed from the cache after persistEvidence.
  readonly dataBase64: string;
  readonly persisted: false;
}

export interface BrowserScreenshotPersisted {
  readonly seq: number;
  readonly viewportPx: BrowserViewportPx;
  readonly persisted: true;
  // Relative to the per-run side-file directory (`<evidenceDir>/<runId>/`).
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export type BrowserScreenshotResult = BrowserScreenshotPreview | BrowserScreenshotPersisted;

export interface BrowserContentResult {
  readonly seq: number;
  readonly byteLength: number;
  // Redacted HTML. Never persisted directly; consumers may include in evidence after a second pass.
  readonly redactedHtml: string;
}

export interface CdpReachability {
  readonly reachable: boolean;
  readonly userAgent: string | null;
  readonly browserVersion: string | null;
  readonly webSocketDebuggerUrl: string | null;
}
