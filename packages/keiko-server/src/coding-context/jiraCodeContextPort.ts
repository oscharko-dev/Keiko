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
  if (url.hostname !== base.hostname || url.protocol !== "https:") {
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
  if (url.hostname !== base.hostname || url.protocol !== "https:") {
    throw new JiraCodeContextPortError("jira-denied");
  }
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
  const authorization = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`;
  return {
    readJson: async (request: JiraCodeContextHttpRequest): Promise<unknown> => {
      const url = requestUrl(base, request);
      let response: Response;
      try {
        response = await fetchFn(url, {
          method: "GET",
          redirect: "follow",
          headers: { accept: "application/json", authorization },
          signal: globalThis.AbortSignal.timeout(timeoutMs),
        });
      } catch {
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
