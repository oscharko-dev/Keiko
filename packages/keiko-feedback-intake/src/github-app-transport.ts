import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { performance } from "node:perf_hooks";

const HOST = "api.github.com";
const ORIGIN = `https://${HOST}`;
export const GITHUB_MAX_RESPONSE_BYTES = 256 * 1024;
// One result per page leaves room for worst-case JSON escaping of a maximum 64 KiB issue body.
// Search is bounded to two results: one valid reconciliation candidate plus duplicate detection.
export const GITHUB_SEARCH_PAGE_SIZE = 1;
export const GITHUB_MAX_SEARCH_RESULTS = 2;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;

export type GithubHttpOperation =
  | { readonly kind: "inspect-app"; readonly jwt: string }
  | { readonly kind: "inspect-installation"; readonly installationId: string; readonly jwt: string }
  | {
      readonly kind: "inspect-repository-installation";
      readonly repositoryId: string;
      readonly jwt: string;
    }
  | {
      readonly kind: "mint-token";
      readonly installationId: string;
      readonly repositoryId: string;
      readonly jwt: string;
    }
  | {
      readonly kind: "find-marker";
      readonly owner: string;
      readonly repository: string;
      readonly marker: string;
      readonly page: number;
      readonly token: string;
    }
  | {
      readonly kind: "create-issue";
      readonly repositoryId: string;
      readonly title: string;
      readonly body: string;
      readonly labels: readonly string[];
      readonly token: string;
    };

export interface GithubHttpResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Uint8Array;
  readonly requestCommitted: boolean;
  readonly retryAfter?: string;
  readonly rateLimitRemaining?: string;
  readonly rateLimitReset?: string;
}

export interface GithubTransport {
  execute(
    operation: GithubHttpOperation,
    options?: GithubTransportRequestOptions,
  ): Promise<GithubHttpResponse>;
}

export interface GithubTransportRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function boundedTimeout(requested: number | undefined, maximum: number): number {
  const timeout = Math.min(requested ?? maximum, maximum);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new GithubTransportError(false);
  return timeout;
}

export class GithubTransportError extends Error {
  constructor(readonly requestCommitted: boolean) {
    super("GitHub provider is unavailable");
    this.name = "GithubTransportError";
  }
}

interface RequestProjection {
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly authorization: string;
  readonly body?: Uint8Array;
}

function id(value: string): string {
  if (!DECIMAL_ID.test(value)) throw new GithubTransportError(false);
  return value;
}

function page(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1 || value > GITHUB_MAX_SEARCH_RESULTS) {
    throw new GithubTransportError(false);
  }
  return String(value);
}

function createIssueBody(
  operation: Extract<GithubHttpOperation, { kind: "create-issue" }>,
): Buffer {
  return Buffer.from(
    JSON.stringify({ title: operation.title, body: operation.body, labels: operation.labels }),
  );
}

function searchQuery(owner: string, repository: string, marker: string): string {
  const slug = /^[A-Za-z0-9_.-]{1,100}$/u;
  const exactMarker = /^<!-- keiko-feedback-reconciliation-v1:[A-Za-z0-9_-]{43} -->$/u;
  if (!slug.test(owner) || !slug.test(repository) || !exactMarker.test(marker)) {
    throw new GithubTransportError(false);
  }
  return encodeURIComponent(`repo:${owner}/${repository} "${marker}" in:body`);
}

export function githubSearchIssuesPath(
  owner: string,
  repository: string,
  marker: string,
  pageNumber: number,
): string {
  return `/search/issues?q=${searchQuery(owner, repository, marker)}&per_page=${String(GITHUB_SEARCH_PAGE_SIZE)}&page=${page(pageNumber)}`;
}

function project(operation: GithubHttpOperation): RequestProjection {
  switch (operation.kind) {
    case "inspect-app":
      return { path: "/app", method: "GET", authorization: `Bearer ${operation.jwt}` };
    case "inspect-installation":
      return {
        path: `/app/installations/${id(operation.installationId)}`,
        method: "GET",
        authorization: `Bearer ${operation.jwt}`,
      };
    case "inspect-repository-installation":
      return {
        path: `/repositories/${id(operation.repositoryId)}/installation`,
        method: "GET",
        authorization: `Bearer ${operation.jwt}`,
      };
    case "mint-token":
      return {
        path: `/app/installations/${id(operation.installationId)}/access_tokens`,
        method: "POST",
        authorization: `Bearer ${operation.jwt}`,
        body: Buffer.from(
          `{"repository_ids":[${id(operation.repositoryId)}],"permissions":{"issues":"write"}}`,
        ),
      };
    case "find-marker":
      return {
        path: githubSearchIssuesPath(
          operation.owner,
          operation.repository,
          operation.marker,
          operation.page,
        ),
        method: "GET",
        authorization: `Bearer ${operation.token}`,
      };
    case "create-issue":
      return {
        path: `/repositories/${id(operation.repositoryId)}/issues`,
        method: "POST",
        authorization: `Bearer ${operation.token}`,
        body: createIssueBody(operation),
      };
  }
}

const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [address, prefix, family] of [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["::ffff:0:0", 96, "ipv6"],
  ["64:ff9b::", 96, "ipv6"],
  ["100::", 64, "ipv6"],
  ["2001::", 23, "ipv6"],
  ["2002::", 16, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
] as const) {
  (family === "ipv4" ? blockedV4 : blockedV6).addSubnet(address, prefix, family);
}

export function isAllowedGithubAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  if (family === 6) return !blockedV6.check(address, "ipv6");
  return false;
}

interface ApprovedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

