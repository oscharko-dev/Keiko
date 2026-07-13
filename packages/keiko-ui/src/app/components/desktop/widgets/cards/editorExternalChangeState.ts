import type { EditorM7WatchEvent } from "@oscharko-dev/keiko-contracts";

export type EditorExternalChangeStatus =
  "idle" | "cleanChanged" | "dirtyChanged" | "deleted" | "renamed" | "rescanRequired" | "degraded";

export interface EditorExternalChangeState {
  readonly status: EditorExternalChangeStatus;
  readonly relativePath: string | null;
  readonly oldRelativePath: string | null;
  readonly sequence: number;
  readonly reason: string | null;
  readonly compareOpen: boolean;
}

export type EditorExternalChangeAction =
  | {
      readonly type: "observed";
      readonly event: EditorM7WatchEvent;
      readonly activePath: string | undefined;
      readonly dirty: boolean;
      readonly saving: boolean;
      readonly originatedByKeiko: boolean;
    }
  | { readonly type: "keepLocal" }
  | { readonly type: "reloadStarted" }
  | { readonly type: "reloadSucceeded" }
  | { readonly type: "compareOpened" }
  | { readonly type: "compareClosed" }
  | { readonly type: "dirtyChanged"; readonly dirty: boolean }
  | { readonly type: "degraded"; readonly sequence: number; readonly reason: string };

export const IDLE_EXTERNAL_CHANGE_STATE: EditorExternalChangeState = {
  status: "idle",
  relativePath: null,
  oldRelativePath: null,
  sequence: 0,
  reason: null,
  compareOpen: false,
};

function eventTargetsActivePath(
  event: EditorM7WatchEvent,
  activePath: string | undefined,
): boolean {
  if (activePath === undefined) return event.relativePath.length === 0;
  return (
    event.relativePath.length === 0 ||
    event.relativePath === activePath ||
    event.oldRelativePath === activePath
  );
}

function statusForObserved(
  action: Extract<EditorExternalChangeAction, { readonly type: "observed" }>,
): EditorExternalChangeStatus {
  if (action.event.kind === "rescan" || action.event.kind === "overflow") return "rescanRequired";
  if (action.event.health === "degraded" || action.event.health === "rescanRequired") {
    return "degraded";
  }
  if (action.event.kind === "deleted") return "deleted";
  if (action.event.kind === "renamed") return "renamed";
  return action.dirty || action.saving ? "dirtyChanged" : "cleanChanged";
}

function observedState(
  action: Extract<EditorExternalChangeAction, { readonly type: "observed" }>,
): EditorExternalChangeState {
  return {
    status: statusForObserved(action),
    relativePath: action.event.relativePath,
    oldRelativePath: action.event.oldRelativePath ?? null,
    sequence: action.event.sequence,
    reason: action.event.reason ?? null,
    compareOpen: false,
  };
}

export function editorExternalChangeReducer(
  state: EditorExternalChangeState,
  action: EditorExternalChangeAction,
): EditorExternalChangeState {
  switch (action.type) {
    case "observed":
      if (!eventTargetsActivePath(action.event, action.activePath)) return state;
      if (action.originatedByKeiko && !action.dirty && !action.saving)
        return IDLE_EXTERNAL_CHANGE_STATE;
      return observedState(action);
    case "degraded":
      return {
        status: "degraded",
        relativePath: "",
        oldRelativePath: null,
        sequence: action.sequence,
        reason: action.reason,
        compareOpen: false,
      };
    case "compareOpened":
      return state.status === "idle" ? state : { ...state, compareOpen: true };
    case "compareClosed":
      return { ...state, compareOpen: false };
    case "dirtyChanged":
      return state.status === "cleanChanged" && action.dirty
        ? { ...state, status: "dirtyChanged" }
        : state;
    case "keepLocal":
    case "reloadStarted":
    case "reloadSucceeded":
      return IDLE_EXTERNAL_CHANGE_STATE;
  }
}
