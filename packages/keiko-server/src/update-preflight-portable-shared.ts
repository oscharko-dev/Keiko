import type { UpdatePreflightBlocker, UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";
import { UPDATE_PORTABLE_TARGET_ASSET_NAMES } from "@oscharko-dev/keiko-contracts/runtime/update-session";
import { blocker } from "./update-preflight-impact.js";

export interface GitHubAsset {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly downloadUrl: string;
}

export interface PortableRelease {
  readonly id: number;
  readonly targetVersion: string;
  readonly assets: readonly GitHubAsset[];
}

export const MAX_PORTABLE_ASSET_REDIRECTS = 3;
const PORTABLE_RETRY_DELAYS_MS = [1_000, 3_000] as const;
const MAX_RETRY_AFTER_MS = 30_000;

export interface PortableFetchRetryOptions {
  readonly signal?: AbortSignal | undefined;
  readonly deadlineAt?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
}

export type PortableAssetRedirectFailureReason =
  "missing-location" | "malformed-location" | "unsafe-target" | "loop" | "limit" | "unsafe-origin";

export type PortableFetchFailureReason =
  "deadline-exceeded" | "request-aborted" | "network-unavailable" | "unexpected-failure";

const REDIRECT_FAILURE_MESSAGES: Readonly<Record<PortableAssetRedirectFailureReason, string>> = {
  "missing-location": "asset redirect location is missing",
  "malformed-location": "asset redirect location is malformed",
  "unsafe-target": "asset redirect target is unsafe",
  loop: "asset redirect loop detected",
  limit: "asset redirect limit exceeded",
  "unsafe-origin": "asset origin is unsafe",
};

export class PortableAssetRedirectError extends Error {
  public constructor(public readonly reason: PortableAssetRedirectFailureReason) {
    super(REDIRECT_FAILURE_MESSAGES[reason]);
    this.name = "PortableAssetRedirectError";
  }
}

export function portableFetchFailureReason(error: unknown): PortableFetchFailureReason {
  if (error instanceof DOMException) {
    if (error.name === "TimeoutError") return "deadline-exceeded";
    if (error.name === "AbortError") return "request-aborted";
  }
  if (error instanceof TypeError) return "network-unavailable";
  if (typeof error !== "object" || error === null) return "unexpected-failure";
  const code = (error as { readonly code?: unknown }).code;
  return code === "EAI_AGAIN" || code === "ENOTFOUND" || code === "ETIMEDOUT"
    ? "network-unavailable"
    : "unexpected-failure";
}

function transientNetworkError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === "TimeoutError";
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === "EAI_AGAIN" || code === "ENOTFOUND" || code === "ETIMEDOUT";
}

function retryableStatus(response: Response): boolean {
  return response.status === 429 || response.status >= 500;
}

function shouldRetryResponse(response: Response, attempt: number): boolean {
  return retryableStatus(response) && attempt < PORTABLE_RETRY_DELAYS_MS.length;
}

function retryDelay(response: Response | undefined, retry: number, now: number): number {
  const raw = response?.headers.get("retry-after")?.trim();
  if (raw !== undefined && /^\d+$/u.test(raw)) {
    return Math.min(Number(raw) * 1_000, MAX_RETRY_AFTER_MS);
  }
  if (raw !== undefined) {
    const instant = Date.parse(raw);
    if (Number.isFinite(instant)) return Math.min(Math.max(0, instant - now), MAX_RETRY_AFTER_MS);
  }
  return PORTABLE_RETRY_DELAYS_MS[retry] ?? PORTABLE_RETRY_DELAYS_MS.at(-1) ?? 3_000;
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("portable request aborted", "AbortError");
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDone, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDone();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryableFailure(
  error: unknown,
  attempt: number,
  signal: AbortSignal | undefined,
): boolean {
  return (
    signal?.aborted !== true &&
    transientNetworkError(error) &&
    attempt < PORTABLE_RETRY_DELAYS_MS.length
  );
}

function deadlineAllowsRetry(
  deadlineAt: number | undefined,
  current: number,
  delay: number,
): boolean {
  return deadlineAt === undefined || current + delay < deadlineAt;
}

async function waitForPortableRetry(
  response: Response | undefined,
  attempt: number,
  options: PortableFetchRetryOptions,
  now: () => number,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<boolean> {
  const current = now();
  const delay = retryDelay(response, attempt, current);
  if (!deadlineAllowsRetry(options.deadlineAt, current, delay)) return false;
  await response?.body?.cancel();
  await sleep(delay, options.signal);
  return true;
}

function assertPortableFetchWithinDeadline(
  deadlineAt: number | undefined,
  now: () => number,
): void {
  if (deadlineAt !== undefined && now() >= deadlineAt) {
    throw new DOMException("portable request deadline exceeded", "TimeoutError");
  }
}

export async function fetchWithPortableRetry(
  fetchAttempt: () => Promise<Response>,
  options: PortableFetchRetryOptions = {},
): Promise<Response> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  for (let attempt = 0; ; attempt += 1) {
    assertPortableFetchWithinDeadline(options.deadlineAt, now);
    let response: Response | undefined;
    try {
      response = await fetchAttempt();
      if (!shouldRetryResponse(response, attempt)) return response;
    } catch (error) {
      if (!retryableFailure(error, attempt, options.signal)) throw error;
    }
    if (!(await waitForPortableRetry(response, attempt, options, now, sleep))) {
      if (response !== undefined) return response;
      throw new DOMException("portable request deadline exceeded", "TimeoutError");
    }
  }
}

function isApprovedAssetUrl(url: URL, initial: boolean): boolean {
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443")
  ) {
    return false;
  }
  if (initial) {
    return (
      url.hostname === "github.com" &&
      url.pathname.toLowerCase().startsWith("/oscharko-dev/keiko/releases/download/")
    );
  }
  return url.hostname === "github.com" || url.hostname.endsWith(".githubusercontent.com");
}

