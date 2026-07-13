"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import {
  EDITOR_M7_SNIPPET_COLLECTION_VERSION,
  type EditorM7WorkspaceSnippetInput,
  type EditorM7WorkspaceSnippetSnapshot,
} from "@oscharko-dev/keiko-contracts";
import { fetchWorkspaceSnippets, mutateWorkspaceSnippets } from "../../../../../lib/api";
import { subscribeSharedEventSource } from "./sharedEventSource";

export type WorkspaceSnippetsIssue = "load" | "mutation" | "conflict" | "invalid" | "unavailable";

export interface WorkspaceSnippetsView {
  readonly snapshot: EditorM7WorkspaceSnippetSnapshot | undefined;
  readonly loading: boolean;
  readonly mutating: boolean;
  readonly issue: WorkspaceSnippetsIssue | undefined;
  readonly refresh: () => Promise<void>;
  readonly replace: (snippets: readonly EditorM7WorkspaceSnippetInput[]) => Promise<boolean>;
  readonly reset: () => Promise<boolean>;
}

let fallbackId = 0;

function idempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  fallbackId += 1;
  return `workspace-snippets-ui-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
}

function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function eventsUrl(root: string): string {
  return `/api/editor/snippets/events?root=${encodeURIComponent(root)}`;
}

function abortControllerRef(ref: RefObject<AbortController | undefined>): void {
  ref.current?.abort();
}

export function useWorkspaceSnippets(root: string | undefined): WorkspaceSnippetsView {
  const rootRef = useRef(root);
  const readAbort = useRef<AbortController | undefined>(undefined);
  const mutationAbort = useRef<AbortController | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<EditorM7WorkspaceSnippetSnapshot | undefined>();
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [issue, setIssue] = useState<WorkspaceSnippetsIssue | undefined>();
  rootRef.current = root;

  const refresh = useCallback(async (): Promise<void> => {
    if (root === undefined || root.length === 0) return;
    readAbort.current?.abort();
    const controller = new AbortController();
    readAbort.current = controller;
    setLoading(true);
    try {
      const data = await fetchWorkspaceSnippets(root, controller.signal);
      if (rootRef.current === root && !controller.signal.aborted) {
        setSnapshot(data);
        setIssue(undefined);
      }
    } catch (error: unknown) {
      if (!aborted(error) && rootRef.current === root) setIssue("load");
    } finally {
      if (rootRef.current === root && !controller.signal.aborted) setLoading(false);
    }
  }, [root]);

  useEffect(() => {
    setSnapshot(undefined);
    setIssue(undefined);
    void refresh();
    return () => {
      abortControllerRef(readAbort);
      abortControllerRef(mutationAbort);
    };
  }, [refresh]);

  useEffect(() => {
    if (root === undefined || root.length === 0) return undefined;
    return subscribeSharedEventSource(eventsUrl(root), ["ready", "editor-snippets:changed"], () => {
      void refresh();
    });
  }, [refresh, root]);

  const replace = useCallback(
    (snippets: readonly EditorM7WorkspaceSnippetInput[]): Promise<boolean> =>
      mutate({
        action: "replace",
        root,
        snapshot,
        signalRef: mutationAbort,
        setIssue,
        setMutating,
        setSnapshot,
        refresh,
        snippets,
      }),
    [root, snapshot, refresh],
  );
  const reset = useCallback(
    (): Promise<boolean> =>
      mutate({
        action: "reset",
        root,
        snapshot,
        signalRef: mutationAbort,
        setIssue,
        setMutating,
        setSnapshot,
        refresh,
      }),
    [root, snapshot, refresh],
  );
  return { snapshot, loading, mutating, issue, refresh, replace, reset };
}

interface MutateArgs {
  readonly action: "replace" | "reset";
  readonly root: string | undefined;
  readonly snapshot: EditorM7WorkspaceSnippetSnapshot | undefined;
  readonly signalRef: RefObject<AbortController | undefined>;
  readonly setSnapshot: (snapshot: EditorM7WorkspaceSnippetSnapshot) => void;
  readonly setMutating: (mutating: boolean) => void;
  readonly setIssue: (issue: WorkspaceSnippetsIssue | undefined) => void;
  readonly refresh: () => Promise<void>;
  readonly snippets?: readonly EditorM7WorkspaceSnippetInput[] | undefined;
}

// Maps every non-"ok" mutation outcome to a distinct, user-visible issue instead of silently
// discarding it. Conflicts trigger a refresh so the local revision/etag reconciles with the
// server; callers use the returned boolean to decide whether it is safe to discard a draft.
async function mutate(args: MutateArgs): Promise<boolean> {
  if (args.root === undefined || args.snapshot === undefined) return false;
  args.signalRef.current?.abort();
  const controller = new AbortController();
  args.signalRef.current = controller;
  args.setMutating(true);
  args.setIssue(undefined);
  try {
    const result = await mutateWorkspaceSnippets(
      {
        schemaVersion: EDITOR_M7_SNIPPET_COLLECTION_VERSION,
        root: args.root,
        expectedRevision: args.snapshot.revision,
        action: args.action,
        ...(args.snippets === undefined ? {} : { snippets: args.snippets }),
      },
      args.snapshot.etag,
      idempotencyKey(),
      controller.signal,
    );
    if (controller.signal.aborted) return false;
    if (result.kind === "ok") {
      args.setSnapshot(result.snapshot);
      return true;
    }
    if (result.kind === "conflict" || result.kind === "idempotencyConflict") {
      // Reconcile the local revision/etag before flagging the conflict, so the notice reflects
      // the settled state (refresh() clears `issue` on success) instead of being immediately
      // overwritten by it.
      await args.refresh();
      args.setIssue("conflict");
    } else {
      args.setIssue(result.kind);
    }
    return false;
  } catch (error: unknown) {
    if (!aborted(error)) args.setIssue("mutation");
    return false;
  } finally {
    if (!controller.signal.aborted) args.setMutating(false);
  }
}
