import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { disposeEditorModelRegistryRoot } from "@oscharko-dev/keiko-editor";
import type { WorkspaceManifest } from "@oscharko-dev/keiko-contracts";

import { updateChat } from "@/lib/api";
import { useTranslate } from "@/lib/i18n";
import type { Chat, ChatMessage, ProjectWithAvailability } from "@/lib/types";

import { useChatSessionContext } from "../context/ChatSessionContext";
import type { ChatSessionApi } from "../hooks/useChatSession";
import { useWorkspaceManifest } from "../hooks/useWorkspaceManifest";
import type { WindowRenderContext } from "../windows/WindowsRegistry";
import type { EditorWidgetProps, EditorWidgetWorkspacePatch } from "./cards/EditorWidget";
import { MultiRootFilesWidget } from "./cards/MultiRootFilesWidget";
import { gitObjectId } from "./gitObjectId";
import { MultiRootEditorHost } from "./MultiRootEditorHost";
import { useEditorAgentTranslate, type EditorAgentMessageKey } from "./cards/editor-agent-i18n";
import {
  composeEditorSelectionPrompt,
  consumeEditorSelectionHandoff,
  discardEditorSelectionHandoff,
  inspectEditorSelectionHandoff,
  registerEditorSelectionHandoff,
  type EditorSelectionHandoffMetadata,
} from "./cards/editorSelectionHandoff";

function WindowChunkFallback(): ReactNode {
  const t = useTranslate();
  return <div className="lk-loading">{t("common.loading")}</div>;
}

const windowChunkFallback = WindowChunkFallback;
const ChatWindow = dynamic(() => import("../ChatWindow").then((mod) => mod.ChatWindow), {
  ssr: false,
  loading: windowChunkFallback,
});
const EditorWidget = dynamic<EditorWidgetProps>(
  () => import("./cards/EditorWidget").then((mod) => mod.EditorWidget),
  { ssr: false, loading: windowChunkFallback },
);
const FilesWidget = dynamic(() => import("./cards/FilesWidget").then((mod) => mod.FilesWidget), {
  ssr: false,
  loading: windowChunkFallback,
});
function str(cfg: Record<string, unknown>, key: string): string | undefined {
  const value = cfg[key];
  return typeof value === "string" ? value : undefined;
}

