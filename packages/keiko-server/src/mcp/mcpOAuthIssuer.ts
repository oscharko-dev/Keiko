import { createHash } from "node:crypto";
import { causeChain, keikoStackFrames, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { McpRemoteOAuth } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import {
  gatewayFetch,
  readBytesCapped,
  type OutboundHttpEgressConfig,
} from "@oscharko-dev/keiko-model-gateway/internal/http";

/**
 * The authorization server an operator names for a remote MCP server, proven before a run may use
 * it (#3903 AC3). The operator writes the issuer identifier it expects (RFC 8414 §2). Keiko reads
 * that issuer's metadata from the locations derived from it (RFC 8414 §3.1, then OpenID Connect
 * Discovery §4) and accepts a document only when it names exactly that issuer (RFC 8414 §3.3, the
 * mix-up guard, compared as strings), every endpoint is https, PKCE with S256 is offered (the MCP
 * authorization profile requires it) and a client can be had: the operator's own client id, or
 * dynamic registration. The run then reads the same document from the validated location
 * (`oauth.auth_server_metadata_url`), so the runtime never follows the MCP server's own
 * protected-resource metadata to another authorization server. No redirect is followed and
 * loopback and private targets are refused, as for every connector request.
 */
export const MCP_OAUTH_METADATA_MAX_BYTES = 65_536;
export const MCP_OAUTH_METADATA_TIMEOUT_MS = 10_000;

const REFUSALS = [
  "metadata-invalid",
  "issuer-mismatch",
  "insecure-endpoint",
  "pkce-unsupported",
  "registration-unavailable",
] as const;
export type McpOAuthIssuerRefusal = (typeof REFUSALS)[number] | "metadata-unavailable";

export type McpOAuthIssuerValidation =
  | {
      readonly ok: true;
      /** The location whose document validated; the run reads its metadata from there. */
      readonly metadataUrl: string;
      /** The validated authorization endpoint an authorization URL must address. */
      readonly authorizationEndpoint: string;
    }
  | { readonly ok: false; readonly reason: McpOAuthIssuerRefusal };

export interface McpOAuthIssuerCheck {
  readonly egress: OutboundHttpEgressConfig | undefined;
  readonly activityLog: ServerLogSink | undefined;
  readonly correlationId: string;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** RFC 8414 §3.1 inserts the well-known segment before the issuer's path; OIDC appends it. */
export function mcpOAuthMetadataUrls(issuer: string): readonly string[] {
  const url = new URL(issuer);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/u, "");
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

/** Validates one server's expected issuer; never throws, and each location read is one line. */
export async function validateMcpOAuthIssuer(
  server: string,
  oauth: McpRemoteOAuth,
  check: McpOAuthIssuerCheck,
): Promise<McpOAuthIssuerValidation> {
  let refusal: McpOAuthIssuerRefusal = "metadata-unavailable";
  for (const [candidate, metadataUrl] of mcpOAuthMetadataUrls(oauth.issuer).entries()) {
    const verdict = await checkedCandidate(check, { server, candidate, metadataUrl, oauth });
    if (verdict?.ok === true)
      return { ok: true, metadataUrl, authorizationEndpoint: verdict.authorizationEndpoint };
    if (verdict !== undefined) refusal = verdict.reason;
  }
  return { ok: false, reason: refusal };
}

interface Candidate {
  readonly server: string;
  readonly candidate: number;
  readonly metadataUrl: string;
  readonly oauth: McpRemoteOAuth;
}

// `undefined`: no document at this location (another status, an unreadable or non-JSON body).
async function checkedCandidate(
  check: McpOAuthIssuerCheck,
  candidate: Candidate,
): Promise<Verdict | undefined> {
  const started = Date.now();
  const line = { server: candidate.server, candidate: candidate.candidate };
  try {
    const read = await metadataDocument(candidate.metadataUrl, check);
    const verdict =
      read.document === undefined ? undefined : metadataVerdict(read.document, candidate.oauth);
    recordIssuerCandidate(check, {
      ...line,
      outcome: verdictOutcome(verdict, read.document === undefined ? read.status : undefined),
      durationMs: Date.now() - started,
      status: read.status,
    });
    return verdict;
  } catch (error) {
    // A transport failure or a body that is not bounded JSON: this location admits nothing.
    recordIssuerCandidate(check, {
      ...line,
      outcome: "unreadable",
      durationMs: Date.now() - started,
      error,
    });
    return undefined;
  }
}

function verdictOutcome(
  verdict: Verdict | undefined,
  status: number | undefined,
): CandidateOutcome {
  if (verdict === undefined) return status === 200 ? "unreadable" : "not-found";
  return verdict.ok ? "validated" : verdict.reason;
}

interface MetadataRead {
  readonly document?: Readonly<Record<string, unknown>>;
  readonly status: number;
}

async function metadataDocument(url: string, check: McpOAuthIssuerCheck): Promise<MetadataRead> {
  const response = await gatewayFetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "manual",
    egress: { ...check.egress, denyLoopback: true, pinProxiedConnectTarget: true },
    timeoutMs: MCP_OAUTH_METADATA_TIMEOUT_MS,
    maxResponseBytes: MCP_OAUTH_METADATA_MAX_BYTES,
    ...(check.fetchImpl === undefined ? {} : { fetchImpl: check.fetchImpl }),
    ...(check.signal === undefined ? {} : { signal: check.signal }),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    return { status: response.status };
  }
  const bytes = await readBytesCapped(response, MCP_OAUTH_METADATA_MAX_BYTES);
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const document = plainRecord(value);
  return document === undefined ? { status: 200 } : { document, status: 200 };
}

type Verdict =
  | { readonly ok: true; readonly authorizationEndpoint: string }
  | { readonly ok: false; readonly reason: (typeof REFUSALS)[number] };

function metadataVerdict(
  document: Readonly<Record<string, unknown>>,
  oauth: McpRemoteOAuth,
): Verdict {
  if (document.issuer !== oauth.issuer) return { ok: false, reason: "issuer-mismatch" };
  const authorization = httpsUrl(document.authorization_endpoint);
  if (authorization === undefined || !secureEndpoints(document))
    return { ok: false, reason: "insecure-endpoint" };
  if (!listIncludes(document.code_challenge_methods_supported, "S256"))
    return { ok: false, reason: "pkce-unsupported" };
  const responseTypes = document.response_types_supported;
  if (responseTypes !== undefined && !listIncludes(responseTypes, "code"))
    return { ok: false, reason: "metadata-invalid" };
  if (oauth.clientId === undefined && document.registration_endpoint === undefined)
    return { ok: false, reason: "registration-unavailable" };
  return { ok: true, authorizationEndpoint: authorization };
}

// The token endpoint, and the registration endpoint when present, are https too.
function secureEndpoints(document: Readonly<Record<string, unknown>>): boolean {
  const registration = document.registration_endpoint;
  return (
    httpsUrl(document.token_endpoint) !== undefined &&
    (registration === undefined || httpsUrl(registration) !== undefined)
  );
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  const plain = url.username === "" && url.password === "" && url.hash === "";
  return url.protocol === "https:" && plain ? url.href : undefined;
}

function listIncludes(value: unknown, entry: string): boolean {
  return Array.isArray(value) && value.includes(entry);
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

const CANDIDATE_OUTCOMES = ["validated", "not-found", "unreadable", ...REFUSALS] as const;
type CandidateOutcome = (typeof CANDIDATE_OUTCOMES)[number];

const MCP_OAUTH_ISSUER_CHECKED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "mcp.oauth.issuer.checked",
  category: "security",
  owner: "keiko-server",
  emitter: "mcp.mcpOAuthIssuer.recordIssuerCandidate",
  fields: {
    // SHA-256 of the registry's server name: which server, without its name.
    serverSha256: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    // 0: the RFC 8414 location, 1: the OpenID Connect one.
    candidate: { type: "integer", dataClass: "count", required: true },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...CANDIDATE_OUTCOMES],
    },
    httpStatus: { type: "integer", dataClass: "count", required: false },
    durationMs: { type: "integer", dataClass: "count", required: true },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  diagnosticWhen: [{ field: "outcome", values: ["unreadable", ...REFUSALS] }],
  failureClasses: ["mcp-oauth-issuer"],
  proofIds: ["mcp.oauth.issuer.checked.emitted-line"],
  releaseImpact: "patch",
});

interface CandidateLine {
  readonly server: string;
  readonly candidate: number;
  readonly outcome: CandidateOutcome;
  readonly durationMs: number;
  readonly status?: number | undefined;
  readonly error?: unknown;
}

/** One line per metadata location read: never the issuer, a URL or a byte of the document. */
export function recordIssuerCandidate(check: McpOAuthIssuerCheck, line: CandidateLine): void {
  const failed = line.outcome !== "validated" && line.outcome !== "not-found";
  check.activityLog?.write(
    activityLogEvent(
      MCP_OAUTH_ISSUER_CHECKED_OPERATION,
      {
        correlationId: check.correlationId,
        ...(failed ? { level: "warn" as const } : {}),
        ...(line.error === undefined ? {} : { errorKind: "read-failed" as const }),
      },
      {
        serverSha256: createHash("sha256").update(line.server, "utf8").digest("hex"),
        candidate: line.candidate,
        outcome: line.outcome,
        durationMs: Math.max(0, Math.round(line.durationMs)),
        ...(line.status === undefined ? {} : { httpStatus: line.status }),
        ...(line.error === undefined
          ? {}
          : { frames: keikoStackFrames(line.error), causeChain: causeChain(line.error) }),
      },
    ),
  );
}
