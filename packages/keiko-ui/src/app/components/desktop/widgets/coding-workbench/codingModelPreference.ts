import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { CODING_WORKBENCH_RUNTIME_MODEL_ID_MAX_CHARS } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";

// #3873 live review: after a run with "gemma-4-31b-it" the composer fell back to the first offered
// model ("gpt-5.4") on the next visit. The coding model now persists the way the run authority does
// (ADR-0124 D2, ADR-0163 D7): only an explicit human choice is saved — never the default the
// Workbench elects by itself — and a saved choice is honoured only while the gateway still offers
// it; otherwise the current default stands. The run authority lives in the server's memory autonomy
// policy (`/api/memory/autonomy-policy`), whose wire carries the requested mode alone, so until that
// policy also carries a coding model the choice is kept per installation in this browser, like the
// operator's other preferences (`keiko.theme`, `keiko.locale`).
export const CODING_MODEL_STORAGE_KEY = "keiko.codingWorkbench.model";

type PreferenceOperation = "read" | "write";

function reportPreferenceFailure(operation: PreferenceOperation, error: unknown): void {
  reportClientDiagnostic(`[keiko] coding workbench model preference ${operation} failed`, {
    kind: "other",
    errorKind: "unavailable",
    errorEvidence: clientErrorEvidence(error),
  });
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

// Browser storage is outside Keiko's control: only a bounded, plain model identifier is accepted.
function storedModelId(value: string | null): string | null {
  if (value === null || value.length > CODING_WORKBENCH_RUNTIME_MODEL_ID_MAX_CHARS) return null;
  if (value.trim() !== value || value.length === 0 || hasControlCharacter(value)) return null;
  return value;
}

/** The coding model the operator chose last, or null when none was saved or storage is unusable. */
export function savedCodingModel(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return storedModelId(window.localStorage.getItem(CODING_MODEL_STORAGE_KEY));
  } catch (error) {
    reportPreferenceFailure("read", error);
    return null;
  }
}

/** Saves an explicit human model choice. Never call it for a default the Workbench elected. */
export function rememberCodingModel(modelId: string | null): void {
  if (modelId === null || storedModelId(modelId) === null || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CODING_MODEL_STORAGE_KEY, modelId);
  } catch (error) {
    reportPreferenceFailure("write", error);
  }
}

/** The saved model while the gateway still offers it; otherwise nothing, and the default stands. */
export function offeredSavedCodingModel(
  models: readonly ModelCapability[],
): ModelCapability | undefined {
  const saved = savedCodingModel();
  return saved === null ? undefined : models.find((model) => model.id === saved);
}
