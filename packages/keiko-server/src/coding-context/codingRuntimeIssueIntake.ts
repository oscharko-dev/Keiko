import { canonicalise } from "@oscharko-dev/keiko-security";
import type { CodingWorkbenchConnectorScope } from "@oscharko-dev/keiko-contracts";
import { codingWorkbenchPolicyEffectFor } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import type { CodingRuntimeIssueIntake } from "../coding-runtime/codingRuntimeIssueIntake.js";
import { processServerLogSink } from "../process-log-sink.js";
import {
  buildCodeContextPack,
  type CodeContextConnector,
  type CodeContextPackResult,
  type CodeContextRawObject,
} from "./codeContextConnector.js";
import { resolveGitHubIssue, type GitHubIssueResolutionDeps } from "./githubIssueResolution.js";

/** Uses the same resolver and context-pack builder as preview; no second issue reader or store. */
export function createProductionCodingRuntimeIssueIntake(
  deps: GitHubIssueResolutionDeps,
): CodingRuntimeIssueIntake {
  return {
    resolve: (input) => resolveGitHubIssue(deps, input),
    buildContext: (input) => buildContext(deps, input),
  };
}

type ContextInput = Parameters<CodingRuntimeIssueIntake["buildContext"]>[0];
type ContextResult = Awaited<ReturnType<CodingRuntimeIssueIntake["buildContext"]>>;
type ResolvedIssue = Extract<Awaited<ReturnType<typeof resolveGitHubIssue>>, { ok: true }>;

async function buildContext(
  deps: GitHubIssueResolutionDeps,
  input: ContextInput,
): Promise<ContextResult> {
  const resolution = await resolveGitHubIssue(deps, {
    repositoryRoot: input.repositoryRoot,
    issueRef: `#${String(input.binding.issueNumber)}`,
    correlationId: input.correlationId,
  });
  if (!resolution.ok) return resolution;
  if (canonicalise(resolution.binding) !== canonicalise(input.binding)) {
    return { ok: false, failure: "issue-unavailable" };
  }
  const linked = await resolveLinkedIssues(deps, {
    repositoryRoot: input.repositoryRoot,
    body: resolution.contextObject.body,
    boundIssue: input.binding.issueNumber,
    correlationId: input.correlationId,
    runId: input.runId,
  });
  const pack = await buildPack(deps, input, [resolution, ...linked]);
  if (pack.status === "blocked") {
    logPackBlocked(deps, input, pack);
    return { ok: false, failure: "authority-denied" };
  }
  const text = renderPack(pack, commentCountsOf([resolution, ...linked]));
  return {
    ok: true,
    attachment: {
      issueNumber: input.binding.issueNumber,
      itemCount: pack.items.length,
      linkedIssueCount: linked.length,
      byteCount: Buffer.byteLength(text),
      text,
    },
  };
}

