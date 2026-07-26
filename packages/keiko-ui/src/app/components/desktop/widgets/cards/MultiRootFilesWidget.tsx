"use client";

import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import type {
  WorkspaceManifest,
  WorkspaceRootDescriptor,
  WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import { fetchProjects } from "../../../../../lib/api";
import { useTranslate } from "@/lib/i18n";
import type { WorkspaceManifestView } from "../../hooks/useWorkspaceManifest";
import { Icons } from "../../Icons";

import { WorkspaceTrustBadge } from "../../workspace-trust/WorkspaceTrustSurfaces";
import { useWorkspaceTrust } from "../../workspace-trust/useWorkspaceTrust";
import { FilesWidget } from "./FilesWidget";
import styles from "./MultiRootFilesWidget.module.css";

const ChevronRightIcon = Icons.chevronR;
const CloseIcon = Icons.close;
const ROOT_GROUP_NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

interface MultiRootFilesWidgetProps {
  readonly manifest: WorkspaceManifest;
  readonly workspace: WorkspaceManifestView;
  readonly onActiveFileChange: (
    path: string | null,
    root: string | null,
    activeDirectoryPath?: string | null,
  ) => void;
  readonly onOpenFile: (root: string, path: string) => void;
  readonly onOpenGitDelivery: (root: string) => void;
}

interface AddableProject {
  readonly name: string;
  readonly path: string;
}

function rootOrderAfterMove(
  roots: readonly WorkspaceRootDescriptor[],
  index: number,
  offset: -1 | 1,
): readonly WorkspaceRootRef[] {
  const next = roots.map((root) => root.rootRef);
  const target = index + offset;
  if (target < 0 || target >= next.length) return next;
  const [moved] = next.splice(index, 1);
  if (moved !== undefined) next.splice(target, 0, moved);
  return next;
}

function focusSiblingRootGroup(event: KeyboardEvent<HTMLElement>): void {
  if (!ROOT_GROUP_NAV_KEYS.has(event.key)) return;
  const currentGroup = event.currentTarget.closest<HTMLDivElement>("[data-root-group]");
  if (currentGroup === null) return;
  const explorer = currentGroup.closest<HTMLElement>("[data-multi-root-explorer]");
  const groups = Array.from(explorer?.querySelectorAll<HTMLDivElement>("[data-root-group]") ?? []);
  const current = groups.indexOf(currentGroup);
  if (current < 0 || groups.length === 0) return;
  event.preventDefault();
  let target = Math.max(
    0,
    Math.min(groups.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)),
  );
  if (event.key === "Home") target = 0;
  else if (event.key === "End") target = groups.length - 1;
  groups[target]?.focus();
}

