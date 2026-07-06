// Epic #1852 — indexable HTML manual proposal + consent BFF routes (child issues #1866–#1869).
//
// Two additive, product-level routes that extend the governed documentation browser (ADR-0113):
//   * POST /api/docs-browser/propose  — classify + deterministically detect whether a target looks like
//     a static HTML manual, build the bounded scope preview, and flag an already-indexed manual by
//     matching an existing Knowledge Pod's opaque source fingerprint.
//   * POST /api/docs-browser/approve  — re-derive the proposal server-side, refuse anything that is not
//     an approvable manual (or is already indexed), and return the minimal, redaction-safe consent
//     handoff the future crawler epic (#1853) will consume.
//
// Neither route performs ANY egress to the documentation target: detection and preview are pure over
// the user-entered URL, and the only local touch is a read-only Knowledge Pod summary lookup for
// duplicate detection. Nothing is crawled, fetched, captured, indexed, embedded, persisted, or sent to
// a model here — producing a proposal or an approval starts no indexing work.

import {
  applyAuthenticationRequiredOverride,
  asAlreadyIndexedProposal,
  buildDocumentationIndexingProposal,
  buildManualScopePreview,
  classifyDocumentationTarget,
  DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
  DOCUMENTATION_MANUAL_PROPOSAL_SCHEMA_VERSION,
  detectIndexableManual,
  findIndexedManualForFingerprint,
  isApprovableProposalState,
  parseManualProposalRequest,
  summarizeManualOrigin,
  summarizeManualPathPrefix,
  validateDocumentationIndexingApproval,
  validateDocumentationIndexingProposal,
  type DocumentationIndexingApproval,
  type DocumentationIndexingProposal,
  type DocumentationManualSourceKind,
  type DocumentationNavigationReason,
  type DocumentationTargetClass,
  type KnowledgePodSummary,
} from "@oscharko-dev/keiko-contracts";
import { listKnowledgePodSummaries } from "@oscharko-dev/keiko-local-knowledge";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { UiHandlerDeps } from "./deps.js";
import { readDocsBrowserJsonBody } from "./docs-browser.js";
import { openKnowledgeStoreForDeps } from "./local-knowledge-store-open.js";
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";

// A read-only source of validated Knowledge Pod summaries, injectable for tests. The production default
// reads the local store; it never writes, indexes, or calls a model.
export type KnowledgePodLister = (deps: UiHandlerDeps) => readonly KnowledgePodSummary[];

// ─── Normalized-root fingerprint (server-side; a hash never leaks a path) ─────────────

// The parent "directory" of a target: the path up to and including the last slash, so
// `/docs/index.html`, `/docs/`, and `/docs/other.html` all share the manual root `/docs/`.
function rootDirectory(pathname: string): string {
  if (pathname.endsWith("/")) return pathname;
  const slash = pathname.lastIndexOf("/");
  return slash === -1 ? "/" : pathname.slice(0, slash + 1);
}

function normalizedManualRoot(rawTarget: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawTarget.trim());
  } catch {
    return null;
  }
  if (parsed.protocol === "file:") {
    return `file://${rootDirectory(parsed.pathname)}`.toLowerCase();
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return `${parsed.origin}${rootDirectory(parsed.pathname)}`.toLowerCase();
  }
  return null;
}

/**
 * Opaque, content-free fingerprint of a manual's normalized root. Computed downstream of the leaf
 * contracts layer with the shared hash helper; the raw root never crosses the wire. Deterministic:
 * targets that share a manual root produce the same fingerprint. Returns null for non-manual targets.
 */
export function computeManualRootFingerprint(rawTarget: string): string | null {
  const root = normalizedManualRoot(rawTarget);
  return root === null ? null : sha256Hex(canonicalise(root));
}

// ─── Already-indexed detection (read-only, best-effort) ──────────────────────────────

// List validated Knowledge Pod summaries without failing the request when no local store is
// configured. Read-only: no indexing job, no recovery writes, no model call. On any store error the
// caller simply loses already-indexed detection for this request (fail-open toward "not indexed",
// which only ever asks the user to review a scope they must approve anyway).
function safeListKnowledgePods(deps: UiHandlerDeps): readonly KnowledgePodSummary[] {
  let handle: ReturnType<typeof openKnowledgeStoreForDeps> | null = null;
  try {
    handle = openKnowledgeStoreForDeps(deps);
    return listKnowledgePodSummaries(handle.store);
  } catch {
    return [];
  } finally {
    handle?.close();
  }
}

function findAlreadyIndexedPodId(
  rawTarget: string,
  deps: UiHandlerDeps,
  listPods: KnowledgePodLister,
): string | null {
  const fingerprint = computeManualRootFingerprint(rawTarget);
  if (fingerprint === null) return null;
  const match = findIndexedManualForFingerprint(fingerprint, listPods(deps));
  return match === null ? null : String(match.id);
}

function targetClassOf(rawTarget: string): DocumentationTargetClass {
  const classification = classifyDocumentationTarget(rawTarget);
  return classification.ok ? classification.targetClass : "unsupported-scheme";
}

// ─── Core resolvers (pure over target + injected pod lister) ──────────────────────────

/**
 * Resolve the indexing proposal for a target: detect the manual shape, build the redacted proposal,
 * and override to already-indexed when an existing pod covers the same normalized root. Pure with
 * respect to the documentation target — it never fetches or crawls it. When the caller reports that
 * the last navigation to this target required authentication, an otherwise-approvable detection is
 * overridden to `authentication-required` — Keiko never offers to index a target the user was just
 * told it will not sign in to (child issue #1869).
 */
