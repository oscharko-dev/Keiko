import type { ClientComposerSubmission } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { sha256Hex } from "../../hooks/canonical-voice-hasher-runtime";

export function reportTaskSubmission(
  displayed: string,
  draft: string,
  kind: ClientComposerSubmission["kind"],
): void {
  const submitted = displayed.trim();
  reportClientDiagnostic("[keiko] coding task submission attempted", {
    correlationId: newClientCorrelationId(),
    composerActivity: "coding-task-submission",
    composerSubmission: {
      kind,
      outcome: "attempted",
      normalization: "trim",
      displayedDigest: sha256Hex(displayed),
      submittedDigest: sha256Hex(submitted),
      draftMatchesInput: draft === displayed,
      inputCharacterCount: displayed.length,
      submittedCharacterCount: submitted.length,
    },
  });
}
