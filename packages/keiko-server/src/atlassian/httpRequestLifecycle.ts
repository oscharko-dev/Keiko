import {
  AtlassianCredentialCustodyError,
  atlassianAuthorizationHeaderValue,
  type AtlassianCredentialExecutionResolver,
  type AtlassianHttpBodyRequest,
  type AtlassianHttpRequest,
} from "@oscharko-dev/keiko-connectors";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";

type RequestSnapshot = Readonly<AtlassianHttpRequest | AtlassianHttpBodyRequest>;

export interface AtlassianHttpLifecycleOptions {
  /** Server-owned admission after transport preparation; only synchronous true admits. */
  readonly beforeDispatch?: (request: RequestSnapshot) => boolean;
  /** Record the observed status before consuming the body; only synchronous true confirms. */
  readonly onResponse?: (request: RequestSnapshot, status: number) => boolean;
}

interface RequestLifecycle {
  readonly prepareHeaders: () => Headers;
  readonly observe: (response: Response) => Promise<void>;
  readonly rethrowFailure: () => void;
}

function requireConfirmation(result: unknown): void {
  if (result !== true) {
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "Atlassian request lifecycle was not synchronously confirmed",
    ]);
  }
}

function reportObservationFailure(correlationId: string, error: unknown): void {
  emitServerDiagnostic(
    undefined,
    serverDiagnosticFromError({
      correlationId,
      operation: "atlassian.http-observation-failed",
      source: "atlassian-http-lifecycle",
      error,
      redact: () => "server-operation-failed",
    }),
  );
}

/** A JSON body is declared as such; a governed upload also carries Jira's XSRF opt-out (#4176). */
function requestBodyHeaders(request: RequestSnapshot): Record<string, string> {
  if ("upload" in request && request.upload !== undefined)
    return { "content-type": request.upload.contentType, "x-atlassian-token": "no-check" };
  return "bodyJson" in request && request.bodyJson !== undefined
    ? { "content-type": "application/json" }
    : {};
}

export function atlassianHttpRequestLifecycle(
  options: AtlassianHttpLifecycleOptions & {
    readonly credentials: AtlassianCredentialExecutionResolver;
    readonly authRef: string;
    readonly correlationId: string;
  },
  request: RequestSnapshot,
): RequestLifecycle {
  const { credentials, authRef, beforeDispatch, onResponse, correlationId } = options;
  let failure: { readonly error: unknown } | undefined;
  function run<T>(callback: () => T): T {
    try {
      return callback();
    } catch (error) {
      failure = { error };
      throw error;
    }
  }
  return {
    prepareHeaders: (): Headers =>
      run(() => {
        if (beforeDispatch !== undefined) requireConfirmation(beforeDispatch(request));
        const credential = credentials.resolveForExecution(authRef);
        return new Headers({
          authorization: atlassianAuthorizationHeaderValue(credential),
          accept: "application/json",
          ...requestBodyHeaders(request),
        });
      }),
    observe: async (response: Response): Promise<void> => {
      try {
        if (onResponse !== undefined)
          run(() => {
            requireConfirmation(onResponse(request, response.status));
          });
      } catch (error) {
        reportObservationFailure(correlationId, error);
        await response.body?.cancel().catch(() => undefined);
        throw error;
      }
    },
    rethrowFailure: (): void => {
      if (failure !== undefined) throw failure.error;
    },
  };
}
