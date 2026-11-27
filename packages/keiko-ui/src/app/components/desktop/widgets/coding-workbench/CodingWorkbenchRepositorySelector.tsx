"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { ProjectWithAvailability } from "@/lib/types";
import { reconnectProject } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { correlationIdOf } from "@/lib/client-error-summary";
import { bffRequestErrorKind } from "@/lib/http";
import { Icons } from "../../Icons";
import KeikoSelect from "../../KeikoSelect";
import {
  useRepositoryBranchState,
  type RepositoryBranchState,
} from "../../hooks/useRepositoryBranchState";
import { selectableRepositories } from "./codingWorkbenchRepositories";
import { locallyAvailable, needsReconnect } from "./codingWorkbenchRepositoryAvailability";
import { useRepositoryReconnect } from "./useRepositoryReconnect";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import { RetryMessage } from "./CodingWorkbenchChanges";
import styles from "./CodingWorkbenchWindow.module.css";

interface CatalogState {
  readonly repositories: readonly ProjectWithAvailability[];
  readonly loading: boolean;
  readonly error: boolean;
  readonly reload: () => void;
}

// #C review: body-free, but closed — the class of failure, the originating request's correlation
// id (when the caught error carries one) and bounded frame evidence, never raw content.
function reportCatalogFailure(error: unknown): void {
  const correlationId = correlationIdOf(error);
  reportClientDiagnostic("[keiko] coding workbench repository catalog unavailable", {
    kind: "other",
    errorKind: bffRequestErrorKind(error),
    errorEvidence: clientErrorEvidence(error),
    ...(correlationId === undefined ? {} : { correlationId }),
  });
}

// `refreshKey` reloads the catalog when the Workbench learns a folder's workspace came back (#4491),
// so a recovered repository no longer reads as unavailable until the window is reopened.
function useGitRepositoryCatalog(refreshKey: string | undefined): CatalogState {
  const [repositories, setRepositories] = useState<readonly ProjectWithAvailability[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const request = useRef(0);
  const reload = useCallback((): void => {
    const sequence = ++request.current;
    setLoading(true);
    void selectableRepositories().then(
      (projects) => {
        if (request.current !== sequence) return;
        setRepositories(projects);
        setError(false);
        setLoading(false);
      },
      (error: unknown) => {
        if (request.current !== sequence) return;
        setError(true);
        setLoading(false);
        reportCatalogFailure(error);
      },
    );
  }, []);
  useEffect(() => {
    reload();
    return (): void => {
      request.current += 1;
    };
  }, [reload, refreshKey]);
  return { repositories, loading, error, reload };
}

// The folder name of a POSIX or a Windows path, ignoring trailing separators (#3630): the last
// non-empty segment, found by a plain scan rather than a backtracking trailing-separator pattern.
export function repositoryName(root: string): string {
  const parts = root.split(/[\\/]/u);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part !== undefined && part.length > 0) return part;
  }
  return root;
}

const FolderIcon = Icons.folder;
const BranchIcon = Icons.branch;

type SelectorPlacement = "composer" | "setup";
export type WorkbenchExecutionLocation = "local" | "worktree";

interface RepositoryOption {
  readonly value: string;
  readonly label: string;
  /** The full path under the name, like the Git window's picker: two folders can share a name. */
  readonly description?: string;
  readonly disabled?: boolean;
  readonly badge?: string;
}

// U-16: a folder that exists but changed since it was added stays enabled — choosing it reconnects
// it. A folder that is gone, or that the read surface refuses, is disabled with its plain badge.
function registeredOption(
  project: ProjectWithAvailability,
  t: CodingWorkbenchTranslate,
): RepositoryOption {
  const base = {
    value: project.path,
    label: project.name || repositoryName(project.path),
    description: project.path,
  };
  if (locallyAvailable(project)) return base;
  if (needsReconnect(project)) {
    return { ...base, description: t("codingWorkbench.repository.changedReason") };
  }
  return { ...base, disabled: true, badge: t("codingWorkbench.repository.unavailable") };
}

