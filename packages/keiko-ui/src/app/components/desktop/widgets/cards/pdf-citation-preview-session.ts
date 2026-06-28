"use client";

import type {
  PdfCitationPreviewOpenResponse,
  PdfCitationPreviewAnchorQuality,
  PdfCitationPreviewDisplay,
  PdfCitationPreviewOpenAuthorized,
  PdfCitationPreviewOrigin,
  PdfCitationPreviewReasonCode,
} from "@oscharko-dev/keiko-contracts";
import { closePdfCitationPreviewSession } from "@/lib/api";
import type { LocalKnowledgeEvidenceCitation } from "@/lib/types";
import type { WorkspaceApi } from "../../hooks/useWorkspace.types";
import type { AppWindow, WindowCfgValue } from "../../windows/types";

export type PdfCitationPreviewZoomMode = "fit-width" | "fit-page" | "manual";

export interface PdfCitationPreviewSafeWindowCfg {
  readonly [key: string]: WindowCfgValue;
  readonly anchorQuality: PdfCitationPreviewAnchorQuality;
  readonly currentPage: number;
  readonly documentLabel: string;
  readonly failureMessage?: string;
  readonly failureRetryable?: boolean;
  readonly failureTitle?: string;
  readonly pageLabel?: string;
  readonly pageNumber?: number;
  readonly rotation: number;
  readonly sourceLabel?: string;
  readonly zoomMode: PdfCitationPreviewZoomMode;
  readonly zoomValue: number;
}

export interface PdfCitationPreviewContextCitation {
  readonly citation: Pick<
    LocalKnowledgeEvidenceCitation,
    "stableId" | "marker" | "label" | "source"
  >;
  readonly display: PdfCitationPreviewDisplay;
}

export interface PdfCitationPreviewOriginContext {
  readonly assistantMessageId: string;
  readonly chatId: string;
  readonly chatWindowId?: string;
  readonly marker: string;
  readonly representation: PdfCitationPreviewOrigin;
}

export interface PdfCitationPreviewAnswerContext {
  readonly activeStableId: string;
  readonly citations: readonly PdfCitationPreviewContextCitation[];
  readonly origin?: PdfCitationPreviewOriginContext;
}

interface PdfCitationPreviewSessionEntry {
  readonly display: PdfCitationPreviewDisplay;
  readonly context?: PdfCitationPreviewAnswerContext;
  readonly session: PdfCitationPreviewOpenAuthorized["session"];
}

interface PdfCitationPreviewRenderedChatWindow {
  readonly chatId: string;
  readonly messages: Map<string, HTMLElement>;
}

interface PdfCitationPreviewWorkspaceChatWindow {
  readonly chatId: string;
  readonly minimized: boolean;
}

interface PdfCitationPreviewBackNavigationRequest {
  readonly assistantMessageId: string;
  readonly chatId: string;
  readonly chatWindowId: string;
  readonly marker: string;
  readonly representation: PdfCitationPreviewOrigin;
}

export interface PdfCitationPreviewBackToChatAvailability {
  readonly enabled: boolean;
  readonly reason?: string;
}

interface PdfCitationPreviewBackToChatActions {
  readonly focusWindow: WorkspaceApi["focus"];
  readonly restoreWindow?: WorkspaceApi["restore"] | undefined;
}

const DEFAULT_ZOOM_MODE: PdfCitationPreviewZoomMode = "fit-width";
const DEFAULT_ZOOM_VALUE = 1;
const BACK_TO_CHAT_HIGHLIGHT_ATTR = "data-back-to-chat-highlighted";
const BACK_TO_CHAT_HIGHLIGHT_MS = 1800;
const CHAT_UNAVAILABLE_REASON = "The originating chat is no longer available.";
const MESSAGE_UNAVAILABLE_REASON = "The originating answer is no longer available.";
const previewSessionsByWindowId = new Map<string, PdfCitationPreviewSessionEntry>();
const renderedChatWindowsById = new Map<string, PdfCitationPreviewRenderedChatWindow>();
const workspaceChatWindowsById = new Map<string, PdfCitationPreviewWorkspaceChatWindow>();
const pendingBackNavigationByChatWindowId = new Map<
  string,
  PdfCitationPreviewBackNavigationRequest
