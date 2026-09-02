import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { disposeEditorModelRegistryRoot } from "@oscharko-dev/keiko-editor";
import type { WorkspaceManifest } from "@oscharko-dev/keiko-contracts";

import { updateChat } from "@/lib/api";
import { newClientCorrelationId } from "@/lib/http";
import { useTranslate } from "@/lib/i18n";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import type { Chat, ChatMessage, ProjectWithAvailability } from "@/lib/types";

import { ChatSessionProvider } from "../context/ChatSessionContext";
import {
  routeSelectionHandoffToOpenChat,
  usePublishChatWindowActivity,
  usePublishChatWindowRuntime,
  type ChatWindowRuntimeTarget,
} from "../windows/chatWindowActivity";
import { sharedFetchChats, useChatSession, type ChatSessionApi } from "../hooks/useChatSession";
import { useWorkspaceManifest, type WorkspaceManifestView } from "../hooks/useWorkspaceManifest";
import type { WindowRenderContext } from "../windows/WindowsRegistry";
import { CHAT_TITLE_IS_DEFAULT_CFG_KEY } from "../windows/connectionUtils";
import type { EditorWidgetProps, EditorWidgetWorkspacePatch } from "./cards/EditorWidget";
import {
  ManagedTaskWorkspaceUnavailable,
  type ManagedTaskWorkspaceAccess,
} from "./cards/ManagedTaskWorkspaceUnavailable";
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
  type EditorSelectionHandoff,
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

function bool(cfg: Record<string, unknown>, key: string): boolean | undefined {
  const value = cfg[key];
  return typeof value === "boolean" ? value : undefined;
}

// One predicate for "this window targets the bound managed task-workspace root and the paired
// read authority is not confirmed" — shared by the editor AND Files hosts (release-audit F-08) so
// the two surfaces can never disagree about when the managed root is presentable. The managed
// root lives under the deny-listed state area and is readable only through a launcher-paired app
// session (ADR-0141); when authority is missing the host renders the paired-session note instead
// of the raw denials.
function managedTaskWorkspaceAccess(
  ctx: WindowRenderContext,
  targetRoot: string | undefined,
  workspace: Pick<WorkspaceManifestView, "pathReadAuthority">,
): ManagedTaskWorkspaceAccess | null {
  return ctx.activeBinding !== null &&
    targetRoot === ctx.activeBinding.activeRoot &&
    workspace.pathReadAuthority !== "available"
    ? workspace.pathReadAuthority
    : null;
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
  attemptedAction: "open-project" | "open-chat" | "create-chat" | null;
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
  readonly attemptedAction: SelectionRouteAttempt["attemptedAction"];
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
  if (session.activeProject?.path !== workspaceRoot) {
    return args.attemptedAction === null
      ? { kind: "open-project", project }
      : { kind: "fail", noticeKey: "editor.askSelection.openFailed" };
  }
  const canRouteInsideProject =
    args.attemptedAction === null || args.attemptedAction === "open-project";
  if (!canRouteInsideProject) {
    return { kind: "fail", noticeKey: "editor.askSelection.openFailed" };
  }
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
  if (ref.current.id !== id) ref.current = { attemptedAction: null, id, inFlight: false };
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
    isOwnerCurrent?: () => boolean,
  ) => Promise<ChatCreationResult>;
}

interface ChatCreationResult {
  readonly chat: Chat | undefined;
  readonly titleSaveFailed: boolean;
}

interface ActiveChatCreation {
  readonly correlationId: string;
  desiredTitle: string | undefined;
  isOwnerCurrent: () => boolean;
  readonly projectPath: string | null;
  readonly promise: Promise<Chat | undefined>;
  reconciliation: Promise<ChatCreationResult> | null;
  titleRevision: number;
}

function chatCreationOwnerKey(owner: ChatCreationOwner): string {
  return `${owner.kind}\u0000${owner.id}`;
}

const CHAT_CREATION_REQUEST_DIAGNOSTIC = "Chat creation request failed.";
const CHAT_TITLE_UPDATE_DIAGNOSTIC = "Chat title update failed.";
const CHAT_PROJECT_LOOKUP_DIAGNOSTIC = "Chat project lookup failed.";

class ChatCreationRequestFailure extends Error {
  public constructor(readonly correlationId: string) {
    super(CHAT_CREATION_REQUEST_DIAGNOSTIC);
  }
}

function correlatedDiagnostic(message: string, correlationId: string): Error {
  return new Error(`${message} Correlation ID: ${correlationId}`);
}

