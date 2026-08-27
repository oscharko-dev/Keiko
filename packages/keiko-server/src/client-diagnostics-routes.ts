// `POST /api/diagnostics/client` (Wave 5 of epic #3233, ADR-0173).
//
// The browser-side sink (`packages/keiko-ui/src/lib/client-diagnostics.ts`) buffers an already
// bounded, already-redacted-by-convention diagnostic string, but that promise is a LIBRARY
// contract on the browser side — never a trust boundary the server may rely on. This route treats
// every field as hostile input and re-validates it independently:
//
//   * shape and length come from `isClientDiagnosticIngestRequest` (keiko-contracts, the leaf);
//   * `correlationId` is only ever trusted after `isValidCorrelationId` — the same server-side
//     policy every other correlation id on this server goes through (`correlation.ts`) — so a
//     browser cannot inject an arbitrary join key onto another request's timeline;
//   * the message text is written under `extra.clientNote`, NEVER `extra.message`: `"message"` is
//     on `log-redaction.ts`'s `DENIED_FIELD_NAMES` and would collapse to `[redacted:key]` even
//     though the value is already length-bounded by the wire guard. `clientNote` normalises to
//     `"clientnote"`, which is not denied, so the existing per-value guards (length/secret/
//     personal/prose/path) do the actual content-safety work on the value itself — the same
//     "structural, not caller discipline" principle `log-redaction.ts`'s own header states. No new
//     redaction path is written here; the existing choke point is applied a second time,
//     server-side, exactly as it is for every other logged field.
//
// Rate limiting reuses `createInlineCompletionRateLimiter` (the editor's existing token-bucket
// primitive — AGENTS.md §5 forbids a second one) as a single, process-wide bucket: a flapping tab
// or a hostile page must not be able to grow the activity log without bound. The response is 204
// whether a report was accepted or dropped by the limiter — the limit itself is never disclosed to
// the browser — and a dropped report is still counted, mirroring `server-log.ts`'s own
// `reportServerLogFailure` throttle-and-count-suppressed shape: the first drop after a quiet window
// is logged immediately, later drops in the same window are counted silently, and the count is
// flushed on the next window's first drop.

import type { IncomingMessage } from "node:http";

import type { ClientDiagnosticIngestRequest } from "@oscharko-dev/keiko-contracts";
import { isClientDiagnosticIngestRequest } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";

import {
  RequestBodyCancelledError,
  RequestBodyTooLargeError,
  readBoundedRequestBody,
} from "./bounded-request-body.js";
import { isValidCorrelationId } from "./correlation.js";
import {
  createInlineCompletionRateLimiter,
  type InlineCompletionRateLimiter,
} from "./editor/inlineCompletionRateLimiter.js";
import { getServerLogger } from "./observability/index.js";
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";

// A diagnostic report is a handful of short fields — generous relative to the wire guard's own
// 200-character message cap, never a channel for an attached body.
const MAX_CLIENT_DIAGNOSTIC_BODY_BYTES = 4_096;

// Process-wide, not per-connection (this endpoint identifies no session): 60 accepted reports per
// rolling minute is generous for genuine crash/error reporting and bounds a flooding or hostile
// page. `minIntervalMs: 0` disables the limiter's own burst/cooldown gate, so only the sliding
// window cap below applies.
const CLIENT_DIAGNOSTIC_RATE_LIMIT_KEY = "client-diagnostics";

// One declaration for production and the test reset below — duplicating these three literals let
// them drift, so the test reset silently exercised a limiter with different bounds than production.
const CLIENT_DIAGNOSTIC_RATE_LIMIT_CONFIG = {
  minIntervalMs: 0,
  maxPerWindow: 60,
  windowMs: 60_000,
} as const;

let rateLimiter: InlineCompletionRateLimiter = createInlineCompletionRateLimiter(
  CLIENT_DIAGNOSTIC_RATE_LIMIT_CONFIG,
);

const DROP_NOTICE_WINDOW_MS = 60_000;

interface DropNoticeState {
  readonly lastAt: number | null;
  readonly suppressed: number;
}

let dropNotice: DropNoticeState = { lastAt: null, suppressed: 0 };

/** Test-only: puts the shared rate limiter and drop-notice counter back to a clean start. */
export function resetClientDiagnosticsIngestStateForTests(): void {
  rateLimiter = createInlineCompletionRateLimiter(CLIENT_DIAGNOSTIC_RATE_LIMIT_CONFIG);
  dropNotice = { lastAt: null, suppressed: 0 };
}

