import { reportClientDiagnostic } from "./client-diagnostics";
import { clientErrorEvidence } from "./client-error-evidence";

interface RefusedRequest {
  readonly status: number;
  readonly code: string;
  readonly correlationId?: string | undefined;
}

const AUTHORITY_REFUSALS = new Set(["DENIED", "FORBIDDEN", "UNAUTHORIZED"]);

function mayHaveLostSession(error: RefusedRequest): boolean {
  if (error.status === 401) return true;
  if (error.status === 404) return error.code === "NOT_FOUND";
  return error.status === 403 && AUTHORITY_REFUSALS.has(error.code);
}

/**
 * A protected mutation can conceal a missing session behind 404. Reinspect the existing browser
 * inventory instead of treating the last positive inspection as current. The original refusal
 * remains authoritative: neither a missing resource nor a denied write is retried or reclassified.
 * Reads never publish here, so a refused follow-up inspection cannot create a refresh loop.
 */
export async function reinspectSessionAfterMutationRefusal(
  error: RefusedRequest,
  method = "GET",
): Promise<void> {
  const normalized = method.toUpperCase();
  if (normalized === "GET" || normalized === "HEAD" || !mayHaveLostSession(error)) return;
  try {
    // api.ts and http.ts both depend on this helper; the session client itself imports http.ts.
    // Load the existing notification port only after that graph has initialized.
    const { requestCodingAppSessionReinspection } = await import("./coding-app-session-client");
    requestCodingAppSessionReinspection();
    reportClientDiagnostic("App session reinspection requested after a refused mutation.", {
      correlationId: error.correlationId,
      errorKind: error.status === 404 ? "unavailable" : "authority-denied",
    });
  } catch (error_) {
    reportClientDiagnostic("App session reinspection could not be requested.", {
      correlationId: error.correlationId,
      errorEvidence: clientErrorEvidence(error_),
    });
  }
}
