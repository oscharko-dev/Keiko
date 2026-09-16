"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { initializeGitRepository } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { useActiveWorkspace, type ActiveWorkspaceApi } from "./context/ActiveWorkspaceContext";
import { useOptionalChatSessionCatalog } from "./context/ChatSessionContext";
import { useDialogTabTrap } from "./hooks/useDialogTabTrap";
import { useModalInteractionLock } from "./hooks/useModalInteractionLock";
import { useRepositoryBranchState } from "./hooks/useRepositoryBranchState";
import { Icons } from "./Icons";
import { BranchSelector } from "./widgets/cards/git-client/BranchSelector";
import { NewBranchDialog } from "./widgets/cards/git-client/NewBranchDialog";
import { WorktreeMutationConfirmDialog } from "./widgets/cards/git-client/WorktreeMutationConfirmDialog";
import {
  DEFAULT_GIT_CLIENT,
  formatGitError,
  useGitActions,
  type GitActionFlowState,
} from "./widgets/cards/git-client/git-client-seam";
import { notifyGitRepositoryStateInvalidated } from "./widgets/cards/git-repository-state-events";
import styles from "./RepositoryBranchSwitcher.module.css";

const BranchIcon = Icons.branch;

function InitializeRepositoryDialog(props: {
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly t: I18nTranslate;
}): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogTabTrap(dialogRef);
  useModalInteractionLock({ initialFocusRef: dialogRef });
  const { t } = props;
  const dialog = (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-label={t("repositoryBranchSwitcher.setUpGit")}
      tabIndex={-1}
      className={styles.cmpDialogBackdrop}
    >
      <section className={styles.cmpDialogCard}>
        <h2>{t("repositoryBranchSwitcher.setUpGit")}</h2>
        <p>{t("repositoryBranchSwitcher.initializeDescription")}</p>
        <div className={styles.cmpDialogActions}>
          <button type="button" className={styles.cmpSecondary} onClick={props.onCancel}>
            {t("repositoryBranchSwitcher.cancel")}
          </button>
          <button
            type="button"
            className={styles.cmpPrimary}
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {props.busy
              ? t("repositoryBranchSwitcher.initializing")
              : t("repositoryBranchSwitcher.initializeRepository")}
          </button>
        </div>
      </section>
    </div>
  );
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}

function taskWorkspaceBlocksBranchChange(
  repositoryRoot: string,
  activeWorkspace: ActiveWorkspaceApi,
): boolean {
  const instance = activeWorkspace.activeInstance;
  return instance?.repositoryRoot === repositoryRoot && instance.lock !== null;
}

interface TaskBindingGuard {
  readonly error: string | null;
  readonly clearError: () => void;
  readonly blocked: () => boolean;
  readonly release: () => Promise<void>;
}

function useTaskBindingGuard(root: string | null, workspace: ActiveWorkspaceApi): TaskBindingGuard {
  const [error, setError] = useState<string | null>(null);
  const changeBlocked = root !== null && taskWorkspaceBlocksBranchChange(root, workspace);
  const blocked = useCallback((): boolean => {
    if (!changeBlocked) return false;
    setError("Branch changes are unavailable while a coding run holds this repository.");
    return true;
  }, [changeBlocked]);
  const release = useCallback(async (): Promise<void> => {
    if (workspace.activeInstance?.repositoryRoot !== root) return;
    if (!(await workspace.clearActive())) {
      throw new Error("The active task workspace could not be released before changing branches.");
    }
  }, [root, workspace]);
  const clearError = useCallback((): void => setError(null), []);
  return useMemo(
    () => ({ error, clearError, blocked, release }),
    [blocked, clearError, error, release],
  );
}

interface BranchMutationController {
  readonly flow: GitActionFlowState;
  readonly create: (input: {
    readonly branchName: string;
    readonly baseBranchName: string;
  }) => void;
  readonly switchTo: (branchName: string) => void;
}