function repositoryOptions(
  catalog: CatalogState,
  root: string | null,
  t: CodingWorkbenchTranslate,
): readonly RepositoryOption[] {
  const registered = catalog.repositories.map((project) => registeredOption(project, t));
  if (root === null || registered.some((project) => project.value === root)) return registered;
  return [
    {
      value: root,
      label: repositoryName(root),
      description: root,
      disabled: true,
      badge: t("codingWorkbench.repository.unavailable"),
    },
    ...registered,
  ];
}

// The trigger of a chip: the setup form's field, or the composer's compact chip that hugs its
// label up to a bound. A fixed 13ch floor left "keiko" and "main" floating in wide empty chips
// with the caret at the far edge (#3897 UI review).
function chipTrigger(
  placement: SelectorPlacement,
  maximum: number,
): {
  readonly triggerClassName: string | undefined;
  readonly triggerStyle: CSSProperties | undefined;
} {
  return placement === "setup"
    ? { triggerClassName: styles.cmpSetupSelectorTrigger, triggerStyle: undefined }
    : {
        triggerClassName: styles.cmpRepositorySelectorTrigger,
        triggerStyle: { maxWidth: `${String(maximum)}ch` },
      };
}

function RepositoryChip({
  root,
  locked,
  catalog,
  onSelect,
  t,
  placement,
}: {
  readonly root: string | null;
  readonly locked: boolean;
  readonly catalog: CatalogState;
  readonly onSelect: (root: string) => void;
  readonly t: CodingWorkbenchTranslate;
  readonly placement: SelectorPlacement;
}): ReactNode {
  const options = repositoryOptions(catalog, root, t);
  const selected = options.find((option) => option.value === root);
  const label =
    selected?.label ??
    t(catalog.loading ? "codingWorkbench.repository.loading" : "codingWorkbench.repository.none");
  return (
    <KeikoSelect
      value={root ?? ""}
      sections={[{ options }]}
      onValueChange={onSelect}
      onOpen={catalog.reload}
      disabled={locked || (catalog.loading && options.length === 0) || catalog.error}
      placeholder={label}
      ariaLabel={t("codingWorkbench.repository.choose")}
      leadingVisual={<FolderIcon size={15} aria-hidden="true" />}
      {...chipTrigger(placement, 22)}
      showMenuHeader={false}
      showTriggerDescription={false}
      menuPopoverMinWidth={280}
      menuPlacement="up"
      searchPlaceholder={t("codingWorkbench.repository.search")}
      searchEmptyLabel={t("codingWorkbench.repository.noMatches")}
    />
  );
}

// The current branch first, then every other local branch. #I review: a stored branch that is
// not (or no longer) in the loaded list is marked the same way an unregistered root is — disabled,
// with the "unavailable" badge — rather than shown as an ordinary selectable option. `loaded` gates
// this: while the list is still loading or unreadable, an absent match says nothing yet.
export function branchOptions(
  current: string,
  branches: readonly { readonly name: string }[],
  loaded: boolean,
  unavailableBadge: string,
): readonly RepositoryOption[] {
  const rest = branches
    .filter((entry) => entry.name !== current)
    .map((entry) => ({ value: entry.name, label: entry.name }));
  if (current === "") return rest;
  const missing = loaded && !branches.some((entry) => entry.name === current);
  return [
    {
      value: current,
      label: current,
      ...(missing ? { disabled: true, badge: unavailableBadge } : {}),
    },
    ...rest,
  ];
}

// The branch read failed, or answered that Git cannot serve this root: a rejected read sets `error`,
// while an ordinary folder answers HTTP 200 with `available: false` (PR #3625 review).
function branchReadUnavailable(branchState: RepositoryBranchState): boolean {
  return branchState.error !== null || branchState.response?.available === false;
}

