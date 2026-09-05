import type {
  GitDeliveryObservationFailure,
  GitDeliveryObservationFailureReason,
  GitDeliveryReadCompleteness,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import { gitDeliveryObservationFailure } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import {
  CommandCancelledError,
  CommandDeniedError,
  CommandTimeoutError,
  OutputLimitError,
} from "./errors.js";
import type { CommandResult } from "./types.js";

function localFailure(error: Error): GitDeliveryObservationFailureReason {
  if (error instanceof CommandDeniedError) return "authority-denied";
  if (error instanceof CommandCancelledError) return "cancelled";
  if (error instanceof CommandTimeoutError) return "timeout";
  if (error instanceof OutputLimitError) return "output-truncated";
  return "provider-unavailable";
}

function providerFailure(result: CommandResult): GitDeliveryObservationFailureReason | undefined {
  if (result.truncated) return "output-truncated";
  if (result.timedOut) return "timeout";
  if (result.exitCode === 0 && result.signal === null) return undefined;
  // Rate limits can be HTTP 403. Only actual command responses enter this classifier.
  if (/\bHTTP\s+429\b|\brate limit\b/iu.test(result.stderr)) return "rate-limited";
  if (/\bHTTP\s+401\b/u.test(result.stderr)) return "auth-required";
  if (/\bHTTP\s+403\b/u.test(result.stderr)) return "provider-forbidden";
  if (/\bHTTP\s+404\b/u.test(result.stderr)) return "provider-not-found";
  return "provider-unavailable";
}

export function classifyGitProviderReadFailure(
  result: CommandResult | Error,
): GitDeliveryObservationFailure | undefined {
  const reason = result instanceof Error ? localFailure(result) : providerFailure(result);
  return reason === undefined ? undefined : gitDeliveryObservationFailure(reason);
}

/** Internal read seam; production supplies the existing governed merge adapter's runGh. */
export type GitProviderReadRunner = (argv: readonly string[]) => Promise<CommandResult | Error>;

export interface GitProviderPageInput {
  readonly run: GitProviderReadRunner;
  readonly argv: (page: number) => readonly string[];
  readonly pageSize: number;
  readonly maxPages: number;
  readonly maxBytes: number;
  readonly counted?: boolean;
  readonly signal?: AbortSignal;
}

export interface GitProviderPageResult {
  readonly values: readonly unknown[];
  readonly completeness: GitDeliveryReadCompleteness;
}

interface PageState {
  pages: number;
  bytes: number;
  values: unknown[];
  total: number | undefined;
}

interface ParsedPage {
  readonly values: readonly unknown[];
  readonly total?: number;
}

function validBounds(input: GitProviderPageInput): boolean {
  return [
    [input.pageSize, 100],
    [input.maxPages, 5],
    [input.maxBytes, 1_048_576],
  ].every(
    ([value, max]) =>
      value !== undefined &&
      max !== undefined &&
      Number.isSafeInteger(value) &&
      value > 0 &&
      value <= max,
  );
}

function parsePage(stdout: string, counted: boolean): ParsedPage | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!counted) return Array.isArray(value) ? { values: value } : undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return countedPage(value as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

function countedPage(record: Record<string, unknown>): ParsedPage | undefined {
  return Array.isArray(record.values) &&
    typeof record.total === "number" &&
    Number.isSafeInteger(record.total) &&
    record.total >= 0 &&
    Object.keys(record).length === 2
    ? { values: record.values, total: record.total }
    : undefined;
}

function finish(state: PageState, failure?: GitDeliveryObservationFailure): GitProviderPageResult {
  const counts = { pages: state.pages, bytes: state.bytes, entries: state.values.length };
  return {
    values: state.values,
    completeness:
      failure === undefined
        ? { ...counts, complete: true }
        : { ...counts, complete: false, failure },
  };
}

async function fetchPage(
  input: GitProviderPageInput,
  page: number,
): Promise<CommandResult | Error> {
  try {
    return await input.run(input.argv(page));
  } catch (error) {
    return error instanceof Error ? error : new Error("Provider read failed");
  }
}

function acceptPage(
  input: GitProviderPageInput,
  state: PageState,
  result: CommandResult,
): { readonly done: boolean; readonly failure?: GitDeliveryObservationFailure } {
  const page = parsePage(result.stdout, input.counted === true);
  if (page === undefined || page.values.length > input.pageSize)
    return { done: true, failure: gitDeliveryObservationFailure("malformed-response") };
  if (state.total !== undefined && state.total !== page.total)
    return { done: true, failure: gitDeliveryObservationFailure("revision-changed") };
  state.total = page.total;
  state.values.push(...page.values);
  if (state.total === undefined) return { done: page.values.length < input.pageSize };
  if (
    state.values.length > state.total ||
    (page.values.length < input.pageSize && state.values.length < state.total)
  )
    return { done: true, failure: gitDeliveryObservationFailure("revision-changed") };
  return { done: state.values.length === state.total };
}

function evaluateResponse(
  input: GitProviderPageInput,
  state: PageState,
  result: CommandResult | Error,
): { readonly done: boolean; readonly failure?: GitDeliveryObservationFailure } {
  if (!(result instanceof Error)) {
    state.bytes +=
      Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8");
    if (state.bytes > input.maxBytes)
      return { done: true, failure: gitDeliveryObservationFailure("output-truncated") };
  }
  const failure = classifyGitProviderReadFailure(result);
  if (failure !== undefined) return { done: true, failure };
  if (result instanceof Error)
    return { done: true, failure: gitDeliveryObservationFailure("provider-unavailable") };
  return acceptPage(input, state, result);
}

function observationCancelled(input: GitProviderPageInput): boolean {
  return input.signal?.aborted === true;
}

export async function readGitProviderPages(
  request: GitProviderPageInput,
): Promise<GitProviderPageResult> {
  const input = Object.freeze({ ...request });
  const state: PageState = { pages: 0, bytes: 0, values: [], total: undefined };
  if (!validBounds(input)) return finish(state, gitDeliveryObservationFailure("invalid-binding"));
  for (let page = 1; page <= input.maxPages; page += 1) {
    if (observationCancelled(input))
      return finish(state, gitDeliveryObservationFailure("cancelled"));
    const result = await fetchPage(input, page);
    state.pages += 1;
    if (observationCancelled(input))
      return finish(state, gitDeliveryObservationFailure("cancelled"));
    const accepted = evaluateResponse(input, state, result);
    if (accepted.done) return finish(state, accepted.failure);
  }
  return finish(state, gitDeliveryObservationFailure("pagination-exhausted"));
}
