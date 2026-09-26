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

/** Revalidate at bind time because an earlier catalog read can become stale. */
export async function repositorySelectable(root: string): Promise<boolean> {
  const { projects } = await fetchProjects();
  const project = projects.find((entry) => entry.path === root);
  if (project === undefined || !locallyAvailable(project)) return false;
  return gitAvailable(root);
}
