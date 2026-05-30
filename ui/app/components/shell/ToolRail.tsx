"use client";

import type { ReactNode } from "react";

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
// Tool button
// ---------------------------------------------------------------------------

interface ToolButtonProps {
  name: string;
  label: string;
  icon: ReactNode;
}

function ToolButton({ name, label, icon }: ToolButtonProps): ReactNode {
  const tipId = `tool-${name}-tip`;
  return (
    <li className="flex flex-col items-center">
      <button
        type="button"
        disabled
        aria-describedby={tipId}
        className="flex flex-col items-center gap-1 rounded p-2 text-ink-dim
          disabled:cursor-not-allowed disabled:opacity-40"
      >
        {icon}
        <span className="text-xs text-ink-dim">{label}</span>
      </button>
      <span
        id={tipId}
        role="tooltip"
        className="mt-0.5 text-center text-xs text-ink-muted"
      >
        Available in a later release
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// ToolRail
// ---------------------------------------------------------------------------

const TOOLS: ToolButtonProps[] = [
  { name: "files", label: "Files", icon: <FilesIcon /> },
  { name: "browser", label: "Browser", icon: <BrowserIcon /> },
  { name: "review", label: "Review", icon: <ReviewIcon /> },
  { name: "terminal", label: "Terminal", icon: <TerminalIcon /> },
];

export function ToolRail(): ReactNode {
  return (
    <aside aria-label="Workspace tools" className="flex flex-col bg-chrome">
      <ul className="flex flex-col gap-4 px-2 py-4">
        {TOOLS.map((tool) => (
          <ToolButton key={tool.name} {...tool} />
        ))}
      </ul>
    </aside>
  );
}

export default ToolRail;
