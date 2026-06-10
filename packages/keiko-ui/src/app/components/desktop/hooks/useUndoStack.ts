// Epic #518 / Issue #527 — Workspace UI undo stack.
//
// Implements the typed undo stack from ADR-0028. The stack stores only
// WorkspaceUiAction records (the discriminated union in @oscharko-dev/keiko-contracts).
// Because no WorkspaceUiAction constructor exists for evidence / patch /
// verification / model-call / tool / memory / FS / durable-config kinds,
// the stack cannot record or reverse those classes. The refusal is
// compile-time, not runtime.
//
// The hook is dependency-free apart from React; no library is introduced.

"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  type WorkspaceUiAction,
  type WorkspaceUndoStackApi,
  workspaceActionLabel,
  workspaceInverseAction,
} from "@oscharko-dev/keiko-contracts";

interface UndoStackInternalState {
  readonly undoStack: ReadonlyArray<WorkspaceUiAction>;
  readonly redoStack: ReadonlyArray<WorkspaceUiAction>;
}

const EMPTY_STATE: UndoStackInternalState = { undoStack: [], redoStack: [] };
const DEFAULT_LIMIT = 100;

export interface UseUndoStackOptions {
  readonly limit?: number;
  // The substrate dispatches the inverse action by calling this side-effect.
  // Callers wire it to whatever React state owns the surface (useWorkspace,
  // panel toggles, tab switches). The hook itself does NOT mutate any
  // application state — it only stores/inverts/labels the actions.
  readonly apply: (action: WorkspaceUiAction) => void;
}

export function useUndoStack(options: UseUndoStackOptions): WorkspaceUndoStackApi {
  const { apply } = options;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const [state, setState] = useState<UndoStackInternalState>(EMPTY_STATE);
  // Pinning apply via ref keeps the returned API stable across re-renders
  // and avoids re-binding the hook every time the parent re-renders.
  const applyRef = useRef(apply);
  applyRef.current = apply;
  // Mirror of the current state kept in a ref so that undo/redo can read
  // the latest value synchronously without depending on the `state` variable
  // (which would force re-memoisation of the callbacks on every push).
  const stateRef = useRef(state);
  stateRef.current = state;

  const push = useCallback(
    (action: WorkspaceUiAction): void => {
      setState((prev) => {
        const next = [...prev.undoStack, action];
        const trimmed = next.length > limit ? next.slice(next.length - limit) : next;
        return { undoStack: trimmed, redoStack: [] };
      });
    },
    [limit],
  );

  const undo = useCallback((): void => {
    // Read state from the ref (not from the updater) so that the side-effect
    // fires exactly once in the callback body — never inside the setState
    // updater. React StrictMode double-invokes pure updaters in dev, which
    // would call applyRef.current() twice and silently cancel the user's
    // intent. Callbacks like undo() are NOT double-invoked by StrictMode.
    const current = stateRef.current;
    if (current.undoStack.length === 0) return;
    const last = current.undoStack[current.undoStack.length - 1] as WorkspaceUiAction;
    const inverse = workspaceInverseAction(last);
    setState({
      undoStack: current.undoStack.slice(0, -1),
      redoStack: [...current.redoStack, last],
    });
    applyRef.current(inverse);
  }, []);

  const redo = useCallback((): void => {
    // Same pattern: read from the ref, set state with a plain object (not an
    // updater), then call apply exactly once in the callback body.
    const current = stateRef.current;
    if (current.redoStack.length === 0) return;
    const last = current.redoStack[current.redoStack.length - 1] as WorkspaceUiAction;
    setState({
      undoStack: [...current.undoStack, last],
      redoStack: current.redoStack.slice(0, -1),
    });
    applyRef.current(last);
  }, []);

  const clear = useCallback((): void => {
    setState(EMPTY_STATE);
  }, []);

  return useMemo<WorkspaceUndoStackApi>(() => {
    const top = state.undoStack[state.undoStack.length - 1];
    const redoTop = state.redoStack[state.redoStack.length - 1];
    return {
      canUndo: state.undoStack.length > 0,
      canRedo: state.redoStack.length > 0,
      undoLabel: top !== undefined ? workspaceActionLabel(top) : null,
      redoLabel: redoTop !== undefined ? workspaceActionLabel(redoTop) : null,
      push,
      undo,
      redo,
      clear,
    };
  }, [state, push, undo, redo, clear]);
}
