import type { CodingRepositoryFailureReason } from "@oscharko-dev/keiko-contracts/runtime/coding-repository-search";
import {
  FileTooLargeError,
  PathDeniedError,
  PathEscapeError,
  RepoSearchInvalidQueryError,
  RepoSearchInvalidRangeError,
  WorkspaceReadError,
} from "./errors.js";
import type { StructuralExecutionControl } from "./structuralExecution.js";

export class CodingRepositorySearchError extends Error {
  public constructor(
    public readonly reason: CodingRepositoryFailureReason,
    cause?: unknown,
  ) {
    super(`coding repository operation ${reason}`, cause === undefined ? undefined : { cause });
    this.name = "CodingRepositorySearchError";
  }
}

export function codingRepositoryFailure(
  error: unknown,
  control: StructuralExecutionControl,
): CodingRepositorySearchError {
  if (control.nowMs() >= control.deadlineAtMs)
    return new CodingRepositorySearchError("timeout", error);
  if (control.signal?.aborted === true) return new CodingRepositorySearchError("cancelled", error);
  if (error instanceof CodingRepositorySearchError) return error;
  return knownFailure(error);
}

function knownFailure(error: unknown): CodingRepositorySearchError {
  if (error instanceof PathDeniedError || error instanceof PathEscapeError)
    return new CodingRepositorySearchError("scope-denied", error);
  if (error instanceof FileTooLargeError)
    return new CodingRepositorySearchError("file-too-large", error);
  if (error instanceof RepoSearchInvalidQueryError || error instanceof RepoSearchInvalidRangeError)
    return new CodingRepositorySearchError("invalid-request", error);
  if (error instanceof WorkspaceReadError)
    return new CodingRepositorySearchError("file-unreadable", error);
  return new CodingRepositorySearchError("failed", error);
}