function BranchChip({
  root,
  branch,
  locked,
  branchState,
  onSelect,
  t,
  placement,
}: {
  readonly root: string | null;
  readonly branch: string | null;
  readonly locked: boolean;
  readonly branchState: RepositoryBranchState;
  readonly onSelect: (branch: string) => void;
  readonly t: CodingWorkbenchTranslate;
  readonly placement: SelectorPlacement;
}): ReactNode {
  const current = branch ?? branchState.currentBranch ?? "";
  const unreadable = branchState.loading || branchReadUnavailable(branchState);
  const loaded = !unreadable;
  const options = branchOptions(
    current,
    branchState.branches,
    loaded,
    t("codingWorkbench.repository.unavailable"),
  );
  const label = current || t("codingWorkbench.repository.noBranch");
  return (
    <KeikoSelect
      value={current}
      sections={[{ options }]}
      onValueChange={onSelect}
      disabled={locked || root === null || unreadable || options.length === 0}
      placeholder={label}
      ariaLabel={t("codingWorkbench.repository.chooseBranch")}
      leadingVisual={<BranchIcon size={15} aria-hidden="true" />}
      {...chipTrigger(placement, 26)}
      showMenuHeader={false}
      menuPopoverMinWidth={340}
      menuPopoverMaxHeight={280}
      menuPlacement="up"
      searchPlaceholder={t("codingWorkbench.repository.searchBranch")}
      searchEmptyLabel={t("codingWorkbench.repository.noBranchMatches")}
      mono
    />
  );
}

const LOCATION_LABEL_KEYS = {
  local: "codingWorkbench.repository.locationLocal",
  worktree: "codingWorkbench.repository.locationWorktree",
} as const satisfies Record<WorkbenchExecutionLocation, Parameters<CodingWorkbenchTranslate>[0]>;

const ALL_LOCATIONS: readonly WorkbenchExecutionLocation[] = ["local", "worktree"];

// #4068: only the locations the runtime can confine are offered; absent, both are.
function LocationChip({
  location,
  offered = ALL_LOCATIONS,
  locked,
  onSelect,
  t,
  placement,
}: {
  readonly location: WorkbenchExecutionLocation;
  readonly offered?: readonly WorkbenchExecutionLocation[] | undefined;
  readonly locked: boolean;
  readonly onSelect: (location: WorkbenchExecutionLocation) => void;
  readonly t: CodingWorkbenchTranslate;
  readonly placement: SelectorPlacement;
}): ReactNode {
  const LocationIcon = Icons.terminal;
  const options = ALL_LOCATIONS.filter(
    (candidate) => candidate === location || offered.includes(candidate),
  ).map((value) => ({ value, label: t(LOCATION_LABEL_KEYS[value]) }));
  return (
    <KeikoSelect
      value={location}
      sections={[{ options }]}
      onValueChange={(value): void => onSelect(value === "worktree" ? "worktree" : "local")}
      disabled={locked || options.length < 2}
      ariaLabel={t("codingWorkbench.repository.locationLabel")}
      leadingVisual={<LocationIcon size={15} aria-hidden="true" />}
      {...chipTrigger(placement, 22)}
      menuPopoverMinWidth={260}
      showMenuHeader={false}
      menuPlacement="up"
    />
  );
}

// A registered folder that still exists but whose workspace connection no longer matches the
// directory behind it (a repository deleted and cloned again at the same path): the person can
// reconnect it in one step, so the notice offers that instead of only naming the problem.
function repositoryReconnectable(root: string | null, catalog: CatalogState): boolean {
  if (root === null || catalog.loading || catalog.error) return false;
  const selected = catalog.repositories.find((project) => project.path === root);
  return selected !== undefined && selected.available && selected.workspaceAvailable === false;
}

function repositoryUnavailable(root: string | null, catalog: CatalogState): boolean {
  if (root === null || catalog.loading || catalog.error) return false;
  const selected = catalog.repositories.find((project) => project.path === root);
  return selected === undefined || !locallyAvailable(selected);
}

