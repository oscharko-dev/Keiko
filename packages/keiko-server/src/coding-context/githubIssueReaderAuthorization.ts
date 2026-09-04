import type { UiHandlerDeps } from "../deps.js";
import { deriveRepositoryId } from "../task-workspace/naming.js";

/**
 * Is the GitHub issue reader authorized for one repository?
 *
 * Issue #3385 replaces the `GITHUB_CONNECTOR_AUTHORIZED` environment variable with this
 * server-persisted, repository-scoped answer. The variable was read once at process launch and
 * bound to whatever project the process started in, so a deployment could not authorize one
 * repository without authorizing every repository that process later opened, and revoking meant
 * restarting. The stored record is keyed by the content-free repository identity the task workspace
 * already derives, and is consulted per read, so a revocation takes effect on the next read.
 *
 * Fail-closed in every direction: no repository root, an unknown root, no store, or no row all
 * answer `false`. Only an explicit stored grant answers `true`. Neither a browser request field nor
 * issue text can reach this decision — the only input is a server-resolved repository root.
 */
export function isGitHubIssueReaderAuthorized(
  deps: Pick<UiHandlerDeps, "store">,
  repositoryRoot: string | undefined,
): boolean {
  if (repositoryRoot === undefined || repositoryRoot === "") return false;
  const record = deps.store.readGitHubIssueReaderAuthorization(deriveRepositoryId(repositoryRoot));
  return record?.authorized === true;
}
