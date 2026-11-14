import type { ProjectWithAvailability } from "@oscharko-dev/keiko-contracts/bff-wire";

/**
 * The folder a window may start in when the person has chosen none: the chat session's project,
 * but only while it exists and the read surface lets the person use it. A project the server marks
 * `readable: false` stays listed and can be chosen, but is never the starting project (#4371).
 */
export function startingProjectRoot(project: ProjectWithAvailability | null): string | null {
  return project?.available === true && project.readable !== false ? project.path : null;
}
