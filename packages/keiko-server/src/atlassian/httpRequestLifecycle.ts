import {
  AtlassianCredentialCustodyError,
  atlassianAuthorizationHeaderValue,
  jiraPropertyPathKey,
  type AtlassianCredentialExecutionResolver,
  type AtlassianHttpBodyRequest,
  type AtlassianHttpRequest,
  type JiraHumanInputHttpRequest,
} from "@oscharko-dev/keiko-connectors";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import { directoryAccessHeaders } from "./httpDirectoryAccess.js";
import { identityExperimentalHeaders } from "./httpIdentityExperimental.js";
import { decodeCanonicalUriSegment } from "./canonicalUriSegment.js";
import { claimHttpHumanInput } from "./httpHumanInput.js";
import type { JiraHumanInputView } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

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
/** HTTP composition only. Neither variant is accepted from tool arguments or ordinary requests. */
export type JiraPrivateAuthentication =
  | { readonly kind: "anonymous" }
  | {
      readonly kind: "session";
      readonly scope: "actor" | "avatar" | "logout" | "websudo";
      readonly cookie: () => string;
      readonly legacyTemporaryRelease?: "10.3" | "10.4";
    };

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
function nativeBodyHeaders(request: RequestSnapshot): Record<string, string> | undefined {
  const identity = "maxBodyBytes" in request ? identityExperimentalHeaders(request) : undefined;
  if (identity !== undefined) return identity;
  const directory = "maxBodyBytes" in request ? directoryAccessHeaders(request) : undefined;
  if (directory !== undefined) return directory;
  const archive = emailTemplateHeaders(
    "jiraEmailTemplateArchive" in request ? request.jiraEmailTemplateArchive : undefined,
    request,
  );
  if (archive !== undefined) return archive;
  const permissionAttribute = permissionAttributeHeaders(
    "jiraPermissionAttribute" in request ? request.jiraPermissionAttribute : undefined,
    request,
  );
  return permissionAttribute;
}
function requestBodyHeaders(request: RequestSnapshot): Record<string, string> {
  const native = nativeBodyHeaders(request);
  if (native !== undefined) return native;
  if ("upload" in request && request.upload !== undefined)
    return { "content-type": request.upload.contentType, "x-atlassian-token": "no-check" };
  return "bodyJson" in request && request.bodyJson !== undefined
    ? { "content-type": "application/json" }
    : {};
}
function emailTemplateHeaders(
  value: unknown,
  request: RequestSnapshot,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (value !== true || !("maxBodyBytes" in request) || !URL.canParse(request.url))
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "Unsupported email-template archive request",
    ]);
  const url = new URL(request.url);
  if (!emailTemplateUrl(url, request.url))
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "Unsupported email-template archive target",
    ]);
  return emailTemplateBodyHeaders(request);
}
function emailTemplateBodyHeaders(request: AtlassianHttpBodyRequest): Record<string, string> {
  if (
    request.bodyJson !== undefined ||
    request.jiraExperimental !== undefined ||
    request.jiraPermissionAttribute !== undefined
  )
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "Unsupported email-template archive content",
    ]);
  if (request.method === "GET" && request.upload === undefined)
    return { accept: "application/zip" };
  if (request.method === "POST" && request.upload?.contentType === "application/zip")
    return { "content-type": "application/zip" };
  throw new AtlassianCredentialCustodyError("invalid-input", [
    "Unsupported email-template archive body",
  ]);
}
function emailTemplateUrl(url: URL, raw: string): boolean {
  return (
    closedJiraUrl(url) &&
    url.toString() === raw &&
    url.pathname.endsWith("/rest/api/2/email-templates") &&
    !/%(?:2e|2f|5c|25)/iu.test(url.pathname)
  );
}
// The enclosing HTTP owner already binds the configured HTTPS origin and context path before
// constructing this lifecycle. These fixed opt-ins retain that same floor, including loopback.
function closedJiraUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === ""
  );
}
function canonicalAttributeKey(encoded: string | undefined): boolean {
  return jiraPropertyPathKey(decodeCanonicalUriSegment(encoded));
}
function permissionAttributeUrl(url: URL): boolean {
  if (!closedJiraUrl(url)) return false;
  const match = /\/rest\/api\/2\/permissionscheme\/([1-9][0-9]{0,18})\/attribute\/([^/]+)$/u.exec(
    url.pathname,
  );
  const id = match?.[1];
  return (
    id !== undefined && BigInt(id) <= 9223372036854775807n && canonicalAttributeKey(match?.[2])
  );
}
function plainBooleanRequest(request: RequestSnapshot): boolean {
  return (
    request.method === "PUT" &&
    !("upload" in request && request.upload !== undefined) &&
    "bodyJson" in request &&
    (request.bodyJson === "true" || request.bodyJson === "false")
  );
}
/** PermissionSchemeResource consumes text/plain, not a JSON string. The only admitted bytes
 * are literal booleans at this one native route; ordinary JSON requests stay JSON. */
