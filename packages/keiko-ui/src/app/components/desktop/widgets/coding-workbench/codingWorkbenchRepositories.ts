import type { ProjectWithAvailability } from "@/lib/types";
import { fetchGitSummary, fetchProjects } from "@/lib/api";

function locallyAvailable(project: ProjectWithAvailability): boolean {
  return project.available && project.workspaceAvailable === true;
}

async function gitAvailable(root: string): Promise<boolean> {
  const summary = await fetchGitSummary(root);
  return summary.available && summary.state === "available";
}

/** Mirror Git's complete registered repository list, including unavailable entries. */
export async function selectableRepositories(): Promise<readonly ProjectWithAvailability[]> {
  const { projects } = await fetchProjects();
  return projects;
}

/**
 * #H review: only the Git-availability half of this check (`gitAvailable`, a live
 * `fetchGitSummary` — no caching found in api.ts) is actually revalidated here. Catalog membership
 * (`fetchProjects`, api.ts) is served from that function's own 2-second TTL cache
 * (`PROJECTS_CACHE_TTL_MS`), so a root registered or removed within that window can still read
 * stale here. This is only an early client-side UX gate, not the authority boundary: the server
 * independently revalidates the repository with a live `git` process at run start regardless of
 * anything this function returns — `CodingRuntimeOrchestrator.startFresh` ->
 * `resolveLaunch`/`GitPreparation.prepare` -> `readIdentity`
 * (packages/keiko-server/src/coding-runtime/productionRuntimeGitPreparation.ts) rejects a
 * workspace root mismatch or a failed `readVerifiedRepositoryIdentity`
 * (packages/keiko-server/src/gitDelivery/verifiedRepositoryIdentity.ts), which runs a real `git
 * remote` read (packages/keiko-tools/src/git-worktree-snapshot-node.ts) and refuses the launch on
 * a non-Git or otherwise unavailable root.
 */
export async function repositorySelectable(root: string): Promise<boolean> {
  const { projects } = await fetchProjects();
  const project = projects.find((entry) => entry.path === root);
  if (project === undefined || !locallyAvailable(project)) return false;
  return gitAvailable(root);
}
