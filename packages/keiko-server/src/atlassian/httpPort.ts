// Concrete AtlassianHttpPort adapter (Issue #2241, ADR-0128 D1/D2/D3).
//
// keiko-server is the sole composition root for the Atlassian connector lane: this adapter is
// built from the shared proxy/CA-aware `gatewayFetch` transport (ADR-0038, the same
// `internal/http` subpath the Figma connector port already consumes) and closes over ONE
// connector's base URL and `authRef`.
//
// The resolved secret exists only inside this closure: it is materialised into the
// `Authorization` header by the narrow execution resolver immediately before the platform fetch
// call — it is never logged here and never re-emitted by the port (mirroring the figmaHttpPort
// comment; ADR-0128 D2 write-only rule). The port's result union carries a status code or a typed
// transport classification only — no response body, no response headers, no upstream error text —
// so nothing observed through it can leak content or a reflected credential.
//
// Egress posture (ADR-0128 D3): the connector's base-URL host is the sole allowlisted target,
// re-checked here at request-construction time (defense in depth on top of creation-time
// validation); `gatewayFetch` itself always issues `redirect: "manual"`, so a 3xx is surfaced,
// never followed.

import {
  ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES,
  ATLASSIAN_HTTP_UPLOAD_MAX_BYTES,
  ATLASSIAN_WRITE_RESPONSE_MAX_BYTES,
  AtlassianCredentialCustodyError,
  JiraHumanInputCustodyError,
  JiraPrivateSessionError,
  jiraPrivateCookie,
  type JiraPrivateCookie,
  type AtlassianCredentialExecutionResolver,
  type AtlassianHttpBodyPort,
  type AtlassianHttpBodyRequest,
  type AtlassianHttpBodyResult,
  type AtlassianHttpPort,
  type AtlassianHttpRequest,
  type AtlassianHttpResult,
} from "@oscharko-dev/keiko-connectors";
import { createSecretSpellingStreamRedactor, SecretSpellingOverflowError } from "@oscharko-dev/keiko-security";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { applicationRoleResponseVersion, assertDirectoryAccessTarget } from "./httpDirectoryAccess.js";
import { assertIdentityExperimentalTarget } from "./httpIdentityExperimental.js";
import { assertHumanInputTarget, claimHttpHumanInput, humanInputPurpose, ownedHumanInput, privateHumanBody, privateHumanResponse } from "./httpHumanInput.js";
import { assertPrivateSessionRequest } from "./httpAvatarSession.js";
import {
  isSafeAtlassianConnectorBaseUrl,
  canonicalAtlassianConnectorBaseUrl,
  JIRA_ATTACHMENT_MAX_BYTES,
  type JiraHumanInputView,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  outboundTargetBlockedReason,
  gatewayFetch,
  isRecoverableTlsTrustError,
  type OutboundHttpEgressConfig,
} from "@oscharko-dev/keiko-model-gateway/internal/http";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import {
  atlassianHttpRequestLifecycle,
  type AtlassianHttpLifecycleOptions,
  type JiraPrivateAuthentication,
} from "./httpRequestLifecycle.js";
import { isAtlassianTargetAdmission, type AtlassianTargetAdmission } from "./targetAdmission.js";
import { recordTargetAdmission } from "./targetAdmissionActivity.js";

// Hard per-request ceiling: the largest ADR-0128 D3 budget (bulk sync pagination). Requests ask
// for less (the verify probe asks for 30 000 ms); a hostile or buggy caller can never widen it.
const MAX_TIMEOUT_MS = 60_000;