function permissionAttributeHeaders(
  value: unknown,
  request: RequestSnapshot,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (value !== true || !plainBooleanRequest(request) || !URL.canParse(request.url))
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "Unsupported permission attribute request",
    ]);
  if (!permissionAttributeUrl(new URL(request.url)))
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "Unsupported permission attribute target",
    ]);
  return { "content-type": "text/plain" };
}
function experimentalJiraUrl(url: URL): boolean {
  return (
    closedJiraUrl(url) && /\/rest\/agile\/1\.0\/sprint\/(?:unmap|unmap-all)$/u.test(url.pathname)
  );
}
function experimentalJiraHeaders(value: unknown, request: RequestSnapshot): Record<string, string> {
  if (value === undefined) return {};
  if (value !== true || request.method !== "PUT" || !URL.canParse(request.url))
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "Unsupported experimental Jira request",
    ]);
  if (!experimentalJiraUrl(new URL(request.url)))
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "Unsupported experimental Jira target",
    ]);
  return { "X-ExperimentalApi": "true" };
}

type RequestLifecycleOptions = AtlassianHttpLifecycleOptions & {
  readonly credentials: AtlassianCredentialExecutionResolver;
  readonly authRef: string;
  readonly correlationId: string;
  readonly privateAuthentication?: JiraPrivateAuthentication;
  readonly onHumanInputConsumed?: (view: JiraHumanInputView) => void;
};
interface HeaderPreparation {
  readonly options: RequestLifecycleOptions;
  readonly credentials: AtlassianCredentialExecutionResolver;
  readonly authRef: string;
  readonly beforeDispatch: AtlassianHttpLifecycleOptions["beforeDispatch"];
}
function humanInputHeaders(input: JiraHumanInputHttpRequest | undefined): Record<string, string> {
  return input !== undefined &&
    input.selection.binding.operation !== "jira.unlock-user-anonymization"
    ? {
        "content-type": "application/json",
        ...(input.selection.binding.operation === "jira.update-user-password"
          ? { "X-ExperimentalApi": "true" }
          : {}),
      }
    : {};
}
function prepareRequestHeaders(
  context: HeaderPreparation,
  request: RequestSnapshot,
  headers: Readonly<Record<string, string>>,
): Headers {
  const { options, credentials, authRef, beforeDispatch } = context;
  if (beforeDispatch !== undefined) requireConfirmation(beforeDispatch(request));
  const input = "jiraHumanInput" in request ? request.jiraHumanInput : undefined;
  if (
    input?.selection.binding.operation === "jira.unlock-user-anonymization" &&
    claimHttpHumanInput(credentials, input, options.onHumanInputConsumed)
      .ownerShutdownConfirmation !== "confirmed"
  )
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "Missing human owner-shutdown attestation",
    ]);
  const privateAuth = options.privateAuthentication;
  if (privateAuth?.kind === "anonymous")
    return new Headers({
      accept: "application/json",
      ...headers,
      "content-type": "application/json",
    });
  if (privateAuth?.kind === "session")
    return new Headers({
      cookie: privateAuth.cookie(),
      accept: "application/json",
      ...headers,
    });
  const credential = credentials.resolveForExecution(authRef);
  return new Headers({
    authorization: atlassianAuthorizationHeaderValue(credential),
    accept: "application/json",
    ...humanInputHeaders(input),
    ...headers,
  });
}
export function atlassianHttpRequestLifecycle(
  options: RequestLifecycleOptions,
  request: RequestSnapshot,
): RequestLifecycle {
  const { credentials, authRef, beforeDispatch, onResponse, correlationId } = options;
  const preparation = { options, credentials, authRef, beforeDispatch };
  // Validate the closed opt-in before admission callbacks can mark a native effect dispatched.
  const headers = {
    ...requestBodyHeaders(request),
    ...experimentalJiraHeaders(
      "jiraExperimental" in request ? request.jiraExperimental : undefined,
      request,
    ),
  };
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
    prepareHeaders: (): Headers => run(() => prepareRequestHeaders(preparation, request, headers)),
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