async function approvedAddress(): Promise<ApprovedAddress> {
  const results = await lookup(HOST, { all: true, verbatim: true });
  if (results.length === 0 || results.some((result) => !isAllowedGithubAddress(result.address))) {
    throw new GithubTransportError(false);
  }
  const approved = results[0];
  if (approved === undefined) throw new GithubTransportError(false);
  if (approved.family !== 4 && approved.family !== 6) throw new GithubTransportError(false);
  return { address: approved.address, family: approved.family };
}

function collectResponse(
  response: import("node:http").IncomingMessage,
  committed: boolean,
): Promise<GithubHttpResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > GITHUB_MAX_RESPONSE_BYTES) response.destroy(new GithubTransportError(committed));
      else chunks.push(chunk);
    });
    response.on("error", () => {
      reject(new GithubTransportError(committed));
    });
    response.on("end", () => {
      const location = response.headers.location;
      if (
        location !== undefined ||
        ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400)
      ) {
        reject(new GithubTransportError(committed));
        return;
      }
      resolve(projectResponse(response, chunks, committed));
    });
  });
}

function boundedRateHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && /^[0-9]{1,12}$/u.test(value) ? value : undefined;
}

function projectResponse(
  response: import("node:http").IncomingMessage,
  chunks: readonly Buffer[],
  committed: boolean,
): GithubHttpResponse {
  const retryAfter = boundedRateHeader(response.headers["retry-after"]);
  const rateLimitRemaining = boundedRateHeader(response.headers["x-ratelimit-remaining"]);
  const rateLimitReset = boundedRateHeader(response.headers["x-ratelimit-reset"]);
  return {
    status: response.statusCode ?? 0,
    contentType: response.headers["content-type"] ?? "",
    body: Uint8Array.from(Buffer.concat(chunks)),
    requestCommitted: committed,
    ...(retryAfter === undefined ? {} : { retryAfter }),
    ...(rateLimitRemaining === undefined ? {} : { rateLimitRemaining }),
    ...(rateLimitReset === undefined ? {} : { rateLimitReset }),
  };
}

function awaitWithDeadline<T>(
  pending: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal?.aborted === true) return Promise.reject(new GithubTransportError(false));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      action();
    };
    const abort = (): void => {
      finish(() => {
        reject(new GithubTransportError(false));
      });
    };
    const timer = setTimeout(abort, timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    void pending.then(
      (value) => {
        finish(() => {
          resolve(value);
        });
      },
      () => {
        finish(() => {
          reject(new GithubTransportError(false));
        });
      },
    );
  });
}

function pinnedRequestOptions(
  projection: RequestProjection,
  selected: ApprovedAddress,
): import("node:https").RequestOptions {
  return {
    method: projection.method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: projection.authorization,
      "user-agent": "keiko-feedback-intake",
      "x-github-api-version": "2022-11-28",
      ...(projection.body === undefined
        ? {}
        : {
            "content-type": "application/json",
            "content-length": projection.body.byteLength,
          }),
    },
    lookup: (_hostname, _options, callback): void => {
      callback(null, selected.address, selected.family);
    },
    servername: HOST,
    rejectUnauthorized: true,
  };
}

// Request, abort, absolute-deadline, and response listeners stay together so cleanup is auditable.
// eslint-disable-next-line max-lines-per-function
function executePinnedRequest(
  projection: RequestProjection,
  selected: ApprovedAddress,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<GithubHttpResponse> {
  let committed = false;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      action();
    };
    const call = request(
      `${ORIGIN}${projection.path}`,
      pinnedRequestOptions(projection, selected),
      (response) => {
        void collectResponse(response, committed).then(
          (value) => {
            finish(() => {
              resolve(value);
            });
          },
          () => {
            finish(() => {
              reject(new GithubTransportError(committed));
            });
          },
        );
      },
    );
    const abort = (): void => {
      call.destroy(new GithubTransportError(committed));
    };
    const deadline = setTimeout(abort, timeoutMs);
    deadline.unref();
    signal?.addEventListener("abort", abort, { once: true });
    call.on("finish", () => {
      committed = true;
    });
    call.on("error", () => {
      finish(() => {
        reject(new GithubTransportError(committed));
      });
    });
    if (projection.body === undefined) call.end();
    else call.end(projection.body);
  });
}

export interface GithubTransportDependencies {
  readonly resolveAddress?: () => Promise<ApprovedAddress>;
  readonly executePinnedRequest?: typeof executePinnedRequest;
  readonly monotonicNow?: () => number;
}

export class FixedOriginGithubTransport implements GithubTransport {
  constructor(
    private readonly deadlineMs = 10_000,
    private readonly dependencies: GithubTransportDependencies = {},
  ) {}

  async execute(
    operation: GithubHttpOperation,
    options: GithubTransportRequestOptions = {},
  ): Promise<GithubHttpResponse> {
    const projection = project(operation);
    const timeoutMs = boundedTimeout(options.timeoutMs, this.deadlineMs);
    if (isAborted(options.signal)) throw new GithubTransportError(false);
    const monotonicNow = this.dependencies.monotonicNow ?? ((): number => performance.now());
    const startedAt = monotonicNow();
    const selected = await awaitWithDeadline(
      (this.dependencies.resolveAddress ?? approvedAddress)(),
      timeoutMs,
      options.signal,
    );
    const remainingMs = timeoutMs - (monotonicNow() - startedAt);
    if (remainingMs <= 0 || isAborted(options.signal)) {
      throw new GithubTransportError(false);
    }
    return (this.dependencies.executePinnedRequest ?? executePinnedRequest)(
      projection,
      selected,
      remainingMs,
      options.signal,
    );
  }
}
