// Production Jira port for the coding-context connector (Epic #1982, follow-up to #1989).
//
// Governed outbound HTTPS with the same guardrail discipline the server applies to
// other egress (host pinned to the configured Jira base URL, https-only, bounded
// response size, hard timeout, GET-only). No provider SDK. Credentials travel only
// in the Authorization header of the outbound request; they are never logged,
// never placed on errors, and never reach evidence or sidecar state. Errors carry
// content-free codes only.

import { Buffer } from "node:buffer";
import { URL } from "node:url";

import type {
  JiraCodeContextHttpPort,
  JiraCodeContextHttpRequest,
} from "./jiraCodeContextConnector.js";

const JIRA_TIMEOUT_MS = 30_000;
const JIRA_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const JIRA_MAX_REDIRECTS = 5;

export type JiraCodeContextPortErrorCode =
  "jira-config-invalid" | "jira-denied" | "jira-failed" | "jira-invalid-json";

export class JiraCodeContextPortError extends Error {
  readonly code: JiraCodeContextPortErrorCode;

  constructor(code: JiraCodeContextPortErrorCode) {
    super(`jira code context port: ${code}`);
    this.code = code;
  }
}

export interface JiraCodeContextPortConfig {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
}

export interface JiraCodeContextPortDeps {
  readonly fetchFn?: typeof globalThis.fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

export function parseJiraCodeContextPortConfig(
  env: NodeJS.ProcessEnv,
): JiraCodeContextPortConfig | undefined {
  const baseUrl = env.KEIKO_JIRA_BASE_URL;
  const email = env.KEIKO_JIRA_EMAIL;
  const apiToken = env.KEIKO_JIRA_API_TOKEN;
  if (baseUrl === undefined || email === undefined || apiToken === undefined) return undefined;
  if (baseUrl.length === 0 || email.length === 0 || apiToken.length === 0) return undefined;
  return { baseUrl, email, apiToken };
}

function pinnedBaseUrl(config: JiraCodeContextPortConfig): URL {
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new JiraCodeContextPortError("jira-config-invalid");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new JiraCodeContextPortError("jira-config-invalid");
  }
  return url;
}

function requestUrl(base: URL, request: JiraCodeContextHttpRequest): URL {
  // The request type is GET-only by construction; the path gate below is the runtime boundary.
  if (!request.path.startsWith("/rest/api/")) {
    throw new JiraCodeContextPortError("jira-denied");
  }
  const url = new URL(request.path, base);
  for (const [key, value] of Object.entries(request.query)) {
    url.searchParams.set(key, value);
  }
  if (url.origin !== base.origin || url.protocol !== "https:") {
    throw new JiraCodeContextPortError("jira-denied");
  }
  return url;
}

function assertResponseStaysOnHost(responseUrl: string, base: URL): void {
  if (responseUrl === "") return;
  let url: URL;
  try {
    url = new URL(responseUrl);
  } catch {
    throw new JiraCodeContextPortError("jira-denied");
  }
  if (url.origin !== base.origin || url.protocol !== "https:") {
    throw new JiraCodeContextPortError("jira-denied");
  }
}

function redirectDestination(response: Response, current: URL, base: URL): URL | undefined {
  if (response.status < 300 || response.status >= 400) return undefined;
  const location = response.headers.get("location");
  if (location === null) return undefined;
  let destination: URL;
  try {
    destination = new URL(location, current);
  } catch {
    throw new JiraCodeContextPortError("jira-denied");
  }
  if (
    destination.origin !== base.origin ||
    destination.protocol !== "https:" ||
    destination.username !== "" ||
    destination.password !== ""
  ) {
    throw new JiraCodeContextPortError("jira-denied");
  }
  return destination;
}

async function fetchPinnedJiraResponse(
  fetchFn: typeof globalThis.fetch,
  initialUrl: URL,
  base: URL,
  authorization: string,
  signal: AbortSignal,
): Promise<Response> {
  let url = initialUrl;
  for (let redirects = 0; redirects <= JIRA_MAX_REDIRECTS; redirects += 1) {
    const response = await fetchFn(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json", authorization },
      signal,
    });
    const destination = redirectDestination(response, url, base);
    if (destination === undefined) return response;
    if (redirects === JIRA_MAX_REDIRECTS) throw new JiraCodeContextPortError("jira-denied");
    url = destination;
  }
  throw new JiraCodeContextPortError("jira-denied");
}

function parseBoundedJson(payload: string): unknown {
  if (Buffer.byteLength(payload, "utf8") > JIRA_MAX_RESPONSE_BYTES) {
    throw new JiraCodeContextPortError("jira-invalid-json");
  }
  try {
    return JSON.parse(payload);
  } catch {
    throw new JiraCodeContextPortError("jira-invalid-json");
  }
}

export function createJiraCodeContextHttpPort(
  config: JiraCodeContextPortConfig,
  deps: JiraCodeContextPortDeps = {},
): JiraCodeContextHttpPort {
  const base = pinnedBaseUrl(config);
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? JIRA_TIMEOUT_MS;
  const basicAuthCredentials = `${config.email}:${config.apiToken}`;
  const authorization = `Basic ${Buffer.from(basicAuthCredentials).toString("base64")}`;
  return {
    readJson: async (request: JiraCodeContextHttpRequest): Promise<unknown> => {
      const url = requestUrl(base, request);
      let response: Response;
      try {
        response = await fetchPinnedJiraResponse(
          fetchFn,
          url,
          base,
          authorization,
          globalThis.AbortSignal.timeout(timeoutMs),
        );
      } catch (error) {
        if (error instanceof JiraCodeContextPortError) throw error;
        throw new JiraCodeContextPortError("jira-failed");
      }
      assertResponseStaysOnHost(response.url, base);
      if (!response.ok) throw new JiraCodeContextPortError("jira-failed");
      let payload: string;
      try {
        payload = await response.text();
      } catch {
        throw new JiraCodeContextPortError("jira-failed");
      }
      return parseBoundedJson(payload);
    },
  };
}