function dropNoticeThrottled(now: number): boolean {
  if (dropNotice.lastAt === null) return false;
  const elapsed = now - dropNotice.lastAt;
  return elapsed >= 0 && elapsed < DROP_NOTICE_WINDOW_MS;
}

// Reports a rate-limited drop exactly once per window, carrying how many further drops that same
// window suppressed — never the report content, which was never admitted past the limiter.
function noticeRateLimitedDrop(now: number): void {
  if (dropNoticeThrottled(now)) {
    dropNotice = { lastAt: dropNotice.lastAt, suppressed: dropNotice.suppressed + 1 };
    return;
  }
  const suppressed = dropNotice.suppressed;
  dropNotice = { lastAt: now, suppressed: 0 };
  getServerLogger().warn({
    category: "diagnostic",
    op: "client.diagnostic.rate-limited",
    ...(suppressed > 0 ? { extra: { suppressedDrops: suppressed } } : {}),
  });
}

// Projects the validated request onto the activity log. `message` is admitted only as
// `extra.clientNote` (see module header); `readyState`/`kind` ride along as bounded, closed-shape
// fields the value guards pass through unchanged.
function logClientDiagnostic(request: ClientDiagnosticIngestRequest): void {
  const extra: Record<string, unknown> = { clientNote: request.message };
  if (request.readyState !== undefined) extra.readyState = request.readyState;
  if (request.kind !== undefined) extra.clientKind = request.kind;
  const correlationId =
    request.correlationId !== undefined && isValidCorrelationId(request.correlationId)
      ? request.correlationId
      : undefined;
  getServerLogger().warn({
    category: "diagnostic",
    op: "client.diagnostic",
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(request.kind === undefined ? {} : { errorKind: request.kind }),
    extra,
  });
}

// Discriminates a rejected read (already a fully-formed `RouteResult`) from a successfully parsed
// body, instead of duck-typing the parsed value's shape. Attacker-controlled JSON can legally
// contain a numeric `status` field and a `body` key (e.g. `{"status":200,"body":{...}}`), which
// would collide with a shape test and let the client's own parsed JSON be returned verbatim as this
// route's HTTP response — bypassing `isClientDiagnosticIngestRequest`, the rate limiter, and the
// logger entirely. A tagged union makes that collision structurally impossible: the tag is set by
// this module, never derived from the parsed value.
type BodyReadOutcome =
  | { readonly kind: "rejected"; readonly result: RouteResult }
  | { readonly kind: "parsed"; readonly value: unknown };

function badRequest(message: string, correlationId: string | undefined): RouteResult {
  return { status: 400, body: errorBody("BAD_REQUEST", message, correlationId) };
}

async function readClientDiagnosticBody(
  req: IncomingMessage,
  correlationId: string | undefined,
): Promise<BodyReadOutcome> {
  let raw: string;
  try {
    raw = await readBoundedRequestBody(
      req,
      MAX_CLIENT_DIAGNOSTIC_BODY_BYTES,
      undefined,
      correlationId,
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return {
        kind: "rejected",
        result: {
          status: 413,
          body: errorBody(
            "PAYLOAD_TOO_LARGE",
            "Request body exceeds the size limit.",
            correlationId,
          ),
        },
      };
    }
    if (error instanceof RequestBodyCancelledError) {
      return {
        kind: "rejected",
        result: { status: 499, body: errorBody("REQUEST_CANCELLED", "Request was cancelled.") },
      };
    }
    throw error;
  }
  try {
    return { kind: "parsed", value: JSON.parse(raw) as unknown };
  } catch {
    return {
      kind: "rejected",
      result: badRequest("Request body is not valid JSON.", correlationId),
    };
  }
}

export async function handleClientDiagnosticIngest(ctx: RouteContext): Promise<RouteResult> {
  const outcome = await readClientDiagnosticBody(ctx.req, ctx.correlationId);
  if (outcome.kind === "rejected") return outcome.result;
  const parsed = outcome.value;
  if (!isClientDiagnosticIngestRequest(parsed)) {
    return badRequest("Request body is not a valid diagnostic report.", ctx.correlationId);
  }
  const now = Date.now();
  if (!rateLimiter.tryAcquire(CLIENT_DIAGNOSTIC_RATE_LIMIT_KEY, now)) {
    noticeRateLimitedDrop(now);
    return { status: 204, body: null };
  }
  logClientDiagnostic(parsed);
  return { status: 204, body: null };
}