// #B review: a registered, workspace-available root that is not (or no longer) a Git repository —
// `repositoryUnavailable` above says nothing about this, since it only checks catalog membership.
// The branch read IS the signal: a rejected read, or a resolved one that says Git cannot serve this
// root (`branchReadUnavailable`). Gated the same way the branch chip locks itself (never while already flagged
// unavailable, or while either read is still settling), so the two notices stay mutually exclusive.
function repositoryBranchUnavailable(
  root: string | null,
  unavailable: boolean,
  catalog: CatalogState,
  branchState: RepositoryBranchState,
): boolean {
  return (
    root !== null &&
    !unavailable &&
    !catalog.loading &&
    !catalog.error &&
    !branchState.loading &&
    !branchState.ordinaryFolder &&
    branchReadUnavailable(branchState)
  );
}

// A registered folder the branch read answered as an ordinary folder (not a Git repository). It is
// no failure: the Workbench works in it without a branch (owner decision 2026-10-30), so it gets a
// non-blocking hint, no "Open Git" escape and no alert.
function repositoryFolderMode(
  root: string | null,
  unavailable: boolean,
  catalog: CatalogState,
  branchState: RepositoryBranchState,
): boolean {
  return (
    root !== null &&
    !unavailable &&
    !catalog.loading &&
    !catalog.error &&
    branchState.ordinaryFolder
  );
}

function SelectorField({
  placement,
  label,
  children,
}: {
  readonly placement: SelectorPlacement;
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      className={
        placement === "setup" ? styles.cmpSetupSelectorField : styles.cmpRepositorySelectorChip
      }
    >
      {placement === "setup" ? <span>{label}</span> : null}
      {children}
    </div>
  );
}

// The help for a repository Git no longer lists, for a folder the server's read surface excludes
// (#3873 F1: a policy decision the Git window names as `DENIED`, never a missing Git repository), or
// for a folder whose Git status could not be read.
function selectorNoticeKey(
  unavailable: boolean,
  branchUnavailable: boolean,
  branchDenied: boolean,
): Parameters<CodingWorkbenchTranslate>[0] | undefined {
  if (unavailable) return "codingWorkbench.repository.unavailableHelp";
  if (branchDenied) return "codingWorkbench.repository.deniedHelp";
  if (branchUnavailable) return "codingWorkbench.repository.gitUnavailableHelp";
  return undefined;
}

