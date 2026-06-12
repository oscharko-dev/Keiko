// Epic #518 / Issue #528 — Workspace object descriptor metadata table.
//
// ADR-0029 extends the existing WindowsRegistry.ts with four declarative
// metadata fields per object type: lifecycle, trustBoundary, authority,
// persistence. To keep the existing 377-line registry file unchanged, the
// extension lives in this sidecar table.
//
// The closed-set enums are owned by @oscharko-dev/keiko-contracts; the
// validator runs at module evaluation in dev/test and throws on any
// inconsistency. The unit test in descriptor-meta.test.ts is the
// production assertion that the table is consistent.

import {
  type WorkspaceDescriptorMeta,
  validateWorkspaceDescriptorMeta,
} from "@oscharko-dev/keiko-contracts";
import type { WindowType } from "./WindowsRegistry";

// ─── Meta table: one entry per WindowType ─────────────────────────────────

export const WIN_META: Readonly<Record<WindowType, WorkspaceDescriptorMeta>> = {
  chat: {
    lifecycle: ["draft", "streaming", "final", "archived"],
    trustBoundary: ["ui", "model", "evidence"],
    authority: "user-confirm",
    persistence: "durable.ui",
  },
  chatHistory: {
    lifecycle: ["live", "archived"],
    trustBoundary: ["ui"],
    authority: "user-confirm",
    persistence: "durable.ui",
  },
  files: {
    lifecycle: ["connecting", "connected", "degraded", "disconnected", "error"],
    trustBoundary: ["ui", "fs"],
    authority: "user",
    persistence: "fs-reference",
  },
  connector: {
    lifecycle: ["connecting", "connected", "degraded", "disconnected", "error"],
    trustBoundary: ["ui", "fs"],
    authority: "user",
    persistence: "fs-reference",
  },
  localKnowledge: {
    lifecycle: ["idle", "connecting", "connected", "degraded", "disconnected", "error"],
    trustBoundary: ["ui", "fs", "model"],
    authority: "user-confirm",
    persistence: "durable.ui",
  },
  editor: {
    lifecycle: ["viewing", "editing", "unsaved", "saved", "error"],
    trustBoundary: ["ui", "fs"],
    authority: "user",
    persistence: "fs-reference",
  },
  browser: {
    lifecycle: ["idle", "live", "error"],
    trustBoundary: ["ui", "network"],
    authority: "user-confirm",
    persistence: "transient",
  },
  terminal: {
    lifecycle: ["idle", "running", "blocked", "cancelled", "error"],
    trustBoundary: ["ui", "tool"],
    authority: "user-confirm",
    persistence: "transient",
  },
  review: {
    lifecycle: ["proposed", "needs-review", "applied", "reverted", "archived"],
    trustBoundary: ["ui", "evidence"],
    authority: "user-confirm",
    persistence: "evidence-reference",
  },
  agents: {
    lifecycle: ["proposed", "running", "blocked", "needs-review", "verified", "cancelled"],
    trustBoundary: ["ui", "model", "tool", "evidence"],
    authority: "user-confirm",
    persistence: "durable.ui",
  },
  integ: {
    lifecycle: ["idle", "connecting", "connected", "degraded", "disconnected", "error"],
    trustBoundary: ["ui", "network"],
    authority: "user-confirm",
    persistence: "durable.config",
  },
  keiko: {
    lifecycle: ["live"],
    trustBoundary: ["ui", "memory"],
    authority: "user",
    persistence: "memory-reference",
  },
  settings: {
    lifecycle: ["viewing", "editing", "saved"],
    trustBoundary: ["ui"],
    authority: "user",
    persistence: "durable.config",
  },
  project: {
    lifecycle: ["none", "connecting", "connected", "disconnected"],
    trustBoundary: ["ui", "fs"],
    authority: "user",
    persistence: "durable.config",
  },
  search: {
    lifecycle: ["idle", "searching", "results", "error"],
    trustBoundary: ["ui", "fs"],
    authority: "read-only",
    persistence: "transient",
  },
  plugins: {
    lifecycle: ["idle", "installed", "disabled", "enabled"],
    trustBoundary: ["ui"],
    authority: "user",
    persistence: "durable.config",
  },
  automations: {
    lifecycle: ["idle", "enabled", "disabled"],
    trustBoundary: ["ui"],
    authority: "user",
    persistence: "durable.config",
  },
  mobile: {
    lifecycle: ["paired", "unpaired", "error"],
    trustBoundary: ["ui", "network"],
    authority: "user-confirm",
    persistence: "durable.config",
  },
  inspector: {
    lifecycle: ["empty", "focused"],
    trustBoundary: ["ui"],
    authority: "ui-only",
    persistence: "transient",
  },
  activity: {
    lifecycle: ["live", "archived"],
    trustBoundary: ["ui"],
    authority: "read-only",
    persistence: "transient",
  },
  notifications: {
    lifecycle: ["unread", "read", "dismissed"],
    trustBoundary: ["ui"],
    authority: "ui-only",
    persistence: "transient",
  },
  resources: {
    lifecycle: ["live"],
    trustBoundary: ["ui"],
    authority: "read-only",
    persistence: "transient",
  },
  // Epic #270 — QI hub: launches model-routed, evidence-backed runs (user-confirmed authority).
  quality: {
    lifecycle: ["idle", "running", "results", "error"],
    trustBoundary: ["ui", "model", "evidence"],
    authority: "user-confirm",
    persistence: "evidence-reference",
  },
  // Epic #270 — QI run result card: shows an evidence-backed run; review/export are user-confirmed.
  qiRun: {
    lifecycle: ["running", "final", "needs-review", "verified", "failed", "cancelled"],
    trustBoundary: ["ui", "model", "evidence"],
    authority: "user-confirm",
    persistence: "evidence-reference",
  },
  // Epic #532 — Relationship engine hub: governance metadata over the relationship graph. Reads
  // durable relationship rows (V5 UI-store, ADR-0031) and references evidence artifacts; grants no
  // model/tool/fs/workflow authority. Mutations (create/archive/revoke) are explicit user actions.
  relationships: {
    lifecycle: ["idle", "live", "degraded", "blocked", "error"],
    trustBoundary: ["ui", "evidence"],
    authority: "user-confirm",
    persistence: "durable.ui",
  },
  // Epic #750, Issue #756 — Figma Snapshot window: triggers a server-side snapshot-build from a
  // board link and displays the captured screens. The PAT never reaches the UI; the window stores
  // only the resulting snapshotRunId in cfg so the connected QI hub can read it as a source.
  figma: {
    lifecycle: ["idle", "running", "results", "error"],
    trustBoundary: ["ui", "evidence", "network"],
    authority: "user-confirm",
    persistence: "evidence-reference",
  },
};

// ─── Module-evaluation validation ─────────────────────────────────────────
//
// In dev / test (Vitest / Next.js dev server), the entire table is
// validated when this module loads. A misconfigured descriptor throws
// before any user action. Production builds rely on the descriptor-meta
// test (in tests above and in CI) — the same validator running per row.

export function validateAllDescriptorMeta(): readonly string[] {
  const errors: string[] = [];
  for (const type of Object.keys(WIN_META) as WindowType[]) {
    const meta = WIN_META[type];
    const found = validateWorkspaceDescriptorMeta(type, meta);
    for (const e of found) {
      errors.push(`[${e.objectType}].${e.field}: ${e.message}`);
    }
  }
  return errors;
}

// `process.env.NODE_ENV` is exposed by Next.js. In production builds the
// guard skips the throw so a hot path is never blocked by descriptor
// validation; the unit test in descriptor-meta.test.ts is the production
// assertion.
if (typeof process !== "undefined" && process.env["NODE_ENV"] !== "production") {
  const errors = validateAllDescriptorMeta();
  if (errors.length > 0) {
    throw new Error(`Workspace descriptor meta table failed validation:\n  ${errors.join("\n  ")}`);
  }
}