function RootGroup({
  root,
  index,
  manifest,
  workspace,
  onActiveFileChange,
  onOpenFile,
  onOpenGitDelivery,
  rovingTabIndex,
  onRovingFocus,
}: MultiRootFilesWidgetProps & {
  readonly root: WorkspaceRootDescriptor;
  readonly index: number;
  readonly rovingTabIndex: 0 | -1;
  readonly onRovingFocus: (rootRef: WorkspaceRootRef) => void;
}): ReactNode {
  const t = useTranslate();
  const trust = useWorkspaceTrust(root.canonicalRoot);
  const [expanded, setExpanded] = useState(true);
  const focused = manifest.focusedRootRef === root.rootRef;
  const move = (offset: -1 | 1): void => {
    void workspace.reorderRoots(root.rootRef, rootOrderAfterMove(manifest.roots, index, offset));
  };
  const handleRootGroupKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "ArrowLeft" && expanded) {
      event.preventDefault();
      setExpanded(false);
      return;
    }
    if (event.key === "ArrowRight" && !expanded) {
      event.preventDefault();
      setExpanded(true);
      return;
    }
    focusSiblingRootGroup(event);
  };
  return (
    <div
      className={styles.cmpRootGroup}
      role="treeitem"
      aria-expanded={expanded}
      aria-selected={focused}
      aria-label={root.displayName}
      data-root-group
      tabIndex={rovingTabIndex}
      onFocus={(): void => onRovingFocus(root.rootRef)}
      onKeyDown={(event): void => {
        if (event.target === event.currentTarget) handleRootGroupKeyDown(event);
      }}
    >
      <div className={styles.cmpRootHeader} data-focused={focused}>
        <button
          type="button"
          className={styles.cmpRootToggle}
          data-root-group-header
          aria-expanded={expanded}
          onKeyDown={handleRootGroupKeyDown}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className={styles.cmpCaret} data-expanded={expanded} aria-hidden="true">
            <ChevronRightIcon size={12} />
          </span>
          <span className={styles.cmpRootName}>
            {root.displayName}
            <span className={styles.cmpRootPath}>{root.canonicalRoot}</span>
          </span>
        </button>
        <WorkspaceTrustBadge status={trust.status} />
        <button
          type="button"
          className={styles.cmpAction}
          disabled={focused || workspace.mutating}
          aria-label={t("filesWidget.multiRoot.focus", { name: root.displayName })}
          onClick={() => void workspace.focusRoot(root.rootRef)}
        >
          {focused ? t("filesWidget.multiRoot.focused") : t("filesWidget.multiRoot.focusAction")}
        </button>
        <button
          type="button"
          className={styles.cmpAction}
          disabled={index === 0 || workspace.mutating}
          aria-label={t("filesWidget.multiRoot.moveUp", { name: root.displayName })}
          onClick={() => move(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          className={styles.cmpAction}
          disabled={index === manifest.roots.length - 1 || workspace.mutating}
          aria-label={t("filesWidget.multiRoot.moveDown", { name: root.displayName })}
          onClick={() => move(1)}
        >
          ↓
        </button>
        <button
          type="button"
          className={styles.cmpAction}
          disabled={manifest.roots.length === 1 || workspace.mutating}
          aria-label={t("filesWidget.multiRoot.remove", { name: root.displayName })}
          onClick={() => void workspace.removeRoot(root.rootRef, root.rootRef)}
        >
          <CloseIcon size={12} />
        </button>
      </div>
      {expanded ? (
        <div className={styles.cmpRootTree} role="group">
          <FilesWidget
            root={root.canonicalRoot}
            watchActive={focused}
            onActiveFileChange={onActiveFileChange}
            onOpenFile={(fileRoot, path) => {
              void workspace.focusRoot(root.rootRef);
              onOpenFile(fileRoot, path);
            }}
            onOpenGitDelivery={onOpenGitDelivery}
          />
        </div>
      ) : null}
    </div>
  );
}

function AddRootToolbar({
  manifest,
  workspace,
}: Pick<MultiRootFilesWidgetProps, "manifest" | "workspace">): ReactNode {
  const t = useTranslate();
  const [projects, setProjects] = useState<readonly AddableProject[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  useEffect(() => {
    let cancelled = false;
    void fetchProjects()
      .then((payload) => {
        if (cancelled) return;
        const currentPaths = new Set(manifest.roots.map((root) => root.canonicalRoot));
        setProjects(
          payload.projects
            .filter((project) => project.available && !currentPaths.has(project.path))
            .map((project) => ({ name: project.name, path: project.path })),
        );
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [manifest.roots]);
  const options = useMemo(() => projects, [projects]);
  const actor = manifest.roots.find((root) => root.rootRef === manifest.focusedRootRef);
  return (
    <fieldset className={styles.cmpToolbar} aria-label={t("filesWidget.multiRoot.manage")}>
      <select
        className={styles.cmpSelect}
        aria-label={t("filesWidget.multiRoot.project")}
        value={selectedPath}
        disabled={workspace.mutating || options.length === 0}
        onChange={(event) => setSelectedPath(event.target.value)}
      >
        <option value="">{t("filesWidget.multiRoot.chooseProject")}</option>
        {options.map((project) => (
          <option key={project.path} value={project.path}>
            {project.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={styles.cmpAction}
        disabled={workspace.mutating || selectedPath.length === 0 || actor === undefined}
        onClick={() => {
          if (actor !== undefined) void workspace.addRoot(actor.rootRef, selectedPath);
        }}
      >
        {t("filesWidget.multiRoot.add")}
      </button>
    </fieldset>
  );
}

export function MultiRootFilesWidget(props: MultiRootFilesWidgetProps): ReactNode {
  const t = useTranslate();
  const fallbackRootRef = props.manifest.focusedRootRef ?? props.manifest.roots[0]?.rootRef ?? null;
  const [rovingRootRef, setRovingRootRef] = useState<WorkspaceRootRef | null>(fallbackRootRef);
  const [lastFallbackRootRef, setLastFallbackRootRef] = useState(fallbackRootRef);
  if (lastFallbackRootRef !== fallbackRootRef) {
    // Reset before commit so a changed manifest focus is never paired with the previous tab stop.
    setLastFallbackRootRef(fallbackRootRef);
    setRovingRootRef(fallbackRootRef);
  }
  const activeRootRef = props.manifest.roots.some((root) => root.rootRef === rovingRootRef)
    ? rovingRootRef
    : fallbackRootRef;
  return (
    <section
      className={styles.cmpRootExplorer}
      data-multi-root-explorer
      aria-label={t("filesWidget.multiRoot.label")}
    >
      <AddRootToolbar manifest={props.manifest} workspace={props.workspace} />
      {props.workspace.issue === null ? null : (
        <p className={styles.cmpIssue} role="alert">
          {t("filesWidget.multiRoot.error")}
        </p>
      )}
      <div className={styles.cmpRootList} role="tree" aria-label={t("filesWidget.multiRoot.label")}>
        {props.manifest.roots.map((root, index) => (
          <RootGroup
            {...props}
            root={root}
            index={index}
            key={root.rootRef}
            rovingTabIndex={root.rootRef === activeRootRef ? 0 : -1}
            onRovingFocus={setRovingRootRef}
          />
        ))}
      </div>
    </section>
  );
}