>();
const highlightTimersByElement = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
const registryListeners = new Set<() => void>();

function emitRegistryChange(): void {
  for (const listener of registryListeners) {
    listener();
  }
}

function safePageNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 1;
}

function baseSafeWindowCfg(
  display: PdfCitationPreviewDisplay,
  initialPage: number | undefined,
): PdfCitationPreviewSafeWindowCfg {
  return {
    documentLabel: display.documentLabel,
    ...(display.sourceLabel === undefined ? {} : { sourceLabel: display.sourceLabel }),
    ...(display.pageNumber === undefined ? {} : { pageNumber: display.pageNumber }),
    ...(display.pageLabel === undefined ? {} : { pageLabel: display.pageLabel }),
    anchorQuality: display.anchorQuality,
    currentPage: safePageNumber(initialPage ?? display.pageNumber),
    zoomMode: DEFAULT_ZOOM_MODE,
    zoomValue: DEFAULT_ZOOM_VALUE,
    rotation: 0,
  };
}

function activeFailureCopy(reason: PdfCitationPreviewReasonCode): {
  readonly message: string;
  readonly retryable: boolean;
  readonly title: string;
} {
  switch (reason) {
    case "preview-metadata-missing":
      return {
        title: "Preview recovery required",
        message:
          "Keiko can no longer verify this citation for immediate PDF preview. Reopen the answer after the preview metadata is refreshed.",
        retryable: false,
      };
    case "document-not-ready":
      return {
        title: "Preview not ready",
        message:
          "Keiko is still preparing the verified PDF source for preview. Reopen the citation when preparation completes.",
        retryable: false,
      };
    case "document-content-mismatch":
      return {
        title: "Preview changed",
        message:
          "The verified PDF bytes changed after this answer was generated. Keiko will not bypass the original citation hash.",
        retryable: false,
      };
    case "page-provenance-missing":
      return {
        title: "Preview recovery required",
        message:
          "Keiko can verify the PDF source, but the cited page anchor is no longer available for preview.",
        retryable: false,
      };
    case "preview-source-missing":
      return {
        title: "Preview source unavailable",
        message: "The verified PDF source is no longer available for preview.",
        retryable: false,
      };
    case "preview-source-unreadable":
      return {
        title: "Preview temporarily unavailable",
        message:
          "Keiko could not read the verified PDF safely. Reopen the citation to request a fresh preview session.",
        retryable: false,
      };
    case "preview-source-oversized":
      return {
        title: "Preview too large",
        message: "The verified PDF exceeds the passive preview size limit for this viewer.",
        retryable: false,
      };
    case "stable-id-mismatch":
    case "citation-not-found":
      return {
        title: "Preview unavailable",
        message:
          "This citation no longer matches the structured grounded-answer metadata for this response.",
        retryable: false,
      };
    case "assistant-message-not-found":
    case "assistant-message-chat-mismatch":
    case "grounded-answer-missing":
    case "not-local-knowledge-citation":
      return {
        title: "Preview unavailable",
        message:
          "This answer no longer carries a verified Local Knowledge PDF preview for the selected citation.",
        retryable: false,
      };
    case "lineage-missing":
      return {
        title: "Preview unavailable",
        message: "Keiko can no longer trace this citation to a verified PDF source.",
        retryable: false,
      };
    case "lineage-mismatch":
      return {
        title: "Preview unavailable",
        message: "The citation lineage no longer matches the verified PDF source for this answer.",
        retryable: false,
      };
    case "document-not-pdf":
      return {
        title: "Preview unavailable",
        message: "The verified citation source is no longer a PDF.",
        retryable: false,
      };
    default:
      return {
        title: "Preview unavailable",
        message: "Keiko could not open the verified PDF preview for this citation.",
        retryable: false,
      };
  }
}

function failureSafeWindowCfg(
  response: Extract<PdfCitationPreviewOpenResponse, { readonly outcome: "rejected" }>,
  initialPage: number | undefined,
): PdfCitationPreviewSafeWindowCfg {
  const copy = activeFailureCopy(response.reason);
  const display =
    response.display ??
    ({
      anchorQuality: "page-only",
      documentLabel: "PDF Preview",
    } satisfies PdfCitationPreviewDisplay);
  return {
    ...baseSafeWindowCfg(display, initialPage),
    failureTitle: copy.title,
    failureMessage: copy.message,
    failureRetryable: copy.retryable,
  };
}

