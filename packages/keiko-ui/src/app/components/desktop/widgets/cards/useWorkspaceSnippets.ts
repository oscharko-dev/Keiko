"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import {
  EDITOR_M7_SNIPPET_COLLECTION_VERSION,
  type EditorM7WorkspaceSnippetInput,
  type EditorM7WorkspaceSnippetSnapshot,
} from "@oscharko-dev/keiko-contracts";
import { fetchWorkspaceSnippets, mutateWorkspaceSnippets } from "../../../../../lib/api";
import { subscribeSharedEventSource } from "./sharedEventSource";

export type WorkspaceSnippetsIssue = "load" | "mutation" | "conflict";

export interface WorkspaceSnippetsView {
  readonly snapshot: EditorM7WorkspaceSnippetSnapshot | undefined;
  readonly loading: boolean;
  readonly mutating: boolean;
  readonly issue: WorkspaceSnippetsIssue | undefined;
  readonly refresh: () => Promise<void>;
  readonly replace: (snippets: readonly EditorM7WorkspaceSnippetInput[]) => Promise<void>;
  readonly reset: () => Promise<void>;
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
    (snippets: readonly EditorM7WorkspaceSnippetInput[]): Promise<void> =>
      mutate({
        action: "replace",
        root,
        snapshot,
        signalRef: mutationAbort,
        setIssue,
        setMutating,
        setSnapshot,
        snippets,
      }),
    [root, snapshot],
  );
  const reset = useCallback(
    (): Promise<void> =>
      mutate({
        action: "reset",
        root,
        snapshot,
        signalRef: mutationAbort,
        setIssue,
        setMutating,
        setSnapshot,
      }),
    [root, snapshot],
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
  readonly snippets?: readonly EditorM7WorkspaceSnippetInput[] | undefined;
}

async function mutate(args: MutateArgs): Promise<void> {
  if (args.root === undefined || args.snapshot === undefined) return;
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
    if (controller.signal.aborted || result.kind !== "ok") return;
    args.setSnapshot(result.snapshot);
  } catch (error: unknown) {
    if (!aborted(error)) args.setIssue("mutation");
  } finally {
    if (!controller.signal.aborted) args.setMutating(false);
  }
}