export function resolveManualProposal(
  target: string,
  deps: UiHandlerDeps,
  listPods: KnowledgePodLister = safeListKnowledgePods,
  lastNavigationReason: DocumentationNavigationReason | null = null,
): DocumentationIndexingProposal {
  const detection = applyAuthenticationRequiredOverride(
    detectIndexableManual(target),
    lastNavigationReason,
  );
  const proposal = buildDocumentationIndexingProposal({
    detection,
    targetClass: targetClassOf(target),
    originSummary: summarizeManualOrigin(target),
    pathPrefixSummary: summarizeManualPathPrefix(target),
  });
  if (!isApprovableProposalState(proposal.state)) return proposal;
  const podId = findAlreadyIndexedPodId(target, deps, listPods);
  return podId === null ? proposal : asAlreadyIndexedProposal(proposal, podId);
}

export type ManualApprovalDecision =
  | { readonly ok: true; readonly approval: DocumentationIndexingApproval }
  | { readonly ok: false; readonly code: string; readonly message: string };

function buildApproval(
  sourceKind: DocumentationManualSourceKind,
  fingerprint: string,
  target: string,
): DocumentationIndexingApproval {
  const preview = buildManualScopePreview({
    sourceKind,
    originSummary: summarizeManualOrigin(target),
    pathPrefixSummary: summarizeManualPathPrefix(target),
  });
  return {
    schemaVersion: DOCUMENTATION_MANUAL_PROPOSAL_SCHEMA_VERSION,
    approved: true,
    sourceKind,
    sourceFingerprint: fingerprint,
    originSummary: preview.originSummary,
    pathPrefixSummary: preview.pathPrefixSummary,
    proposedPodName: preview.proposedPodName,
    limits: DEFAULT_DOCUMENTATION_MANUAL_SCOPE_LIMITS,
  };
}

const NOT_APPROVABLE: ManualApprovalDecision = {
  ok: false,
  code: "PROPOSAL_NOT_APPROVABLE",
  message: "This target cannot be approved for indexing.",
};

/**
 * Decide whether a target may be approved for indexing and, if so, produce the redaction-safe consent
 * handoff. Fails closed: a non-approvable manual, an already-indexed root, a target that required
 * authentication on the last navigation, or a target with no stable root is refused rather than
 * approved. Starts no indexing work.
 */
export function resolveManualApproval(
  target: string,
  deps: UiHandlerDeps,
  listPods: KnowledgePodLister = safeListKnowledgePods,
  lastNavigationReason: DocumentationNavigationReason | null = null,
): ManualApprovalDecision {
  const detection = applyAuthenticationRequiredOverride(
    detectIndexableManual(target),
    lastNavigationReason,
  );
  if (!isApprovableProposalState(detection.state) || detection.sourceKind === null) {
    return NOT_APPROVABLE;
  }
  if (findAlreadyIndexedPodId(target, deps, listPods) !== null) {
    return {
      ok: false,
      code: "ALREADY_INDEXED",
      message: "This manual is already covered by a Knowledge Pod.",
    };
  }
  const fingerprint = computeManualRootFingerprint(target);
  if (fingerprint === null) return NOT_APPROVABLE;
  return { ok: true, approval: buildApproval(detection.sourceKind, fingerprint, target) };
}

// ─── HTTP handlers ────────────────────────────────────────────────────────────────────

interface TargetRequest {
  readonly target: string;
  readonly lastNavigationReason: DocumentationNavigationReason | null;
}

type TargetOutcome =
  | { readonly ok: true; readonly request: TargetRequest }
  | { readonly ok: false; readonly error: RouteResult };

async function readTarget(ctx: RouteContext): Promise<TargetOutcome> {
  const read = await readDocsBrowserJsonBody(ctx);
  if (!read.ok) return { ok: false, error: read.error };
  const parsed = parseManualProposalRequest(read.body);
  if (!parsed.ok) {
    const body = errorBody("BAD_REQUEST", parsed.errors.join("; "), ctx.correlationId);
    return { ok: false, error: { status: 400, body } };
  }
  return {
    ok: true,
    request: {
      target: parsed.value.target,
      lastNavigationReason: parsed.value.lastNavigationReason,
    },
  };
}

export async function handleDocsBrowserPropose(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const outcome = await readTarget(ctx);
  if (!outcome.ok) return outcome.error;
  const proposal = resolveManualProposal(
    outcome.request.target,
    deps,
    safeListKnowledgePods,
    outcome.request.lastNavigationReason,
  );
  if (!validateDocumentationIndexingProposal(proposal).ok) {
    const body = errorBody("INTERNAL", "Proposal failed redaction checks.", ctx.correlationId);
    return { status: 500, body };
  }
  return { status: 200, body: proposal };
}

export async function handleDocsBrowserApprove(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const outcome = await readTarget(ctx);
  if (!outcome.ok) return outcome.error;
  const decision = resolveManualApproval(
    outcome.request.target,
    deps,
    safeListKnowledgePods,
    outcome.request.lastNavigationReason,
  );
  if (!decision.ok) {
    return { status: 409, body: errorBody(decision.code, decision.message, ctx.correlationId) };
  }
  if (!validateDocumentationIndexingApproval(decision.approval).ok) {
    const body = errorBody("INTERNAL", "Approval failed redaction checks.", ctx.correlationId);
    return { status: 500, body };
  }
  return { status: 200, body: decision.approval };
}
