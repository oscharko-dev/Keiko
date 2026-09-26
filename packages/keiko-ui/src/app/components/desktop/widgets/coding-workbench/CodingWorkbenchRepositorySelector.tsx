"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ProjectWithAvailability } from "@/lib/types";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { Icons } from "../../Icons";
import KeikoSelect from "../../KeikoSelect";
import { useRepositoryBranchState } from "../../hooks/useRepositoryBranchState";
import { selectableRepositories } from "./codingWorkbenchRepositories";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import styles from "./CodingWorkbenchWindow.module.css";

interface CatalogState {
  readonly repositories: readonly ProjectWithAvailability[];
  readonly loading: boolean;
  readonly error: boolean;
  readonly reload: () => void;
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
      () => {
        if (request.current !== sequence) return;
        setError(true);
        setLoading(false);
        reportClientDiagnostic("[keiko] coding workbench repository catalog unavailable");
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

function repositoryName(root: string): string {
  const parts = root.replaceAll(/[/\\]+$/gu, "").split(/[/\\]/u);
  return parts.at(-1) ?? root;
}

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
      leadingVisual={<Icons.folder size={15} aria-hidden="true" />}
      triggerClassName={
        placement === "setup" ? styles.setupSelectorTrigger : styles.repositorySelectorTrigger
      }
      triggerStyle={placement === "setup" ? undefined : { width: controlWidth(label) }}
      showMenuHeader={false}
      menuPopoverMinWidth={280}
      menuPlacement="up"
      searchPlaceholder={t("codingWorkbench.repository.search")}
    />
  );
}

function BranchChip({
  root,
  branch,
  locked,
  onSelect,
  t,
  placement,
}: {
  readonly root: string | null;
  readonly branch: string | null;
  readonly locked: boolean;
  readonly onSelect: (branch: string) => void;
  readonly t: CodingWorkbenchTranslate;
  readonly placement: SelectorPlacement;
}): ReactNode {
  const state = useRepositoryBranchState(locked ? null : root);
  const current = branch ?? state.currentBranch ?? "";
  const options = [
    ...(current === "" ? [] : [{ value: current, label: current }]),
    ...state.branches
      .filter((entry) => entry.name !== current)
      .map((entry) => ({ value: entry.name, label: entry.name })),
  ];
  const label = current || t("codingWorkbench.repository.noBranch");
  return (
    <KeikoSelect
      value={current}
      sections={[{ options }]}
      onValueChange={onSelect}
      disabled={
        locked || root === null || state.loading || state.error !== null || options.length === 0
      }
      placeholder={label}
      ariaLabel={t("codingWorkbench.repository.chooseBranch")}
      leadingVisual={<Icons.branch size={15} aria-hidden="true" />}
      triggerClassName={
        placement === "setup" ? styles.setupSelectorTrigger : styles.repositorySelectorTrigger
      }
      triggerStyle={placement === "setup" ? undefined : { width: controlWidth(label) }}
      showMenuHeader={false}
      menuPopoverMinWidth={340}
      menuPopoverMaxHeight={280}
      menuPlacement="up"
      searchPlaceholder={t("codingWorkbench.repository.searchBranch")}
      mono
    />
  );
}

export function CodingWorkbenchRepositorySelector({
  root,
  branch,
  locked,
  onSelect,
  onSelectBranch,
  onOpenGit,
  placement = "composer",
}: {
  readonly root: string | null;
  readonly branch: string | null;
  readonly locked: boolean;
  readonly onSelect: (root: string) => void;
  readonly onSelectBranch: (branch: string) => void;
  readonly onOpenGit: () => void;
  readonly placement?: SelectorPlacement;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const catalog = useGitRepositoryCatalog();
  const selected = catalog.repositories.find((project) => project.path === root);
  const unavailable =
    root !== null &&
    !catalog.loading &&
    !catalog.error &&
    (selected === undefined || !projectAvailable(selected));
  return (
    <div className={placement === "setup" ? styles.setupSelector : styles.repositorySelector}>
      <div
        className={placement === "setup" ? styles.setupSelectorField : styles.repositorySelectorChip}
      >
        {placement === "setup" ? <span>{t("codingWorkbench.repository.label")}</span> : null}
        <RepositoryChip
          root={root}
          locked={locked}
          catalog={catalog}
          onSelect={onSelect}
          t={t}
          placement={placement}
        />
      </div>
      <div
        className={placement === "setup" ? styles.setupSelectorField : styles.repositorySelectorChip}
      >
        {placement === "setup" ? <span>{t("codingWorkbench.repository.branchLabel")}</span> : null}
        <BranchChip
          root={root}
          branch={branch}
          locked={locked || unavailable}
          onSelect={onSelectBranch}
          t={t}
          placement={placement}
        />
      </div>
      {placement === "setup" && (root === null || unavailable || catalog.error) ? (
        <button type="button" className={styles.repositorySelectorGit} onClick={onOpenGit}>
          {t("codingWorkbench.repository.manage")}
        </button>
      ) : null}
      {catalog.error || unavailable ? (
        <p className={styles.repositorySelectorNotice} role="alert">
          {t(
            catalog.error
              ? "codingWorkbench.repository.loadError"
              : "codingWorkbench.repository.unavailableHelp",
          )}
        </p>
      ) : null}
    </div>
  );
}