function windowIdForSessionHandle(sessionHandle: string): string | undefined {
  for (const [windowId, entry] of previewSessionsByWindowId) {
    if (entry.session.handle === sessionHandle) {
      return windowId;
    }
  }
  return undefined;
}

function openCitationChipDisclosure(messageElement: HTMLElement): void {
  const disclosure = messageElement.querySelector<HTMLDetailsElement>(
    ".grounded-evidence-disclosure",
  );
  if (disclosure !== null && disclosure.open === false) {
    disclosure.open = true;
  }
}

function findInlineMarkerTarget(messageElement: HTMLElement, marker: string): HTMLElement | null {
  const targets = messageElement.querySelectorAll<HTMLElement>(".citation-inline-marker");
  return (
    Array.from(targets).find((target) => {
      if (target.textContent?.trim() !== marker) return false;
      return target.closest('.chat-msg-content[data-collapsed="true"]') === null;
    }) ?? null
  );
}

function findCitationChipTarget(messageElement: HTMLElement, marker: string): HTMLElement | null {
  openCitationChipDisclosure(messageElement);
  const buttons = messageElement.querySelectorAll<HTMLButtonElement>(".grounded-citation-action");
  return (
    Array.from(buttons).find((button) =>
      (button.getAttribute("aria-label") ?? "").startsWith(`${marker} `),
    ) ?? null
  );
}

function findBackNavigationTarget(
  messageElement: HTMLElement,
  marker: string,
  preferred: PdfCitationPreviewOrigin,
): HTMLElement | null {
  const primary =
    preferred === "inline-marker"
      ? findInlineMarkerTarget(messageElement, marker)
      : findCitationChipTarget(messageElement, marker);
  if (primary !== null) {
    return primary;
  }
  return preferred === "inline-marker"
    ? findCitationChipTarget(messageElement, marker)
    : findInlineMarkerTarget(messageElement, marker);
}

function applyBackNavigationHighlight(element: HTMLElement): void {
  const existingTimer = highlightTimersByElement.get(element);
  if (existingTimer !== undefined) {
    clearTimeout(existingTimer);
  }
  element.setAttribute(BACK_TO_CHAT_HIGHLIGHT_ATTR, "true");
  const timer = setTimeout(() => {
    element.removeAttribute(BACK_TO_CHAT_HIGHLIGHT_ATTR);
    highlightTimersByElement.delete(element);
  }, BACK_TO_CHAT_HIGHLIGHT_MS);
  highlightTimersByElement.set(element, timer);
}

function consumePendingBackNavigation(chatWindowId: string): void {
  const request = pendingBackNavigationByChatWindowId.get(chatWindowId);
  if (request === undefined) return;
  const renderedWindow = renderedChatWindowsById.get(chatWindowId);
  if (renderedWindow === undefined || renderedWindow.chatId !== request.chatId) return;
  const messageElement = renderedWindow.messages.get(request.assistantMessageId);
  if (messageElement === undefined) return;

  pendingBackNavigationByChatWindowId.delete(chatWindowId);
  messageElement.scrollIntoView({ block: "center", inline: "nearest" });

  const target = findBackNavigationTarget(messageElement, request.marker, request.representation);
  if (target !== null) {
    target.focus({ preventScroll: true });
    applyBackNavigationHighlight(target);
    return;
  }

  messageElement.focus({ preventScroll: true });
}

function removeRenderedChatWindow(windowId: string): void {
  if (!renderedChatWindowsById.delete(windowId)) return;
  emitRegistryChange();
}

function workspaceChatWindowForOrigin(
  origin: PdfCitationPreviewOriginContext | undefined,
): PdfCitationPreviewWorkspaceChatWindow | undefined {
  if (origin?.chatWindowId === undefined) return undefined;
  return workspaceChatWindowsById.get(origin.chatWindowId);
}

