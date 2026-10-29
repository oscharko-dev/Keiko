// Routine evidence of what the human did on the Coding Workbench page (#3897). Each report is a
// closed shape the server records at info as `client.coding-workbench.interaction`, on the routine
// budget: opening a detail is never a warn/unknown browser failure.
import type { MouseEvent } from "react";
import type {
  ClientCodingWorkbenchAgentKind,
  ClientCodingWorkbenchDetailSection,
  ClientDiagnosticCodingWorkbenchInteraction,
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
