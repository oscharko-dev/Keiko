// Gateway-backed HTTP `ManualCrawlFetcher` for intranet HTML manuals (Issue #2063, trust-9).
//
// keiko-local-knowledge performs NO network egress (ADR-0019 trust-9): its crawl runner is a pure
// orchestrator that resolves the link graph, enforces the fail-closed scope guard, and bounds the
// traversal, delegating byte retrieval to an injected `ManualCrawlFetcher`. This is the production
// HTTP implementation, and it lives HERE in keiko-server (the sole egress composition root), built
// on the shared proxy/CA-aware `gatewayFetch` transport (ADR-0038). `gatewayFetch` owns the network
// trust boundary: it always issues `redirect: "manual"` (a 3xx is surfaced, never followed) and
// re-validates redirect targets, blocks literal/loopback/link-local/blocked targets, and — on the
// direct path — pins the outbound connect to the DNS-validated address set, closing the
// resolve-then-connect DNS-rebinding gap (AUDIT-SEC-001). The crawl scope guard (in the runner)
// remains the authority on WHICH origin/path may be fetched; this fetcher adds a cheap defense-in-
// depth re-check (scheme + no embedded credentials) and never lets a raw upstream error, header, or
// body text escape — every failure is a body-free deny reason.
//
// Failure matrix (fetcher state -> result -> runner classification). Fail closed everywhere:
//   non-http target                     -> {ok:false, "fetch-failed"}         -> denied
//   unparseable URL                     -> {ok:false, "fetch-failed"}         -> denied
//   scheme not http/https               -> {ok:false, "unsupported-scheme"}   -> denied
//   URL carries user:pass credentials   -> {ok:false, "credentialed-url"}     -> denied
//   SSRF/rebinding/TLS/proxy/timeout    -> {ok:false, "fetch-failed"}         -> denied (error text dropped)
//   3xx (redirect: manual)              -> {ok:true, redirected:true}         -> denied "redirect"
//   4xx / 5xx / <200                    -> {ok:false, "fetch-failed"}         -> denied (error page never indexed)
//   2xx, body EXCEEDS the per-page cap  -> {ok:true, truncated:true}          -> denied "oversized-page"
//   2xx, empty body                     -> {ok:true, bytes:[]}                -> denied "empty-page"
//   2xx, non-html content type          -> {ok:true, contentType:<other>}    -> denied "non-html"
//   2xx, html, within cap               -> {ok:true, bytes, contentType}      -> ACCEPTED

import {
  gatewayFetch,
  type OutboundHttpEgressConfig,
} from "@oscharko-dev/keiko-model-gateway/internal/http";
import type {
  ManualCrawlFetcher,
  ManualFetchResult,
  ManualFetchTarget,
} from "@oscharko-dev/keiko-local-knowledge";

// A single manual page is small; a hostile or dead origin must not hold a crawl slot open.
const MANUAL_FETCH_TIMEOUT_MS = 20_000;

export interface GatewayManualFetcherOptions {
  // Resolved fresh per request so runtime gateway-config updates are honored immediately.
  readonly egress?: (() => OutboundHttpEgressConfig | undefined) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

interface FetchOptions {
  readonly maxBytes: number;
  readonly signal?: AbortSignal | undefined;
}

// Defense-in-depth re-check on top of the runner's scope guard: the target must be an http/https URL
// with no embedded credentials. Returns a deny reason instead of the URL when it is refused.
function validateHttpTarget(
  rawUrl: string,
): { readonly url: URL } | { readonly deny: ManualFetchResult } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { deny: { ok: false, reason: "fetch-failed" } };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { deny: { ok: false, reason: "unsupported-scheme" } };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { deny: { ok: false, reason: "credentialed-url" } };
  }
  return { url };
}

function composeSignal(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
}

// Stream the response body, stopping at the per-page cap. `truncated` is set only when the body
// strictly EXCEEDS the cap (a body exactly at the cap is complete), matching the WorkspaceFs
// fetcher's `size > maxBytes` semantics. The payload is never buffered past the cap.
async function readBytesBounded(
  response: Response,
  maxBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> {
  const cap = Math.max(0, Math.trunc(maxBytes));
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return { bytes: new Uint8Array(0), truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (total + chunk.value.byteLength > cap) {
      chunks.push(chunk.value.subarray(0, cap - total));
      await reader.cancel().catch(() => undefined);
      return { bytes: concatChunks(chunks, cap), truncated: true };
    }
    chunks.push(chunk.value);
    total += chunk.value.byteLength;
  }
  return { bytes: concatChunks(chunks, total), truncated: false };
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function classifyResponse(response: Response, maxBytes: number): Promise<ManualFetchResult> {
  const contentType = response.headers.get("content-type");
  if (response.status >= 300 && response.status < 400) {
    // gatewayFetch never follows a redirect; the crawler refuses it (scope re-validation is its job).
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: true,
      bytes: new Uint8Array(0),
      contentType,
      status: response.status,
      redirected: true,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    // A 4xx/5xx error page must never be indexed; classifyFetch does not inspect status codes.
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "fetch-failed" };
  }
  const { bytes, truncated } = await readBytesBounded(response, maxBytes);
  return { ok: true, bytes, contentType, status: response.status, truncated };
}

async function fetchHttpPage(
  url: URL,
  options: FetchOptions,
  config: GatewayManualFetcherOptions,
): Promise<ManualFetchResult> {
  const egress = config.egress?.();
  try {
    const response = await gatewayFetch(url.toString(), {
      method: "GET",
      headers: { accept: "text/html,application/xhtml+xml" },
      signal: composeSignal(config.timeoutMs ?? MANUAL_FETCH_TIMEOUT_MS, options.signal),
      ...(egress === undefined ? {} : { egress }),
      ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    });
    return await classifyResponse(response, options.maxBytes);
  } catch {
    // Timeout, DNS/connection/TLS failure, blocked SSRF/rebinding target, or a refused redirect
    // target — the error text is deliberately dropped so no upstream detail can ride into a
    // diagnostic or wire response.
    return { ok: false, reason: "fetch-failed" };
  }
}

/**
 * Build a `gatewayFetch`-backed HTTP `ManualCrawlFetcher` for intranet HTML manuals. `local` targets
 * are refused (the local-manual path uses the WorkspaceFs fetcher). See the failure matrix above.
 */
export function createGatewayManualFetcher(
  config: GatewayManualFetcherOptions = {},
): ManualCrawlFetcher {
  return {
    fetchManualPage: (target: ManualFetchTarget, options): Promise<ManualFetchResult> => {
      if (target.kind !== "http") {
        return Promise.resolve({ ok: false, reason: "fetch-failed" });
      }
      const validated = validateHttpTarget(target.url);
      if ("deny" in validated) {
        return Promise.resolve(validated.deny);
      }
      return fetchHttpPage(validated.url, options, config);
    },
  };
}
