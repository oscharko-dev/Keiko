"use client";

import dynamic from "next/dynamic";
import {
  Activity,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type {
  EditorAgentRootBinding,
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
import { rovingTabTargetFile } from "./cards/editorPaneGeometry";
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

function agentRootBinding(
  manifest: WorkspaceManifest,
  root: WorkspaceRootDescriptor,
): EditorAgentRootBinding | undefined {
  if (manifest.roots.length === 1) return undefined;
  return {
    workspaceId: manifest.workspaceId,
    manifestRef: manifest.manifestRef,
    manifestRevision: manifest.revision,
    manifestDigest: manifest.manifestDigest,
    rootRef: root.rootRef,
    rootIdentityDigest: root.identityDigest,
  };
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

function tabElementId(prefix: string, rootRef: WorkspaceRootRef): string {
  return `${prefix}-tab-${rootRef}`;
}

function panelElementId(prefix: string, rootRef: WorkspaceRootRef): string {
  return `${prefix}-panel-${rootRef}`;
}

/**
 * Issue #2768 — `role="tablist"`/`role="tab"` is a contract, not a label: it promises arrow-key
 * traversal, a single tab stop, and a tab that names its panel. Without them the switcher was
 * announced as a tablist while behaving like a plain button row — every tab a separate tab stop,
 * no arrow navigation, and no way for a screen reader to tell which region a tab governs.
 *
 * Activation is MANUAL (arrows move focus, Enter/Space activates, which the native button already
 * does). WAI-ARIA APG only recommends automatic activation when the panel appears without
 * noticeable latency; selecting a root here calls `workspace.focusRoot`, a server round trip, so
 * arrowing through the tabs must not fire one per key press.
 */
function rootTabTraversalTarget(
  rootRefs: readonly WorkspaceRootRef[],
  current: WorkspaceRootRef,
  key: string,
): WorkspaceRootRef | undefined {
  if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") {
    return undefined;
  }
  // Reused rather than reimplemented: the same wrap-around/Home/End rule the editor's own tab strip
  // already roams by, so the two roving tab stops cannot drift apart.
  const target = rovingTabTargetFile(rootRefs, current, key);
  return target === undefined ? undefined : (target as WorkspaceRootRef);
}

function EditorRootTab({
  root,
  selected,
  focused,
  idPrefix,
  onSelect,
  onKeyDown,
}: {
  readonly root: WorkspaceRootDescriptor;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly idPrefix: string;
  readonly onSelect: () => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}): ReactNode {
  const trust = useWorkspaceTrust(root.canonicalRoot);
  return (
    <button
      type="button"
      role="tab"
      id={tabElementId(idPrefix, root.rootRef)}
      className={styles.cmpRootTab}
      aria-selected={selected}
      aria-controls={panelElementId(idPrefix, root.rootRef)}
      tabIndex={focused ? 0 : -1}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <span>{root.displayName}</span>
      <WorkspaceTrustBadge status={trust.status} issue={trust.issue} />
    </button>
  );
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
  const idPrefix = useId();
  // Manual activation keeps the roving tab stop separate from the selection: arrowing moves focus
  // (and the single tabIndex=0) without firing the server-side focusRoot a selection would.
  const [focusedRootRef, setFocusedRootRef] = useState<WorkspaceRootRef>(activeRoot.rootRef);
  const activeRootRef = useRef(activeRoot.rootRef);
  const manifestRef = useRef(manifest);
  const updateCfgRef = useRef(updateCfg);
  activeRootRef.current = activeRoot.rootRef;
  manifestRef.current = manifest;
  updateCfgRef.current = updateCfg;
  // The roving tab stop is separate from the selection only for MANUAL activation — arrowing moves
  // focus without selecting. A selection that changes on its own is the other case: `activeRoot` is
  // derived from `configuredRoot`/the manifest, so `openEditorFile` writing another root into cfg,
  // or a `focusRoot` raised elsewhere, moves the selected tab without `selectRoot` ever running.
  // Without this resync the only tabbable tab stays on the previously selected root while
  // `aria-selected` and the visible tabpanel are on another — the tablist contract says the tab stop
  // belongs to the selected tab when focus is outside the tablist (Qodo review, PR #2770; the same
  // resync MultiRootFilesWidget took in #2753). Arrowing is unaffected: it does not change
  // `activeRoot`, so this effect does not fire and cannot steal focus back.
  useEffect(() => setFocusedRootRef(activeRoot.rootRef), [activeRoot.rootRef]);
  useEffect(() => setSessions(parsedSessions), [parsedSessions]);
  // openEditorFile targets an existing editor window by writing root/file/openFiles/layoutJson into
  // its cfg. Per-root sessions take precedence over cfg, so once a root had a session that request
  // was silently dropped and "open in editor" from search, Problems, history or an agent proposal
  // did nothing. Adopt the request into the target root's session, then clear it from cfg so it is
  // consumed exactly once and cannot fight later edits in that root.
  const openRequestFile = stringValue(cfg, "file");
  const openRequestRoot = stringValue(cfg, "root");
  useEffect(() => {
    if (openRequestFile === undefined || openRequestRoot === undefined) return;
    const target = manifestRef.current.roots.find(
      (candidate) => candidate.canonicalRoot === openRequestRoot,
    );
    if (target === undefined) return;
    const existing = sessionsRef.current.get(target.rootRef);
    if (existing === undefined || legacyLayoutJson === undefined) return;
    if (existing.layoutJson === legacyLayoutJson) return;
    const next = new Map(sessionsRef.current);
    next.set(target.rootRef, {
      rootRef: target.rootRef,
      root: target.canonicalRoot,
      layoutJson: legacyLayoutJson,
    });
    sessionsRef.current = next;
    setSessions(next);
    updateCfgRef.current({
      rootSessionsJson: serializeEditorRootSessions(next, manifestRef.current, target.rootRef),
      file: undefined,
      openFiles: undefined,
      layoutJson: undefined,
    });
  }, [legacyLayoutJson, openRequestFile, openRequestRoot]);
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

  const onTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    from: WorkspaceRootRef,
  ): void => {
    const target = rootTabTraversalTarget(
      manifest.roots.map((root) => root.rootRef),
      from,
      event.key,
    );
    if (target === undefined) return;
    event.preventDefault();
    setFocusedRootRef(target);
    document.getElementById(tabElementId(idPrefix, target))?.focus();
  };

  const selectRoot = (root: WorkspaceRootDescriptor): void => {
    setFocusedRootRef(root.rootRef);
    const session = sessionsRef.current.get(root.rootRef);
    updateCfg({
      root: root.canonicalRoot,
      file: undefined,
      openFiles: undefined,
      layoutJson: session?.layoutJson,
      rootSessionsJson: serializeEditorRootSessions(sessionsRef.current, manifest, root.rootRef),
      // Issue #2621 — the reveal in cfg was addressed to the root that is being left. Selecting a
      // tab by hand is not that request, and cfg keys carry the reveal to whichever root is named
      // there, so the stale line range is dropped instead of following the user to the new tab.
      revealLineStart: undefined,
      revealLineEnd: undefined,
      revealRequestId: undefined,
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
            // The tab stop follows focus, but only a tab that still exists can hold it: a removed
            // root would otherwise leave the tablist with no tabIndex=0 and no way in by keyboard.
            focused={
              root.rootRef ===
              (manifest.roots.some((candidate) => candidate.rootRef === focusedRootRef)
                ? focusedRootRef
                : activeRoot.rootRef)
            }
            idPrefix={idPrefix}
            onSelect={() => selectRoot(root)}
            onKeyDown={(event) => onTabKeyDown(event, root.rootRef)}
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
          <div
            className={styles.cmpSession}
            role="tabpanel"
            id={panelElementId(idPrefix, root.rootRef)}
            aria-labelledby={tabElementId(idPrefix, root.rootRef)}
            hidden={!active}
            key={root.rootRef}
          >
            <Activity mode={active ? "visible" : "hidden"}>
              <EditorWidget
                {...baseProps}
                {...initialSessionProps(root, sessions, cfg)}
                root={root.canonicalRoot}
                agentRootBinding={agentRootBinding(manifest, root)}
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