// Issue #3246: on dev run 32563378802 the oversized-body test resolved 200 in one coverage
// shard — the only way `assertValidRequestBody` below can let an oversized body through is the
// imported ceiling not being a finite number in that worker (a build/resolution defect, not a
// request-shaped input). A defect in the imported constant must surface as a load-time throw,
// never as a silently unbounded write-channel body cap, so this runs once, unconditionally, as
// soon as the module is evaluated — before any port can be constructed or any request guarded.
function assertFiniteSafeIntegerCeiling(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a finite positive safe integer`);
  }
}
assertFiniteSafeIntegerCeiling(
  ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES,
  "ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES",
);

// Exported so the inverted-comparison rejection (below) is unit-testable directly against a
// non-finite ceiling without reaching around the module-load assertion above, which already
// blocks a non-finite `ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES` from ever reaching this function in
// a real process. Pure and body-free: byte counts only, never request content.
export function exceedsBodyByteCeiling(bytes: number, ceilingBytes: number): boolean {
  // A non-finite ceiling rejects explicitly: with a bare `bytes > cap`, NaN/undefined fail EVERY comparison including
  // `>`, so `bytes > cap` silently lets an oversized body through when `cap` is not a finite
  // number. The negated form rejects closed on exactly that case.
  return !Number.isFinite(ceilingBytes) || bytes > ceilingBytes;
}

export interface CreateAtlassianHttpPortOptions extends AtlassianHttpLifecycleOptions {
  readonly privateAuthentication?: JiraPrivateAuthentication;
  readonly onHumanInputConsumed?: (view: JiraHumanInputView) => void;
  /** Only the fixed login composition receives a bounded private candidate; never a result field. */
  readonly onJiraLoginCookie?: (cookie: JiraPrivateCookie) => void;
  /** Server-owned one-shot identity observation; never a model or HTTP request option. */
  readonly singleAttempt?: true;
  /** Derived from current saved Data Center metadata; never a request-body authority flag. */
  readonly targetAdmission?:
    ((signal: AbortSignal) => Promise<AtlassianTargetAdmission | undefined>) | undefined;
  readonly activityLog?: ServerLogSink | undefined;
  readonly deniedLoopbackPorts?: () => readonly number[];
  readonly baseUrl: string;
  readonly authRef: string;
  readonly credentials: AtlassianCredentialExecutionResolver;
  // Resolved fresh per request so runtime gateway-config updates are honored immediately.
  readonly egress?: (() => OutboundHttpEgressConfig | undefined) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly correlationId?: string | undefined;
}

function boundedTimeoutMs(requested: number): number {
  if (!Number.isFinite(requested) || requested < 1) return 1;
  return Math.min(Math.trunc(requested), MAX_TIMEOUT_MS);
}

// Inherit transport settings only. Model-provider private/metadata opt-ins never authorize
// a connector. The saved connector's exact target admission is applied below.
function forwardedConnectorEgressConfig(
  base: OutboundHttpEgressConfig | undefined,
): OutboundHttpEgressConfig {
  if (base === undefined) {
    return {};
  }

  const { httpProxy, httpsProxy, noProxy, caBundlePath, acknowledgeProxiedHostnamePolicy } = base;

  return {
    ...(httpProxy !== undefined ? { httpProxy } : {}),
    ...(httpsProxy !== undefined ? { httpsProxy } : {}),
    ...(noProxy !== undefined ? { noProxy } : {}),
    ...(caBundlePath !== undefined ? { caBundlePath } : {}),
    ...(acknowledgeProxiedHostnamePolicy === true
      ? { acknowledgeProxiedHostnamePolicy: true }
      : {}),
  };
}

function admissionEgressConfig(
  options: CreateAtlassianHttpPortOptions,
  addressClass: AtlassianTargetAdmission["addressClass"],
): OutboundHttpEgressConfig {
  return {
    ...forwardedConnectorEgressConfig(options.egress?.()),
    denyLoopback: addressClass !== "loopback",
    allowPrivateNetwork: addressClass === "private",
    requiredTargetClass: addressClass,
    pinProxiedConnectTarget: true,
    deniedLoopbackPorts: options.deniedLoopbackPorts?.() ?? [],
  };
}

function recordAdmission(
  options: CreateAtlassianHttpPortOptions,
  outcome: "admitted" | "blocked" | "failed",
  addressClass?: AtlassianTargetAdmission["addressClass"],
): void {
  recordTargetAdmission(
    options.activityLog ?? processServerLogSink(),
    options.correlationId ?? UNKNOWN_CORRELATION_ID,
    options.targetAdmission === undefined ? "default-public" : "saved-data-center",
    outcome,
    addressClass,
  );
}

async function connectorEgressConfig(
  options: CreateAtlassianHttpPortOptions,
  base: URL,
  signal: AbortSignal,
): Promise<OutboundHttpEgressConfig | undefined> {
  try {
    const admission = await options.targetAdmission?.(signal);
    if (
      options.targetAdmission !== undefined &&
      (!isAtlassianTargetAdmission(admission) ||
        admission.baseUrl !== canonicalAtlassianConnectorBaseUrl(base.toString()))
    ) {
      recordAdmission(options, "blocked");
      return undefined;
    }
    const addressClass = admission?.addressClass ?? "public";
    const egress = admissionEgressConfig(options, addressClass);
    const blocked = outboundTargetBlockedReason(base, egress) !== undefined;
    recordAdmission(options, blocked ? "blocked" : "admitted", addressClass);
    return blocked ? undefined : egress;
  } catch (error) {
    recordAdmission(options, "failed");
    throw error;
  }
}

// Both direct and proxied connects use the gateway's vetted address set. An explicit admission
// narrows DNS to one address class; metadata/link-local targets and active BFF ports stay denied.
// Request paths must stay inside the configured context path before credentials are resolved.
function isContainedPath(base: URL, target: URL): boolean {
  const prefix = base.pathname.replace(/\/$/, "");
  return target.pathname === prefix || target.pathname.startsWith(`${prefix}/`);
}

function assertAllowlistedTarget(base: URL, requestUrl: string): URL {
  let target: URL;
  try {
    target = new URL(requestUrl);
  } catch (error) {
    throw new AtlassianCredentialCustodyError(
      "invalid-input",
      ["request URL must be a valid URL"],
      error,
    );
  }
  const allowed =
    isContainedPath(base, target) &&
    target.toString() === requestUrl &&
    !/%(?:2e|2f|5c|25)/i.test(target.pathname) &&
    !requestUrl.includes("#") &&
    target.protocol === "https:" &&
    target.host === base.host &&
    target.username.length === 0 &&
    target.password.length === 0;
  if (!allowed) {
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "request URL must stay on the connector's configured https host",
    ]);
  }
  return target;
}

// AbortSignal.timeout aborts with a DOMException named TimeoutError. Everything else is a
// network-class failure (DNS, refused connection, TLS, or proxy) and fails closed as such — the
// error text is deliberately dropped so no upstream detail can ride into diagnostics or wire
// responses. The narrow return union is assignable to both port result unions (body-less and
// bounded-body).
function classifyTransportError(
  error: unknown,
): { kind: "timeout" } | { kind: "network-error"; reason?: "tls" } {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { kind: "timeout" };
  }
  if (isRecoverableTlsTrustError(error) || isTerminalTlsError(error)) {
    return { kind: "network-error", reason: "tls" };
  }
  return { kind: "network-error" };
}

const TERMINAL_TLS_CODES: ReadonlySet<string> = new Set([
  "TLS_CA_FAILURE",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function isTerminalTlsError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const record = current as Record<string, unknown>;
    if (typeof record.code === "string" && TERMINAL_TLS_CODES.has(record.code)) return true;
    current = record.cause;
  }
  return false;
}

// Best-effort body drain: the custody lane never reads response content, but the stream must be
// released so the connection does not linger.
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Releasing the unread stream is best-effort only.
  }
}

// Jira can accept an invalid PAT as an anonymous read and return 200 with an empty collection
// (JRASERVER-78126). These ports always send credentials: anonymous success is an auth refusal.
// Apply only to reads; never erase the observed outcome of an already dispatched mutation.
async function authenticatedReadResponse(method: string, response: Response): Promise<Response> {
  if (
    method === "GET" &&
    response.ok &&
    response.headers.get("x-ausername")?.trim().toLowerCase() === "anonymous"
  ) {
    await discardBody(response);
    return new Response(null, { status: 401 });
  }
  return response;
}

function atlassianPortBaseUrl(baseUrl: string): URL {
  if (!isSafeAtlassianConnectorBaseUrl(baseUrl)) {
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "baseUrl must be an https URL without credentials, query, or fragment",
    ]);
  }
  return new URL(baseUrl);
}

export function createGatewayAtlassianHttpPort(
  options: CreateAtlassianHttpPortOptions,
): AtlassianHttpPort {
  const base = atlassianPortBaseUrl(options.baseUrl);
  return async (input: AtlassianHttpRequest): Promise<AtlassianHttpResult> => {
    const request = Object.freeze({ ...input });
    const target = assertAllowlistedTarget(base, request.url);
    const signal = AbortSignal.timeout(boundedTimeoutMs(request.timeoutMs));
    const lifecycle = atlassianHttpRequestLifecycle(
      { ...options, correlationId: options.correlationId ?? UNKNOWN_CORRELATION_ID },
      request,
    );
    try {
      const egress = await connectorEgressConfig(options, base, signal);
      if (egress === undefined) return { kind: "network-error" };
      const upstream = await gatewayFetch(target.toString(), {
        method: request.method,
        prepareHeaders: lifecycle.prepareHeaders,
        ...(options.singleAttempt === true ? { singleAttempt: true } : {}),
        signal,
        egress,
        log: processServerLogSink(),
        logContext: { correlationId: options.correlationId ?? UNKNOWN_CORRELATION_ID },
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
      const response = await authenticatedReadResponse(request.method, upstream);
      await lifecycle.observe(response);
      await discardBody(response);
      return { kind: "response", status: response.status };
    } catch (error) {
      lifecycle.rethrowFailure();
      if (error instanceof AtlassianCredentialCustodyError) throw error;
      return classifyTransportError(error);
    }
  };
}

// ─── Bounded-body channel (Issues #2242/#2244, ADR-0128 D3/D5) ────────────────
// Identical trust posture to the body-less channel above (same allowlist re-check, same
// credential materialisation rule, same redirect fail-closed transport), plus a STREAMED body
// read that stops at the per-request cap — the payload is never buffered past `maxBodyBytes`,
// even transiently. Retry-After is parsed into a bounded delay. A bounded strong native ETag
// crosses only the fixed applicationrole CAS port; no generic header map, token result or
// diagnostic value is exposed. A
// run-cancellation abort classifies as `timeout` here — the sync lane re-checks its own signal
// immediately afterwards, so the run still terminates as cancelled. The governed write lane
// (#2244) sends bounded JSON request bodies over POST/PUT through this same channel; the body is
// re-checked against the shared ceiling here fail-closed (the executors already enforce it with
// typed results).

interface BoundedBodyRead {
  readonly bodyText: string;
  readonly archiveBytes?: Uint8Array<ArrayBuffer>;
  readonly bodyBytes: number;
  readonly truncated: boolean;
}

function bodyCollector(binary: boolean, cap: number) {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let archive: Uint8Array<ArrayBuffer> | undefined;
  let offset = 0;
  let text = "";
  return {
    append: (chunk: Uint8Array) => {
      if (!binary) { text += decoder.decode(chunk, { stream: true }); return; }
      if (chunk.byteLength === 0) return;
      archive ??= new Uint8Array(cap);
      archive.set(chunk, offset);
      offset += chunk.byteLength;
    },
    finish: (bodyBytes: number, truncated: boolean): BoundedBodyRead => {
      if (!binary) return { bodyText: text + decoder.decode(), bodyBytes, truncated };
      const archiveBytes = archive === undefined ? new Uint8Array(0) : archive.slice(0, bodyBytes);
      return { bodyText: "", archiveBytes, bodyBytes, truncated };
    },
  };
}
async function readBodyBounded(response: Response, maxBodyBytes: number, binary = false): Promise<BoundedBodyRead> {
  const cap = Math.max(0, Math.trunc(maxBodyBytes));
  const reader = response.body?.getReader();
  const body = bodyCollector(binary, cap);
  if (reader === undefined) return body.finish(0, false);
  let bytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const remaining = cap - bytes;
    if (chunk.value.byteLength >= remaining) {
      body.append(chunk.value.subarray(0, Math.max(0, remaining)));
      bytes += Math.min(chunk.value.byteLength, Math.max(0, remaining));
      await reader.cancel().catch(() => undefined);
      return body.finish(bytes, true);
    }
    body.append(chunk.value);
    bytes += chunk.value.byteLength;
  }
  return body.finish(bytes, false);
}

async function readResponseBody(response: Response, request: AtlassianHttpBodyRequest): Promise<BoundedBodyRead> {
  if (request.jiraEmailTemplateArchive === true && request.method === "GET" && response.ok) {
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/zip") {
      await discardBody(response);
      return { bodyText: "", bodyBytes: 0, truncated: false };
    }
    return readBodyBounded(response, request.maxBodyBytes, true);
  }
  // Native error text stays under the ordinary write-response ceiling even for ZIP downloads.
  const cap = request.jiraEmailTemplateArchive === true
    ? Math.min(request.maxBodyBytes, ATLASSIAN_WRITE_RESPONSE_MAX_BYTES) : request.maxBodyBytes;
  return readBodyBounded(response, cap);
}

// Parses `Retry-After` (delay-seconds or HTTP-date) into a non-negative millisecond delay. The
// sync lane caps it again at its own backoff ceiling; invalid or absent values yield undefined.
function parseRetryAfterMs(headerValue: string | null, now: number): number | undefined {
  if (headerValue === null) return undefined;
  const trimmed = headerValue.trim();
  if (/^\d+$/u.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - now);
}

function composeBodyRequestSignal(request: AtlassianHttpBodyRequest): AbortSignal {
  const timeout = AbortSignal.timeout(boundedTimeoutMs(request.timeoutMs));
  return request.signal === undefined ? timeout : AbortSignal.any([timeout, request.signal]);
}

// Write-channel request-body guard (Issue #2244, ADR-0128 D3): a JSON body may only accompany
// POST/PUT and never exceeds the shared ceiling. The write executors enforce both rules with
// typed results before ever calling the port; a violation reaching this adapter is a programming
// error and fails closed on the same custody failure surface as an invalid URL.
// A governed upload (#4176) is one multipart POST, bounded, never combined with a JSON body.
const MULTIPART_CONTENT_TYPE = /^multipart\/form-data; boundary=[A-Za-z0-9_-]{1,70}$/u;
function assertValidUpload(request: AtlassianHttpBodyRequest): void {
  const upload = request.upload;
  if (upload === undefined) return;
  if (
    request.method !== "POST" ||
    request.bodyJson !== undefined ||
    !(upload.bytes instanceof Uint8Array) || !(upload.bytes.buffer instanceof ArrayBuffer) ||
    !(request.jiraEmailTemplateArchive === true
      ? upload.contentType === "application/zip" : request.jiraAvatarImage === true
        ? upload.contentType === "image/png" || upload.contentType === "image/jpeg" : MULTIPART_CONTENT_TYPE.test(upload.contentType)) ||
    exceedsBodyByteCeiling(upload.bytes.byteLength, ATLASSIAN_HTTP_UPLOAD_MAX_BYTES)
  ) {
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "upload must be one bounded admitted POST",
    ]);
  }
}

function assertEmailTemplateTarget(base: URL, target: URL, request: AtlassianHttpBodyRequest): void {
  if (request.jiraEmailTemplateArchive === undefined) return;
  const path = `${base.pathname.replace(/\/$/u, "")}/rest/api/2/email-templates`;
  if (request.jiraEmailTemplateArchive !== true || target.pathname !== path || target.search !== "" ||
      !Number.isSafeInteger(request.maxBodyBytes) || request.maxBodyBytes < 1 ||
      request.maxBodyBytes > JIRA_ATTACHMENT_MAX_BYTES)
    throw new AtlassianCredentialCustodyError("invalid-input", ["Unsupported email-template archive target or byte bound"]);
}

function ownedBodyRequest(request: Readonly<AtlassianHttpBodyRequest>): Readonly<AtlassianHttpBodyRequest> {
  if (request.jiraHumanInput !== undefined) return Object.freeze({ ...request, jiraHumanInput: ownedHumanInput(request.jiraHumanInput) });
  if (typeof request.jiraApplicationRole === "object" && request.jiraApplicationRole !== null)
    return Object.freeze({ ...request, jiraApplicationRole: Object.freeze({ ...request.jiraApplicationRole }) });
  if ((request.jiraEmailTemplateArchive !== true && request.jiraAvatarImage !== true) || request.upload === undefined) return request;
  // Admission/egress can await: retain our own bytes before either callback can run.
  return Object.freeze({ ...request, upload: Object.freeze({
    contentType: request.upload.contentType, bytes: new Uint8Array(request.upload.bytes),
  }) });
}
function assertValidRequestBody(request: AtlassianHttpBodyRequest): void {
  assertValidUpload(request);
  if (request.bodyJson === undefined) return;
  if (request.method !== "POST" && request.method !== "PUT") {
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "a request body is allowed only on POST or PUT",
    ]);
  }
  const bodyBytes = Buffer.byteLength(request.bodyJson, "utf8");
  if (exceedsBodyByteCeiling(bodyBytes, ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES)) {
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "request body exceeds the write-channel size ceiling",
    ]);
  }
}

function requestBody(request: AtlassianHttpBodyRequest, options: CreateAtlassianHttpPortOptions): {
  readonly body?: string | Uint8Array<ArrayBuffer>;
  readonly prepareBody?: () => string;
} {
  const input = request.jiraHumanInput;
  if (input?.selection.binding.operation === "jira.unlock-user-anonymization") return {};
  if (input !== undefined) return { prepareBody: () => {
    const values = claimHttpHumanInput(options.credentials, input, options.onHumanInputConsumed);
    const body = privateHumanBody(input, values);
    if (Buffer.byteLength(body, "utf8") > ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES) throw new AtlassianCredentialCustodyError("invalid-input");
    return body;
  } };
  if (request.upload !== undefined) return { body: request.upload.bytes };
  return request.bodyJson === undefined ? {} : { body: request.bodyJson };
}

function observePrivateCookie(authentication: JiraPrivateAuthentication | undefined): {
  readonly authentication: JiraPrivateAuthentication | undefined;
  readonly value: () => string | undefined;
} {
  let value: string | undefined;
  if (authentication?.kind !== "session") return { authentication, value: () => undefined };
  return { value: () => value, authentication: { ...authentication, cookie: () => {
    const header = authentication.cookie(); const separator = header.indexOf("=");
    const cookie = jiraPrivateCookie({ name: header.slice(0, separator), value: header.slice(separator + 1) });
    if (separator < 1 || cookie === undefined) throw new AtlassianCredentialCustodyError("invalid-input", ["Invalid private Jira session material"]);
    value = cookie.value; return `${cookie.name}=${cookie.value}`;
  } } };
}
function privateCookieBody(body: BoundedBodyRead, status: number, value: string | undefined): BoundedBodyRead {
  if (status < 200 || status >= 300) return { ...body, bodyText: "" };
  if (value === undefined) return { ...body, bodyText: "", truncated: true };
  // Reuse the existing exact-secret spelling owner, including escaped JSON spellings. No second
  // JSON evaluation and no remote diagnostics can disclose this ephemeral cookie to a projector.
  const floor = createSecretSpellingStreamRedactor([value]);
  try {
    floor.push(body.bodyText); floor.finish();
    return floor.redactedCount() === 0 ? body : { ...body, bodyText: "", truncated: true };
  } catch (error) {
    if (error instanceof SecretSpellingOverflowError) return { ...body, bodyText: "", truncated: true };
    throw error;
  }
}

export function createGatewayAtlassianHttpBodyPort(
  options: CreateAtlassianHttpPortOptions,
): AtlassianHttpBodyPort {
  const base = atlassianPortBaseUrl(options.baseUrl);
  return async (input: AtlassianHttpBodyRequest): Promise<AtlassianHttpBodyResult> => {
    const snapshot = Object.freeze({ ...input });
    const target = assertAllowlistedTarget(base, snapshot.url);
    assertEmailTemplateTarget(base, target, snapshot);
    assertDirectoryAccessTarget(base, target, snapshot);
    assertIdentityExperimentalTarget(base, target, snapshot);
    assertHumanInputTarget(base, snapshot, options.authRef);
    assertPrivateSessionRequest(base, snapshot, options.privateAuthentication);
    if (options.privateAuthentication?.kind === "anonymous" && humanInputPurpose(snapshot) !== "login")
      throw new AtlassianCredentialCustodyError("invalid-input", ["Anonymous Jira transport is reserved for private login"]);
    if (humanInputPurpose(snapshot) === "login" && options.privateAuthentication?.kind !== "anonymous")
      throw new AtlassianCredentialCustodyError("invalid-input", ["Jira login requires private anonymous transport"]);
    assertValidRequestBody(snapshot);
    const request = ownedBodyRequest(snapshot);
    const signal = composeBodyRequestSignal(request);
    const privateCookie = observePrivateCookie(options.privateAuthentication);
    const lifecycle = atlassianHttpRequestLifecycle(
      { ...options, ...(privateCookie.authentication === undefined ? {} : { privateAuthentication: privateCookie.authentication }),
        correlationId: options.correlationId ?? UNKNOWN_CORRELATION_ID },
      request,
    );
    try {
      const egress = await connectorEgressConfig(options, base, signal);
      if (egress === undefined) return { kind: "network-error" };
      const upstream = await gatewayFetch(target.toString(), {
        method: request.method,
        prepareHeaders: lifecycle.prepareHeaders,
        singleAttempt: options.singleAttempt === true || request.method !== "GET",
        ...requestBody(request, options),
        signal,
        egress,
        log: processServerLogSink(),
        logContext: { correlationId: options.correlationId ?? UNKNOWN_CORRELATION_ID },
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
      const response = await authenticatedReadResponse(request.method, upstream);
      await lifecycle.observe(response);
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), Date.now());
      const observedBody = await readResponseBody(response, request);
      const body = options.privateAuthentication?.kind === "session"
        ? privateCookieBody(observedBody, response.status, privateCookie.value()) : observedBody;
      const purpose = humanInputPurpose(request);
      const bodyText = purpose === undefined ? body.bodyText : privateHumanResponse(purpose, response.status, body.bodyText, body.truncated, options.onJiraLoginCookie);
      const applicationRoleVersion = applicationRoleResponseVersion(request, response);
      return {
        kind: "response",
        status: response.status,
        bodyText,
        ...(body.archiveBytes === undefined ? {} : { archiveBytes: body.archiveBytes }),
        ...(applicationRoleVersion === undefined ? {} : { applicationRoleVersion }),
        bodyBytes: body.bodyBytes,
        truncated: body.truncated,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    } catch (error) {
      lifecycle.rethrowFailure();
      if (error instanceof AtlassianCredentialCustodyError || error instanceof JiraHumanInputCustodyError || error instanceof JiraPrivateSessionError) throw error;
      return classifyTransportError(error);
    }
  };
}
