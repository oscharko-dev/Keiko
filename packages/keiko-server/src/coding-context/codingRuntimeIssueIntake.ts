import { canonicalise } from "@oscharko-dev/keiko-security";
import type { CodingWorkbenchConnectorScope } from "@oscharko-dev/keiko-contracts";
import type { CodingRuntimeIssueIntake } from "../coding-runtime/codingRuntimeIssueIntake.js";
// The real connector-scope entitlement for the run's effective mode, reused from its one producer
// (epic #3384 correction 7) rather than restated here — a restated `["source-control.read"]`
// admitted a GitHub read regardless of mode, so a run below `autonomous-delivery` got issue
// context the connector-scope model never actually granted it.
import { DELIVERY_CONNECTOR_SCOPES } from "../coding-runtime/productionRuntimeWorkspaceAuthority.js";
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
  const pack = await buildPack(input, resolution);
  if (pack.status === "blocked") return { ok: false, failure: "authority-denied" };
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

function connectorScopesFor(
  effectiveMode: ContextInput["effectiveMode"],
): readonly CodingWorkbenchConnectorScope[] {
  return effectiveMode === "autonomous-delivery" ? DELIVERY_CONNECTOR_SCOPES : [];
}

async function buildPack(
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
