"use client";

import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { updateProject, ApiError } from "@/lib/api";
import type { ProjectWithAvailability } from "@/lib/types";
import { ConfirmDialog } from "./ConfirmDialog";
import { deleteProject } from "@/lib/api";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ProjectRowProps {
  project: ProjectWithAvailability;
  collapsed: boolean;
  selected: boolean;
  onSelect: (path: string) => void;
  onFavoriteToggled: () => void;
  onRemoved: (path: string) => void;
}

/**
 * A single project row in the sidebar.
 * - Row is a <button> that selects the project.
 * - Star button toggles favorite.
 * - Remove button (hover/focus revealed) opens a confirm dialog.
 */
export function ProjectRow({
  project,
  collapsed,
  selected,
  onSelect,
  onFavoriteToggled,
  onRemoved,
}: ProjectRowProps): ReactNode {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [favoriteLoading, setFavoriteLoading] = useState(false);
  const removeButtonRef = useRef<HTMLButtonElement>(null);

  const displayName = project.name;
  const label = project.available === false
    ? `${displayName} (unavailable)`
    : displayName;

  async function handleFavorite(e: React.MouseEvent): Promise<void> {
    e.stopPropagation();
    if (favoriteLoading) return;
    setFavoriteLoading(true);
    try {
      await updateProject(project.path, { favorite: !project.favorite });
      onFavoriteToggled();
    } catch (err: unknown) {
      // Best-effort toggle — surface error only if it's an ApiError with a message
      if (err instanceof ApiError) {
        // Silently ignore for now; the optimistic UI will be corrected on next load
      }
    } finally {
      setFavoriteLoading(false);
    }
  }

  function handleRemoveClick(e: React.MouseEvent): void {
    e.stopPropagation();
    setConfirmOpen(true);
  }

  async function handleConfirmRemove(): Promise<void> {
    await deleteProject(project.path);
    setConfirmOpen(false);
    onRemoved(project.path);
  }

  if (collapsed) {
    return (
      <button
        type="button"
        aria-label={label}
        aria-current={selected ? "true" : undefined}
        title={project.path}
        onClick={() => { onSelect(project.path); }}
        className={`flex w-full items-center justify-center rounded py-1.5 text-sm
          transition-colors
          focus:outline-none focus-visible:ring-2 focus-visible:ring-focus
          ${selected ? "bg-elevated text-ink" : "text-ink-muted hover:bg-elevated hover:text-ink"}
          ${project.available === false ? "opacity-60" : ""}`}
      >
        {displayName.charAt(0).toUpperCase()}
      </button>
    );
  }

  return (
    <>
      <div className="group relative flex items-center rounded">
        <button
          type="button"
          aria-current={selected ? "true" : undefined}
          title={project.path}
          onClick={() => { onSelect(project.path); }}
          className={`flex flex-1 items-center gap-1.5 truncate rounded py-1.5 pl-2 pr-1 text-sm
            transition-colors
            focus:outline-none focus-visible:ring-2 focus-visible:ring-focus
            ${selected ? "bg-elevated text-ink" : "text-ink-muted hover:bg-elevated hover:text-ink"}
            ${project.available === false ? "opacity-60" : ""}`}
        >
          <span className="truncate">{displayName}</span>
          {project.available === false && (
            <span
              className="ml-auto shrink-0 text-xs text-ink-dim"
              aria-label="Project path unavailable"
            >
              ✕
            </span>
          )}
        </button>

        {/* Star / favorite toggle */}
        <button
          type="button"
          aria-label={
            project.favorite
              ? `Untoggle favorite for ${displayName}`
              : `Toggle favorite for ${displayName}`
          }
          disabled={favoriteLoading}
          onClick={(e) => { void handleFavorite(e); }}
          className={`shrink-0 rounded p-0.5 text-xs
            opacity-0 transition-opacity
            group-hover:opacity-100 focus-visible:opacity-100
            focus:outline-none focus-visible:ring-1 focus-visible:ring-focus
            disabled:cursor-not-allowed
            ${project.favorite ? "text-accent opacity-100" : "text-ink-dim"}`}
        >
          {project.favorite ? "★" : "☆"}
        </button>

        {/* Remove — revealed on hover/focus for available projects; always visible for unavailable */}
        <button
          ref={removeButtonRef}
          type="button"
          aria-label={`Remove ${displayName} from sidebar`}
          onClick={handleRemoveClick}
          className={`shrink-0 rounded p-0.5 text-xs text-ink-dim
            transition-opacity
            focus:outline-none focus-visible:ring-1 focus-visible:ring-focus
            hover:text-red-400
            ${project.available === false ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
        >
          ×
        </button>
      </div>

      {confirmOpen && (
        <ConfirmDialog
          title={`Remove ${displayName}?`}
          description="The directory on disk is not deleted. Existing chats will be removed from the sidebar."
          confirmLabel="Remove"
          onConfirm={() => { void handleConfirmRemove(); }}
          onCancel={() => {
            setConfirmOpen(false);
            setTimeout(() => { removeButtonRef.current?.focus(); }, 0);
          }}
        />
      )}
    </>
  );
}

export default ProjectRow;
