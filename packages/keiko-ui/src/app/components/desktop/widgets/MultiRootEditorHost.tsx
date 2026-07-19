"use client";

import dynamic from "next/dynamic";
import { Activity, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { disposeEditorModelRegistryRoot } from "@oscharko-dev/keiko-editor";
import type {
  WorkspaceManifest,
  WorkspaceRootDescriptor,
  WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";
import { useTranslate } from "@/lib/i18n";
import {
  EDITOR_ROOT_SESSIONS_SCHEMA_VERSION,
  parseEditorRootSessions,
  serializeEditorRootSessions,
  type EditorRootSession,
} from "@/lib/editor-root-sessions";
import type { WorkspaceManifestView } from "../hooks/useWorkspaceManifest";
import { WorkspaceTrustBadge } from "../workspace-trust/WorkspaceTrustSurfaces";
import { useWorkspaceTrust } from "../workspace-trust/useWorkspaceTrust";
import type { EditorWidgetProps, EditorWidgetWorkspacePatch } from "./cards/EditorWidget";
import styles from "./MultiRootEditorHost.module.css";

const EditorWidget = dynamic<EditorWidgetProps>(
  () => import("./cards/EditorWidget").then((module) => module.EditorWidget),
  { ssr: false },
);

interface MultiRootEditorHostProps {
  readonly manifest: WorkspaceManifest;
  readonly workspace: WorkspaceManifestView;
  readonly configuredRoot: string | undefined;
  readonly cfg: Record<string, unknown>;
  readonly buildBaseProps: (
    root: string,
  ) => Omit<
    EditorWidgetProps,
    "file" | "layoutJson" | "onWorkspaceChange" | "openFiles" | "root" | "sessionActive"
  >;
  readonly updateCfg: (
    patch: Record<string, string | number | boolean | readonly string[] | undefined>,
  ) => void;
}

function stringValue(cfg: Record<string, unknown>, key: string): string | undefined {
  const value = cfg[key];
  return typeof value === "string" ? value : undefined;
}

function stringList(cfg: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = cfg[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function selectedRoot(
  manifest: WorkspaceManifest,
  configuredRoot: string | undefined,
): WorkspaceRootDescriptor {
  return (
    manifest.roots.find((root) => root.canonicalRoot === configuredRoot) ??
    manifest.roots.find((root) => root.rootRef === manifest.focusedRootRef) ??
    manifest.roots[0]!
  );
}

function initialSessionProps(
  root: WorkspaceRootDescriptor,
  sessions: ReadonlyMap<WorkspaceRootRef, EditorRootSession>,
  cfg: Record<string, unknown>,
): Pick<EditorWidgetProps, "file" | "layoutJson" | "openFiles"> {
  const session = sessions.get(root.rootRef);
  if (session !== undefined) return { layoutJson: session.layoutJson };
  if (stringValue(cfg, "root") !== root.canonicalRoot) return {};
  const file = stringValue(cfg, "file");
  const openFiles = stringList(cfg, "openFiles");
  const layoutJson = stringValue(cfg, "layoutJson");
  return {
    ...(file === undefined ? {} : { file }),
    ...(openFiles === undefined ? {} : { openFiles }),
    ...(layoutJson === undefined ? {} : { layoutJson }),
  };
}

function parsedSessionsWithLegacyFallback(
  sessionsJson: string | undefined,
  manifest: WorkspaceManifest,
  configuredRoot: string | undefined,
  layoutJson: string | undefined,
): ReadonlyMap<WorkspaceRootRef, EditorRootSession> {
  const parsed = parseEditorRootSessions(sessionsJson, manifest);
  const root = manifest.roots.find((candidate) => candidate.canonicalRoot === configuredRoot);
  if (root === undefined || layoutJson === undefined || parsed.has(root.rootRef)) return parsed;
  return parseEditorRootSessions(
    JSON.stringify({
      schemaVersion: EDITOR_ROOT_SESSIONS_SCHEMA_VERSION,
      sessions: [
        ...parsed.values(),
        { rootRef: root.rootRef, root: root.canonicalRoot, layoutJson },
      ],
    }),
    manifest,
  );
}

function EditorRootTab({
  root,
  selected,
  onSelect,
}: {
  readonly root: WorkspaceRootDescriptor;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactNode {
  const trust = useWorkspaceTrust(root.canonicalRoot);
  return (
    <button
      type="button"
      role="tab"
      className={styles.cmpRootTab}
      aria-selected={selected}
      onClick={onSelect}
    >
      <span>{root.displayName}</span>
      <WorkspaceTrustBadge status={trust.status} />
    </button>
  );
}

function useRemovedRootDisposal(manifest: WorkspaceManifest): void {
  const previousRoots = useRef(manifest.roots);
  useEffect(() => {
    const currentRefs = new Set(manifest.roots.map((root) => root.rootRef));
    for (const root of previousRoots.current) {
      if (!currentRefs.has(root.rootRef)) {
        disposeEditorModelRegistryRoot(root.canonicalRoot, "root-disposed", true);
      }
    }
    previousRoots.current = manifest.roots;
  }, [manifest.roots]);
}

export function MultiRootEditorHost({
  manifest,
  workspace,
  configuredRoot,
  cfg,
  buildBaseProps,
  updateCfg,
}: MultiRootEditorHostProps): ReactNode {
  const t = useTranslate();
  const sessionsJson = stringValue(cfg, "rootSessionsJson");
  const legacyLayoutJson = stringValue(cfg, "layoutJson");
  const parsedSessions = useMemo(
    () =>
      parsedSessionsWithLegacyFallback(sessionsJson, manifest, configuredRoot, legacyLayoutJson),
    [configuredRoot, legacyLayoutJson, manifest, sessionsJson],
  );
  const [sessions, setSessions] = useState(parsedSessions);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const activeRoot = selectedRoot(manifest, configuredRoot);
  const activeRootRef = useRef(activeRoot.rootRef);
  const manifestRef = useRef(manifest);
  const updateCfgRef = useRef(updateCfg);
  activeRootRef.current = activeRoot.rootRef;
  manifestRef.current = manifest;
  updateCfgRef.current = updateCfg;
  useRemovedRootDisposal(manifest);
  useEffect(() => setSessions(parsedSessions), [parsedSessions]);
  useEffect(() => {
    if (sessionsJson !== undefined || parsedSessions.size === 0) return;
    updateCfgRef.current({
      rootSessionsJson: serializeEditorRootSessions(
        parsedSessions,
        manifestRef.current,
        activeRootRef.current,
      ),
    });
  }, [parsedSessions, sessionsJson]);

  const updateSession = useCallback(
    (root: WorkspaceRootDescriptor, patch: EditorWidgetWorkspacePatch): void => {
      if (patch.layoutJson === undefined) return;
      const next = new Map(sessionsRef.current);
      next.set(root.rootRef, {
        rootRef: root.rootRef,
        root: root.canonicalRoot,
        layoutJson: patch.layoutJson,
      });
      sessionsRef.current = next;
      setSessions(next);
      const currentManifest = manifestRef.current;
      updateCfgRef.current({
        rootSessionsJson: serializeEditorRootSessions(next, currentManifest, root.rootRef),
        ...(activeRootRef.current === root.rootRef ? { root: root.canonicalRoot, ...patch } : {}),
      });
    },
    [],
  );
  const sessionChangeHandlers = useMemo(
    () =>
      new Map(
        manifest.roots.map(
          (root) =>
            [
              root.rootRef,
              (patch: EditorWidgetWorkspacePatch): void => updateSession(root, patch),
            ] as const,
        ),
      ),
    [manifest.roots, updateSession],
  );

  const selectRoot = (root: WorkspaceRootDescriptor): void => {
    const session = sessionsRef.current.get(root.rootRef);
    updateCfg({
      root: root.canonicalRoot,
      file: undefined,
      openFiles: undefined,
      layoutJson: session?.layoutJson,
      rootSessionsJson: serializeEditorRootSessions(sessionsRef.current, manifest, root.rootRef),
    });
    void workspace.focusRoot(root.rootRef);
  };

  return (
    <section className={styles.cmpHost} aria-label={t("editor.multiRoot.label")}>
      <div
        className={styles.cmpRootTabs}
        role="tablist"
        aria-label={t("editor.multiRoot.switcher")}
      >
        {manifest.roots.map((root) => (
          <EditorRootTab
            root={root}
            selected={root.rootRef === activeRoot.rootRef}
            onSelect={() => selectRoot(root)}
            key={root.rootRef}
          />
        ))}
      </div>
      {workspace.issue === null ? null : (
        <p className={styles.cmpIssue} role="alert">
          {t("editor.multiRoot.error")}
        </p>
      )}
      {manifest.roots.map((root) => {
        const active = root.rootRef === activeRoot.rootRef;
        const baseProps = buildBaseProps(root.canonicalRoot);
        return (
          <div className={styles.cmpSession} hidden={!active} key={root.rootRef}>
            <Activity mode={active ? "visible" : "hidden"}>
              <EditorWidget
                {...baseProps}
                {...initialSessionProps(root, sessions, cfg)}
                root={root.canonicalRoot}
                sessionActive={active}
                windowId={`${baseProps.windowId ?? "editor"}-${root.rootRef}`}
                onWorkspaceChange={sessionChangeHandlers.get(root.rootRef)}
              />
            </Activity>
          </div>
        );
      })}
    </section>
  );
}