function renderedChatWindowForOrigin(
  origin: PdfCitationPreviewOriginContext | undefined,
): PdfCitationPreviewRenderedChatWindow | undefined {
  if (origin?.chatWindowId === undefined) return undefined;
  return renderedChatWindowsById.get(origin.chatWindowId);
}

function backToChatAvailability(
  origin: PdfCitationPreviewOriginContext | undefined,
): PdfCitationPreviewBackToChatAvailability {
  if (origin?.chatWindowId === undefined) {
    return { enabled: false, reason: CHAT_UNAVAILABLE_REASON };
  }

  const workspaceChatWindow = workspaceChatWindowForOrigin(origin);
  if (workspaceChatWindow === undefined || workspaceChatWindow.chatId !== origin.chatId) {
    return { enabled: false, reason: CHAT_UNAVAILABLE_REASON };
  }

  const renderedChatWindow = renderedChatWindowForOrigin(origin);
  if (renderedChatWindow === undefined) {
    return workspaceChatWindow.minimized
      ? { enabled: true }
      : { enabled: false, reason: CHAT_UNAVAILABLE_REASON };
  }
  if (
    renderedChatWindow.chatId === origin.chatId &&
    !renderedChatWindow.messages.has(origin.assistantMessageId)
  ) {
    return { enabled: false, reason: MESSAGE_UNAVAILABLE_REASON };
  }

  return { enabled: true };
}

export function openPdfCitationPreviewWindow(
  openWindow: WorkspaceApi["add"],
  preview: PdfCitationPreviewOpenAuthorized,
  options?: {
    readonly context?: PdfCitationPreviewAnswerContext | undefined;
    readonly currentPage?: number | undefined;
  },
): string | null {
  const windowId = openWindow(
    "pdfCitationPreview",
    baseSafeWindowCfg(preview.display, options?.currentPage),
  );
  if (windowId !== null) {
    previewSessionsByWindowId.set(windowId, {
      ...(options?.context === undefined ? {} : { context: options.context }),
      display: preview.display,
      session: preview.session,
    });
    emitRegistryChange();
  }
  return windowId;
}

export function getPdfCitationPreviewSession(
  windowId: string,
): PdfCitationPreviewSessionEntry | undefined {
  return previewSessionsByWindowId.get(windowId);
}

export function subscribePdfCitationPreviewRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

export function getPdfCitationPreviewBackToChatAvailability(
  windowId: string,
): PdfCitationPreviewBackToChatAvailability {
  return backToChatAvailability(previewSessionsByWindowId.get(windowId)?.context?.origin);
}

export function activatePdfCitationPreviewContext(
  windowId: string,
  stableId: string,
): PdfCitationPreviewContextCitation | undefined {
  const existing = previewSessionsByWindowId.get(windowId);
  const context = existing?.context;
  if (existing === undefined || context === undefined) return undefined;
  const nextCitation = context.citations.find(
    (citation) => citation.citation.stableId === stableId,
  );
  if (nextCitation === undefined) return undefined;
  if (context.activeStableId === stableId && existing.display === nextCitation.display) {
    return nextCitation;
  }
  previewSessionsByWindowId.set(windowId, {
    ...existing,
    display: nextCitation.display,
    context: {
      ...context,
      activeStableId: stableId,
    },
  });
  emitRegistryChange();
  return nextCitation;
}

export function activatePdfCitationPreviewBackToChat(
  windowId: string,
  actions: PdfCitationPreviewBackToChatActions,
): boolean {
  const entry = previewSessionsByWindowId.get(windowId);
  const origin = entry?.context?.origin;
  const availability = backToChatAvailability(origin);
  if (!availability.enabled || origin?.chatWindowId === undefined) {
    return false;
  }
  const chatWindowId = origin.chatWindowId;

  pendingBackNavigationByChatWindowId.set(chatWindowId, {
    assistantMessageId: origin.assistantMessageId,
    chatId: origin.chatId,
    chatWindowId,
    marker: origin.marker,
    representation: origin.representation,
  });
  actions.restoreWindow?.(chatWindowId);
  actions.focusWindow(chatWindowId);
  queueMicrotask(() => {
    consumePendingBackNavigation(chatWindowId);
  });
  return true;
}

