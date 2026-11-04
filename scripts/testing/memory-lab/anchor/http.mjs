// HTTP plumbing of the anchor fetcher (#4208): one request with a timeout and a classified failure,
// and the retry loop around it. A caller passes a context with the injectable `fetchFn`, `sleep` and
// `log`, and the tuning values `attempts`, `backoffMs`, `maxBackoffMs` and `timeoutMs`.
// Errors never echo a response body: the datasets-server answers {"error": "..."} and only that
// message is quoted, truncated; a gateway's HTML page is dropped.
export const FETCHER = "keiko-memory-lab-anchor-fetch/1";
const JSON_HEADERS = Object.freeze({ accept: "application/json", "user-agent": FETCHER });
export const DOWNLOAD_HEADERS = Object.freeze({ accept: "*/*", "user-agent": FETCHER });
// 422 is listed because the datasets-server answers it sporadically while its backend is degraded
// (observed 2026-11-03: the same offset returned 422, then 500, then 200); the attempt bound still
// ends a genuinely invalid request.
const RETRYABLE_STATUSES = new Set([408, 422, 425, 429]);
const ERROR_DETAIL_CHARS = 200;

/** A failure of one request; `retryable` says whether trying again can help. */
export class FetchFailure extends Error {
  constructor(message, { retryable, status, retryAfterMs, cause } = {}) {
    super(message, { cause });
    this.name = "FetchFailure";
    this.retryable = retryable === true;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function describeNetworkError(error) {
  const code = error?.cause?.code ?? error?.code;
  return typeof code === "string" ? code : (error?.name ?? "error");
}

function retryAfterOf(response) {
  const header = response.headers?.get("retry-after");
  if (typeof header !== "string" || header.trim() === "") return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

// The datasets-server answers errors as {"error": "..."}; a gateway answers HTML. Only the former is
// quoted, truncated, and nothing of a body is ever echoed otherwise.
async function errorDetail(response) {
  const text = await response.text().catch(() => "");
  try {
    const message = JSON.parse(text)?.error;
    return typeof message === "string" ? `: ${message.slice(0, ERROR_DETAIL_CHARS)}` : "";
  } catch {
    return "";
  }
}

export async function requestOnce(url, context, { timeoutMs, headers }) {
  let response;
  try {
    response = await context.fetchFn(url, {
      headers,
      signal: globalThis.AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new FetchFailure(`request failed (${describeNetworkError(error)})`, {
      retryable: true,
      cause: error,
    });
  }
  if (response.ok) return response;
  const status = response.status;
  throw new FetchFailure(`HTTP ${String(status)}${await errorDetail(response)}`, {
    retryable: status >= 500 || RETRYABLE_STATUSES.has(status),
    status,
    retryAfterMs: retryAfterOf(response),
  });
}

function retryDelayMs(failure, attempt, context) {
  const requested = failure.retryAfterMs ?? context.backoffMs * 2 ** (attempt - 1);
  return Math.min(requested, context.maxBackoffMs);
}

// Runs one attempt; a retryable failure waits and recurses, anything else ends with a message that
// names what was being fetched and how often it was tried.
export async function withRetries(context, what, attemptOnce, attempt = 1) {
  try {
    return await attemptOnce();
  } catch (error) {
    if (!(error instanceof FetchFailure)) throw error;
    if (!error.retryable || attempt >= context.attempts)
      throw new FetchFailure(
        `${what} failed after ${String(attempt)} attempt(s): ${error.message}`,
        { status: error.status, cause: error },
      );
    const delayMs = retryDelayMs(error, attempt, context);
    context.log(`retry ${what}: ${error.message}; waiting ${String(delayMs)} ms`);
    await context.sleep(delayMs);
    return withRetries(context, what, attemptOnce, attempt + 1);
  }
}

async function readBodyText(response) {
  try {
    return await response.text();
  } catch (error) {
    throw new FetchFailure(`response body interrupted (${describeNetworkError(error)})`, {
      retryable: true,
      cause: error,
    });
  }
}

function parseJson(text, accepts) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FetchFailure("response body is not JSON", { retryable: true });
  }
  if (!accepts(value)) throw new FetchFailure("response has an unexpected shape");
  return value;
}

/** Requests a JSON document with retries; `accepts` validates its shape. Returns text and value. */
export async function requestJson(url, what, context, accepts) {
  return withRetries(context, what, async () => {
    const response = await requestOnce(url, context, {
      timeoutMs: context.timeoutMs,
      headers: JSON_HEADERS,
    });
    const text = await readBodyText(response);
    return { text, value: parseJson(text, accepts) };
  });
}
