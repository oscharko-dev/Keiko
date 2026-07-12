import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { useTranslate } from "@/lib/i18n";
import type { Chat, ChatMessage, ProjectWithAvailability } from "@/lib/types";

import { useChatSessionContext } from "../context/ChatSessionContext";
import type { ChatSessionApi } from "../hooks/useChatSession";
import type { WindowRenderContext } from "../windows/WindowsRegistry";
import type { EditorWidgetProps } from "./cards/EditorWidget";
import { gitObjectId } from "./gitObjectId";
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
  "editor.askSelection.chatUnavailable" | "editor.askSelection.openFailed"
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
): Promise<unknown> {
  if (route.kind === "open-project") return session.openProject(route.project);
  if (route.kind === "open-chat") return session.openChat(route.chat);
  return session.openNewChat(route.project);
}

function currentRouteAttempt(
  ref: { current: SelectionRouteAttempt },
  id: string,
): SelectionRouteAttempt {
  if (ref.current.id !== id) ref.current = { attempted: false, id, inFlight: false };
  return ref.current;
}

function useSelectionHandoffControl(args: {
  readonly chatId: string | undefined;
  readonly ctx: WindowRenderContext;
  readonly id: string | undefined;
  readonly session: ChatSessionApi;
}): SelectionHandoffControl {
  const [noticeKey, setNoticeKey] = useState<SelectionHandoffNoticeKey | null>(null);
  const [revision, setRevision] = useState(0);
  const [settledId, setSettledId] = useState<string | null>(null);
  const attemptRef = useRef<SelectionRouteAttempt>({ attempted: false, id: null, inFlight: false });
  const { id, session } = args;
  useEffect(() => {
    if (id === undefined || settledId === id) return;
    const metadata = inspectEditorSelectionHandoff(id);
    if (metadata === null) return;
    const delay = Math.max(1, metadata.expiresAt - Date.now() + 1);
    const timeout = window.setTimeout(() => setRevision((value) => value + 1), delay);
    return () => window.clearTimeout(timeout);
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
      setNoticeKey(route.noticeKey);
      setSettledId(id);
      return;
    }
    if (route.kind === "consume") {
      const handoff = consumeEditorSelectionHandoff(id, route.workspaceRoot);
      if (handoff === null) {
        setRevision((value) => value + 1);
        return;
      }
      args.ctx.updateCfg({
        chatId: route.chat.id,
        title: route.chat.title,
        selectionHandoffId: undefined,
      });
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
      setRevision((value) => value + 1);
    };
    void routeSelectionHandoff(route, session).then(finish, finish);
  }, [args.chatId, args.ctx, id, revision, session, settledId]);
  return { noticeKey, pending: id !== undefined && settledId !== id };
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
  const creatingRef = useRef(false);
  const chatId = str(cfg, "chatId");
  const title = str(cfg, "title");
  const selectionHandoffId = str(cfg, "selectionHandoffId");
  const { updateCfg } = ctx;
  const { activeChat, activeProject, chats, loading, openChat, openNewChat } = session;
  const activeTarget =
    activeChat !== undefined && activeChat.status !== "closed" ? activeChat : undefined;
  const handoff = useSelectionHandoffControl({ chatId, ctx, id: selectionHandoffId, session });

  useEffect(() => {
    if (loading || selectionHandoffId !== undefined) return;
    if (chatId !== undefined) {
      if (activeTarget?.id === chatId) return;
      const target = chats.find((chat) => chat.id === chatId && chat.status !== "closed");
      if (target !== undefined) void openChat(target);
      return;
    }
    if (creatingRef.current) return;
    creatingRef.current = true;
    void openNewChat(undefined, title)
      .then((created) => {
        if (created !== undefined) updateCfg({ chatId: created.id, title: created.title });
      })
      .finally(() => {
        creatingRef.current = false;
      });
  }, [
    chatId,
    activeTarget?.id,
    chats,
    loading,
    openChat,
    openNewChat,
    selectionHandoffId,
    title,
    updateCfg,
  ]);

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
    session.loading || handoff.pending || (chatId !== undefined && activeTarget?.id !== chatId);
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

  const body = targetMissing ? (
    <div className="lk-empty">
      <p className="lk-empty-title">Chat not found</p>
      <p className="lk-empty-body">This conversation was deleted or is no longer available.</p>
    </div>
  ) : waitingForTarget ? (
    <div className="lk-loading">Opening chat...</div>
  ) : (
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
  return (
    <>
      {handoff.noticeKey === null ? null : (
        <p className="lk-alert" role="alert">
          {agentT(handoff.noticeKey)}
        </p>
      )}
      {body}
    </>
  );
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
  const file = str(cfg, "file");
  const openFiles = stringArray(cfg, "openFiles");
  const layoutJson = str(cfg, "layoutJson");
  const revealLineStart = num(cfg, "revealLineStart");
  const revealLineEnd = num(cfg, "revealLineEnd");
  const revealRequestId = str(cfg, "revealRequestId");
  const props: EditorWidgetProps = {
    ...(root === undefined ? {} : { root }),
    ...(file === undefined ? {} : { file }),
    ...(openFiles === undefined ? {} : { openFiles }),
    ...(layoutJson === undefined ? {} : { layoutJson }),
    ...(revealLineStart === undefined ? {} : { revealLineStart }),
    ...(revealLineEnd === undefined ? {} : { revealLineEnd }),
    ...(revealRequestId === undefined ? {} : { revealRequestId }),
    linkedRoot: ctx.linkedRoot,
    linkedFilePath: ctx.linkedFilePath,
    linkedCapsuleIds: ctx.linkedCapsuleIds,
    linkedCapsuleSetIds: ctx.linkedCapsuleSetIds,
    windowId: ctx.windowId,
    onWorkspaceChange: (patch) =>
      ctx.updateCfg({
        root: patch.root,
        file: patch.file,
        openFiles: patch.openFiles,
        layoutJson: patch.layoutJson,
      }),
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
    onAskSelection: (handoff) => {
      if (root === undefined) return false;
      const selectionHandoffId = registerEditorSelectionHandoff(root, handoff);
      if (selectionHandoffId === null) return false;
      const chatWindowId = ctx.openWindow("chat", { selectionHandoffId });
      if (chatWindowId !== null) return true;
      discardEditorSelectionHandoff(selectionHandoffId);
      return false;
    },
  };

  // A workspace switch remounts Monaco so models from the previous root cannot survive it.
  return <EditorWidget key={ctx.activeRoot ?? "unbound"} {...props} />;
}