function useBranchMutations(
  root: string | null,
  branches: ReturnType<typeof useRepositoryBranchState>["branches"],
  guard: TaskBindingGuard,
): BranchMutationController {
  const { flow, reset, runMutation } = useGitActions(DEFAULT_GIT_CLIENT, root ?? "");
  useEffect(() => reset(), [reset, root]);
  const switchTo = useCallback(
    (branchName: string): void => {
      if (root === null || guard.blocked()) return;
      runMutation(async () => {
        await guard.release();
        return DEFAULT_GIT_CLIENT.branchSwitch({ projectId: root, branchName });
      });
    },
    [guard, root, runMutation],
  );
  const create = useCallback(
    (input: { readonly branchName: string; readonly baseBranchName: string }): void => {
      const base = branches.find((branch) => branch.name === input.baseBranchName);
      if (root === null || base === undefined || guard.blocked()) return;
      runMutation(async () => {
        await guard.release();
        const created = await DEFAULT_GIT_CLIENT.branchCreate({
          projectId: root,
          branchName: input.branchName,
          baseBranchName: input.baseBranchName,
          startPointRefHash: base.headRefHash,
        });
        return created.status === "succeeded"
          ? DEFAULT_GIT_CLIENT.branchSwitch({ projectId: root, branchName: input.branchName })
          : created;
      });
    },
    [branches, guard, root, runMutation],
  );
  return useMemo(() => ({ flow, create, switchTo }), [create, flow, switchTo]);
}

interface InitializationController {
  readonly open: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly show: () => void;
  readonly close: () => void;
  readonly run: () => void;
}

function useRepositoryInitialization(root: string | null): InitializationController {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootGenerationRef = useRef(0);
  useEffect(() => {
    rootGenerationRef.current += 1;
    setOpen(false);
    setBusy(false);
    setError(null);
    return (): void => {
      rootGenerationRef.current += 1;
    };
  }, [root]);
  const run = useCallback((): void => {
    if (root === null) return;
    const rootGeneration = rootGenerationRef.current;
    setBusy(true);
    setError(null);
    void initializeGitRepository({ projectId: root, initialBranch: "main" }).then(
      (): void => {
        if (rootGenerationRef.current !== rootGeneration) return;
        setBusy(false);
        setOpen(false);
        notifyGitRepositoryStateInvalidated(root);
      },
      (cause: unknown): void => {
        if (rootGenerationRef.current !== rootGeneration) return;
        setBusy(false);
        setError(formatGitError(cause));
        reportClientDiagnostic(
          `[keiko] repository initialization failed: ${clientErrorSummary(cause)}`,
          { correlationId: correlationIdOf(cause) },
        );
      },
    );
  }, [root]);
  const show = useCallback((): void => setOpen(true), []);
  const close = useCallback((): void => setOpen(false), []);
  return useMemo(
    () => ({ open, busy, error, show, close, run }),
    [busy, close, error, open, run, show],
  );
}

interface DialogState {
  readonly newBranchOpen: boolean;
  readonly pendingSwitch: string | null;
  readonly openNewBranch: () => void;
  readonly closeNewBranch: () => void;
  readonly requestSwitch: (branchName: string) => void;
  readonly clearSwitch: () => void;
}

function useBranchDialogs(root: string | null, guard: TaskBindingGuard): DialogState {
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  const { clearError } = guard;
  useEffect(() => {
    setPendingSwitch(null);
    setNewBranchOpen(false);
    clearError();
  }, [clearError, root]);
  const openNewBranch = useCallback((): void => {
    if (!guard.blocked()) setNewBranchOpen(true);
  }, [guard]);
  const requestSwitch = useCallback(
    (branchName: string): void => {
      if (!guard.blocked()) setPendingSwitch(branchName);
    },
    [guard],
  );
  const closeNewBranch = useCallback((): void => setNewBranchOpen(false), []);
  const clearSwitch = useCallback((): void => setPendingSwitch(null), []);
  return useMemo(
    () => ({
      newBranchOpen,
      pendingSwitch,
      openNewBranch,
      closeNewBranch,
      requestSwitch,
      clearSwitch,
    }),
    [clearSwitch, closeNewBranch, newBranchOpen, openNewBranch, pendingSwitch, requestSwitch],
  );
}

