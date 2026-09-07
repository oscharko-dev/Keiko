import { canonicalise } from "@oscharko-dev/keiko-security";
import type { CodingWorkbenchConnectorScope } from "@oscharko-dev/keiko-contracts";
import { codingWorkbenchPolicyEffectFor } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import type { CodingRuntimeIssueIntake } from "../coding-runtime/codingRuntimeIssueIntake.js";
import { processServerLogSink } from "../process-log-sink.js";
import {
  buildCodeContextPack,
  type CodeContextConnector,
  type CodeContextPackResult,
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
  const pack = await buildPack(deps, input, resolution);
  if (pack.status === "blocked") {
    logPackBlocked(deps, input, pack);
    return { ok: false, failure: "authority-denied" };
  }
  const text = renderPack(pack, resolution.preview.commentCount);
  return {
    ok: true,
    attachment: {
      issueNumber: input.binding.issueNumber,
      itemCount: pack.items.length,
      byteCount: Buffer.byteLength(text),
      text,
    },
  };
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
  resolution: ResolvedIssue,
): Promise<CodeContextPackResult> {
  const connector: CodeContextConnector = {
    read: () => Promise.resolve(resolution.contextObject),
  };
  const ownerAndRepo = resolution.preview.provenance.ownerAndRepo;
  return buildCodeContextPack(
    {
      runId: input.runId,
      effectiveMode: input.effectiveMode,
      connectorScopes: connectorScopesFor(input.effectiveMode),
      maxBodyBytes: 16_384,
      refs: [
        {
          source: "github",
          objectKind: "issue",
          ownerAndRepo,
          objectId: String(input.binding.issueNumber),
        },
      ],
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

function renderPack(pack: CodeContextPackResult, commentCount: number): string {
  return JSON.stringify(
    pack.items.map((item) => ({
      ...item,
      title: item.title.slice(0, 256),
      comments: item.comments.slice(0, 8).map((comment) => ({
        ...comment,
        body: comment.body.slice(0, 1_024),
        bodyTruncated: comment.bodyTruncated || comment.body.length > 1_024,
      })),
      omittedCommentCount: Math.max(0, commentCount - 8),
    })),
  );
}