// #D review: a catalog-error notice with no way back — the repository KeikoSelect disables itself
// on `catalog.error`, so its own `onOpen={catalog.reload}` can never fire, and the composer
// placement never rendered the setup form's "Open Git" escape at all. Reuses the one retry
// affordance the Workbench already has (`RetryMessage`, CodingWorkbenchChanges.tsx) instead of a
// second copy of "message plus button".
function SelectorNotice({
  unavailable,
  branchUnavailable,
  branchDenied,
  folderMode,
  folderUnsupported,
  catalogError,
  onRetryCatalog,
  t,
}: {
  readonly unavailable: boolean;
  readonly branchUnavailable: boolean;
  readonly branchDenied: boolean;
  readonly folderMode: boolean;
  // #4068: the runtime confines no work in place, so this ordinary folder cannot run here.
  readonly folderUnsupported: boolean;
  readonly catalogError: boolean;
  readonly onRetryCatalog: () => void;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (catalogError) {
    return (
      <RetryMessage
        text={t("codingWorkbench.repository.loadError")}
        className={styles.cmpRepositorySelectorNotice}
        role="alert"
        retry={{ label: t("codingWorkbench.repository.retryLoad"), onRetry: onRetryCatalog }}
      />
    );
  }
  if (folderMode) return <FolderNotice unsupported={folderUnsupported} t={t} />;
  const key = selectorNoticeKey(unavailable, branchUnavailable, branchDenied);
  if (key === undefined) return null;
  return (
    <p className={styles.cmpRepositorySelectorNotice} role="alert">
      {t(key)}
    </p>
  );
}

// An ordinary folder works in place; #4068: where the runtime confines no work in place, it says
// that the folder cannot run here instead.
function FolderNotice({
  unsupported,
  t,
}: {
  readonly unsupported: boolean;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return unsupported ? (
    <p
      className={styles.cmpRepositorySelectorNotice}
      role="alert"
      data-testid="coding-workbench-folder-unsupported"
    >
      {t("codingWorkbench.repository.folderModeUnsupported")}
    </p>
  ) : (
    <p className={styles.cmpRepositorySelectorNotice} data-testid="coding-workbench-folder-hint">
      {t("codingWorkbench.repository.folderModeHint")}
    </p>
  );
}

// No project yet (nothing was chosen, and nothing refused is offered as a default): one plain
// sentence and one button that leads to choosing a folder (#4371).
function GitEscape({
  noProject,
  onOpenGit,
  t,
}: {
  readonly noProject: boolean;
  readonly onOpenGit: () => void;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <button type="button" className={styles.cmpRepositorySelectorGit} onClick={onOpenGit}>
      {t(
        noProject ? "codingWorkbench.repository.chooseFolder" : "codingWorkbench.repository.manage",
      )}
    </button>
  );
}

function NoProjectNotice({ t }: { readonly t: CodingWorkbenchTranslate }): ReactNode {
  return (
    <p className={styles.cmpRepositorySelectorNotice} data-testid="coding-workbench-no-project">
      {t("codingWorkbench.repository.noProject")}
    </p>
  );
}

// The way back when the catalog failed, the repository left Git, or a registered folder never
// was a Git repository (#B review): open Git from the setup form, and say what happened.
function SelectorRecovery({
  placement,
  root,
  unavailable,
  branchUnavailable,
  branchDenied,
  folderMode,
  folderUnsupported,
  catalogError,
  onOpenGit,
  onRetryCatalog,
  t,
}: {
  readonly placement: SelectorPlacement;
  readonly root: string | null;
  readonly unavailable: boolean;
  readonly branchUnavailable: boolean;
  readonly branchDenied: boolean;
  readonly folderMode: boolean;
  readonly folderUnsupported: boolean;
  readonly catalogError: boolean;
  readonly onOpenGit: () => void;
  readonly onRetryCatalog: () => void;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const noProject = placement === "setup" && root === null && !catalogError;
  const showGit =
    placement === "setup" && (root === null || unavailable || branchUnavailable || catalogError);
  return (
    <>
      {showGit ? <GitEscape noProject={noProject} onOpenGit={onOpenGit} t={t} /> : null}
      {noProject ? <NoProjectNotice t={t} /> : null}
      <SelectorNotice
        unavailable={unavailable}
        branchUnavailable={branchUnavailable}
        branchDenied={branchDenied}
        folderMode={folderMode}
        folderUnsupported={folderUnsupported}
        catalogError={catalogError}
        onRetryCatalog={onRetryCatalog}
        t={t}
      />
    </>
  );
}

interface RepositorySelectorState {
  readonly catalog: CatalogState;
  readonly unavailable: boolean;
  readonly branchLocked: boolean;
  readonly branchState: RepositoryBranchState;
  readonly branchUnavailable: boolean;
  // #3873 F1: the branch read was refused as an access decision, not answered by Git.
  readonly branchDenied: boolean;
  // The root is an ordinary folder: no branch, no Git features, but fully usable.
  readonly folderMode: boolean;
  // #4068: ...unless the runtime confines no work in place.
  readonly folderUnsupported: boolean;
  readonly reconnectable: boolean;
  // U-16: choosing a changed folder reconnects it first; the failure stays visible.
  readonly choose: (root: string) => void;
  readonly reconnectFailed: boolean;
}

// Extracted so the exported component stays under the lint bar's max-lines-per-function: the
// catalog and branch reads, and the derived "cannot proceed with Git" flags (#B, #D, #3873 F1),
// belong together as one unit of state the component's JSX only renders.
function useRepositorySelectorState(
  root: string | null,
  locked: boolean,
  {
    offeredLocations: offered,
    catalogRefreshKey,
  }: Pick<CodingWorkbenchRepositorySelectorProps, "offeredLocations" | "catalogRefreshKey">,
  onSelect: (root: string) => void,
): RepositorySelectorState {
  const catalog = useGitRepositoryCatalog(catalogRefreshKey);
  const reconnect = useRepositoryReconnect(catalog.repositories, catalog.reload, onSelect);
  const unavailable = repositoryUnavailable(root, catalog);
  const branchLocked = locked || unavailable;
  const branchState = useRepositoryBranchState(branchLocked ? null : root);
  const branchUnavailable = repositoryBranchUnavailable(root, unavailable, catalog, branchState);
  const branchDenied = branchUnavailable && branchState.denied;
  const folderMode = repositoryFolderMode(root, unavailable, catalog, branchState);
  const folderUnsupported = folderMode && offered !== undefined && !offered.includes("local");
  return {
    catalog,
    unavailable,
    branchLocked,
    branchState,
    branchUnavailable,
    branchDenied,
    folderMode,
    folderUnsupported,
    reconnectable: repositoryReconnectable(root, catalog),
    choose: reconnect.choose,
    reconnectFailed: reconnect.failed,
  };
}

interface CodingWorkbenchRepositorySelectorProps {
  readonly root: string | null;
  readonly branch: string | null;
  readonly locked: boolean;
  readonly onSelect: (root: string) => void;
  readonly onSelectBranch: (branch: string) => void;
  readonly location: WorkbenchExecutionLocation;
  /** The locations the runtime can confine (#4068); absent, both are offered. */
  readonly offeredLocations?: readonly WorkbenchExecutionLocation[] | undefined;
  readonly onSelectLocation: (location: WorkbenchExecutionLocation) => void;
  readonly onOpenGit: () => void;
  readonly placement?: SelectorPlacement;
  /** A change reloads the repository catalog (the folder's workspace availability moved). */
  readonly catalogRefreshKey?: string | undefined;
  /** The person reconnected the selected repository: the window binds it again. */
  readonly onReconnected?: (() => void) | undefined;
}

function LocationSelectorField({
  location,
  offered,
  locked,
  onSelect,
  placement,
  t,
}: {
  readonly location: WorkbenchExecutionLocation;
  readonly offered: readonly WorkbenchExecutionLocation[] | undefined;
  readonly locked: boolean;
  readonly onSelect: (location: WorkbenchExecutionLocation) => void;
  readonly placement: SelectorPlacement;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <SelectorField placement={placement} label={t("codingWorkbench.repository.locationLabel")}>
      <LocationChip
        location={location}
        offered={offered}
        locked={locked}
        onSelect={onSelect}
        t={t}
        placement={placement}
      />
    </SelectorField>
  );
}

function BranchSelectorField({
  root,
  branch,
  locked,
  state,
  onSelect,
  placement,
  t,
}: {
  readonly root: string | null;
  readonly branch: string | null;
  readonly locked: boolean;
  readonly state: RepositoryBranchState;
  readonly onSelect: (branch: string) => void;
  readonly placement: SelectorPlacement;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <SelectorField placement={placement} label={t("codingWorkbench.repository.branchLabel")}>
      <BranchChip
        root={root}
        branch={branch}
        locked={locked}
        branchState={state}
        onSelect={onSelect}
        t={t}
        placement={placement}
      />
    </SelectorField>
  );
}

function reportReconnectFailure(error: unknown): void {
  const correlationId = correlationIdOf(error);
  reportClientDiagnostic("[keiko] coding workbench repository reconnect failed", {
    kind: "other",
    errorKind: bffRequestErrorKind(error),
    errorEvidence: clientErrorEvidence(error),
    ...(correlationId === undefined ? {} : { correlationId }),
  });
}

// One click re-connects the registered folder through the same route the Git window uses; the
// connection is proven afresh by the server, never assumed. A refusal says so in plain words.
function ReconnectAction({
  root,
  reload,
  onReconnected,
  t,
}: {
  readonly root: string;
  readonly reload: () => void;
  readonly onReconnected: (() => void) | undefined;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const reconnect = (): void => {
    setBusy(true);
    setFailed(false);
    void reconnectProject(root)
      .then(() => {
        reload();
        onReconnected?.();
      })
      .catch((error: unknown) => {
        setFailed(true);
        reportReconnectFailure(error);
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <>
      <button
        type="button"
        className={styles.cmpRepositorySelectorGit}
        disabled={busy}
        onClick={reconnect}
        data-testid="coding-workbench-reconnect"
      >
        {t("codingWorkbench.repository.reconnect")}
      </button>
      {failed ? (
        <p className={styles.cmpRepositorySelectorNotice} role="alert">
          {t("codingWorkbench.repository.reconnectFailed")}
        </p>
      ) : null}
    </>
  );
}

function SelectorRecoveryForState({
  root,
  state,
  placement,
  onOpenGit,
  onReconnected,
  t,
}: {
  readonly root: string | null;
  readonly state: RepositorySelectorState;
  readonly placement: SelectorPlacement;
  readonly onOpenGit: () => void;
  readonly onReconnected: (() => void) | undefined;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <>
      <SelectorRecoveryNotice
        root={root}
        state={state}
        placement={placement}
        onOpenGit={onOpenGit}
        t={t}
      />
      {root !== null && state.reconnectable ? (
        <ReconnectAction
          root={root}
          reload={state.catalog.reload}
          onReconnected={onReconnected}
          t={t}
        />
      ) : null}
    </>
  );
}

function SelectorRecoveryNotice({
  root,
  state,
  placement,
  onOpenGit,
  t,
}: {
  readonly root: string | null;
  readonly state: RepositorySelectorState;
  readonly placement: SelectorPlacement;
  readonly onOpenGit: () => void;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <SelectorRecovery
      placement={placement}
      root={root}
      unavailable={state.unavailable}
      branchUnavailable={state.branchUnavailable}
      branchDenied={state.branchDenied}
      folderMode={state.folderMode}
      folderUnsupported={state.folderUnsupported}
      catalogError={state.catalog.error}
      onOpenGit={onOpenGit}
      onRetryCatalog={state.catalog.reload}
      t={t}
    />
  );
}

function RepositorySelectorField({
  root,
  locked,
  catalog,
  onSelect,
  placement,
  t,
}: {
  readonly root: string | null;
  readonly locked: boolean;
  readonly catalog: CatalogState;
  readonly onSelect: (root: string) => void;
  readonly placement: SelectorPlacement;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <SelectorField placement={placement} label={t("codingWorkbench.repository.label")}>
      <RepositoryChip
        root={root}
        locked={locked}
        catalog={catalog}
        onSelect={onSelect}
        t={t}
        placement={placement}
      />
    </SelectorField>
  );
}

function ReconnectNotice({
  failed,
  t,
}: {
  readonly failed: boolean;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return failed ? (
    <p className={styles.cmpRepositorySelectorNotice} role="alert">
      {t("codingWorkbench.repository.reconnectChoiceFailed")}
    </p>
  ) : null;
}

export function CodingWorkbenchRepositorySelector({
  root,
  branch,
  locked,
  onSelect,
  onSelectBranch,
  onOpenGit,
  placement = "composer",
  ...work
}: CodingWorkbenchRepositorySelectorProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const state = useRepositorySelectorState(root, locked, work, onSelect);
  return (
    <div className={placement === "setup" ? styles.cmpSetupSelector : styles.cmpRepositorySelector}>
      <RepositorySelectorField
        root={root}
        locked={locked}
        catalog={state.catalog}
        onSelect={state.choose}
        t={t}
        placement={placement}
      />
      <LocationSelectorField
        location={state.folderMode ? "local" : work.location}
        offered={work.offeredLocations}
        locked={locked || root === null || state.folderMode}
        onSelect={work.onSelectLocation}
        t={t}
        placement={placement}
      />
      <BranchSelectorField
        root={root}
        branch={branch}
        locked={state.branchLocked}
        state={state.branchState}
        onSelect={onSelectBranch}
        t={t}
        placement={placement}
      />
      <SelectorRecoveryForState
        placement={placement}
        root={root}
        state={state}
        onOpenGit={onOpenGit}
        onReconnected={work.onReconnected}
        t={t}
      />
      <ReconnectNotice failed={state.reconnectFailed} t={t} />
    </div>
  );
}