function BranchControl(props: {
  readonly root: string | null;
  readonly state: ReturnType<typeof useRepositoryBranchState>;
  readonly flow: GitActionFlowState;
  readonly dialogs: DialogState;
  readonly initialization: InitializationController;
  readonly t: I18nTranslate;
}): ReactNode {
  if (props.state.response?.reason === "not-a-repository") {
    return (
      <button
        type="button"
        className={styles.cmpSetupButton}
        disabled={props.initialization.busy}
        onClick={props.initialization.show}
      >
        <BranchIcon size={14} /> {props.t("repositoryBranchSwitcher.setUpGit")}
      </button>
    );
  }
  return (
    <BranchSelector
      branches={props.state.branches}
      currentBranch={props.state.currentBranch ?? ""}
      loading={props.state.loading}
      disabled={props.root === null || props.state.response?.available !== true}
      busy={props.flow.busy}
      onSwitchBranch={props.dialogs.requestSwitch}
      onCreateBranch={props.dialogs.openNewBranch}
    />
  );
}

function BranchDialogs(props: {
  readonly branchState: ReturnType<typeof useRepositoryBranchState>;
  readonly mutations: BranchMutationController;
  readonly dialogs: DialogState;
  readonly initialization: InitializationController;
  readonly t: I18nTranslate;
}): ReactNode {
  const { branchState, dialogs, initialization, mutations, t } = props;
  return (
    <>
      {dialogs.pendingSwitch === null ? null : (
        <WorktreeMutationConfirmDialog
          request={{ kind: "branch-switch", branchName: dialogs.pendingSwitch }}
          onCancel={dialogs.clearSwitch}
          onConfirm={() => {
            const branchName = dialogs.pendingSwitch;
            dialogs.clearSwitch();
            if (branchName !== null) mutations.switchTo(branchName);
          }}
        />
      )}
      {dialogs.newBranchOpen ? (
        <NewBranchDialog
          branches={branchState.branches}
          currentBranch={branchState.currentBranch ?? ""}
          busy={mutations.flow.busy}
          outcome={mutations.flow.outcome}
          error={mutations.flow.error}
          onCreate={mutations.create}
          onClose={dialogs.closeNewBranch}
        />
      ) : null}
      {initialization.open ? (
        <InitializeRepositoryDialog
          busy={initialization.busy}
          onCancel={initialization.close}
          onConfirm={initialization.run}
          t={t}
        />
      ) : null}
    </>
  );
}

export function RepositoryBranchSwitcher(): ReactNode {
  const root = useOptionalChatSessionCatalog()?.activeProject?.path ?? null;
  const workspace = useActiveWorkspace();
  const branchState = useRepositoryBranchState(root);
  const guard = useTaskBindingGuard(root, workspace);
  const mutations = useBranchMutations(root, branchState.branches, guard);
  const dialogs = useBranchDialogs(root, guard);
  const initialization = useRepositoryInitialization(root);
  const t = useTranslate();
  useEffect(() => {
    if (mutations.flow.outcome?.status === "succeeded") dialogs.closeNewBranch();
  }, [dialogs, mutations.flow.outcome?.status]);

  const feedback = guard.error ?? initialization.error ?? mutations.flow.error ?? branchState.error;
  return (
    <div className={styles.cmpRoot}>
      <BranchControl
        root={root}
        state={branchState}
        flow={mutations.flow}
        dialogs={dialogs}
        initialization={initialization}
        t={t}
      />
      {feedback === null ? null : (
        <p role="alert" className={styles.cmpFeedback}>
          {feedback}
        </p>
      )}
      <BranchDialogs
        branchState={branchState}
        mutations={mutations}
        dialogs={dialogs}
        initialization={initialization}
        t={t}
      />
    </div>
  );
}
