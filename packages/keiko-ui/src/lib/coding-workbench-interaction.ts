// Routine evidence of what the human did on the Coding Workbench page (#3897). Each report is a
// closed shape the server records at info as `client.coding-workbench.interaction`, on the routine
// budget: opening a detail is never a warn/unknown browser failure.
import type { MouseEvent } from "react";
import {
  CLIENT_CODING_WORKBENCH_DIFF_BYTE_COUNT_MAX,
  CLIENT_CODING_WORKBENCH_DIFF_LINE_COUNT_MAX,
  CLIENT_CODING_WORKBENCH_FILE_COUNT_MAX,
  type ClientCodingWorkbenchActivationTrigger,
  type ClientCodingWorkbenchAgentKind,
  type ClientCodingWorkbenchDetailSection,
  type ClientCodingWorkbenchDiffSurface,
  type ClientCodingWorkbenchRepositorySource,
  type ClientDiagnosticCodingWorkbenchInteraction,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { reportClientDiagnostic } from "./client-diagnostics";

export function reportCodingWorkbenchInteraction(
  interaction: ClientDiagnosticCodingWorkbenchInteraction,
  correlationId?: string,
  parentCorrelationId?: string,
): void {
  reportClientDiagnostic(`[keiko] coding workbench interaction: ${interaction.interaction}`, {
    codingWorkbenchInteraction: interaction,
    correlationId,
    ...(parentCorrelationId === undefined ? {} : { parentCorrelationId }),
  });
}

/**
 * The reader opened or closed a disclosure by activating its summary (a click, or Enter/Space,
 * which the browser turns into one). The `toggle` event also fires when the page opens a
 * disclosure itself, such as a failed tool card, so it is never read as the reader's. The element
 * toggles after this handler, so the new state is the opposite of the current one.
 */
export function reportCodingWorkbenchSummaryActivated(
  section: ClientCodingWorkbenchDetailSection,
  event: MouseEvent<HTMLElement>,
): void {
  const details = event.currentTarget.parentElement;
  if (!(details instanceof HTMLDetailsElement) || event.isDefaultPrevented()) return;
  reportCodingWorkbenchInteraction({
    interaction: "details-toggled",
    section,
    expanded: !details.open,
  });
}

/** A built-in agent by name; a custom primary agent only as `custom`, never by its name. */
export function codingWorkbenchAgentKind(agent: string): ClientCodingWorkbenchAgentKind {
  return agent === "build" || agent === "plan" ? agent : "custom";
}

/**
 * A mounted Workbench window settled where its repository came from (#4068): its own saved
 * selection, the folder the shell held, or none. The closed source only, never the path.
 */
export function reportCodingWorkbenchRepositoryResolved(
  repositorySource: ClientCodingWorkbenchRepositorySource,
): void {
  reportCodingWorkbenchInteraction({ interaction: "repository-resolved", repositorySource });
}

/**
 * The Workbench asked the server to activate a workspace on its own (U-3). The trigger is derived
 * from where the window took its repository: its own selection, the repository a run pinned into
 * it, the shell's seed, or the active workspace it follows. Never the path.
 */
export function reportCodingWorkbenchActivationRequested(
  activationTrigger: ClientCodingWorkbenchActivationTrigger | undefined,
  correlationId: string,
): void {
  reportCodingWorkbenchInteraction(
    {
      interaction: "workspace-activation-requested",
      activationTrigger: activationTrigger ?? "active-follow",
    },
    correlationId,
  );
}

const ACTIVATION_TRIGGER_OF_SOURCE: Readonly<
  Record<ClientCodingWorkbenchRepositorySource, ClientCodingWorkbenchActivationTrigger>
> = { window: "window-selection", shell: "shell-seed", none: "active-follow" };

/** A window's own repository is `window-pinned` when a run pinned it, else the person's pick. */
export function activationTriggerOf(
  source: ClientCodingWorkbenchRepositorySource | undefined,
  pinned: boolean,
): ClientCodingWorkbenchActivationTrigger | undefined {
  if (source === undefined) return undefined;
  return source === "window" && pinned ? "window-pinned" : ACTIVATION_TRIGGER_OF_SOURCE[source];
}

/** The size of a diff that switched to the windowed view: counts only, never a path or text. */
export interface CodingWorkbenchWindowedDiffSize {
  readonly fileCount: number;
  readonly totalLineCount: number;
  readonly totalByteCount: number;
}

/**
 * A diff above the window threshold switched to the windowed view (#4108). The counts are clamped
 * to the wire bounds, so an outsized answer diff is reported at the bound instead of refused.
 */
export function reportCodingWorkbenchDiffWindowed(
  surface: ClientCodingWorkbenchDiffSurface,
  size: CodingWorkbenchWindowedDiffSize,
): void {
  reportCodingWorkbenchInteraction({
    interaction: "diff-windowed",
    surface,
    fileCount: Math.min(size.fileCount, CLIENT_CODING_WORKBENCH_FILE_COUNT_MAX),
    totalLineCount: Math.min(size.totalLineCount, CLIENT_CODING_WORKBENCH_DIFF_LINE_COUNT_MAX),
    totalByteCount: Math.min(size.totalByteCount, CLIENT_CODING_WORKBENCH_DIFF_BYTE_COUNT_MAX),
  });
}
