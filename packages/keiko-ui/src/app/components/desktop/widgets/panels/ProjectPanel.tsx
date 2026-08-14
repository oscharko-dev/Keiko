"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { Chat, ProjectWithAvailability } from "@/lib/types";
import { Icons } from "../../Icons";
import { useChatSessionActions, useChatSessionCatalog } from "../../context/ChatSessionContext";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const ChevronRIcon = Icons.chevronR;
const FolderIcon = Icons.folder;

// KEIKO-0262 layout: styled inline to avoid touching globals.css (SHA-pinned visual-proof gate,
// #1300). Preserves the previous single-row project-header appearance now that the caret is a
// physically separate button.
const PROJ_HEAD_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  width: "100%",
  gap: "2px",
};
// WCAG 2.5.8 Target Size (Minimum): the caret's pointer target is 24×24 CSS pixels; the
// visible chevron stays at 13px and is centered by placeItems (Codex on PR #3089: 3766009390).
const PROJ_CARET_BTN_STYLE: CSSProperties = {
  display: "grid",
  placeItems: "center",
  flexShrink: 0,
  width: "24px",
  height: "24px",
  padding: 0,
  margin: 0,
  border: 0,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
};
const PROJECT_CHAT_GROUP_STYLE: CSSProperties = { border: 0, margin: 0, minWidth: 0 };

interface ProjectRowProps {
  readonly project: ProjectWithAvailability;
  readonly activeProjectPath: string | undefined;
  readonly chats: readonly Chat[];
  readonly activeChatId: string | undefined;
  readonly onProject: (project: ProjectWithAvailability) => void;
  readonly onChat: (chat: Chat) => void;
  readonly treeRef: React.RefObject<HTMLDivElement | null>;
}

function projectAvailabilityLabel(project: ProjectWithAvailability): string {
  return project.available ? "Available" : "Unavailable";
}

// Roving-tabindex key set — mirrors FilesWidget TREE_NAV_KEYS (audit PA-03).
const TREE_NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"]);

function getTreeItems(container: HTMLDivElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button[role='treeitem']"));
}

interface TreeKeyContext {
  readonly items: HTMLButtonElement[];
  readonly index: number;
  readonly btn: HTMLButtonElement;
}

function focusNextTreeItem({ items, index }: TreeKeyContext): void {
  items[index + 1]?.focus();
}

function focusPreviousTreeItem({ items, index }: TreeKeyContext): void {
  items[index - 1]?.focus();
}

function focusFirstTreeItem({ items }: TreeKeyContext): void {
  items[0]?.focus();
}

function focusLastTreeItem({ items }: TreeKeyContext): void {
  items.at(-1)?.focus();
}

function focusParentTreeItem({ items, index }: TreeKeyContext): void {
  const level = Number(items[index]?.getAttribute("aria-level") ?? "1");
  for (let i = index - 1; i >= 0; i -= 1) {
    if (Number(items[i]?.getAttribute("aria-level") ?? "1") < level) {
      items[i]?.focus();
      break;
    }
  }
}

// KEIKO-0262: expansion is a distinct capability from activation. ArrowRight/ArrowLeft dispatch
// to the sibling caret button (mirroring FilesWidget's `.tr-caret-btn` pattern), so the head
// button's own onClick — which triggers openProject and discards the composer draft — never fires
// on a pure keyboard expand/collapse.
function caretButtonFor(btn: HTMLButtonElement): HTMLButtonElement | null {
  return btn.closest(".proj")?.querySelector<HTMLButtonElement>("button.proj-caret-btn") ?? null;
}

function expandOrFocusNextTreeItem(context: TreeKeyContext): void {
  // Expand if collapsed, else move to first child.
  const { btn } = context;
  if (btn.getAttribute("aria-expanded") === "false") {
    caretButtonFor(btn)?.click();
  } else if (btn.getAttribute("aria-expanded") === "true") {
    focusNextTreeItem(context);
  }
}

function collapseOrFocusParentTreeItem(context: TreeKeyContext): void {
  // Collapse if expanded; otherwise move to parent (lower aria-level).
  if (context.btn.getAttribute("aria-expanded") === "true") {
    caretButtonFor(context.btn)?.click();
  } else {
    focusParentTreeItem(context);
  }
}

