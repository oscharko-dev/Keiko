// Epic #1851 child #1862 — governed documentation browser BFF route.
//
// A single additive, product-level route: POST /api/docs-browser/navigate. It exists because the
// low-level /api/browser/* routes are CDP-session-coupled and loopback-only (ADR-0017 D2), while the
// product needs one governed call that classifies ANY user-entered documentation target and returns
// a redacted, UI-owned navigation outcome. See ADR-0113.
//
// The route performs NO egress to the documentation target: classification is pure URL work. The only
// network touch is reusing the existing browser session manager's non-mutating `checkStatus` probe to
// confirm the loopback CDP backend for the preview path — the same already-permitted loopback egress
// the /api/browser/* routes use. Nothing is crawled, captured, indexed, persisted, or sent to a model.

import type { IncomingMessage } from "node:http";
import {
  buildDocumentationNavigationResult,
  classifyDocumentationTarget,
  mapBrowserErrorToDocumentationReason,
  parseDocumentationNavigationRequest,
  resolveDocumentationNavigationReason,
  type DocumentationNavigationReason,
  type DocumentationTargetClass,
  type DocumentationTargetClassificationOk,
} from "@oscharko-dev/keiko-contracts";
import { BrowserToolError } from "@oscharko-dev/keiko-tools";
import type { UiHandlerDeps } from "./deps.js";
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";

// The request body is a small JSON object (target + optional port); 8 KB is generous and keeps a
// pathological target string out of memory and logs. Independent of the transport-level cap.
const MAX_DOCS_BROWSER_BODY_BYTES = 8_000;

class BodyTooLargeError extends Error {
  public constructor() {
    super("docs-browser request body too large");
    this.name = "BodyTooLargeError";
  }
}

class BadJsonError extends Error {
  public constructor() {
    super("docs-browser request body is not a JSON object");
    this.name = "BadJsonError";
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_DOCS_BROWSER_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new BodyTooLargeError());
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

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadJsonError();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BadJsonError();
  }
  return parsed as Record<string, unknown>;
}

function errorCodeOf(error: unknown): string | null {
  return error instanceof BrowserToolError ? error.code : null;
}

// Reuse the existing browser session manager's non-mutating reachability probe for the loopback
// preview path only. Any other class returns the pure classification-derived reason with no egress.
async function resolveReason(
  classification: DocumentationTargetClassificationOk,
  cdpPort: number | undefined,
  deps: UiHandlerDeps,
  backendAvailable: boolean,
): Promise<DocumentationNavigationReason> {
  const base = resolveDocumentationNavigationReason(classification.targetClass, backendAvailable);
  const browser = deps.browser;
  if (classification.targetClass !== "loopback" || browser === undefined || cdpPort === undefined) {
    return base;
  }
  try {
    const status = await browser.checkStatus(cdpPort);
    return status.reachable ? "preview-available" : "browser-backend-unavailable";
  } catch (error) {
    return mapBrowserErrorToDocumentationReason(errorCodeOf(error));
  }
}

function classificationFailureReason(
  reason: "invalid-target" | "unsupported-scheme" | "credentials-in-target",
): DocumentationNavigationReason {
  // `credentials-in-target` is intentionally collapsed into `invalid-target` so the response never
  // hints that the rejected target carried a credential.
  return reason === "unsupported-scheme" ? "unsupported-scheme" : "invalid-target";
}

export type DocsBrowserBodyOutcome =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly error: RouteResult };

/**
 * Read and JSON-parse a docs-browser request body at the BFF trust boundary, capping the size and
 * mapping a too-large/invalid body to a redacted 413/400 outcome. Shared by the navigate route and the
 * Epic #1852 proposal/approval routes so the body-safety boundary cannot drift.
 */
export async function readDocsBrowserJsonBody(ctx: RouteContext): Promise<DocsBrowserBodyOutcome> {
  try {
    return { ok: true, body: await readJsonObject(ctx.req) };
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      const body = errorBody(
        "PAYLOAD_TOO_LARGE",
        "Request body exceeds the size limit.",
        ctx.correlationId,
      );
      return { ok: false, error: { status: 413, body } };
    }
    const body = errorBody("BAD_REQUEST", "Request body must be a JSON object.", ctx.correlationId);
    return { ok: false, error: { status: 400, body } };
  }
}

function okResult(
  targetClass: DocumentationTargetClass,
  originSummary: string,
  pathSummary: string | null,
  reason: DocumentationNavigationReason,
  backendAvailable: boolean,
): RouteResult {
  return {
    status: 200,
    body: buildDocumentationNavigationResult({
      targetClass,
      originSummary,
      pathSummary,
      reason,
      backendAvailable,
    }),
  };
}

export async function handleDocsBrowserNavigate(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const read = await readDocsBrowserJsonBody(ctx);
  if (!read.ok) return read.error;
  const parsed = parseDocumentationNavigationRequest(read.body);
  if (!parsed.ok) {
    const body = errorBody("BAD_REQUEST", parsed.errors.join("; "), ctx.correlationId);
    return { status: 400, body };
  }
  const backendAvailable = deps.browser !== undefined;
  const classification = classifyDocumentationTarget(parsed.value.target);
  if (!classification.ok) {
    const reason = classificationFailureReason(classification.reason);
    return okResult("unsupported-scheme", "unavailable", null, reason, backendAvailable);
  }
  const reason = await resolveReason(classification, parsed.value.cdpPort, deps, backendAvailable);
  return okResult(
    classification.targetClass,
    classification.originSummary,
    classification.pathSummary,
    reason,
    backendAvailable,
  );
}