function redirectTarget(currentUrl: string, response: Response): string | undefined {
  if (response.status < 300 || response.status >= 400) return undefined;
  const location = response.headers.get("location");
  if (location === null || location.trim().length === 0) {
    throw new PortableAssetRedirectError("missing-location");
  }
  let target: URL;
  try {
    target = new URL(location, currentUrl);
  } catch {
    throw new PortableAssetRedirectError("malformed-location");
  }
  if (!isApprovedAssetUrl(target, false)) {
    throw new PortableAssetRedirectError("unsafe-target");
  }
  return target.toString();
}

async function inspectedRedirectTarget(
  currentUrl: string,
  response: Response,
): Promise<string | undefined> {
  try {
    return redirectTarget(currentUrl, response);
  } catch (error) {
    await response.body?.cancel();
    throw error;
  }
}

async function terminalAssetResponse(response: Response): Promise<Response> {
  if (!response.ok) await response.body?.cancel();
  return response;
}

async function continueAssetRedirect(
  response: Response,
  nextUrl: string,
  redirects: number,
  visited: ReadonlySet<string>,
): Promise<void> {
  await response.body?.cancel();
  if (visited.has(nextUrl)) {
    throw new PortableAssetRedirectError("loop");
  }
  if (redirects === MAX_PORTABLE_ASSET_REDIRECTS) {
    throw new PortableAssetRedirectError("limit");
  }
}

export async function fetchGitHubReleaseAsset(
  initialUrl: string,
  fetchHop: (url: string) => Promise<Response>,
): Promise<Response> {
  const initial = new URL(initialUrl);
  if (!isApprovedAssetUrl(initial, true)) {
    throw new PortableAssetRedirectError("unsafe-origin");
  }
  const visited = new Set<string>();
  let currentUrl = initial.toString();
  for (let redirects = 0; redirects <= MAX_PORTABLE_ASSET_REDIRECTS; redirects += 1) {
    visited.add(currentUrl);
    const response = await fetchHop(currentUrl);
    const nextUrl = await inspectedRedirectTarget(currentUrl, response);
    if (nextUrl === undefined) return terminalAssetResponse(response);
    await continueAssetRedirect(response, nextUrl, redirects, visited);
    currentUrl = nextUrl;
  }
  throw new PortableAssetRedirectError("limit");
}

const LEGACY_TARGETS: readonly UpdatePortableTarget[] = ["windows-x64", "macos-arm64", "macos-x64"];

const CURRENT_TARGETS: readonly UpdatePortableTarget[] = ["linux-x64", ...LEGACY_TARGETS];

export function requiredAssetName(target: UpdatePortableTarget): string {
  return UPDATE_PORTABLE_TARGET_ASSET_NAMES[target];
}

export function firstClassArchiveSetComplete(assets: readonly GitHubAsset[]): boolean {
  const archiveNames = assets
    .map((asset) => asset.name)
    .filter((name) => /^keiko-[a-z0-9-]+\.zip$/u.test(name));
  const actual = new Set(archiveNames);
  if (actual.size !== archiveNames.length) return false;
  return [LEGACY_TARGETS, CURRENT_TARGETS].some((targets) => {
    const expected = new Set(targets.map(requiredAssetName));
    return actual.size === expected.size && archiveNames.every((name) => expected.has(name));
  });
}

export function portableBlocker(
  code: UpdatePreflightBlocker["code"],
  message: string,
): UpdatePreflightBlocker {
  return blocker(code, message, "normal", true);
}