// ─── Linked issues ──────────────────────────────────────────────────────────────────
// An epic names its children as `#n` in its own body, and a run that can read only the epic has to
// ask the operator for their text (Coding Workbench run 15, 2026-09-10: "Missing child issues …
// please provide their text"). The bound issue's same-repository references are therefore resolved
// through the SAME authorized reader the bound issue went through — the per-checkout GitHub-reader
// grant and the remote check apply to each of them — and attached beside it, one level deep and
// bounded. A reference that does not resolve (closed, a pull request, renumbered, unreadable) is
// skipped with its closed failure on a body-free line; the run still starts with what could be read.
export const MAX_LINKED_ISSUES = 8;
// `#n` not preceded by a word character, a slash or another hash: `owner/repo#12` is another
// repository's issue and `##` a heading. Bounded digits, no nested quantifier.
const ISSUE_REFERENCE = /(?<![\w/#])#(\d{1,7})\b/gu;

export function linkedIssueNumbers(body: string, boundIssue: number): readonly number[] {
  const numbers = new Set<number>();
  for (const match of body.matchAll(ISSUE_REFERENCE)) {
    const issueNumber = Number(match[1]);
    if (issueNumber > 0 && issueNumber !== boundIssue) numbers.add(issueNumber);
    if (numbers.size >= MAX_LINKED_ISSUES) break;
  }
  return [...numbers];
}

/** What the linked-issue resolution needs: the authorized repository root and the bound issue. */
export interface LinkedIssueRequest {
  readonly repositoryRoot: string;
  readonly body: string;
  readonly boundIssue: number;
  readonly correlationId: string;
  readonly runId: string;
  readonly signal?: AbortSignal | undefined;
}

async function resolveLinkedIssues(
  deps: GitHubIssueResolutionDeps,
  request: LinkedIssueRequest,
): Promise<readonly ResolvedIssue[]> {
  const numbers = linkedIssueNumbers(request.body, request.boundIssue);
  const resolutions = await Promise.all(
    numbers.map((issueNumber) =>
      resolveGitHubIssue(deps, {
        repositoryRoot: request.repositoryRoot,
        issueRef: `#${String(issueNumber)}`,
        correlationId: request.correlationId,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }),
    ),
  );
  const linked: ResolvedIssue[] = [];
  resolutions.forEach((linkedResolution, index) => {
    if (linkedResolution.ok) linked.push(linkedResolution);
    else logLinkedIssueSkipped(deps, request, numbers[index], linkedResolution.failure);
  });
  return linked;
}

/**
 * The numbers of the bound issue's same-repository references that resolve through the authorized
 * reader — the related-issue line of a delivery's pull request (run 19, 2026-09-10: the PR named only
 * the epic although the run implemented its four children). Same bounds, same skip evidence as the
 * run's issue context.
 */
export async function resolvedLinkedIssueNumbers(
  deps: GitHubIssueResolutionDeps,
  request: LinkedIssueRequest,
): Promise<readonly number[]> {
  const linked = await resolveLinkedIssues(deps, request);
  return linked.map((resolution) => resolution.preview.provenance.issueNumber);
}

// Body-free: the referenced number and the reader's closed failure, never the issue's text.
function logLinkedIssueSkipped(
  deps: GitHubIssueResolutionDeps,
  request: LinkedIssueRequest,
  issueNumber: number | undefined,
  failure: string,
): void {
  (deps.activityLog ?? processServerLogSink()).write({
    level: "info",
    category: "process",
    op: "coding-context.linked-issue-skipped",
    correlationId: request.correlationId,
    extra: {
      runId: request.runId,
      ...(issueNumber === undefined ? {} : { issueNumber }),
      failure,
    },
  });
}

function commentCountsOf(resolutions: readonly ResolvedIssue[]): ReadonlyMap<string, number> {
  return new Map(
    resolutions.map((resolution) => [
      resolution.contextObject.objectId,
      resolution.preview.commentCount,
    ]),
  );
}

/**
 * Which connector scope the run's effective mode actually entitles this read to.
 *
 * The per-checkout GitHub-reader grant (`isGitHubIssueReaderAuthorized`) is the real
 * authorization for reading THIS repository's issues, and `resolveGitHubIssue` above has already
 * enforced it — a resolution only reaches here `ok: true` once that grant held. What is left to
 * decide is the run's own connector-READ entitlement, and a GitHub issue read is a read-only
 * connector-access action: it composes through the shared `internet` resource-scope row exactly
 * like every other read-only connector action does (ADR-0128 D4, mirrored by
 * `atlassian-connectors.ts`'s `ATLASSIAN_CONNECTOR_WORKBENCH_RESOURCE_SCOPE`), and `internet`/`low`
 * is `approval-required` — never `denied` — below Full access (ADR-0138 D2), because reads and
 * planning are allowed in every mode (ADR-0138 D1). Deriving the scope from the matrix's one
 * producer, rather than restating a static list gated on `autonomous-delivery`
 * (`DELIVERY_CONNECTOR_SCOPES`, which models the run's own live network EGRESS and is deliberately
 * `autonomous-delivery`-only), is the fix for correction 7 on #3385: that restatement denied a
 * governed-assist/supervised-coding read the per-checkout grant already authorized. The scope is
 * withheld only on an actual matrix `denied` verdict, which no mode issues today but which a future
 * matrix edit is free to add without this call site drifting from it.
 */
function connectorScopesFor(
  effectiveMode: ContextInput["effectiveMode"],
): readonly CodingWorkbenchConnectorScope[] {
  const effect = codingWorkbenchPolicyEffectFor(effectiveMode, "internet", "low");
  return effect === "denied" ? [] : ["source-control.read"];
}

/** Body-free evidence for the one branch above that can still refuse an already-granted checkout:
 * a real effective-mode ceiling or missing connector scope (never the issue's own content). */
function logPackBlocked(
  deps: GitHubIssueResolutionDeps,
  input: ContextInput,
  pack: CodeContextPackResult,
): void {
  const sink = deps.activityLog ?? processServerLogSink();
  sink.write({
    level: "info",
    category: "security",
    op: "coding-context.pack",
    correlationId: input.correlationId,
    extra: {
      runId: input.runId,
      effectiveMode: input.effectiveMode,
      status: pack.status,
      blockedCount: pack.evidence.blockedCount,
      blockedReasons: [...new Set(pack.blocked.map((blocked) => blocked.reason))],
    },
  });
}

async function buildPack(
  deps: GitHubIssueResolutionDeps,
  input: ContextInput,
  resolutions: readonly ResolvedIssue[],
): Promise<CodeContextPackResult> {
  // Every object was read by the authorized resolver above; the connector only hands each ref its
  // own already-read object and refuses a ref it never resolved.
  const objects = new Map<string, CodeContextRawObject>(
    resolutions.map((resolution) => [
      String(resolution.preview.provenance.issueNumber),
      resolution.contextObject,
    ]),
  );
  const connector: CodeContextConnector = {
    read: (ref) => {
      const object = objects.get(ref.objectId);
      return object === undefined
        ? Promise.reject(new Error("code-context-object-unresolved"))
        : Promise.resolve(object);
    },
  };
  const ownerAndRepo = resolutions[0]?.preview.provenance.ownerAndRepo ?? "";
  return buildCodeContextPack(
    {
      runId: input.runId,
      effectiveMode: input.effectiveMode,
      connectorScopes: connectorScopesFor(input.effectiveMode),
      maxBodyBytes: 16_384,
      refs: resolutions.map((resolution) => ({
        source: "github" as const,
        objectKind: "issue" as const,
        ownerAndRepo,
        objectId: String(resolution.preview.provenance.issueNumber),
      })),
    },
    {
      connectors: { github: connector, jira: connector },
      connectorConfig: {
        github_connector_authorized: true,
        github_allowed_owner_and_repo: ownerAndRepo,
      },
      nowIso: () => new Date().toISOString(),
      // #3941762925: thread the owning activity-log port and this operation's correlation id so
      // `buildCodeContextPack`'s sanitisation evidence (`codeContextConnector.ts:319`,
      // `emitSanitizationEvidence`) actually reaches the log — mirrors `logPackBlocked` above,
      // which already falls back to `processServerLogSink()` the same way.
      activityLog: deps.activityLog ?? processServerLogSink(),
      correlationId: input.correlationId,
    },
  );
}

function renderPack(
  pack: CodeContextPackResult,
  commentCounts: ReadonlyMap<string, number>,
): string {
  return JSON.stringify(
    pack.items.map((item) => ({
      ...item,
      title: item.title.slice(0, 256),
      comments: item.comments.slice(0, 8).map((comment) => ({
        ...comment,
        body: comment.body.slice(0, 1_024),
        bodyTruncated: comment.bodyTruncated || comment.body.length > 1_024,
      })),
      omittedCommentCount: Math.max(
        0,
        (commentCounts.get(item.objectId) ?? item.comments.length) - 8,
      ),
    })),
  );
}
