import {
  CODING_WORKBENCH_MODE_POLICIES,
  type CodingWorkbenchMode,
  type CodingWorkbenchModelSource,
  type CodingWorkbenchRuntimeEvent,
  type CodingWorkbenchRuntimeHealth,
} from "@oscharko-dev/keiko-contracts";
import type {
  CodingWorkbenchProjection,
  CodingWorkbenchRunState,
} from "./codingWorkbenchProjection";

export type CodingWorkbenchTone = "neutral" | "success" | "warning" | "danger";

export function isActiveRunState(state: CodingWorkbenchRunState): boolean {
  return (
    state === "running" ||
    state === "approval-required" ||
    state === "approved" ||
    state === "blocked" ||
    state === "governed-assist" ||
    state === "governed-assist-blocked"
  );
}

export function cx(...classes: readonly (string | undefined)[]): string {
  return classes.filter((value): value is string => value !== undefined).join(" ");
}

export function modeLabel(mode: CodingWorkbenchMode): string {
  return CODING_WORKBENCH_MODE_POLICIES[mode].display.label;
}

export function modeDescription(mode: CodingWorkbenchMode): string {
  return CODING_WORKBENCH_MODE_POLICIES[mode].display.description;
}

export function modelSourceLabel(source: CodingWorkbenchModelSource): string {
  if (source === "keiko-model-gateway") return "Keiko Gateway providers";
  if (source === "openai-api-key-through-gateway") return "OpenAI API key through Gateway";
  return "ChatGPT/Codex subscription profile";
}

export function runtimeLabel(runtime: string): string {
  if (runtime === "keiko-sidecar") return "Keiko sidecar";
  if (runtime === "codex-cli-adapter") return "Codex CLI adapter";
  return "Delivery runner";
}

export function runStateLabel(state: CodingWorkbenchRunState): string {
  const labels: Record<CodingWorkbenchRunState, string> = {
    empty: "Ready",
    running: "Running",
    "approval-required": "Approval required",
    approved: "Approved",
    denied: "Denied",
    stopped: "Stopped",
    blocked: "Blocked",
    "governed-assist": "Assist proposal",
    "governed-assist-blocked": "Assist blocked",
    failed: "Failed",
    completed: "Completed",
  };
  return labels[state];
}

export function healthLabel(health: CodingWorkbenchRuntimeHealth): string {
  if (health === "ready") return "Sidecar ready";
  if (health === "busy") return "Sidecar busy";
  if (health === "degraded") return "Sidecar degraded";
  return "Sidecar stopped";
}

export function healthTone(health: CodingWorkbenchRuntimeHealth): CodingWorkbenchTone {
  if (health === "ready") return "success";
  if (health === "busy") return "neutral";
  if (health === "degraded") return "warning";
  return "danger";
}

export function progressText(progress: CodingWorkbenchProjection["progress"]): string {
  return progress.total === 0
    ? "0 items"
    : `${String(progress.completed)} / ${String(progress.total)}`;
}

export function diffText(projection: CodingWorkbenchProjection): string {
  return `${String(projection.diff.addedLines)} added, ${String(projection.diff.deletedLines)} deleted`;
}

export function verificationText(projection: CodingWorkbenchProjection): string {
  const summary = projection.verification;
  return `${String(summary.passedCount)} passed, ${String(summary.failedCount)} failed, ${String(summary.skippedCount)} skipped`;
}

export function requestStatusLabel(state: string): string {
  if (state === "stop-requested") return "Stop requested. Server authority must perform the stop.";
  if (state === "takeover-requested") {
    return "Manual takeover requested. Runtime authority remains server-side.";
  }
  if (state === "approved") return "One-time approval recorded in the UI surface.";
  if (state === "denied") return "Permission request denied in the UI surface.";
  return "No operator override requested.";
}

export function permissionLabel(kind: string): string {
  if (kind === "workspace-write") return "Workspace write";
  if (kind === "command-execution") return "Command execution";
  if (kind === "network-egress") return "Network egress";
  if (kind === "connector-access") return "Connector access";
  return "Delivery substrate";
}

export function codexStatusLabel(status: string): string {
  if (status === "connected") return "Connected";
  if (status === "loading") return "Checking";
  if (status === "unavailable") return "Profile unavailable";
  if (status === "redistribution-unapproved") return "Unavailable in this release";
  if (status === "disabled-by-deployment") return "Disabled by deployment";
  if (status === "unsupported-headless") return "Unavailable headless";
  return "Needs setup";
}

export function eventTitle(event: CodingWorkbenchRuntimeEvent): string {
  if (event.kind === "runtime-started") return "Runtime started";
  if (event.kind === "permission-requested") return "Permission requested";
  if (event.kind === "diff-summarized") return "Diff summarized";
  if (event.kind === "verification-summarized") return "Verification summarized";
  if (event.kind === "failure-redacted") return "Failure redacted";
  if (event.kind === "artifact-produced") return "Artifact produced";
  if (event.kind === "task-submitted") return "Task submitted";
  return "Runtime observation";
}

export function eventDetail(event: CodingWorkbenchRuntimeEvent): string {
  if (event.kind === "diff-summarized") return `${String(event.fileCount ?? 0)} files changed`;
  if (event.kind === "verification-summarized") {
    return `${event.verificationStatus ?? "unknown"} verification`;
  }
  if (event.kind === "permission-requested") return "A privileged action is waiting for approval";
  if (event.kind === "failure-redacted") return event.failureSummary ?? "Failure details redacted";
  if (event.kind === "artifact-produced") return event.artifactLabel ?? "Content-free artifact";
  return event.taskRef ?? event.channel ?? event.runtimeSource ?? "Content-free runtime event";
}