export function registerPdfCitationPreviewMessageTarget(args: {
  readonly assistantMessageId: string;
  readonly chatId: string;
  readonly chatWindowId: string;
  readonly element: HTMLElement;
}): () => void {
  const windowEntry = renderedChatWindowsById.get(args.chatWindowId);
  if (windowEntry === undefined) {
    renderedChatWindowsById.set(args.chatWindowId, {
      chatId: args.chatId,
      messages: new Map([[args.assistantMessageId, args.element]]),
    });
  } else {
    windowEntry.messages.set(args.assistantMessageId, args.element);
    if (windowEntry.chatId !== args.chatId) {
      renderedChatWindowsById.set(args.chatWindowId, {
        chatId: args.chatId,
        messages: windowEntry.messages,
      });
    }
  }
  emitRegistryChange();
  consumePendingBackNavigation(args.chatWindowId);

  return () => {
    const current = renderedChatWindowsById.get(args.chatWindowId);
    if (current === undefined) return;
    current.messages.delete(args.assistantMessageId);
    if (current.messages.size === 0) {
      removeRenderedChatWindow(args.chatWindowId);
      return;
    }
    emitRegistryChange();
  };
}

export function showPdfCitationPreviewResult(
  windows: Pick<WorkspaceApi, "add" | "focus" | "update">,
  preview: PdfCitationPreviewOpenResponse,
  options?: {
    readonly context?: PdfCitationPreviewAnswerContext | undefined;
    readonly currentPage?: number | undefined;
  },
): string | null {
  if (preview.outcome === "authorized") {
    const existingWindowId = windowIdForSessionHandle(preview.session.handle);
    if (existingWindowId !== undefined) {
      previewSessionsByWindowId.set(existingWindowId, {
        ...(options?.context === undefined ? {} : { context: options.context }),
        display: preview.display,
        session: preview.session,
      });
      emitRegistryChange();
      windows.update(existingWindowId, {
        cfg: baseSafeWindowCfg(preview.display, options?.currentPage),
      });
      windows.focus(existingWindowId);
      return existingWindowId;
    }
    return openPdfCitationPreviewWindow(windows.add, preview, options);
  }
  return windows.add("pdfCitationPreview", failureSafeWindowCfg(preview, options?.currentPage));
}

export function syncPdfCitationPreviewWindowRegistry(wins: readonly AppWindow[] | null): void {
  let changed = false;
  const activeWindowIds = new Set(
    (wins ?? []).filter((win) => win.type === "pdfCitationPreview").map((win) => win.id),
  );
  for (const [windowId, entry] of previewSessionsByWindowId) {
    if (activeWindowIds.has(windowId)) continue;
    previewSessionsByWindowId.delete(windowId);
    changed = true;
    void closePdfCitationPreviewSession(entry.session.handle).catch(() => {
      // Closing a missing/expired preview is best-effort only; the server TTL is the fail-safe.
    });
  }
  const nextWorkspaceChatWindows = new Map<string, PdfCitationPreviewWorkspaceChatWindow>();
  for (const win of wins ?? []) {
    if (win.type !== "chat") continue;
    const chatId = typeof win.cfg["chatId"] === "string" ? win.cfg["chatId"] : "";
    if (chatId.length === 0) continue;
    nextWorkspaceChatWindows.set(win.id, { chatId, minimized: win.minimized === true });
  }
  for (const windowId of workspaceChatWindowsById.keys()) {
    if (nextWorkspaceChatWindows.has(windowId)) continue;
    workspaceChatWindowsById.delete(windowId);
    renderedChatWindowsById.delete(windowId);
    pendingBackNavigationByChatWindowId.delete(windowId);
    changed = true;
  }
  for (const [windowId, entry] of nextWorkspaceChatWindows) {
    const previous = workspaceChatWindowsById.get(windowId);
    if (previous?.chatId === entry.chatId && previous.minimized === entry.minimized) continue;
    workspaceChatWindowsById.set(windowId, entry);
    changed = true;
  }
  if (changed) {
    emitRegistryChange();
  }
}

export function clearPdfCitationPreviewWindowRegistryForTests(): void {
  previewSessionsByWindowId.clear();
  renderedChatWindowsById.clear();
  workspaceChatWindowsById.clear();
  pendingBackNavigationByChatWindowId.clear();
}
