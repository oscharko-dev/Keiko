// Which repository the Git window shows, decided from its configuration, its current selection and
// the connected-repository list. An explicit hand-off from the Files window names the folder to show
// and wins over the current selection (#4103 F2), so a second hand-off into an open window switches
// it; a configuration change that is not a hand-off never replaces what the person selected.
//
// A repository list that failed to load blocks every decision until it loads again. An error about
// one repository (refused, or its connection failed) keeps the window where it is until the person
// acts, and an explicit new hand-off is such an act: it supersedes that error.

import type { ProjectWithAvailability } from "@/lib/types";

export type RepositoryRefusalReason = "unavailable" | "workspaceUnavailable";

export type RepositorySelectionDecision =
  | { readonly kind: "wait" }
  | { readonly kind: "bind-locked"; readonly path: string }
  | { readonly kind: "select"; readonly path: string; readonly endsHandOff: boolean }
  | { readonly kind: "connect-hand-off"; readonly path: string }
  | {
      readonly kind: "refuse";
      readonly reason: RepositoryRefusalReason;
      readonly endsHandOff: boolean;
    };

export interface RepositorySelectionInput {
  readonly lockedToActiveRoot: boolean;
  readonly configuredPath: string | null;
  /** The configured path arrived through an explicit hand-off that has not settled yet. */
  readonly handOffPending: boolean;
  readonly selectedPath: string | null;
  readonly reposLoading: boolean;
  /** The repository list itself failed to load, so no repository can be decided. */
  readonly reposListFailed: boolean;
  /** The window's current repository error, from the list or from one repository. */
  readonly reposError: string | null;
  readonly repositories: readonly ProjectWithAvailability[];
}

const WAIT: RepositorySelectionDecision = { kind: "wait" };

/** The repository path the window was configured with, or null when it names none. */
export function configuredRepositoryPath(projectId: string | undefined): string | null {
  return projectId !== undefined && projectId !== "" ? projectId : null;
}

export interface HandOffState {
  readonly handOffPending: boolean;
  readonly lockedToActiveRoot: boolean;
  readonly configuredPath: string | null;
}

/**
 * The folder an explicit, unsettled hand-off names, or null. A window locked to the active task
 * workspace never follows a hand-off.
 */
export function handedOffRepositoryPath(state: HandOffState): string | null {
  return state.handOffPending && !state.lockedToActiveRoot ? state.configuredPath : null;
}

/**
 * A repository switch that completes after a Files hand-off arrived or changed, naming another
 * folder, is superseded by it: the hand-off proceeds and the switch neither selects nor persists
 * its repository. A switch the hand-off itself started (same folder) is never superseded.
 */
export function supersededByNewerHandOff(
  handOffAtStart: string | null,
  pendingHandOff: string | null,
  switchPath: string,
): boolean {
  return (
    pendingHandOff !== null && pendingHandOff !== handOffAtStart && pendingHandOff !== switchPath
  );
}

function waitsForRepositoryState(
  input: RepositorySelectionInput,
  handOffPath: string | null,
): boolean {
  if (input.reposLoading || input.reposListFailed) return true;
  return input.reposError !== null && handOffPath === null;
}

function decideListedRepository(
  repository: ProjectWithAvailability | undefined,
  path: string,
  handOffPath: string | null,
): RepositorySelectionDecision {
  const endsHandOff = handOffPath !== null;
  if (repository === undefined) {
    // A handed-off folder that was never connected is connected, not discarded.
    return handOffPath === null
      ? { kind: "refuse", reason: "unavailable", endsHandOff }
      : { kind: "connect-hand-off", path };
  }
  if (repository.available !== true) return { kind: "refuse", reason: "unavailable", endsHandOff };
  if (repository.workspaceAvailable !== true) {
    return { kind: "refuse", reason: "workspaceUnavailable", endsHandOff };
  }
  return { kind: "select", path, endsHandOff };
}

export function decideRepositorySelection(
  input: RepositorySelectionInput,
): RepositorySelectionDecision {
  // A root the desktop locked to the active task workspace is a managed worktree: the server
  // registers it for trust, manifests and verification and keeps it out of the user-facing
  // repository list on purpose, so the recents-membership check below could only ever declare it
  // unavailable and strand the operator (#3390, rehearsal run-21). It is bound as-is.
  if (input.lockedToActiveRoot && input.configuredPath !== null) {
    return { kind: "bind-locked", path: input.configuredPath };
  }
  const handOffPath = handedOffRepositoryPath(input);
  if (waitsForRepositoryState(input, handOffPath)) return WAIT;
  const requestedPath = handOffPath ?? input.selectedPath ?? input.configuredPath;
  if (requestedPath === null) return WAIT;
  const repository = input.repositories.find((candidate) => candidate.path === requestedPath);
  return decideListedRepository(repository, requestedPath, handOffPath);
}