// Key-to-handler registry — keeps handleTreeKey a flat dispatch instead of a branchy chain.
const TREE_KEY_HANDLERS: Record<string, (context: TreeKeyContext) => void> = {
  ArrowDown: focusNextTreeItem,
  ArrowUp: focusPreviousTreeItem,
  Home: focusFirstTreeItem,
  End: focusLastTreeItem,
  ArrowRight: expandOrFocusNextTreeItem,
  ArrowLeft: collapseOrFocusParentTreeItem,
};

function handleTreeKey(event: ReactKeyboardEvent<HTMLDivElement>, container: HTMLDivElement): void {
  const items = getTreeItems(container);
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const btn = target.closest<HTMLButtonElement>("button[role='treeitem']");
  if (btn === null) return;
  const index = items.indexOf(btn);
  if (index < 0) return;
  event.preventDefault();
  TREE_KEY_HANDLERS[event.key]?.({ items, index, btn });
}

interface ProjectHeadButtonProps {
  readonly project: ProjectWithAvailability;
  readonly isActiveProject: boolean;
  readonly expanded: boolean;
  readonly availabilityLabel: string;
  readonly treeRef: React.RefObject<HTMLDivElement | null>;
  readonly onActivate: () => void;
  readonly onToggleExpanded: () => void;
}

