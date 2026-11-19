"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { I18nProvider, useTranslate } from "@/lib/i18n";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import {
  WORKSPACE_STORAGE_CHANGED_EVENT,
  WorkspaceStorageScopeContext,
} from "./hooks/workspace-storage";
import { AppBootPlaceholder, APP_BOOT_RECOVERY_HANDOFF_EVENT } from "./AppBootPlaceholder";
import styles from "./AppShellBoundary.module.css";

type RestoreState =
  | { readonly kind: "booting" | "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly storageId: string };

async function readWorkspaceStorageId(signal: AbortSignal): Promise<string> {
  const response = await fetch("/api/workspace/state", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error("Workspace layout ownership is unavailable.");
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("workspace" in body)) {
    throw new TypeError("Invalid workspace layout ownership.");
  }
  const workspace = body.workspace;
  if (typeof workspace !== "object" || workspace === null || !("storageId" in workspace)) {
    throw new TypeError("Missing workspace layout ownership.");
  }
  if (typeof workspace.storageId !== "string" || !/^[0-9a-f]{64}$/u.test(workspace.storageId)) {
    throw new TypeError("Invalid workspace layout identity.");
  }
  return workspace.storageId;
}

function useWorkspaceRestoration(): { readonly state: RestoreState; readonly retry: () => void } {
  const [state, setState] = useState<RestoreState>({ kind: "booting" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setState({ kind: "loading" });
    const controller = new AbortController();
    let stopped = false;
    const timer = setTimeout(() => controller.abort(), 10_000);
    const correlationId = newClientCorrelationId();
    // This effect owns the real, bounded read now. Its loading state has not necessarily
    // committed, so the pre-hydration watchdog must stop inspecting the old placeholder.
    window.dispatchEvent(new Event(APP_BOOT_RECOVERY_HANDOFF_EVENT));
    reportClientDiagnostic("Workspace layout ownership lifecycle started.", {
      correlationId,
      composerActivity: "workspace-ownership-started",
    });
    void readWorkspaceStorageId(controller.signal).then(
      (storageId) => {
        if (!stopped) setState({ kind: "ready", storageId });
        clearTimeout(timer);
      },
      (error: unknown) => {
        clearTimeout(timer);
        if (stopped) return;
        reportClientDiagnostic("Workspace layout ownership could not be resolved.", {
          correlationId,
          kind: "other",
          errorKind: "unavailable",
          errorEvidence: clientErrorEvidence(error),
        });
        setState({ kind: "failed" });
      },
    );
    return (): void => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [attempt]);
  const retry = useCallback((): void => {
    setState({ kind: "loading" });
    setAttempt((current) => current + 1);
  }, []);
  useWorkspaceStorageChange(state, retry);
  return { state, retry };
}

// A ready workspace whose server now serves another data store re-reads the ownership: the restart
// unmounts every window of the old store (its pollers and pending writes stop with it) and mounts
// the workspace that belongs to the store that answers. Nothing of the old store is replayed.
function useWorkspaceStorageChange(state: RestoreState, retry: () => void): void {
  const ready = state.kind === "ready";
  useEffect(() => {
    if (!ready) return undefined;
    const onChanged = (): void => {
      window.removeEventListener(WORKSPACE_STORAGE_CHANGED_EVENT, onChanged);
      reportClientDiagnostic("Workspace layout ownership changed.", {
        correlationId: newClientCorrelationId(),
        composerActivity: "workspace-ownership-changed",
      });
      retry();
    };
    window.addEventListener(WORKSPACE_STORAGE_CHANGED_EVENT, onChanged);
    return (): void => {
      window.removeEventListener(WORKSPACE_STORAGE_CHANGED_EVENT, onChanged);
    };
  }, [ready, retry]);
}

export function WorkspacePersistenceBoundary({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  const { state, retry } = useWorkspaceRestoration();
  // Before hydration, only the inline watchdog can recover a missing client bundle. Keep its
  // existing static target until this boundary mounts; store ownership still gates every child.
  if (state.kind === "booting") return <AppBootPlaceholder />;
  if (state.kind === "ready") {
    return (
      <WorkspaceStorageScopeContext value={state.storageId}>
        {children}
      </WorkspaceStorageScopeContext>
    );
  }
  return (
    <I18nProvider>
      <WorkspaceRestorationStatus failed={state.kind === "failed"} retry={retry} />
    </I18nProvider>
  );
}

function WorkspaceRestorationStatus({
  failed,
  retry,
}: {
  readonly failed: boolean;
  readonly retry: () => void;
}): ReactNode {
  const t = useTranslate();
  return (
    <div className={styles.surface}>
      <div className={styles.panel} role={failed ? "alert" : "status"}>
        <p>{t(failed ? "workspace.restore.failed" : "common.loading")}</p>
        {failed ? (
          <button className={styles.action} type="button" onClick={retry}>
            {t("common.retry")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
