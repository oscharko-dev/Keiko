"use client";

// Connect panel (Epic #1571 — "Git Window" redesign empty state). Replaces the two-column body
// when no repository is connected: an icon medallion, a short prompt, the Connect / Clone actions,
// a Recent-repositories list, and a calm agent hint. Repository selection here transitions the
// window into the connected Changes view. Styles compose existing globals.css tokens (ADR-0051).
// See ADR-0098 for the git-client window conventions.

import type { ReactNode } from "react";
import type { ProjectWithAvailability } from "@/lib/types";
import { Icons } from "../../../Icons";
import { NATIVE_BLOCK_STYLE } from "../../../native-element-styles";
import {
  AGENT_HINT_STYLE,
  CONNECT_COLUMN_STYLE,
  CONNECT_MEDALLION_STYLE,
  CONNECT_SUBTITLE_STYLE,
  CONNECT_TITLE_STYLE,
  CONNECT_WRAP_STYLE,
  MONO_PATH_STYLE,
  PRIMARY_BTN,
  RECENT_LABEL_STYLE,
  RECENT_MEDALLION_STYLE,
  recentRowStyle,
  SECONDARY_BTN,
  SUBTLE_TEXT_STYLE,
} from "./git-client-styles";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const FolderIcon = Icons.folder;
const ChevronRIcon = Icons.chevronR;
const BranchIcon = Icons.branch;
const LinkIcon = Icons.link;
const SparkIcon = Icons.spark;

interface ConnectPanelProps {
  readonly repositories: readonly ProjectWithAvailability[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly onSelect: (path: string) => void;
  readonly onConnect: () => void;
  readonly onClone: () => void;
}

interface RecentRepositoriesProps {
  readonly repositories: readonly ProjectWithAvailability[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly onSelect: (path: string) => void;
}

function RecentRepositories({
  repositories,
  loading,
  error,
  onSelect,
}: RecentRepositoriesProps): ReactNode {
  if (error !== null) {
    return (
      <p role="alert" style={{ ...SUBTLE_TEXT_STYLE, fontSize: 12 }}>
        {error}
      </p>
    );
  }
  if (loading && repositories.length === 0) {
    return (
      <output style={{ ...NATIVE_BLOCK_STYLE, ...SUBTLE_TEXT_STYLE, fontSize: 12 }}>
        Loading repositories…
      </output>
    );
  }
  if (repositories.length === 0) {
    return (
      <p style={{ ...SUBTLE_TEXT_STYLE, fontSize: 12 }}>
        No repositories yet. Connect or clone one to get started.
      </p>
    );
  }
  return (
    <ul
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {repositories.map((repo) => (
        <li key={repo.path}>
          <button
            type="button"
            style={recentRowStyle(false)}
            title={repo.path}
            onClick={() => onSelect(repo.path)}
          >
            <span aria-hidden="true" style={RECENT_MEDALLION_STYLE}>
              <FolderIcon size={16} />
            </span>
            <span
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                minWidth: 0,
                flex: 1,
              }}
            >
              <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--fg)" }}>
                {repo.name}
              </span>
              <span style={MONO_PATH_STYLE}>{repo.path}</span>
            </span>
            <span aria-hidden="true" style={{ color: "var(--fg-faint)" }}>
              <ChevronRIcon size={15} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ConnectPanel({
  repositories,
  loading,
  error,
  onSelect,
  onConnect,
  onClone,
}: ConnectPanelProps): ReactNode {
  return (
    <div style={CONNECT_WRAP_STYLE}>
      <div style={CONNECT_COLUMN_STYLE}>
        <div aria-hidden="true" style={CONNECT_MEDALLION_STYLE}>
          <BranchIcon size={28} />
        </div>
        <h2 style={CONNECT_TITLE_STYLE}>No repository connected</h2>
        <p style={CONNECT_SUBTITLE_STYLE}>
          Connect a folder or repository to review changes, stage commits, and open pull requests —
          all in one window.
        </p>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 22 }}>
          <button type="button" style={PRIMARY_BTN} onClick={onConnect}>
            <FolderIcon size={16} /> Connect repository
          </button>
          <button type="button" style={SECONDARY_BTN} onClick={onClone}>
            <LinkIcon size={15} /> Clone from URL
          </button>
        </div>

        <div style={{ width: "100%", marginTop: 34, textAlign: "left" }}>
          <div style={RECENT_LABEL_STYLE}>Recent</div>
          <RecentRepositories
            repositories={repositories}
            loading={loading}
            error={error}
            onSelect={onSelect}
          />
        </div>

        <div style={AGENT_HINT_STYLE}>
          <span
            aria-hidden="true"
            style={{ display: "inline-flex", color: "var(--accent-text)", marginTop: 1 }}
          >
            <SparkIcon size={14} />
          </span>
          <span style={{ fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.55 }}>
            Once a repository is connected, Keiko can summarize your working changes and draft
            commit messages for you.
          </span>
        </div>
      </div>
    </div>
  );
}
