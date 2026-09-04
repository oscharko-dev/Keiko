import type { UiHandlerDeps } from "../deps.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { ServerLogSink } from "../observability/index.js";
import { deriveRepositoryId } from "../task-workspace/naming.js";
import type { GitHubCodeContextApiPort } from "./githubCodeContextConnector.js";
import { createGitHubCodeContextApiPort } from "./githubCodeContextPort.js";

/**
 * Why the GitHub issue reader was admitted or refused for one repository. A closed vocabulary, so a
 * support timeline can tell a repository that was never granted apart from one whose grant was
 * withdrawn, and both apart from a request that named no repository at all.
 */
export type GitHubIssueReaderAuthorizationDecision =
  "authorized" | "repository-unresolved" | "store-unavailable" | "no-grant" | "revoked";

export interface GitHubIssueReaderAuthorizationObservation {
  readonly activityLog?: ServerLogSink | undefined;
  readonly correlationId?: string | undefined;
}

function decide(
  deps: Pick<UiHandlerDeps, "store">,
  repositoryRoot: string | undefined,
): {
  readonly decision: GitHubIssueReaderAuthorizationDecision;
  readonly repositoryId?: string;
  readonly revision?: number;
} {
  if (repositoryRoot === undefined || repositoryRoot === "") {
    return { decision: "repository-unresolved" };
  }
  const repositoryId = deriveRepositoryId(repositoryRoot);
  // A deps graph composed without persistence must DENY, not throw. `store` is typed as required,
  // but a partially-composed graph can still reach here, and an exception on the authorization path
  // would surface as an opaque failure rather than the fail-closed refusal this decision owes its
  // caller. The decision stays distinct from "no grant" so a support timeline can tell a repository
  // nobody granted apart from a deployment whose store was never wired.
  // `store` is typed as required, so the checker treats any nullish test on it as redundant. The
  // guard is about runtime SHAPE, not the type: a partially-composed deps graph — every hand-built
  // test double included — can reach here without one, and an exception on the authorization path
  // would surface as an opaque failure instead of the fail-closed refusal this decision owes its
  // caller. The unknown-typed view states that honestly rather than silencing the rule.
  const read = (deps as { readonly store?: Partial<UiHandlerDeps["store"]> | undefined }).store
    ?.readGitHubIssueReaderAuthorization;
  if (typeof read !== "function") return { decision: "store-unavailable", repositoryId };
  const record = read(repositoryId);
  if (record === undefined) return { decision: "no-grant", repositoryId };
  return {
    decision: record.authorized ? "authorized" : "revoked",
    repositoryId,
    revision: record.revision,
  };
}

/**
 * Is the GitHub issue reader authorized for one repository?
 *
 * Issue #3385 replaces the `GITHUB_CONNECTOR_AUTHORIZED` environment variable with this
 * server-persisted answer, scoped to one local checkout. The variable was read once at process
 * launch and bound to whatever project the process started in, so a deployment could not authorize
 * one checkout without authorizing every checkout that process later opened, and revoking meant
 * restarting. The stored record is keyed by the content-free identity the task workspace derives
 * from the WORKSPACE ROOT, and is consulted per read, so a revocation takes effect on the next read.
 *
 * The scope is deliberately named precisely: it is the local checkout, NOT the remote GitHub
 * repository whose issues are read. Two clones of the same remote are two separate grants, and a
 * checkout whose remote is later repointed keeps the grant it already had. Binding the grant to the
 * resolved remote instead would be a stronger guarantee and is not what this stores; #3385's
 * `IssueRunBinding` is where the remote identity gets pinned, and that resolver is not built yet.
 *
 * Fail-closed in every direction: no repository root, an unknown root, and no row all answer
 * `false`. Only an explicit stored grant answers `true`. Neither a browser request field nor issue
 * text can reach this decision — the only input is a server-resolved repository root.
 *
 * Every evaluation leaves body-free evidence on the activity log (ADR-0173): without it a denied
 * external read is indistinguishable in a support timeline from a missing row, a withdrawn grant, or
 * a request that never named a repository. The line carries the content-free repository id, the
 * decision and the grant's revision — never a path, a remote, or issue text.
 */
export function isGitHubIssueReaderAuthorized(
  deps: Pick<UiHandlerDeps, "store">,
  repositoryRoot: string | undefined,
  observation: GitHubIssueReaderAuthorizationObservation = {},
): boolean {
  const { decision, repositoryId, revision } = decide(deps, repositoryRoot);
  const authorized = decision === "authorized";
  const sink = observation.activityLog ?? processServerLogSink();
  sink.write({
    level: authorized ? "debug" : "info",
    category: "security",
    op: "coding-context.github-authorization.evaluated",
    correlationId: observation.correlationId ?? UNKNOWN_CORRELATION_ID,
    extra: {
      decision,
      authorized,
      ...(repositoryId === undefined ? {} : { repositoryId }),
      // Which stored grant was evaluated, so a timeline can tell one revision from the next. Absent
      // exactly when no row was read, which the decision already says.
      ...(revision === undefined ? {} : { revision }),
    },
  });
  return authorized;
}

/**
 * Build the read-only `gh api` port for ONE repository root.
 *
 * Both composition sites used to build it from `deps.preferredProjectPath`, the project the process
 * happened to start in. That made the port a launch-time snapshot: opening another repository later
 * left GitHub context unavailable however the grant was set, and where the two roots differed,
 * authorization was evaluated for one repository while `gh` was confined to another. The port is now
 * always built for the repository the caller is actually working in, so the stored grant is the only
 * thing that decides.
 */
export function gitHubCodeContextPortFor(
  repositoryRoot: string | undefined,
  processEnv: NodeJS.ProcessEnv,
): GitHubCodeContextApiPort | undefined {
  if (repositoryRoot === undefined || repositoryRoot === "") return undefined;
  return createGitHubCodeContextApiPort({
    workspace: {
      root: repositoryRoot,
      selectedRoot: repositoryRoot,
      name: undefined,
      version: undefined,
      testFramework: "unknown",
      sourceDirs: [],
      testDirs: [],
      languages: [],
      ignoreLines: [],
    },
    processEnv,
  });
}