function num(cfg: Record<string, unknown>, key: string): number | undefined {
  const value = cfg[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(cfg: Record<string, unknown>, key: string): readonly string[] | undefined {
  const raw = cfg[key];
  if (!Array.isArray(raw)) return undefined;
  const values = raw
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  return values.length > 0 ? values : undefined;
}

type SelectionHandoffNoticeKey = Extract<
  EditorAgentMessageKey,
  | "chat.creation.openFailed"
  | "chat.creation.titleSaveFailed"
  | "editor.askSelection.chatUnavailable"
  | "editor.askSelection.openFailed"
>;

type SelectionHandoffRoute =
  | { readonly kind: "wait" }
  | { readonly kind: "fail"; readonly noticeKey: SelectionHandoffNoticeKey }
  | { readonly kind: "consume"; readonly chat: Chat; readonly workspaceRoot: string }
  | { readonly kind: "open-project"; readonly project: ProjectWithAvailability }
  | { readonly kind: "open-chat"; readonly chat: Chat }
  | { readonly kind: "create-chat"; readonly project: ProjectWithAvailability };

interface SelectionRouteAttempt {
  attempted: boolean;
  id: string | null;
  inFlight: boolean;
}

interface SelectionHandoffControl {
  readonly noticeKey: SelectionHandoffNoticeKey | null;
  readonly pending: boolean;
}

function matchingOpenChat(
  chats: readonly Chat[],
  workspaceRoot: string,
  preferredId: string | undefined,
): Chat | undefined {
  const matches = chats.filter(
    (chat) => chat.projectPath === workspaceRoot && chat.status !== "closed",
  );
  return matches.find((chat) => chat.id === preferredId) ?? matches[0];
}

function selectionHandoffRoute(args: {
  readonly attempted: boolean;
  readonly chatId: string | undefined;
  readonly metadata: EditorSelectionHandoffMetadata | null;
  readonly routing: boolean;
  readonly session: ChatSessionApi;
}): SelectionHandoffRoute {
  const { metadata, session } = args;
  if (metadata === null) return { kind: "fail", noticeKey: "editor.askSelection.openFailed" };
  if (session.loading || session.sending || args.routing) return { kind: "wait" };
  const workspaceRoot = metadata.workspaceRoot;
  const project = session.projects.find((candidate) => candidate.path === workspaceRoot);
  if (project?.available !== true || session.noEligibleModels) {
    return { kind: "fail", noticeKey: "editor.askSelection.chatUnavailable" };
  }
  const activeChat = session.activeChat?.status === "closed" ? undefined : session.activeChat;
  if (session.activeProject?.path === workspaceRoot && activeChat?.projectPath === workspaceRoot) {
    return session.selectedModel === undefined
      ? { kind: "fail", noticeKey: "editor.askSelection.chatUnavailable" }
      : { kind: "consume", chat: activeChat, workspaceRoot };
  }
  if (args.attempted) return { kind: "fail", noticeKey: "editor.askSelection.openFailed" };
  if (session.activeProject?.path !== workspaceRoot) return { kind: "open-project", project };
  const existing = matchingOpenChat(session.chats, workspaceRoot, args.chatId);
  return existing === undefined
    ? { kind: "create-chat", project }
    : { kind: "open-chat", chat: existing };
}

function routeSelectionHandoff(
  route: Extract<
    SelectionHandoffRoute,
    { readonly kind: "open-project" | "open-chat" | "create-chat" }
  >,
  session: ChatSessionApi,
  createChat: (project: ProjectWithAvailability) => Promise<unknown>,
): Promise<unknown> {
  if (route.kind === "open-project") return session.openProject(route.project);
  if (route.kind === "open-chat") return session.openChat(route.chat);
  return createChat(route.project);
}

function currentRouteAttempt(
  ref: { current: SelectionRouteAttempt },
  id: string,
): SelectionRouteAttempt {
  if (ref.current.id !== id) ref.current = { attempted: false, id, inFlight: false };
  return ref.current;
}

interface ChatCreationOwner {
  readonly kind: "selection" | "window";
  readonly id: string;
}

interface ChatCreationCoordinator {
  readonly release: (owner: ChatCreationOwner) => void;
  readonly request: (
    owner: ChatCreationOwner,
    project?: ProjectWithAvailability,
    title?: string,
  ) => Promise<ChatCreationResult>;
}

interface ChatCreationResult {
  readonly chat: Chat | undefined;
  readonly titleSaveFailed: boolean;
}

interface ActiveChatCreation {
  desiredTitle: string | undefined;
  owner: ChatCreationOwner;
  readonly projectPath: string | null;
  readonly promise: Promise<Chat | undefined>;
  reconciliation: Promise<ChatCreationResult> | null;
  titleRevision: number;
}

function sameCreationOwner(left: ChatCreationOwner, right: ChatCreationOwner): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function normalizedChatTitle(title: string | undefined): string | undefined {
  const normalized = title?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

async function reconcileActiveChatCreation(
  active: ActiveChatCreation,
  replaceChat: ChatSessionApi["replaceChat"],
  isCurrent: () => boolean,
): Promise<ChatCreationResult> {
  let chat = await active.promise;
  if (chat === undefined || !isCurrent()) return { chat: undefined, titleSaveFailed: false };
  while (isCurrent()) {
    const revision = active.titleRevision;
    const title = active.desiredTitle;
    if (title === undefined || chat.title === title) return { chat, titleSaveFailed: false };
    try {
      const response = await updateChat(chat.id, { title });
      if (!isCurrent()) return { chat: undefined, titleSaveFailed: false };
      chat = response.chat;
      if (revision !== active.titleRevision) continue;
      replaceChat(chat);
      return { chat, titleSaveFailed: false };
    } catch {
      if (revision !== active.titleRevision) continue;
      return isCurrent()
        ? { chat, titleSaveFailed: true }
        : { chat: undefined, titleSaveFailed: false };
    }
  }
  return { chat: undefined, titleSaveFailed: false };
}

function activeCreationResult(
  active: ActiveChatCreation,
  currentRef: { current: ActiveChatCreation | null },
  replaceChat: ChatSessionApi["replaceChat"],
): Promise<ChatCreationResult> {
  if (active.reconciliation !== null) return active.reconciliation;
  const reconciliation = reconcileActiveChatCreation(
    active,
    replaceChat,
    (): boolean => currentRef.current === active,
  );
  const tracked = reconciliation.finally((): void => {
    if (active.reconciliation === tracked) active.reconciliation = null;
  });
  active.reconciliation = tracked;
  return tracked;
}

function useChatCreationCoordinator(
  openNewChat: ChatSessionApi["openNewChat"],
  replaceChat: ChatSessionApi["replaceChat"],
): ChatCreationCoordinator {
  const activeByProjectRef = useRef(new Map<string | null, ActiveChatCreation>());
  const currentRef = useRef<ActiveChatCreation | null>(null);
  const request = useCallback<ChatCreationCoordinator["request"]>(
    (owner, project, title): Promise<ChatCreationResult> => {
      const projectPath = project?.path ?? null;
      let active = activeByProjectRef.current.get(projectPath);
      if (active === undefined) {
        active = {
          desiredTitle: normalizedChatTitle(title),
          owner,
          projectPath,
          promise: openNewChat(project, title),
          reconciliation: null,
          titleRevision: 0,
        };
        activeByProjectRef.current.set(projectPath, active);
      } else {
        active.owner = owner;
        active.desiredTitle = normalizedChatTitle(title);
        active.titleRevision += 1;
      }
      currentRef.current = active;
      return activeCreationResult(active, currentRef, replaceChat);
    },
    [openNewChat, replaceChat],
  );
  const release = useCallback<ChatCreationCoordinator["release"]>((owner): void => {
    for (const [projectPath, active] of activeByProjectRef.current) {
      if (!sameCreationOwner(active.owner, owner)) continue;
      activeByProjectRef.current.delete(projectPath);
      if (currentRef.current === active) currentRef.current = null;
      return;
    }
  }, []);
  return useMemo((): ChatCreationCoordinator => ({ release, request }), [release, request]);
}

const pendingHandoffDisposals = new Map<string, number>();

function retainSelectionHandoff(id: string): void {
  const timeout = pendingHandoffDisposals.get(id);
  if (timeout === undefined) return;
  window.clearTimeout(timeout);
  pendingHandoffDisposals.delete(id);
}

function scheduleSelectionHandoffDisposal(id: string): void {
  retainSelectionHandoff(id);
  const timeout = window.setTimeout((): void => {
    if (pendingHandoffDisposals.get(id) !== timeout) return;
    pendingHandoffDisposals.delete(id);
    discardEditorSelectionHandoff(id);
  }, 0);
  pendingHandoffDisposals.set(id, timeout);
}

function useSelectionHandoffControl(args: {
  readonly chatId: string | undefined;
  readonly coordinator: ChatCreationCoordinator;
  readonly ctx: WindowRenderContext;
  readonly id: string | undefined;
  readonly session: ChatSessionApi;
}): SelectionHandoffControl {
  const [noticeKey, setNoticeKey] = useState<SelectionHandoffNoticeKey | null>(null);
  const [revision, setRevision] = useState(0);
  const [settledId, setSettledId] = useState<string | null>(null);
  const attemptRef = useRef<SelectionRouteAttempt>({ attempted: false, id: null, inFlight: false });
  const { id, session } = args;
  useEffect((): (() => void) | undefined => {
    if (id === undefined) return;
    retainSelectionHandoff(id);
    return (): void => {
      scheduleSelectionHandoffDisposal(id);
    };
  }, [id]);
  useEffect(() => {
    if (id === undefined || settledId === id) return;
    const metadata = inspectEditorSelectionHandoff(id);
    if (metadata === null) return;
    const delay = Math.max(1, metadata.expiresAt - Date.now() + 1);
    const timeout = window.setTimeout((): void => setRevision((value): number => value + 1), delay);
    return (): void => window.clearTimeout(timeout);
  }, [id, settledId]);
  useEffect(() => {
    if (id === undefined || settledId === id) return;
    const attempt = currentRouteAttempt(attemptRef, id);
    const route = selectionHandoffRoute({
      attempted: attempt.attempted,
      chatId: args.chatId,
      metadata: inspectEditorSelectionHandoff(id),
      routing: attempt.inFlight,
      session,
    });
    if (route.kind === "wait") return;
    if (route.kind === "fail") {
      discardEditorSelectionHandoff(id);
      args.ctx.updateCfg({ selectionHandoffId: undefined });
      args.coordinator.release({ kind: "selection", id });
      setNoticeKey(route.noticeKey);
      setSettledId(id);
      return;
    }
    if (route.kind === "consume") {
      const handoff = consumeEditorSelectionHandoff(id, route.workspaceRoot);
      if (handoff === null) {
        setRevision((value): number => value + 1);
        return;
      }
      args.ctx.updateCfg({
        chatId: route.chat.id,
        title: route.chat.title,
        selectionHandoffId: undefined,
        newChatRequestId: undefined,
      });
      args.coordinator.release({ kind: "selection", id });
      args.ctx.focusWindow(args.ctx.windowId);
      setNoticeKey(null);
      setSettledId(id);
      void session
        .sendMessage({ text: composeEditorSelectionPrompt(handoff) })
        .then(undefined, () => setNoticeKey("editor.askSelection.openFailed"));
      return;
    }
    attempt.attempted = true;
    attempt.inFlight = true;
    const finish = (): void => {
      if (attemptRef.current.id === id) attemptRef.current.inFlight = false;
      setRevision((value): number => value + 1);
    };
    const createChat = (project: ProjectWithAvailability): Promise<unknown> =>
      args.coordinator.request({ kind: "selection", id }, project);
    void routeSelectionHandoff(route, session, createChat).then(finish, finish);
  }, [args.chatId, args.coordinator, args.ctx, id, revision, session, settledId]);
  return { noticeKey, pending: id !== undefined && settledId !== id };
}

interface ChatCreationControlArgs {
  readonly activeProject: ProjectWithAvailability | undefined;
  readonly chatId: string | undefined;
  readonly coordinator: ChatCreationCoordinator;
  readonly loading: boolean;
  readonly newChatRequestId: string | undefined;
  readonly selectionHandoffId: string | undefined;
  readonly title: string | undefined;
  readonly updateCfg: WindowRenderContext["updateCfg"];
}

interface ChatCreationControl {
  readonly errorKey: SelectionHandoffNoticeKey | null;
  readonly pending: boolean;
}

interface ChatCreationError {
  readonly chatId: string | undefined;
  readonly messageKey: SelectionHandoffNoticeKey;
  readonly requestId: string;
}

function useChatCreationControl(args: ChatCreationControlArgs): ChatCreationControl {
  const {
    activeProject,
    chatId,
    coordinator,
    loading,
    newChatRequestId,
    selectionHandoffId,
    title,
    updateCfg,
  } = args;
  const [error, setError] = useState<ChatCreationError | null>(null);
  const pending = chatId === undefined && selectionHandoffId === undefined;
  const requestId = pending ? (newChatRequestId ?? "initial-unbound-chat") : undefined;
  const projectPath = activeProject?.path ?? null;
  const requestKey = requestId === undefined ? undefined : `${requestId}\u0000${projectPath ?? ""}`;
  const attemptSequenceRef = useRef(0);
  const attemptedRequestKeyRef = useRef<string | undefined>(undefined);
  const latestAttemptRef = useRef(0);

  useEffect((): void => {
    if (loading || requestKey === undefined) return;
    if (attemptedRequestKeyRef.current === requestKey) return;
    const attempt = attemptSequenceRef.current + 1;
    const owner = { kind: "window", id: `${requestKey}\u0000${String(attempt)}` } as const;
    attemptSequenceRef.current = attempt;
    latestAttemptRef.current = attempt;
    attemptedRequestKeyRef.current = requestKey;
    setError(null);
    void coordinator
      .request(owner, activeProject, title)
      .then(
        (result): void => {
          if (latestAttemptRef.current !== attempt) return;
          if (result.chat === undefined) {
            setError({
              chatId: undefined,
              messageKey: "chat.creation.openFailed",
              requestId: requestKey,
            });
            return;
          }
          if (result.titleSaveFailed) {
            setError({
              chatId: result.chat.id,
              messageKey: "chat.creation.titleSaveFailed",
              requestId: requestKey,
            });
          }
          updateCfg({
            chatId: result.chat.id,
            title: result.chat.title,
            newChatRequestId: undefined,
          });
        },
        (): void => {
          if (latestAttemptRef.current === attempt) {
            setError({
              chatId: undefined,
              messageKey: "chat.creation.openFailed",
              requestId: requestKey,
            });
          }
        },
      )
      .finally((): void => {
        coordinator.release(owner);
      });
  }, [activeProject, coordinator, loading, requestKey, title, updateCfg]);
  const visibleError =
    error !== null &&
    error.chatId === chatId &&
    (chatId !== undefined || error.requestId === requestKey)
      ? error.messageKey
      : null;
  return { errorKey: visibleError, pending };
}

export function ChatWindowSessionHost({
  cfg,
  ctx,
}: {
  readonly cfg: Record<string, unknown>;
  readonly ctx: WindowRenderContext;
}): ReactNode {
  const agentT = useEditorAgentTranslate();
  const session = useChatSessionContext();
  const chatId = str(cfg, "chatId");
  const title = str(cfg, "title");
  const selectionHandoffId = str(cfg, "selectionHandoffId");
  const newChatRequestId = str(cfg, "newChatRequestId");
  const { updateCfg } = ctx;
  const { activeChat, activeProject, chats, loading, openChat, openNewChat, replaceChat } = session;
  const activeTarget =
    activeChat !== undefined && activeChat.status !== "closed" ? activeChat : undefined;
  const creationCoordinator = useChatCreationCoordinator(openNewChat, replaceChat);
  const handoff = useSelectionHandoffControl({
    chatId,
    coordinator: creationCoordinator,
    ctx,
    id: selectionHandoffId,
    session,
  });
  const creatingChat = useChatCreationControl({
    activeProject,
    chatId,
    coordinator: creationCoordinator,
    loading,
    newChatRequestId,
    selectionHandoffId,
    title,
    updateCfg,
  });

  useEffect((): void => {
    if (loading || selectionHandoffId !== undefined || chatId === undefined) return;
    if (activeTarget?.id === chatId) return;
    const target = chats.find((chat): boolean => chat.id === chatId && chat.status !== "closed");
    if (target !== undefined) void openChat(target);
  }, [chatId, activeTarget?.id, chats, loading, openChat, selectionHandoffId]);

  useEffect(() => {
    if (loading || chatId === undefined || activeTarget?.id !== chatId) return;
    if (activeTarget.title !== title) updateCfg({ title: activeTarget.title });
  }, [activeTarget?.id, activeTarget?.title, chatId, loading, title, updateCfg]);

  const targetMissing =
    selectionHandoffId === undefined &&
    chatId !== undefined &&
    !session.loading &&
    activeTarget?.id !== chatId &&
    !session.chats.some((chat) => chat.id === chatId && chat.status !== "closed");
  const waitingForTarget =
    session.loading ||
    handoff.pending ||
    creatingChat.pending ||
    (chatId !== undefined && activeTarget?.id !== chatId);
  const openRunResult = useCallback(
    (message: ChatMessage): void => {
      if (message.runId === undefined) return;
      const runCfg: Record<string, string | number | boolean> = { runId: message.runId };
      const workflow = message.workflowId ?? message.taskType;
      if (workflow !== undefined) runCfg.workflow = workflow;
      const runRoot = ctx.activeRoot ?? activeProject?.path;
      if (runRoot !== undefined) runCfg.workspaceRoot = runRoot;
      ctx.openWindow("agents", runCfg);
    },
    [activeProject?.path, ctx],
  );

  let body: ReactNode;
  if (targetMissing) {
    body = (
      <div className="lk-empty">
        <p className="lk-empty-title">{"Chat not found"}</p>
        <p className="lk-empty-body">
          {"This conversation was deleted or is no longer available."}
        </p>
      </div>
    );
  } else if (waitingForTarget) {
    body = <div className="lk-loading">{"Opening chat..."}</div>;
  } else {
    body = (
      <ChatWindow
        windowId={ctx.windowId}
        mini={ctx.mini === true}
        minimalChat={ctx.minimalChat === true}
        compact={ctx.compact === true}
        controlsNarrow={ctx.controlsNarrow === true}
        barCompact={ctx.barCompact === true}
        workflowCompact={ctx.workflowCompact === true}
        linkedRoot={ctx.activeRoot ?? ctx.linkedRoot}
        linkedRoots={ctx.linkedRoots}
        openEditorFile={ctx.openEditorFile}
        previewWindows={{
          add: ctx.openWindow,
          focus: ctx.focusWindow,
          update: ctx.updateWindow,
        }}
        onOpenRunResult={openRunResult}
      />
    );
  }
  return (
    <>
      {handoff.noticeKey === null ? null : (
        <p className="lk-alert" role="alert">
          {agentT(handoff.noticeKey)}
        </p>
      )}
      {creatingChat.errorKey === null ? null : (
        <p className="lk-alert" role="alert">
          {agentT(creatingChat.errorKey)}
        </p>
      )}
      {body}
    </>
  );
}

// Issue #2621 — a root that leaves the workspace must hand back the Monaco models it retained, and
// among the components that render an editor this host is the one that observes every transition
// where that happens (a workspace whose editor window is closed still disposes nothing, unchanged
// from before). Watching the manifest inside `MultiRootEditorHost` misses the two-root case: it
// renders only while more than one root exists, so dropping to a single root
// re-renders this host into its V1 branch, so the multi-root host unmounts on the very transition
// that had to fire the disposal and never sees the manifest the removed root is missing from. Here
// the observation straddles both branches, so 2 -> 1 is diffed exactly like N -> N-1.
function useRemovedRootDisposal(manifest: WorkspaceManifest | null): void {
  const observed = useRef<WorkspaceManifest | null>(manifest);
  useEffect(() => {
    // A missing manifest is absence of evidence (loading, a failed load, a V1 root), never proof
    // that a root was removed, and a different workspace is a navigation rather than a removal.
    // Forced disposal destroys dirty buffers in every window sharing the root, so both stay closed
    // and the last workspace actually observed remains the baseline to diff against.
    if (manifest === null) return;
    const before = observed.current;
    observed.current = manifest;
    if (before?.workspaceId !== manifest.workspaceId) return;
    const remaining = new Set(manifest.roots.map((entry) => entry.rootRef));
    for (const removed of before.roots) {
      if (remaining.has(removed.rootRef)) continue;
      disposeEditorModelRegistryRoot(removed.canonicalRoot, "root-disposed", true);
    }
  }, [manifest]);
}

// Issue #2747 — a window must not keep operating against a root that left the workspace. The rule
// already exists one surface over: `resolveExplicitWindowRoot` (#2619, ADR-0147 D1) falls back to
// the focused root when the configured one is not a manifest member. It engages only from two roots
// up and the editor host resolves its own root, so the same rule is applied here — and it has to be,
// because #2621's removed-root disposal force-disposes that root's models underneath this editor,
// which would otherwise stay bound to a disposed Monaco model. An active task-workspace binding
// overrides cfg (ADR-0090 D4); cfg is dormant then and is left untouched.
function useDepartedRootRetarget(args: {
  readonly configuredRoot: string | undefined;
  readonly effectiveRoot: string | undefined;
  readonly manifest: WorkspaceManifest | null;
  readonly updateCfg: WindowRenderContext["updateCfg"];
}): void {
  const { configuredRoot, effectiveRoot, manifest } = args;
  const updateCfgRef = useRef(args.updateCfg);
  updateCfgRef.current = args.updateCfg;
  useEffect(() => {
    if (manifest === null || configuredRoot === undefined) return;
    if (effectiveRoot !== configuredRoot) return;
    if (manifest.roots.some((entry) => entry.canonicalRoot === configuredRoot)) return;
    const focused =
      manifest.roots.find((entry) => entry.rootRef === manifest.focusedRootRef) ??
      manifest.roots[0];
    if (focused === undefined) return;
    updateCfgRef.current({
      root: focused.canonicalRoot,
      // Every one of these described the departed root: its open files, its layout, and a reveal
      // whose addressee no longer exists.
      file: undefined,
      openFiles: undefined,
      layoutJson: undefined,
      revealLineStart: undefined,
      revealLineEnd: undefined,
      revealRequestId: undefined,
    });
  }, [configuredRoot, effectiveRoot, manifest]);
}

export function EditorWindowSessionHost({
  cfg,
  ctx,
  root,
}: {
  readonly cfg: Record<string, unknown>;
  readonly ctx: WindowRenderContext;
  readonly root: string | undefined;
}): ReactNode {
  const configuredRoot = str(cfg, "root");
  const workspace = useWorkspaceManifest(root ?? configuredRoot);
  const file = str(cfg, "file");
  const openFiles = stringArray(cfg, "openFiles");
  const layoutJson = str(cfg, "layoutJson");
  useRemovedRootDisposal(workspace.manifest);
  useDepartedRootRetarget({
    configuredRoot,
    effectiveRoot: root,
    manifest: workspace.manifest,
    updateCfg: ctx.updateCfg,
  });
  const buildBaseProps = useCallback(
    (targetRoot: string): EditorSessionBaseProps => ({
      ...editorSessionBaseProps(targetRoot, cfg, ctx),
      ...addressedRevealProps(cfg, targetRoot),
    }),
    [cfg, ctx],
  );
  if (workspace.manifest !== null && workspace.manifest.roots.length > 1) {
    return (
      <MultiRootEditorHost
        manifest={workspace.manifest}
        workspace={workspace}
        configuredRoot={configuredRoot}
        cfg={cfg}
        buildBaseProps={buildBaseProps}
        updateCfg={ctx.updateCfg}
      />
    );
  }
  const props: EditorWidgetProps = {
    ...editorSessionBaseProps(root, cfg, ctx),
    ...addressedRevealProps(cfg, root),
    ...(root === undefined ? {} : { root }),
    ...(file === undefined ? {} : { file }),
    ...(openFiles === undefined ? {} : { openFiles }),
    ...(layoutJson === undefined ? {} : { layoutJson }),
    onWorkspaceChange: (patch) => updateEditorCfg(ctx, configuredRoot, patch),
  };

  // V1/unbound roots keep the ADR-0090 remount guarantee. V2 manifests instead keep one keyed
  // EditorWidget state container per root inside MultiRootEditorHost.
  return <EditorWidget key={root ?? "unbound"} {...props} />;
}

type EditorSessionBaseProps = Omit<
  EditorWidgetProps,
  "file" | "layoutJson" | "onWorkspaceChange" | "openFiles" | "root" | "sessionActive"
>;

function updateEditorCfg(
  ctx: WindowRenderContext,
  configuredRoot: string | undefined,
  patch: EditorWidgetWorkspacePatch,
): void {
  const rootChanged = patch.root !== undefined && patch.root !== configuredRoot;
  ctx.updateCfg({
    root: patch.root,
    file: patch.file,
    openFiles: patch.openFiles,
    layoutJson: patch.layoutJson,
    // Issue #2621 — the reveal in cfg is addressed to the root named there, so re-homing the window
    // to a different root invalidates it. The editor applies a reveal from its Monaco mount wiring,
    // and a root change remounts this branch's editor (ADR-0090 D4), so keeping the triple would
    // fire the line jump again in another root's file — and would silently re-address it to the new
    // root, which is the very targeting the multi-root branch then trusts. Only on a root change: an
    // ordinary layout commit carries the same root and must not kill an in-flight reveal.
    ...(rootChanged
      ? { revealLineStart: undefined, revealLineEnd: undefined, revealRequestId: undefined }
      : {}),
  });
}

type EditorRevealSessionProps = Pick<
  EditorWidgetProps,
  "revealLineEnd" | "revealLineStart" | "revealRequestId"
>;

// Issue #2621 — a reveal names its addressee in the same cfg patch that carries the line range, so
// exactly one editor may act on it: the one whose EFFECTIVE root is that addressee. One rule for
// both branches, because both can misdeliver and they used to do it differently. The multi-root host
// mounts every root, so an ungated request reached all of them at once. The single-root branch shows
// whichever root ADR-0090 binding resolves, which need not be the addressee — and since that editor
// is keyed by the effective root, a task-workspace switch remounts it and the mount wiring replays
// the request in the wrong worktree's file. An addressee that matches no editor reaches nobody.
function addressedRevealProps(
  cfg: Record<string, unknown>,
  effectiveRoot: string | undefined,
): EditorRevealSessionProps {
  return str(cfg, "root") === effectiveRoot ? revealSessionProps(cfg) : {};
}

function revealSessionProps(cfg: Record<string, unknown>): EditorRevealSessionProps {
  return {
    ...(num(cfg, "revealLineStart") === undefined
      ? {}
      : { revealLineStart: num(cfg, "revealLineStart") }),
    ...(num(cfg, "revealLineEnd") === undefined
      ? {}
      : { revealLineEnd: num(cfg, "revealLineEnd") }),
    ...(str(cfg, "revealRequestId") === undefined
      ? {}
      : { revealRequestId: str(cfg, "revealRequestId") }),
  };
}

function editorSessionBaseProps(
  targetRoot: string | undefined,
  cfg: Record<string, unknown>,
  ctx: WindowRenderContext,
): EditorSessionBaseProps {
  const file = str(cfg, "file");
  return {
    linkedRoot: ctx.linkedRoot,
    linkedFilePath: ctx.linkedFilePath,
    linkedCapsuleIds: ctx.linkedCapsuleIds,
    linkedCapsuleSetIds: ctx.linkedCapsuleSetIds,
    windowId: ctx.windowId,
    openEditorFile: ctx.openEditorFile,
    onOpenGitCommit: (projectPath, commit) => {
      const target = gitObjectId(commit);
      if (target !== undefined) ctx.openWindow("governedGit", { projectPath, commit: target });
    },
    onOpenGitDiff: (projectPath, path) => {
      ctx.openWindow("governedGit", { projectPath, path });
    },
    onOpenProblems: (projectPath) => {
      ctx.openWindow("problems", { projectPath });
    },
    onOpenWorkspaceTrust: () => {
      ctx.openWindow("workspaceTrust");
    },
    onOpenDebugPanel: () => {
      if (targetRoot !== undefined) {
        ctx.openWindow("debug", {
          projectPath: targetRoot,
          ...(file === undefined ? {} : { activeFile: file }),
        });
      }
    },
    onAskSelection: (handoff) => {
      if (targetRoot === undefined) return false;
      const selectionHandoffId = registerEditorSelectionHandoff(targetRoot, handoff);
      if (selectionHandoffId === null) return false;
      const chatWindowId = ctx.openWindow("chat", { selectionHandoffId });
      if (chatWindowId !== null) return true;
      discardEditorSelectionHandoff(selectionHandoffId);
      return false;
    },
  };
}

export function FilesWindowSessionHost({
  cfg,
  ctx,
  root,
}: {
  readonly cfg: Record<string, unknown>;
  readonly ctx: WindowRenderContext;
  readonly root: string | undefined;
}): ReactNode {
  const t = useTranslate();
  const workspace = useWorkspaceManifest(root);
  const onActiveFileChange = (
    path: string | null,
    resolvedRoot: string | null,
    activeDirectoryPath?: string | null,
  ): void => {
    ctx.updateCfg({
      activeFilePath: path ?? undefined,
      resolvedRoot: resolvedRoot ?? undefined,
      ...(activeDirectoryPath === undefined
        ? {}
        : { activeDirectoryPath: activeDirectoryPath ?? undefined }),
    });
  };
  const onOpenFile = (fileRoot: string, path: string): void => {
    ctx.openEditorFile({ root: fileRoot, path });
  };
  const onOpenGitDelivery = (projectRoot: string): void => {
    ctx.openWindow("governedGit", { projectPath: projectRoot });
  };
  if (workspace.manifest !== null && workspace.manifest.roots.length > 1) {
    return (
      <MultiRootFilesWidget
        manifest={workspace.manifest}
        workspace={workspace}
        onActiveFileChange={onActiveFileChange}
        onOpenFile={onOpenFile}
        onOpenGitDelivery={onOpenGitDelivery}
      />
    );
  }
  // The Explorer root bar is navigation: "go up" and the path input both route here. Turning it
  // into workspace.addRoot made ordinary upward navigation fail, because a parent directory
  // overlaps the current root and manifest validation rejects overlapping roots. Adding a root
  // stays an explicit, separate action through AddRootToolbar in the multi-root Explorer.
  const onRootChange = (nextRoot: string): void => {
    ctx.updateCfg({
      root: nextRoot,
      activeFilePath: undefined,
      activeDirectoryPath: undefined,
      resolvedRoot: undefined,
    });
  };
  return (
    <>
      {workspace.issue === "mutation" ? (
        <p className="files-error" role="alert">
          {t("filesWidget.multiRoot.error")}
        </p>
      ) : null}
      <FilesWidget
        {...(root === undefined ? {} : { root })}
        onActiveFileChange={onActiveFileChange}
        onRootChange={onRootChange}
        onOpenFile={(fileRoot: string, path: string) =>
          ctx.openWindow("editor", { root: fileRoot, file: path, openFiles: [path] })
        }
        onOpenGitDelivery={onOpenGitDelivery}
      />
    </>
  );
}
