import type { ProjectWithAvailability } from "@/lib/types";

/**
 * Whether a registered folder can hold a coding run: it exists, its workspace is current, and the
 * read surface lets the person use it. A folder the server lists as `readable: false` (Keiko's own
 * state area, or the program folder of a folder package or desktop installation, ADR-0121 D9)
 * stays listed and is never offered for a run, exactly as it is never a window's starting folder
 * (#4371). One predicate for the picker's options and for the checks before a start.
 */
export function locallyAvailable(project: ProjectWithAvailability): boolean {
  return project.available && project.workspaceAvailable === true && project.readable !== false;
}

/**
 * A registered folder that still exists and is readable but whose workspace membership is not
 * current (deleted and cloned again at the same path): the server refuses it on purpose, and
 * choosing it in the picker is the person's explicit act to reconnect it (U-16).
 */
export function needsReconnect(project: ProjectWithAvailability): boolean {
  return project.available && project.readable !== false && project.workspaceAvailable !== true;
}
