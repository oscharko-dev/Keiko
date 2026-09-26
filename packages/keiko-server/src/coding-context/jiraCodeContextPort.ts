// Production Jira port for the coding-context connector (Epic #1982, follow-up to #1989).
//
// Governed outbound HTTPS with the same guardrail discipline the server applies to
// other egress (host pinned to the configured Jira base URL, https-only, bounded
// response size, hard timeout, GET-only). No provider SDK. Credentials travel only
// in the Authorization header of the outbound request; they are never logged,
// never placed on errors, and never reach evidence or sidecar state. Errors carry
// content-free codes only.

import { URL } from "node:url";

import type {
  AtlassianCredentialCustody,
  AtlassianCredentialMetadata,
  AtlassianHttpBodyPort,
} from "@oscharko-dev/keiko-connectors";

import type {
  JiraCodeContextHttpPort,
  JiraCodeContextHttpRequest,
} from "./jiraCodeContextConnector.js";

const JIRA_TIMEOUT_MS = 30_000;
const JIRA_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type JiraCodeContextPortErrorCode =
  "jira-config-invalid" | "jira-denied" | "jira-failed" | "jira-invalid-json";

export class JiraCodeContextPortError extends Error {
  readonly code: JiraCodeContextPortErrorCode;

  constructor(code: JiraCodeContextPortErrorCode) {
    super(`jira code context port: ${code}`);
    this.code = code;
  }
}

export interface GovernedJiraCodeContextPortDeps {
  readonly custody: Pick<AtlassianCredentialCustody, "list">;
  readonly httpBodyPortFactory: (metadata: AtlassianCredentialMetadata) => AtlassianHttpBodyPort;
}

/**
 * The sole production Jira context transport. Credential selection and secret resolution stay in
 * the ADR-0128 custody/transport layer; this adapter only selects one configured Jira credential
 * and translates the bounded context read into its already-governed HTTP body port.
 */
export function createGovernedJiraCodeContextHttpPort(
  deps: GovernedJiraCodeContextPortDeps,
): JiraCodeContextHttpPort {
  return {
    readJson: async (request): Promise<unknown> => {
      const metadata = singleJiraCredential(deps.custody);
      const result = await deps.httpBodyPortFactory(metadata)({
        method: request.method,
        url: governedRequestUrl(metadata.baseUrl, request),
        timeoutMs: JIRA_TIMEOUT_MS,
        maxBodyBytes: JIRA_MAX_RESPONSE_BYTES,
      });
      if (
        result.kind !== "response" ||
        result.status < 200 ||
        result.status >= 300 ||
        result.truncated
      ) {
        throw new JiraCodeContextPortError("jira-failed");
      }
      try {
        return JSON.parse(result.bodyText);
      } catch {
        throw new JiraCodeContextPortError("jira-invalid-json");
      }
    },
  };
}

function singleJiraCredential(
  custody: Pick<AtlassianCredentialCustody, "list">,
): AtlassianCredentialMetadata {
  const jira = custody.list().filter((metadata) => metadata.provider === "jira");
  if (jira.length !== 1 || jira[0] === undefined) throw new JiraCodeContextPortError("jira-denied");
  return jira[0];
}

function governedRequestUrl(baseUrl: string, request: JiraCodeContextHttpRequest): string {
  if (!request.path.startsWith("/rest/api/")) throw new JiraCodeContextPortError("jira-denied");
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new JiraCodeContextPortError("jira-denied");
  }
  if (!isSecureJiraBase(base)) throw new JiraCodeContextPortError("jira-denied");
  const url = new URL(request.path, base);
  if (!isPinnedRestApiUrl(url, base)) throw new JiraCodeContextPortError("jira-denied");
  for (const [key, value] of Object.entries(request.query)) url.searchParams.set(key, value);
  return url.toString();
}

function isSecureJiraBase(url: URL): boolean {
  return url.protocol === "https:" && url.username === "" && url.password === "";
}

function isPinnedRestApiUrl(url: URL, base: URL): boolean {
  return (
    url.origin === base.origin && url.protocol === "https:" && url.pathname.startsWith("/rest/api/")
  );
}
