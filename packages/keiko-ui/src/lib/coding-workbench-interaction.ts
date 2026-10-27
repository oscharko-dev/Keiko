// Routine evidence of what the human did on the Coding Workbench page (#3897). Each report is a
// closed shape the server records at info as `client.coding-workbench.interaction`, on the routine
// budget: opening a detail is never a warn/unknown browser failure.
import type { SyntheticEvent } from "react";
import type {
  ClientCodingWorkbenchAgentKind,
  ClientCodingWorkbenchDetailSection,
  ClientDiagnosticCodingWorkbenchInteraction,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { reportClientDiagnostic } from "./client-diagnostics";

export function reportCodingWorkbenchInteraction(
  interaction: ClientDiagnosticCodingWorkbenchInteraction,
  correlationId?: string,
): void {
  reportClientDiagnostic(`[keiko] coding workbench interaction: ${interaction.interaction}`, {
    codingWorkbenchInteraction: interaction,
    correlationId,
  });
}

/** A disclosure opened or closed, read from the element itself. */
export function reportCodingWorkbenchDetailsToggled(
  section: ClientCodingWorkbenchDetailSection,
  event: SyntheticEvent<HTMLDetailsElement>,
): void {
  reportCodingWorkbenchInteraction({
    interaction: "details-toggled",
    section,
    expanded: event.currentTarget.open,
  });
}

/** A built-in agent by name; a custom primary agent only as `custom`, never by its name. */
export function codingWorkbenchAgentKind(agent: string): ClientCodingWorkbenchAgentKind {
  return agent === "build" || agent === "plan" ? agent : "custom";
}
