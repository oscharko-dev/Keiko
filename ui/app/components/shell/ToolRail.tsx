"use client";

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import type { ProjectWithAvailability } from "@/lib/types";
import { useSelectedProject } from "./useSelectedProject";
import { FilesPanel } from "./FilesPanel";
import { PlannedToolPanel } from "./PlannedToolPanel";

// ---------------------------------------------------------------------------
// Follow-up issue references — coordinator fills these in after issue creation
// ---------------------------------------------------------------------------

export const FOLLOWUP_ISSUES: Record<"browser" | "review" | "terminal", string> = {
  browser: "https://github.com/oscharko-dev/Keiko/issues/76",
  review: "https://github.com/oscharko-dev/Keiko/issues/77",
  terminal: "https://github.com/oscharko-dev/Keiko/issues/78",
};

// ---------------------------------------------------------------------------
// Inline SVG icons (simple line-art, no external assets)
// ---------------------------------------------------------------------------

function FilesIcon(): ReactNode {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h7l4 4v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
      <path d="M11 4v4h4" />
    </svg>
  );
}

function BrowserIcon(): ReactNode {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="16" height="14" rx="1" />
      <path d="M2 7h16" />
      <circle cx="5" cy="5" r="0.75" fill="currentColor" />
      <circle cx="8" cy="5" r="0.75" fill="currentColor" />
    </svg>
  );
}

function ReviewIcon(): ReactNode {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="10" r="7" />
      <path d="M10 7v4M10 14v.5" />
    </svg>
  );
}

function TerminalIcon(): ReactNode {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="16" height="14" rx="1" />
      <path d="M6 8l3 2-3 2M11 14h3" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToolName = "files" | "browser" | "review" | "terminal";

interface ToolDef {
  name: ToolName;
  label: string;
  icon: ReactNode;
}

type AvailState = "no-project" | "project-unavailable" | "available";

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const TOOLS: ToolDef[] = [
  { name: "files", label: "Files", icon: <FilesIcon /> },
  { name: "browser", label: "Browser", icon: <BrowserIcon /> },
  { name: "review", label: "Review", icon: <ReviewIcon /> },
  { name: "terminal", label: "Terminal", icon: <TerminalIcon /> },
];

function resolveAvailState(project: ProjectWithAvailability | null): AvailState {
  if (!project) return "no-project";
  if (project.available === false) return "project-unavailable";
  return "available";
}

function disabledTooltip(avail: AvailState): string {
  if (avail === "no-project") return "Select a project to open this tool";
  return "Project path is unavailable";
}

function isToolName(v: string | null): v is ToolName {
  return v === "files" || v === "browser" || v === "review" || v === "terminal";
}

// ---------------------------------------------------------------------------
// ToolButton
// ---------------------------------------------------------------------------

interface ToolButtonProps {
  def: ToolDef;
  pressed: boolean;
  disabled: boolean;
  disabledTip: string | null;
  onToggle: (name: ToolName) => void;
}

function ToolButton({ def, pressed, disabled, disabledTip, onToggle }: ToolButtonProps): ReactNode {
  const tipId = `tool-${def.name}-tip`;

  return (
    <li className="flex flex-col items-center">
      <button
        type="button"
        disabled={disabled}
        aria-label={def.label}
        aria-pressed={disabled ? undefined : pressed}
        aria-describedby={disabled && disabledTip ? tipId : undefined}
        onClick={() => { onToggle(def.name); }}
        className={[
          "flex h-10 w-10 flex-col items-center justify-center rounded",
          disabled
            ? "text-ink-dim disabled:cursor-not-allowed disabled:opacity-40"
            : pressed
              ? "bg-elevated text-ink"
              : "bg-chrome text-ink-muted hover:bg-elevated hover:text-ink",
        ].join(" ")}
      >
        {def.icon}
      </button>
      <span className={`mt-0.5 text-center text-xs ${disabled ? "text-ink-dim" : "text-ink-muted"}`}>
        {def.label}
      </span>
      {disabled && disabledTip && (
        <span id={tipId} role="tooltip" className="sr-only">
          {disabledTip}
        </span>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// ActivePanel
// ---------------------------------------------------------------------------

interface ActivePanelProps {
  tool: ToolName;
  project: ProjectWithAvailability;
  onClose: () => void;
}

function ActivePanel({ tool, project, onClose }: ActivePanelProps): ReactNode {
  if (tool === "files") {
    return <FilesPanel project={project} onClose={onClose} />;
  }
  if (tool === "browser" || tool === "review" || tool === "terminal") {
    return (
      <PlannedToolPanel
        tool={tool}
        project={project}
        onClose={onClose}
        followUpIssueUrl={FOLLOWUP_ISSUES[tool]}
      />
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// ToolRail
// ---------------------------------------------------------------------------

/**
 * Right-side tool entry column. Reads ?project= and ?tool= from the URL.
 * Must be inside a <Suspense> boundary (uses useSearchParams / useRouter).
 */
export function ToolRail(): ReactNode {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawTool = searchParams.get("tool");
  const projectState = useSelectedProject();

  const project = projectState.kind === "found" ? projectState.project : null;
  const avail = resolveAvailState(project);

  const handleToggle = useCallback(
    (name: ToolName) => {
      if (avail !== "available") return;
      const next = new URLSearchParams(searchParams.toString());
      if (rawTool === name) {
        next.delete("tool");
      } else {
        next.set("tool", name);
      }
      router.replace(`?${next.toString()}`);
    },
    [avail, rawTool, searchParams, router],
  );

  const clearTool = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("tool");
    router.replace(`?${next.toString()}`);
  }, [searchParams, router]);

  const activeTool: ToolName | null =
    avail === "available" && isToolName(rawTool) ? rawTool : null;

  const disabled = avail !== "available";
  const tip = disabled ? disabledTooltip(avail) : null;

  return (
    <aside aria-label="Workspace tools" className="flex">
      {/* Active panel — between main content and the icon column */}
      {activeTool && project && (
        <ActivePanel tool={activeTool} project={project} onClose={clearTool} />
      )}

      {/* Icon column — fixed 56 px wide */}
      <ul className="flex w-14 flex-col gap-2 bg-chrome px-2 py-4">
        {TOOLS.map((def) => (
          <ToolButton
            key={def.name}
            def={def}
            pressed={activeTool === def.name}
            disabled={disabled}
            disabledTip={tip}
            onToggle={handleToggle}
          />
        ))}
      </ul>
    </aside>
  );
}

export default ToolRail;