export function normalizedChatTitle(title: string | undefined): string | undefined {
  const normalized = title?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

type ChatCreationReconciliationStep =
  | { readonly kind: "retry"; readonly chat: Chat }
  | { readonly kind: "settled"; readonly result: ChatCreationResult };

async function reconcileChatTitleRevision(
  active: ActiveChatCreation,
  chat: Chat,
  replaceChat: ChatSessionApi["replaceChat"],
  isCurrent: () => boolean,
): Promise<ChatCreationReconciliationStep> {
  const revision = active.titleRevision;
  const title = active.desiredTitle;
  if (title === undefined || chat.title === title) {
    return { kind: "settled", result: { chat, titleSaveFailed: false } };
  }
  try {
    const response = await updateChat(chat.id, { title });
    if (!isCurrent()) {
      return { kind: "settled", result: { chat: undefined, titleSaveFailed: false } };
    }
    if (revision !== active.titleRevision) return { kind: "retry", chat: response.chat };
    replaceChat(response.chat);
    return { kind: "settled", result: { chat: response.chat, titleSaveFailed: false } };
  } catch {
    window.reportError(correlatedDiagnostic(CHAT_TITLE_UPDATE_DIAGNOSTIC, active.correlationId));
    if (revision !== active.titleRevision) return { kind: "retry", chat };
    const result = isCurrent()
      ? { chat, titleSaveFailed: true }
      : { chat: undefined, titleSaveFailed: false };
    return { kind: "settled", result };
  }
}

async function reconcileActiveChatCreation(
  active: ActiveChatCreation,
  replaceChat: ChatSessionApi["replaceChat"],
  isCurrent: () => boolean,
): Promise<ChatCreationResult> {
  let chat: Chat | undefined;
  try {
    chat = await active.promise;
  } catch {
    throw new ChatCreationRequestFailure(active.correlationId);
  }
  if (chat === undefined || !isCurrent()) return { chat: undefined, titleSaveFailed: false };
  while (isCurrent()) {
    const step = await reconcileChatTitleRevision(active, chat, replaceChat, isCurrent);
    if (step.kind === "settled") return step.result;
    chat = step.chat;
  }
  return { chat: undefined, titleSaveFailed: false };
}

function activeCreationResult(
  active: ActiveChatCreation,
  replaceChat: ChatSessionApi["replaceChat"],
): Promise<ChatCreationResult> {
  if (active.reconciliation !== null) return active.reconciliation;
  const reconciliation = reconcileActiveChatCreation(active, replaceChat, (): boolean =>
    active.isOwnerCurrent(),
  );
  const tracked = reconciliation.finally((): void => {
    if (active.reconciliation === tracked) active.reconciliation = null;
  });
  active.reconciliation = tracked;
  return tracked;
}

function releaseSettledCreation(
  activeByOwner: Map<string, ActiveChatCreation>,
  ownerKey: string,
  created: ActiveChatCreation,
  result: Promise<ChatCreationResult>,
): void {
  const releaseIfCurrent = (): void => {
    if (activeByOwner.get(ownerKey) === created) activeByOwner.delete(ownerKey);
  };
  void result.then(releaseIfCurrent, releaseIfCurrent);
}

export function useChatCreationCoordinator(
  openNewChat: ChatSessionApi["openNewChat"],
  replaceChat: ChatSessionApi["replaceChat"],
): ChatCreationCoordinator {
  const activeByOwnerRef = useRef(new Map<string, ActiveChatCreation>());
  const request = useCallback<ChatCreationCoordinator["request"]>(
    (owner, project, title, isOwnerCurrent = (): boolean => true): Promise<ChatCreationResult> => {
      const projectPath = project?.path ?? null;
      const ownerKey = chatCreationOwnerKey(owner);
      let active = activeByOwnerRef.current.get(ownerKey);
      if (active === undefined) {
        const promise = openNewChat(project, title);
        const created: ActiveChatCreation = {
          correlationId: newClientCorrelationId(),
          desiredTitle: normalizedChatTitle(title),
          isOwnerCurrent,
          projectPath,
          promise,
          reconciliation: null,
          titleRevision: 0,
        };
        activeByOwnerRef.current.set(ownerKey, created);
        const result = activeCreationResult(created, replaceChat);
        releaseSettledCreation(activeByOwnerRef.current, ownerKey, created, result);
        return result;
      } else {
        active.isOwnerCurrent = isOwnerCurrent;
        if (owner.kind === "window" || title !== undefined) {
          active.desiredTitle = normalizedChatTitle(title);
          active.titleRevision += 1;
        }
      }
      return activeCreationResult(active, replaceChat);
    },
    [openNewChat, replaceChat],
  );
  const release = useCallback<ChatCreationCoordinator["release"]>((owner): void => {
    const ownerKey = chatCreationOwnerKey(owner);
    activeByOwnerRef.current.delete(ownerKey);
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
  const attemptRef = useRef<SelectionRouteAttempt>({
    attemptedAction: null,
    id: null,
    inFlight: false,
  });
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
      attemptedAction: attempt.attemptedAction,
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
    Object.assign(attempt, { attemptedAction: route.kind, inFlight: true });
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

interface ChatCreationRequestExecution {
  readonly activeProject: ProjectWithAvailability | undefined;
  readonly coordinator: ChatCreationCoordinator;
  readonly isCurrent: () => boolean;
  readonly owner: ChatCreationOwner;
  readonly requestKey: string;
  readonly setError: (error: ChatCreationError | null) => void;
  readonly title: string | undefined;
  readonly updateCfg: WindowRenderContext["updateCfg"];
}

interface ChatCreationAttemptState {
  active: {
    readonly coordinator: ChatCreationCoordinator;
    readonly owner: ChatCreationOwner;
  } | null;
  attemptedRequestKey: string | undefined;
  latestAttempt: number;
  sequence: number;
}

function invalidateChatCreationAttempt(state: ChatCreationAttemptState): void {
  state.sequence += 1;
  state.latestAttempt = state.sequence;
  state.attemptedRequestKey = undefined;
  state.active?.coordinator.release(state.active.owner);
  state.active = null;
}

function useChatCreationLifetime(stateRef: { readonly current: ChatCreationAttemptState }): {
  readonly current: boolean;
} {
  const mountedRef = useRef(true);
  const disposalRef = useRef<number | null>(null);
  useEffect((): (() => void) => {
    const state = stateRef.current;
    mountedRef.current = true;
    if (disposalRef.current !== null) window.clearTimeout(disposalRef.current);
    disposalRef.current = null;
    return (): void => {
      mountedRef.current = false;
      disposalRef.current = window.setTimeout((): void => {
        invalidateChatCreationAttempt(state);
        disposalRef.current = null;
      }, 0);
    };
  }, [stateRef]);
  return mountedRef;
}

function useIdentityRevision(identity: object): number {
  const stateRef = useRef({ identity, revision: 0 });
  if (stateRef.current.identity !== identity) {
    stateRef.current = { identity, revision: stateRef.current.revision + 1 };
  }
  return stateRef.current.revision;
}

function applyChatCreationResult(
  execution: ChatCreationRequestExecution,
  result: ChatCreationResult,
): void {
  if (result.chat === undefined) {
    execution.setError({
      chatId: undefined,
      messageKey: "chat.creation.openFailed",
      requestId: execution.requestKey,
    });
    return;
  }
  if (result.titleSaveFailed) {
    execution.setError({
      chatId: result.chat.id,
      messageKey: "chat.creation.titleSaveFailed",
      requestId: execution.requestKey,
    });
  }
  execution.updateCfg({
    chatId: result.chat.id,
    projectPath: result.chat.projectPath,
    title: result.chat.title,
    newChatRequestId: undefined,
  });
}

export function executeChatCreationRequest(execution: ChatCreationRequestExecution): Promise<void> {
  return execution.coordinator
    .request(execution.owner, execution.activeProject, execution.title, execution.isCurrent)
    .then(
      (result): void => {
        if (execution.isCurrent()) applyChatCreationResult(execution, result);
      },
      (error_): void => {
        const correlationId =
          error_ instanceof ChatCreationRequestFailure
            ? error_.correlationId
            : newClientCorrelationId();
        window.reportError(correlatedDiagnostic(CHAT_CREATION_REQUEST_DIAGNOSTIC, correlationId));
        if (!execution.isCurrent()) return;
        execution.setError({
          chatId: undefined,
          messageKey: "chat.creation.openFailed",
          requestId: execution.requestKey,
        });
      },
    );
}

function visibleChatCreationError(
  error: ChatCreationError | null,
  chatId: string | undefined,
  requestKey: string | undefined,
): SelectionHandoffNoticeKey | null {
  if (error === null || error.chatId !== chatId) return null;
  if (chatId === undefined && error.requestId !== requestKey) return null;
  return error.messageKey;
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
  const coordinatorRevision = useIdentityRevision(coordinator);
  const requestId = pending
    ? (newChatRequestId ?? `initial-unbound-chat-${String(coordinatorRevision)}`)
    : undefined;
  const projectPath = activeProject?.path ?? null;
  const requestKey = requestId === undefined ? undefined : `${requestId}\u0000${projectPath ?? ""}`;
  const attemptStateRef = useRef<ChatCreationAttemptState>({
    active: null,
    attemptedRequestKey: undefined,
    latestAttempt: 0,
    sequence: 0,
  });
  const currentRequestKeyRef = useRef(requestKey);
  currentRequestKeyRef.current = requestKey;
  const mountedRef = useChatCreationLifetime(attemptStateRef);

  useEffect((): void => {
    if (requestKey === undefined) {
      invalidateChatCreationAttempt(attemptStateRef.current);
      return;
    }
    if (loading || attemptStateRef.current.attemptedRequestKey === requestKey) return;
    const attempt = attemptStateRef.current.sequence + 1;
    // A request identity and project are the ownership boundary. The attempt only guards a
    // particular render generation; including it here would make navigating away and back to the
    // same still-pending request start a duplicate creation.
    const owner = { kind: "window", id: requestKey } as const;
    attemptStateRef.current.sequence = attempt;
    attemptStateRef.current.latestAttempt = attempt;
    attemptStateRef.current.attemptedRequestKey = requestKey;
    attemptStateRef.current.active = { coordinator, owner };
    setError(null);
    void executeChatCreationRequest({
      activeProject,
      coordinator,
      isCurrent: (): boolean =>
        mountedRef.current &&
        currentRequestKeyRef.current === requestKey &&
        attemptStateRef.current.latestAttempt === attempt,
      owner,
      requestKey,
      setError,
      title,
      updateCfg,
    });
  }, [activeProject, coordinator, loading, mountedRef, requestKey, title, updateCfg]);
  return { errorKey: visibleChatCreationError(error, chatId, requestKey), pending };
}

interface BoundChatRouting {
  readonly activeTarget: Chat | undefined;
  readonly lookupFailed: boolean;
  readonly resolvingLegacyProject: boolean;
  readonly switchingProject: boolean;
  readonly targetMissing: boolean;
}

type ChatProjectLookup =
  | { readonly kind: "found"; readonly path: string }
  | { readonly kind: "missing" }
  | { readonly kind: "failed" };

async function findChatProjectPath(
  chatId: string,
  projects: readonly ProjectWithAvailability[],
): Promise<ChatProjectLookup> {
  const projectChats = await Promise.all(
    projects.map(async (project): Promise<readonly Chat[] | undefined> => {
      try {
        return (await sharedFetchChats(project.path)).chats;
      } catch {
        window.reportError(
          correlatedDiagnostic(CHAT_PROJECT_LOOKUP_DIAGNOSTIC, newClientCorrelationId()),
        );
        return undefined;
      }
    }),
  );
  const found = projectChats
    .flatMap((chats): readonly Chat[] => chats ?? [])
    .find((chat): boolean => chat.id === chatId && chat.status !== "closed");
  if (found !== undefined) return { kind: "found", path: found.projectPath };
  return projectChats.includes(undefined) ? { kind: "failed" } : { kind: "missing" };
}

interface LegacyChatProjectPathArgs {
  readonly chatId: string | undefined;
  readonly chats: readonly Chat[];
  readonly configuredProjectPath: string | undefined;
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly persistProjectPath: boolean;
  readonly projects: readonly ProjectWithAvailability[];
  readonly updateCfg: WindowRenderContext["updateCfg"];
}

interface LegacyChatLookupEffectArgs {
  readonly chatId: string | undefined;
  readonly configuredProjectPath: string | undefined;
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly local: Chat | undefined;
  readonly lookup: ChatProjectLookup | undefined;
  readonly persistProjectPath: boolean;
  readonly projects: readonly ProjectWithAvailability[];
  readonly setLookup: (chatId: string, result: ChatProjectLookup) => void;
  readonly updateCfg: WindowRenderContext["updateCfg"];
}

function synchronizeLocalChatProjectLookup(args: LegacyChatLookupEffectArgs): boolean {
  if (args.local === undefined || args.chatId === undefined) return false;
  if (args.lookup?.kind === "found" && args.lookup.path === args.local.projectPath) return true;
  args.setLookup(args.chatId, { kind: "found", path: args.local.projectPath });
  if (args.persistProjectPath) args.updateCfg({ projectPath: args.local.projectPath });
  return true;
}

function startRemoteChatProjectLookup(
  args: LegacyChatLookupEffectArgs & { readonly chatId: string },
): (() => void) | undefined {
  if (args.lookup !== undefined) return undefined;
  if (args.projects.length === 0) {
    args.setLookup(
      args.chatId,
      args.error === undefined ? { kind: "missing" } : { kind: "failed" },
    );
    return undefined;
  }
  let active = true;
  void findChatProjectPath(args.chatId, args.projects).then((result): void => {
    if (!active) return;
    args.setLookup(args.chatId, result);
    if (result.kind === "found" && args.persistProjectPath) {
      args.updateCfg({ projectPath: result.path });
    }
  });
  return (): void => {
    active = false;
  };
}

function startLegacyChatProjectLookup(args: LegacyChatLookupEffectArgs): (() => void) | undefined {
  if (args.chatId === undefined || args.configuredProjectPath !== undefined || args.loading) return;
  if (synchronizeLocalChatProjectLookup(args)) return undefined;
  return startRemoteChatProjectLookup({ ...args, chatId: args.chatId });
}

function useLegacyChatProjectPath(args: LegacyChatProjectPathArgs): {
  readonly failed: boolean;
  readonly path: string | undefined;
  readonly pending: boolean;
} {
  const { chatId, chats, configuredProjectPath, loading, persistProjectPath, projects, updateCfg } =
    args;
  const [lookups, setLookups] = useState<ReadonlyMap<string, ChatProjectLookup>>(() => new Map());
  const local = chats.find((chat): boolean => chat.id === chatId && chat.status !== "closed");
  const lookup = chatId === undefined ? undefined : lookups.get(chatId);
  const setLookup = useCallback((id: string, result: ChatProjectLookup): void => {
    setLookups((current) => new Map(current).set(id, result));
  }, []);
  useEffect(
    (): (() => void) | undefined =>
      startLegacyChatProjectLookup({
        chatId,
        configuredProjectPath,
        error: args.error,
        loading,
        local,
        lookup,
        persistProjectPath,
        projects,
        setLookup,
        updateCfg,
      }),
    [
      chatId,
      configuredProjectPath,
      args.error,
      loading,
      local,
      lookup,
      persistProjectPath,
      projects,
      setLookup,
      updateCfg,
    ],
  );
  const path =
    configuredProjectPath ??
    local?.projectPath ??
    (lookup?.kind === "found" ? lookup.path : undefined);
  return {
    failed: lookup?.kind === "failed",
    path,
    pending: chatId !== undefined && path === undefined && lookup === undefined,
  };
}

function activeChatTarget(session: ChatSessionApi): Chat | undefined {
  return session.activeChat?.status === "closed" ? undefined : session.activeChat;
}

function boundChatTargetMissing(args: {
  readonly activeTargetId: string | undefined;
  readonly chatId: string | undefined;
  readonly legacyProjectPending: boolean;
  readonly lookupFailed: boolean;
  readonly liveTargetPresent: boolean;
  readonly loading: boolean;
  readonly selectionHandoffId: string | undefined;
  readonly switchingProject: boolean;
}): boolean {
  return (
    args.selectionHandoffId === undefined &&
    args.chatId !== undefined &&
    !args.loading &&
    !args.legacyProjectPending &&
    !args.lookupFailed &&
    args.activeTargetId !== args.chatId &&
    !args.switchingProject &&
    !args.liveTargetPresent
  );
}

function projectToOpen(
  projectPath: string | undefined,
  session: ChatSessionApi,
): ProjectWithAvailability | undefined {
  if (projectPath === undefined || session.activeProject?.path === projectPath) return undefined;
  return session.projects.find((project): boolean => project.path === projectPath);
}

function useProjectRouting(
  targetProject: ProjectWithAvailability | undefined,
  selectionHandoffId: string | undefined,
  session: ChatSessionApi,
): boolean {
  const attemptedPath = useRef<string | undefined>(undefined);
  const attemptGeneration = useRef(0);
  const [pendingPath, setPendingPath] = useState<string | undefined>();
  useEffect(
    () => (): void => {
      attemptGeneration.current += 1;
    },
    [],
  );
  useEffect((): void => {
    if (
      session.loading ||
      session.error !== undefined ||
      selectionHandoffId !== undefined ||
      targetProject === undefined
    )
      return;
    if (attemptedPath.current === targetProject.path) return;
    attemptedPath.current = targetProject.path;
    const generation = ++attemptGeneration.current;
    setPendingPath(targetProject.path);
    const settle = (): void => {
      if (attemptGeneration.current === generation) setPendingPath(undefined);
    };
    void session.openProject(targetProject).then(settle, settle);
  }, [selectionHandoffId, session, targetProject]);
  useEffect((): void => {
    if (pendingPath === undefined && (targetProject === undefined || session.error !== undefined)) {
      attemptedPath.current = undefined;
    }
  }, [pendingPath, session.error, targetProject]);
  return (targetProject !== undefined && session.error === undefined) || pendingPath !== undefined;
}

function projectRestoreFailed(
  session: ChatSessionApi,
  switchingProject: boolean,
  liveTargetPresent: boolean,
): boolean {
  return !switchingProject && session.error !== undefined && !liveTargetPresent;
}

function routingResult(
  activeTarget: Chat | undefined,
  legacyProject: ReturnType<typeof useLegacyChatProjectPath>,
  lookupFailed: boolean,
  switchingProject: boolean,
  targetMissing: boolean,
): BoundChatRouting {
  return {
    activeTarget,
    lookupFailed,
    resolvingLegacyProject: legacyProject.pending,
    switchingProject,
    targetMissing,
  };
}

function useBoundChatRouting(args: {
  readonly chatId: string | undefined;
  readonly configuredProjectPath: string | undefined;
  readonly projectPathPrivacy: "omit" | undefined;
  readonly selectionHandoffId: string | undefined;
  readonly session: ChatSessionApi;
  readonly updateCfg: WindowRenderContext["updateCfg"];
}): BoundChatRouting {
  const { chatId, selectionHandoffId, session } = args;
  const activeTarget = activeChatTarget(session);
  const legacyProject = useLegacyChatProjectPath({
    chatId,
    chats: session.chats,
    configuredProjectPath: args.configuredProjectPath,
    error: session.error,
    loading: session.loading,
    persistProjectPath: args.projectPathPrivacy !== "omit",
    projects: session.projects,
    updateCfg: args.updateCfg,
  });
  const targetProject = projectToOpen(legacyProject.path, session);
  const switchingProject = useProjectRouting(targetProject, selectionHandoffId, session);
  const liveTargetPresent = session.chats.some(
    (chat): boolean => chat.id === chatId && chat.status !== "closed",
  );
  const lookupFailed =
    legacyProject.failed || projectRestoreFailed(session, switchingProject, liveTargetPresent);
  const { chats, loading, openChat } = session;
  useEffect((): void => {
    if (loading || selectionHandoffId !== undefined || chatId === undefined) return;
    if (activeTarget?.id === chatId) return;
    const target = chats.find((chat): boolean => chat.id === chatId && chat.status !== "closed");
    if (target !== undefined) void openChat(target);
  }, [activeTarget?.id, chatId, chats, loading, openChat, selectionHandoffId]);
  const targetMissing = boundChatTargetMissing({
    activeTargetId: activeTarget?.id,
    chatId,
    legacyProjectPending: legacyProject.pending,
    lookupFailed,
    liveTargetPresent,
    loading: session.loading,
    selectionHandoffId,
    switchingProject,
  });
  return routingResult(activeTarget, legacyProject, lookupFailed, switchingProject, targetMissing);
}

interface MemoryPreference {
  readonly chatId: string | undefined;
  readonly configured: boolean | undefined;
  readonly value: boolean | undefined;
}

function configuredMemoryPreference(
  chatId: string | undefined,
  configured: boolean | undefined,
): MemoryPreference {
  return { chatId, configured, value: configured };
}

function useBoundMemorySession(args: {
  readonly activeTarget: Chat | undefined;
  readonly chatId: string | undefined;
  readonly configuredMemoryEnabled: boolean | undefined;
  readonly session: ChatSessionApi;
  readonly updateCfg: WindowRenderContext["updateCfg"];
}): { readonly hydrating: boolean; readonly session: ChatSessionApi } {
  const { activeTarget, chatId, configuredMemoryEnabled, session, updateCfg } = args;
  const preferenceRef = useRef(configuredMemoryPreference(chatId, configuredMemoryEnabled));
  if (
    preferenceRef.current.chatId !== chatId ||
    preferenceRef.current.configured !== configuredMemoryEnabled
  ) {
    preferenceRef.current = configuredMemoryPreference(chatId, configuredMemoryEnabled);
  }
  const setMemoryEnabled = useCallback(
    (next: boolean): void => {
      preferenceRef.current = {
        chatId,
        configured: preferenceRef.current.configured,
        value: next,
      };
      session.setMemoryEnabled(next);
      updateCfg({ memoryEnabled: next });
    },
    [chatId, session, updateCfg],
  );
  const scopedSession = useMemo<ChatSessionApi>(
    () => ({ ...session, setMemoryEnabled }),
    [session, setMemoryEnabled],
  );
  const preference = preferenceRef.current.value;
  const hydrating =
    chatId !== undefined &&
    activeTarget?.id === chatId &&
    preference !== undefined &&
    session.memoryEnabled !== preference;
  useEffect((): void => {
    if (!hydrating || preference === undefined) return;
    session.setMemoryEnabled(preference);
  }, [hydrating, preference, session]);
  return { hydrating, session: scopedSession };
}

function useBoundChatTitle(args: {
  readonly activeTarget: Chat | undefined;
  readonly chatId: string | undefined;
  readonly loading: boolean;
  readonly title: string | undefined;
  readonly updateCfg: WindowRenderContext["updateCfg"];
}): void {
  useEffect((): void => {
    const { activeTarget, chatId, loading, title, updateCfg } = args;
    if (loading || chatId === undefined || activeTarget?.id !== chatId) return;
    if (activeTarget.title === title) return;
    const materializesInitialTitle = normalizedChatTitle(title) === undefined;
    updateCfg(
      materializesInitialTitle
        ? { title: activeTarget.title }
        : { title: activeTarget.title, [CHAT_TITLE_IS_DEFAULT_CFG_KEY]: false },
    );
  }, [args]);
}

function ChatNotFound(): ReactNode {
  const agentT = useEditorAgentTranslate();
  return (
    <div className="lk-empty">
      <p className="lk-empty-title">{agentT("chat.restoration.notFoundTitle")}</p>
      <p className="lk-empty-body">{agentT("chat.restoration.notFoundBody")}</p>
    </div>
  );
}

// The chat bind is asynchronous: a lazy chunk, then a sequential session bootstrap. Named so an
// operator, a screen reader and a journey can each tell "still binding" from "bound with an empty
// transcript" — the two render identically otherwise, which is what made a stalled bind surface as a
// composer that was simply never found.
function ChatBindPending(): ReactNode {
  const agentT = useEditorAgentTranslate();
  return (
    <div className="lk-loading" role="status" data-chat-bind="opening">
      {agentT("chat.restoration.opening")}
    </div>
  );
}

function BoundChatBody({
  activeProjectPath,
  ctx,
  targetLookupFailed,
  targetMissing,
  waiting,
}: {
  readonly activeProjectPath: string | undefined;
  readonly ctx: WindowRenderContext;
  readonly targetLookupFailed: boolean;
  readonly targetMissing: boolean;
  readonly waiting: boolean;
}): ReactNode {
  const agentT = useEditorAgentTranslate();
  const openRunResult = useCallback(
    (message: ChatMessage): void => {
      if (message.runId === undefined) return;
      const runCfg: Record<string, string | number | boolean> = { runId: message.runId };
      const workflow = message.workflowId ?? message.taskType;
      if (workflow !== undefined) runCfg.workflow = workflow;
      const runRoot = ctx.activeRoot ?? activeProjectPath;
      if (runRoot !== undefined) runCfg.workspaceRoot = runRoot;
      ctx.openWindow("agents", runCfg);
    },
    [activeProjectPath, ctx],
  );
  if (targetLookupFailed) return null;
  if (targetMissing) return <ChatNotFound />;
  if (waiting) return <ChatBindPending />;
  return (
    <ChatWindow
      windowId={ctx.windowId}
      suspended={ctx.suspended === true}
      mini={ctx.mini === true}
      minimalChat={ctx.minimalChat === true}
      compact={ctx.compact === true}
      controlsNarrow={ctx.controlsNarrow === true}
      barCompact={ctx.barCompact === true}
      workflowCompact={ctx.workflowCompact === true}
      linkedRoot={ctx.activeRoot ?? ctx.linkedRoot}
      linkedRoots={ctx.linkedRoots}
      openEditorFile={ctx.openEditorFile}
      previewWindows={{ add: ctx.openWindow, focus: ctx.focusWindow, update: ctx.updateWindow }}
      onOpenRunResult={openRunResult}
    />
  );
}

interface BoundChatConfig {
  readonly chatId: string | undefined;
  readonly memoryEnabled: boolean | undefined;
  readonly newChatRequestId: string | undefined;
  readonly projectPath: string | undefined;
  readonly projectPathPrivacy: "omit" | undefined;
  readonly selectionHandoffId: string | undefined;
  readonly title: string | undefined;
}

function boundChatConfig(cfg: Record<string, unknown>): BoundChatConfig {
  const projectPathPrivacy = cfg["projectPathPrivacy"] === "omit" ? "omit" : undefined;
  return {
    chatId: str(cfg, "chatId"),
    memoryEnabled: bool(cfg, "memoryEnabled"),
    newChatRequestId: str(cfg, "newChatRequestId"),
    projectPath: str(cfg, "projectPath"),
    projectPathPrivacy,
    selectionHandoffId: str(cfg, "selectionHandoffId"),
    title: str(cfg, "title"),
  };
}

function ChatHostAlert({
  messageKey,
}: {
  readonly messageKey: SelectionHandoffNoticeKey | null;
}): ReactNode {
  const agentT = useEditorAgentTranslate();
  return messageKey === null ? null : (
    <p className="lk-alert" role="alert">
      {agentT(messageKey)}
    </p>
  );
}

function useBoundChatControls(
  configuration: BoundChatConfig,
  ctx: WindowRenderContext,
  session: ChatSessionApi,
): {
  readonly configuredProjectMissing: boolean;
  readonly creating: ChatCreationControl;
  readonly handoff: SelectionHandoffControl;
} {
  const coordinator = useChatCreationCoordinator(session.openNewChat, session.replaceChat);
  const handoff = useSelectionHandoffControl({
    chatId: configuration.chatId,
    coordinator,
    ctx,
    id: configuration.selectionHandoffId,
    session,
  });
  const configuredProject =
    configuration.projectPath === undefined
      ? session.activeProject
      : session.projects.find((project): boolean => project.path === configuration.projectPath);
  const configuredProjectMissing =
    !session.loading && configuration.projectPath !== undefined && configuredProject === undefined;
  const creating = useChatCreationControl({
    activeProject: configuredProject,
    chatId: configuration.chatId,
    coordinator,
    loading: session.loading || configuredProjectMissing,
    newChatRequestId: configuration.newChatRequestId,
    selectionHandoffId: configuration.selectionHandoffId,
    title: configuration.title,
    updateCfg: ctx.updateCfg,
  });
  return { configuredProjectMissing, creating, handoff };
}

function boundChatWaiting(args: {
  readonly chatId: string | undefined;
  readonly controls: ReturnType<typeof useBoundChatControls>;
  readonly memoryHydrating: boolean;
  readonly routing: BoundChatRouting;
  readonly sessionLoading: boolean;
}): boolean {
  return (
    args.sessionLoading ||
    args.controls.handoff.pending ||
    (!args.controls.configuredProjectMissing && args.controls.creating.pending) ||
    args.routing.switchingProject ||
    args.routing.resolvingLegacyProject ||
    args.memoryHydrating ||
    (args.chatId !== undefined && args.routing.activeTarget?.id !== args.chatId)
  );
}

export function ChatWindowSessionHost({
  cfg,
  ctx,
}: {
  readonly cfg: Record<string, unknown>;
  readonly ctx: WindowRenderContext;
}): ReactNode {
  const session = useChatSession({ autoCreate: false });
  return <BoundChatWindowSessionHost cfg={cfg} ctx={ctx} session={session} />;
}

interface BoundChatWindowSessionHostProps {
  readonly cfg: Record<string, unknown>;
  readonly ctx: WindowRenderContext;
  readonly session: ChatSessionApi;
}

function BoundChatAlerts({
  controls,
  lookupFailed,
}: {
  readonly controls: ReturnType<typeof useBoundChatControls>;
  readonly lookupFailed: boolean;
}): ReactNode {
  return (
    <>
      <ChatHostAlert messageKey={controls.handoff.noticeKey} />
      <ChatHostAlert messageKey={controls.creating.errorKey} />
      <ChatHostAlert messageKey={lookupFailed ? "chat.creation.openFailed" : null} />
    </>
  );
}

function useBoundChatWindowRuntime(
  configuration: BoundChatConfig,
  ctx: WindowRenderContext,
  routing: BoundChatRouting,
  session: ChatSessionApi,
): void {
  const { focusWindow, restoreWindow, updateCfg, windowId } = ctx;
  const { chatId, newChatRequestId, projectPath, selectionHandoffId } = configuration;
  usePublishChatWindowActivity(windowId, session.sending, session.latestGrounded);
  const runtimeTarget = useMemo<ChatWindowRuntimeTarget | undefined>(() => {
    if (newChatRequestId !== undefined || routing.lookupFailed || routing.targetMissing) {
      return undefined;
    }
    const activeTarget = routing.activeTarget;
    if (activeTarget !== undefined && activeTarget.id === chatId) {
      return { conversationId: activeTarget.id, projectPath: activeTarget.projectPath };
    }
    return chatId === undefined || projectPath === undefined
      ? undefined
      : { conversationId: chatId, projectPath };
  }, [
    chatId,
    newChatRequestId,
    projectPath,
    routing.activeTarget,
    routing.lookupFailed,
    routing.targetMissing,
  ]);
  const acceptSelectionHandoff = useCallback(
    (selectionHandoffId: string): void => {
      updateCfg({ selectionHandoffId, newChatRequestId: undefined });
      restoreWindow?.(windowId);
      focusWindow(windowId);
    },
    [focusWindow, restoreWindow, updateCfg, windowId],
  );
  usePublishChatWindowRuntime(
    windowId,
    runtimeTarget,
    acceptSelectionHandoff,
    selectionHandoffId === undefined,
  );
}

function useBoundChatTitleSync(
  configuration: BoundChatConfig,
  routing: BoundChatRouting,
  session: ChatSessionApi,
  ctx: WindowRenderContext,
): void {
  useBoundChatTitle({
    activeTarget: routing.activeTarget,
    chatId: configuration.chatId,
    loading: session.loading,
    title: configuration.title,
    updateCfg: ctx.updateCfg,
  });
}

function BoundChatWindowSessionHost({
  cfg,
  ctx,
  session,
}: BoundChatWindowSessionHostProps): ReactNode {
  const configuration = boundChatConfig(cfg);
  const routing = useBoundChatRouting({
    chatId: configuration.chatId,
    configuredProjectPath: configuration.projectPath,
    projectPathPrivacy: configuration.projectPathPrivacy,
    selectionHandoffId: configuration.selectionHandoffId,
    session,
    updateCfg: ctx.updateCfg,
  });
  useBoundChatWindowRuntime(configuration, ctx, routing, session);
  const memory = useBoundMemorySession({
    activeTarget: routing.activeTarget,
    chatId: configuration.chatId,
    configuredMemoryEnabled: configuration.memoryEnabled,
    session,
    updateCfg: ctx.updateCfg,
  });
  const controls = useBoundChatControls(configuration, ctx, session);
  const targetLookupFailed = routing.lookupFailed || controls.configuredProjectMissing;
  useBoundChatTitleSync(configuration, routing, session, ctx);
  const waitingForTarget = boundChatWaiting({
    chatId: configuration.chatId,
    controls,
    memoryHydrating: memory.hydrating,
    routing,
    sessionLoading: session.loading,
  });
  return (
    <ChatSessionProvider value={memory.session}>
      <BoundChatAlerts controls={controls} lookupFailed={targetLookupFailed} />
      <BoundChatBody
        activeProjectPath={session.activeProject?.path}
        ctx={ctx}
        targetLookupFailed={targetLookupFailed}
        targetMissing={routing.targetMissing}
        waiting={waitingForTarget}
      />
    </ChatSessionProvider>
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
      disposeEditorModelRegistryRoot(removed.canonicalRoot, true);
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
  const effectiveRoot = root ?? configuredRoot;
  const managedAccess = managedTaskWorkspaceAccess(ctx, effectiveRoot, workspace);
  const buildBaseProps = useCallback(
    (targetRoot: string): EditorSessionBaseProps => ({
      ...editorSessionBaseProps(targetRoot, cfg, ctx),
      ...addressedRevealProps(cfg, targetRoot),
    }),
    [cfg, ctx],
  );
  if (managedAccess !== null) {
    return (
      <ManagedTaskWorkspaceUnavailable
        access={managedAccess}
        onRetry={() => void workspace.refresh()}
      />
    );
  }
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

function routeEditorSelectionToChat(
  targetRoot: string | undefined,
  handoff: EditorSelectionHandoff,
  ctx: WindowRenderContext,
): boolean {
  if (targetRoot === undefined) return false;
  const selectionHandoffId = registerEditorSelectionHandoff(targetRoot, handoff);
  if (selectionHandoffId === null) return false;
  const openFallback = (): string | null => {
    return ctx.openWindow("chat", {
      projectPathPrivacy: "omit",
      selectionHandoffId,
    });
  };
  const abandonHandoff = (): void => {
    discardEditorSelectionHandoff(selectionHandoffId);
    reportClientDiagnostic(
      "[keiko] queued editor selection handoff could not be restored after chat closure",
    );
  };
  if (
    routeSelectionHandoffToOpenChat(
      targetRoot,
      selectionHandoffId,
      ctx.currentWindowStack?.() ?? [],
      openFallback,
      abandonHandoff,
    ) !== null
  ) {
    return true;
  }
  if (openFallback() !== null) return true;
  abandonHandoff();
  return false;
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
    workspaceTrustUiAvailable:
      ctx.activeBinding === null || targetRoot !== ctx.activeBinding.activeRoot,
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
    onAskSelection: (handoff) => routeEditorSelectionToChat(targetRoot, handoff, ctx),
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
  // Release-audit F-08: the bound managed task-workspace root is readable only through a
  // launcher-paired app session (ADR-0141). Without this gate — the same one the editor host
  // applies — an unpaired window rendered the raw denials ("Git unavailable", "The requested path
  // is excluded from the read surface.") instead of naming the real, actionable condition. The
  // deny list and the server's content-free deny reason stay untouched; this only presents them.
  const managedAccess = managedTaskWorkspaceAccess(ctx, root, workspace);
  if (managedAccess !== null) {
    return (
      <ManagedTaskWorkspaceUnavailable
        access={managedAccess}
        onRetry={() => void workspace.refresh()}
      />
    );
  }
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
        {...(root === undefined ? { onRootChange } : {})}
        onOpenFile={(fileRoot: string, path: string) =>
          ctx.openWindow("editor", { root: fileRoot, file: path, openFiles: [path] })
        }
        onOpenGitDelivery={onOpenGitDelivery}
      />
    </>
  );
}
