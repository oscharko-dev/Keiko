import { reportClientDiagnostic } from "./client-diagnostics";
import { clientErrorEvidence } from "./client-error-evidence";

interface RefusedRequest {
  readonly status: number;
  readonly code: string;
  readonly correlationId?: string | undefined;
}

const AUTHORITY_REFUSALS = new Set(["DENIED", "FORBIDDEN", "UNAUTHORIZED"]);

const SESSION_CONCEALED_MUTATION_PATHS = [
  /^\/api\/skills(?:\/[^/]+)?$/u,
  /^\/api\/skills\/jira-templates\/(?:validate|propose)$/u,
  /^\/api\/chats\/[^/]+\/(?:draft|skill)$/u,
  /^\/api\/coding-workbench\/drafts\/[^/]+$/u,
  /^\/api\/runs\/[^/]+\/(?:cancel|apply)$/u,
] as const;
const REINSPECTION_COOLDOWN_MS = 5_000;
let lastReinspectionAt = Number.NEGATIVE_INFINITY;
let reinspection: Promise<void> | undefined;

function concealsMissingSession(code: string, path: string | undefined): boolean {
  const pathname = path?.split(/[?#]/u, 1)[0];
  if (pathname === undefined) return false;
  if (code === "CODING_RUNTIME_RUN_NOT_FOUND")
    return /^\/api\/coding-workbench\/runtime\/runs\/[^/]+(?:\/.*)?$/u.test(pathname);
  return (
    code === "NOT_FOUND" &&
    SESSION_CONCEALED_MUTATION_PATHS.some((pattern) => pattern.test(pathname))
  );
}

function mayHaveLostSession(error: RefusedRequest, path: string | undefined): boolean {
  if (error.status === 401) return true;
  if (error.status === 404) return concealsMissingSession(error.code, path);
  return error.status === 403 && AUTHORITY_REFUSALS.has(error.code);
}

/**
 * A protected mutation can conceal a missing session behind 404. Reinspect the existing browser
 * inventory instead of treating the last positive inspection as current. The original refusal
 * remains authoritative: neither a missing resource nor a denied write is retried or reclassified.
 * Reads never publish here, so a refused follow-up inspection cannot create a refresh loop.
 */
export function reinspectSessionAfterMutationRefusal(
  error: RefusedRequest,
  method = "GET",
  path?: string,
): Promise<void> {
  const normalized = method.toUpperCase();
  if (normalized === "GET" || normalized === "HEAD" || !mayHaveLostSession(error, path))
    return Promise.resolve();
  if (reinspection !== undefined) return reinspection;
  const now = performance.now();
  if (now - lastReinspectionAt < REINSPECTION_COOLDOWN_MS) return Promise.resolve();
  lastReinspectionAt = now;
  reinspection = requestReinspection(error).finally(() => {
    reinspection = undefined;
  });
  return reinspection;
}

async function requestReinspection(error: RefusedRequest): Promise<void> {
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
