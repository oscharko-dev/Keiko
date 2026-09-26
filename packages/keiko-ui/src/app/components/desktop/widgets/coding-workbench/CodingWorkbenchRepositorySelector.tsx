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

function useGitRepositoryCatalog(): CatalogState {
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
  }, [reload]);
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

function controlWidth(label: string): string {
  return `${Math.min(Math.max(label.length + 10, 17), 36)}ch`;
}

type SelectorPlacement = "composer" | "setup";

interface RepositoryOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly badge?: string;
}

function projectAvailable(project: ProjectWithAvailability): boolean {
  return project.available && project.workspaceAvailable === true;
}

function repositoryOptions(
  catalog: CatalogState,
  root: string | null,
  t: CodingWorkbenchTranslate,
): readonly RepositoryOption[] {
  const registered = catalog.repositories.map((project) => ({
    value: project.path,
    label: project.name || repositoryName(project.path),
    disabled: !projectAvailable(project),
    ...(!projectAvailable(project) ? { badge: t("codingWorkbench.repository.unavailable") } : {}),
  }));
  if (root === null || registered.some((project) => project.value === root)) return registered;
  return [
    {
      value: root,
      label: repositoryName(root),
      disabled: true,
      badge: t("codingWorkbench.repository.unavailable"),
    },
    ...registered,
  ];
}

// The trigger of a chip: the setup form's field, or the composer's compact chip sized to its label.
function chipTrigger(
  placement: SelectorPlacement,
  label: string,
): {
  readonly triggerClassName: string | undefined;
  readonly triggerStyle: CSSProperties | undefined;
} {
  return placement === "setup"
    ? { triggerClassName: styles.cmpSetupSelectorTrigger, triggerStyle: undefined }
    : {
        triggerClassName: styles.cmpRepositorySelectorTrigger,
        triggerStyle: { width: controlWidth(label) },
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
      {...chipTrigger(placement, label)}
      showMenuHeader={false}
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
      {...chipTrigger(placement, label)}
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

function repositoryUnavailable(root: string | null, catalog: CatalogState): boolean {
  if (root === null || catalog.loading || catalog.error) return false;
  const selected = catalog.repositories.find((project) => project.path === root);
  return selected === undefined || !projectAvailable(selected);
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
    branchReadUnavailable(branchState)
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

// The help for a repository Git no longer lists, or for a folder whose Git status could not be read.
function selectorNoticeKey(
  unavailable: boolean,
  branchUnavailable: boolean,
): Parameters<CodingWorkbenchTranslate>[0] | undefined {
  if (unavailable) return "codingWorkbench.repository.unavailableHelp";
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
  catalogError,
  onRetryCatalog,
  t,
}: {
  readonly unavailable: boolean;
  readonly branchUnavailable: boolean;
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
  const key = selectorNoticeKey(unavailable, branchUnavailable);
  if (key === undefined) return null;
  return (
    <p className={styles.cmpRepositorySelectorNotice} role="alert">
      {t(key)}
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
  catalogError,
  onOpenGit,
  onRetryCatalog,
  t,
}: {
  readonly placement: SelectorPlacement;
  readonly root: string | null;
  readonly unavailable: boolean;
  readonly branchUnavailable: boolean;
  readonly catalogError: boolean;
  readonly onOpenGit: () => void;
  readonly onRetryCatalog: () => void;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const showGit =
    placement === "setup" && (root === null || unavailable || branchUnavailable || catalogError);
  return (
    <>
      {showGit ? (
        <button type="button" className={styles.cmpRepositorySelectorGit} onClick={onOpenGit}>
          {t("codingWorkbench.repository.manage")}
        </button>
      ) : null}
      <SelectorNotice
        unavailable={unavailable}
        branchUnavailable={branchUnavailable}
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
}

// Extracted so the exported component stays under the lint bar's max-lines-per-function: the
// catalog and branch reads, and the two derived "cannot proceed with Git" flags (#B, #D), belong
// together as one unit of state the component's JSX only renders.
function useRepositorySelectorState(root: string | null, locked: boolean): RepositorySelectorState {
  const catalog = useGitRepositoryCatalog();
  const unavailable = repositoryUnavailable(root, catalog);
  const branchLocked = locked || unavailable;
  const branchState = useRepositoryBranchState(branchLocked ? null : root);
  const branchUnavailable = repositoryBranchUnavailable(root, unavailable, catalog, branchState);
  return { catalog, unavailable, branchLocked, branchState, branchUnavailable };
}

interface CodingWorkbenchRepositorySelectorProps {
  readonly root: string | null;
  readonly branch: string | null;
  readonly locked: boolean;
  readonly onSelect: (root: string) => void;
  readonly onSelectBranch: (branch: string) => void;
  readonly onOpenGit: () => void;
  readonly placement?: SelectorPlacement;
}

export function CodingWorkbenchRepositorySelector({
  root,
  branch,
  locked,
  onSelect,
  onSelectBranch,
  onOpenGit,
  placement = "composer",
}: CodingWorkbenchRepositorySelectorProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const { catalog, unavailable, branchLocked, branchState, branchUnavailable } =
    useRepositorySelectorState(root, locked);
  return (
    <div className={placement === "setup" ? styles.cmpSetupSelector : styles.cmpRepositorySelector}>
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
      <SelectorField placement={placement} label={t("codingWorkbench.repository.branchLabel")}>
        <BranchChip
          root={root}
          branch={branch}
          locked={branchLocked}
          branchState={branchState}
          onSelect={onSelectBranch}
          t={t}
          placement={placement}
        />
      </SelectorField>
      <SelectorRecovery
        placement={placement}
        root={root}
        unavailable={unavailable}
        branchUnavailable={branchUnavailable}
        catalogError={catalog.error}
        onOpenGit={onOpenGit}
        onRetryCatalog={catalog.reload}
        t={t}
      />
    </div>
  );
}