function ProjectCaretButton({
  project,
  expanded,
  onToggleExpanded,
}: {
  readonly project: ProjectWithAvailability;
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
}): ReactNode {
  return (
    <button
      className="proj-caret-btn"
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`}
      style={PROJ_CARET_BTN_STYLE}
      // Codex on PR #3089: Chromium focuses <button> on click even at tabIndex={-1}, and the
      // caret is aria-hidden and not a role="treeitem", so `handleTreeKey` cannot find a
      // treeitem from the event target and Arrow/Home/End stops working until focus moves. Prevent
      // the caret from taking focus on click.
      onMouseDown={(event) => event.preventDefault()}
      // Codex 3765267604: when focus is on a chat child (aria-level 2) of THIS expanded project
      // and the user collapses via caret click, `onToggleExpanded` unmounts the child and focus
      // falls out of the tree entirely, breaking subsequent Arrow/Home/End navigation. Move focus
      // to the sibling head treeitem before collapsing so a focused element always survives.
      onClick={(event) => {
        const row = event.currentTarget.closest<HTMLDivElement>(".proj-head-row");
        row?.querySelector<HTMLButtonElement>("button.proj-head")?.focus();
        onToggleExpanded();
      }}
    >
      <span className="proj-caret" data-open={expanded} aria-hidden="true">
        <ChevronRIcon size={13} />
      </span>
    </button>
  );
}

// KEIKO-0262: the head-button click activates (opens the project), the sibling caret button
// toggles expansion only. ArrowRight/ArrowLeft on the treeitem dispatches to the caret, so
// keyboard-only expansion never fires openProject (which discards the composer draft).
function ProjectHeadButton({
  project,
  isActiveProject,
  expanded,
  availabilityLabel,
  treeRef,
  onActivate,
  onToggleExpanded,
}: ProjectHeadButtonProps): ReactNode {
  const clearRovingTabindex = (): void => {
    if (treeRef.current === null) return;
    getTreeItems(treeRef.current).forEach((item) => {
      item.tabIndex = -1;
    });
  };
  return (
    <div className="proj-head-row" style={PROJ_HEAD_ROW_STYLE}>
      <ProjectCaretButton
        project={project}
        expanded={expanded}
        onToggleExpanded={onToggleExpanded}
      />
      <button
        className="proj-head"
        type="button"
        role="treeitem"
        aria-level={1}
        aria-expanded={expanded}
        aria-selected={isActiveProject}
        data-active={isActiveProject ? "true" : "false"}
        aria-current={isActiveProject ? "true" : undefined}
        aria-label={`${project.name} (${availabilityLabel})`}
        tabIndex={isActiveProject ? 0 : -1}
        onClick={() => {
          onActivate();
          clearRovingTabindex();
        }}
      >
        <FolderIcon size={15} aria-hidden="true" />
        <span className="proj-name">{project.name}</span>
        <span className="chat-time">{availabilityLabel}</span>
      </button>
    </div>
  );
}

interface ProjectChatListProps {
  readonly project: ProjectWithAvailability;
  readonly chats: readonly Chat[];
  readonly activeChatId: string | undefined;
  readonly isActiveProject: boolean;
  readonly onChat: (chat: Chat) => void;
}

// Extracted from ProjectRow (#2723 / CodeRabbit): keeps the owning row under the 50-line limit.
function ProjectChatList({
  project,
  chats,
  activeChatId,
  isActiveProject,
  onChat,
}: ProjectChatListProps): ReactNode {
  return (
    <fieldset className="proj-chats" aria-label={project.name} style={PROJECT_CHAT_GROUP_STYLE}>
      {isActiveProject && chats.length === 0 && <div className="proj-empty">{"No chats"}</div>}
      {isActiveProject &&
        chats.length > 0 &&
        chats.map((chat) => (
          <button
            key={chat.id}
            type="button"
            role="treeitem"
            aria-level={2}
            aria-selected={activeChatId === chat.id}
            className="chat-row"
            data-active={activeChatId === chat.id}
            tabIndex={-1}
            onClick={() => {
              onChat(chat);
            }}
          >
            <span className="chat-title">{chat.title}</span>
            {chat.branchLabel !== undefined ? (
              <span className="chat-meta mono">{chat.branchLabel}</span>
            ) : null}
          </button>
        ))}
      {!isActiveProject && <div className="proj-empty">{"Select project to load chats"}</div>}
    </fieldset>
  );
}

function ProjectRow({
  project,
  activeProjectPath,
  chats,
  activeChatId,
  onProject,
  onChat,
  treeRef,
}: ProjectRowProps): ReactNode {
  const isActiveProject = activeProjectPath === project.path;
  const [expanded, setExpanded] = useState(isActiveProject);
  const availabilityLabel = projectAvailabilityLabel(project);

  useEffect(() => {
    if (isActiveProject) setExpanded(true);
  }, [isActiveProject]);

  return (
    <div className="proj">
      <ProjectHeadButton
        project={project}
        isActiveProject={isActiveProject}
        expanded={expanded}
        availabilityLabel={availabilityLabel}
        treeRef={treeRef}
        onActivate={() => {
          setExpanded(true);
          onProject(project);
        }}
        onToggleExpanded={() => setExpanded((current) => !current)}
      />
      {expanded && (
        <ProjectChatList
          project={project}
          chats={chats}
          activeChatId={activeChatId}
          isActiveProject={isActiveProject}
          onChat={onChat}
        />
      )}
    </div>
  );
}

export function ProjectPanel({
  openChatWindow,
}: {
  readonly openChatWindow: (chat: Chat) => void;
}): ReactNode {
  const session = useChatSessionCatalog();
  const actions = useChatSessionActions();
  const treeRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className="tw-scroll">
      <div className="sb-section">
        <span className="sb-section-label">Projects</span>
      </div>
      {session.projects.length === 0 ? (
        <div className="proj-empty">No registered projects</div>
      ) : (
        // role="tree" + onKeyDown implements the WAI-ARIA tree keyboard pattern (PA-03).
        // tabIndex={-1}: programmatic focus target only (mirrors FilesWidget pattern).
        <div
          className="proj-tree"
          role="tree"
          aria-label="Projects"
          tabIndex={-1}
          ref={treeRef}
          onKeyDown={(event) => {
            if (!TREE_NAV_KEYS.has(event.key)) return;
            if (treeRef.current !== null) handleTreeKey(event, treeRef.current);
          }}
        >
          {session.projects.map((project) => (
            <ProjectRow
              key={project.path}
              project={project}
              activeProjectPath={session.activeProject?.path}
              chats={session.activeProject?.path === project.path ? session.chats : []}
              activeChatId={session.activeChat?.id}
              treeRef={treeRef}
              onProject={(nextProject) => {
                void actions.openProject(nextProject);
              }}
              onChat={(chat) => {
                openChatWindow(chat);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
