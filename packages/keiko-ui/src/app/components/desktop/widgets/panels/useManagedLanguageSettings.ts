"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import type {
  ManagedLspLanguage,
  ManagedLspRuntimeConfiguration,
} from "@oscharko-dev/keiko-contracts";
import {
  ApiError,
  fetchManagedLspSettings,
  mutateManagedLspSettings,
  type ManagedLspSettingsAction,
  type ManagedLspSettingsResponse,
} from "@/lib/api";

export interface ManagedLspPendingIntent {
  readonly root: string;
  readonly language: ManagedLspLanguage;
  readonly action: ManagedLspSettingsAction;
  readonly configuration?: ManagedLspRuntimeConfiguration | undefined;
}

export type ManagedLspViewIssue = "load" | "mutation" | "conflict";

export interface ManagedLspViewState {
  readonly data: ManagedLspSettingsResponse | undefined;
  readonly loading: boolean;
  readonly mutating: boolean;
  readonly issue: ManagedLspViewIssue | undefined;
  readonly pendingIntent: ManagedLspPendingIntent | undefined;
  readonly announcement: string;
}

export interface ManagedLspViewController extends ManagedLspViewState {
  readonly refresh: () => Promise<void>;
  readonly apply: (language: ManagedLspLanguage, action: ManagedLspSettingsAction) => Promise<void>;
  readonly retryIntent: () => Promise<void>;
  readonly applyConfiguration: (
    language: ManagedLspLanguage,
    configuration: ManagedLspRuntimeConfiguration,
  ) => Promise<void>;
}

const intentByRoot = new Map<string, ManagedLspPendingIntent>();
let fallbackId = 0;

function idempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  fallbackId += 1;
  return `managed-lsp-ui-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
}

function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function useManagedLanguageSettings(root: string | undefined): ManagedLspViewController {
  const [state, setState] = useState<ManagedLspViewState>({
    data: undefined,
    loading: false,
    mutating: false,
    issue: undefined,
    pendingIntent: root === undefined ? undefined : intentByRoot.get(root),
    announcement: "",
  });
  const rootRef = useRef(root);
  const readAbort = useRef<AbortController | undefined>(undefined);
  const mutationAbort = useRef<AbortController | undefined>(undefined);
  rootRef.current = root;

  const load = useCallback(async (): Promise<void> => {
    readAbort.current?.abort();
    if (root === undefined) {
      setState((current) => ({ ...current, data: undefined, loading: false, issue: undefined }));
      return;
    }
    const controller = new AbortController();
    readAbort.current = controller;
    setState((current) => ({ ...current, loading: true, issue: undefined }));
    try {
      const data = await fetchManagedLspSettings(root, controller.signal);
      if (rootRef.current !== root || controller.signal.aborted) return;
      setState((current) => ({ ...current, data, loading: false, issue: undefined }));
    } catch (error: unknown) {
      if (aborted(error) || rootRef.current !== root) return;
      setState((current) => ({ ...current, loading: false, issue: "load" }));
    }
  }, [root]);

  useEffect(() => {
    readAbort.current?.abort();
    mutationAbort.current?.abort();
    setState({
      data: undefined,
      loading: root !== undefined,
      mutating: false,
      issue: undefined,
      pendingIntent: root === undefined ? undefined : intentByRoot.get(root),
      announcement: "",
    });
    void load();
    return () => {
      readAbort.current?.abort();
      mutationAbort.current?.abort();
    };
  }, [load, root]);

  const execute = useCallback(
    async (intent: ManagedLspPendingIntent): Promise<void> => {
      const current = state.data;
      if (current === undefined || rootRef.current !== intent.root) return;
      mutationAbort.current?.abort();
      const controller = new AbortController();
      mutationAbort.current = controller;
      intentByRoot.set(intent.root, intent);
      setState((value) => ({
        ...value,
        mutating: true,
        issue: undefined,
        pendingIntent: intent,
        announcement: "",
      }));
      try {
        await mutateManagedLspSettings(
          {
            root: intent.root,
            language: intent.language,
            action: intent.action,
            expectedRevision: current.revision,
            ...(intent.configuration === undefined ? {} : { configuration: intent.configuration }),
          },
          current.etag,
          idempotencyKey(),
          controller.signal,
        );
        const data = await fetchManagedLspSettings(intent.root, controller.signal);
        if (rootRef.current !== intent.root || controller.signal.aborted) return;
        intentByRoot.delete(intent.root);
        setState((value) => ({
          ...value,
          data,
          mutating: false,
          issue: undefined,
          pendingIntent: undefined,
          announcement: `${intent.action}:${intent.language}`,
        }));
      } catch (error: unknown) {
        if (aborted(error) || rootRef.current !== intent.root) return;
        if (error instanceof ApiError && error.code === "STALE_REVISION") {
          await reloadAfterConflict(intent.root, controller, setState);
          return;
        }
        setState((value) => ({ ...value, mutating: false, issue: "mutation" }));
      }
    },
    [state.data],
  );

  const apply = useCallback(
    (language: ManagedLspLanguage, action: ManagedLspSettingsAction): Promise<void> => {
      return root === undefined ? Promise.resolve() : execute({ root, language, action });
    },
    [execute, root],
  );
  const retryIntent = useCallback((): Promise<void> => {
    const intent = state.pendingIntent;
    return intent === undefined ? Promise.resolve() : execute(intent);
  }, [execute, state.pendingIntent]);

  const applyConfiguration = useCallback(
    (
      language: ManagedLspLanguage,
      configuration: ManagedLspRuntimeConfiguration,
    ): Promise<void> => {
      return root === undefined
        ? Promise.resolve()
        : execute({ root, language, action: "configure", configuration });
    },
    [execute, root],
  );

  return { ...state, refresh: load, apply, retryIntent, applyConfiguration };
}

async function reloadAfterConflict(
  root: string,
  controller: AbortController,
  setState: Dispatch<SetStateAction<ManagedLspViewState>>,
): Promise<void> {
  try {
    const data = await fetchManagedLspSettings(root, controller.signal);
    if (controller.signal.aborted) return;
    setState((value) => ({ ...value, data, mutating: false, issue: "conflict" }));
  } catch (error: unknown) {
    if (!aborted(error)) {
      setState((value) => ({ ...value, mutating: false, issue: "conflict" }));
    }
  }
}
