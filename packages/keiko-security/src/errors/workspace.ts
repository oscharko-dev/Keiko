// Workspace error taxonomy, mirroring the gateway/harness pattern (ADR-0003, ADR-0004).
// Errors carry a stable `code` discriminant; callers switch on `code`, never parse
// `message`. Every message is redacted at construction so errors are always safe to log.

import { redact } from "../redaction.js";

export const WORKSPACE_CODES = {
  PATH_ESCAPE: "WORKSPACE_PATH_ESCAPE",
  PATH_DENIED: "WORKSPACE_PATH_DENIED",
  NOT_FOUND: "WORKSPACE_NOT_FOUND",
  FILE_TOO_LARGE: "WORKSPACE_FILE_TOO_LARGE",
  READ_FAILED: "WORKSPACE_READ_FAILED",
  REPO_SEARCH_INVALID_QUERY: "WORKSPACE_REPO_SEARCH_INVALID_QUERY",
  REPO_SEARCH_INVALID_RANGE: "WORKSPACE_REPO_SEARCH_INVALID_RANGE",
  REPO_SEARCH_UNSUPPORTED_FILE: "WORKSPACE_REPO_SEARCH_UNSUPPORTED_FILE",
} as const;

export type WorkspaceCode = (typeof WORKSPACE_CODES)[keyof typeof WORKSPACE_CODES];

export abstract class WorkspaceError extends Error {
  abstract readonly code: WorkspaceCode;

  constructor(message: string, secrets: readonly string[] = []) {
    super(redact(message, secrets));
    this.name = new.target.name;
  }
}

// Raised when a candidate path escapes the workspace root (NUL, `..`, or absolute escape).
export class PathEscapeError extends WorkspaceError {
  readonly code = WORKSPACE_CODES.PATH_ESCAPE;
  readonly requestedPath: string;

  constructor(message: string, requestedPath: string, secrets: readonly string[] = []) {
    super(message, secrets);
    this.requestedPath = requestedPath;
  }
}

// Raised when a path matches an always-on deny pattern (secrets, deps, build, vcs).
export class PathDeniedError extends WorkspaceError {
  readonly code = WORKSPACE_CODES.PATH_DENIED;
  readonly requestedPath: string;

  constructor(message: string, requestedPath: string, secrets: readonly string[] = []) {
    super(message, secrets);
    this.requestedPath = requestedPath;
  }
}

// Raised when no workspace root (`.git` or `package.json`) is found above startDir.
export class WorkspaceNotFoundError extends WorkspaceError {
  readonly code = WORKSPACE_CODES.NOT_FOUND;
  readonly startDir: string;

  constructor(message: string, startDir: string, secrets: readonly string[] = []) {
    super(message, secrets);
    this.startDir = startDir;
  }
}

// Raised when a file exceeds the configured read size cap.
export class FileTooLargeError extends WorkspaceError {
  readonly code = WORKSPACE_CODES.FILE_TOO_LARGE;
  readonly requestedPath: string;
  readonly sizeBytes: number;
  readonly limitBytes: number;

  constructor(
    message: string,
    requestedPath: string,
    sizeBytes: number,
    limitBytes: number,
    secrets: readonly string[] = [],
  ) {
    super(message, secrets);
    this.requestedPath = requestedPath;
    this.sizeBytes = sizeBytes;
    this.limitBytes = limitBytes;
  }
}

// Raised for an underlying filesystem read failure at the IO boundary.
export class WorkspaceReadError extends WorkspaceError {
  readonly code = WORKSPACE_CODES.READ_FAILED;
  readonly requestedPath: string;

  constructor(message: string, requestedPath: string, secrets: readonly string[] = []) {
    super(message, secrets);
    this.requestedPath = requestedPath;
  }
}

// Raised at the repo-search API boundary when the RetrievalQuery fails validation, has the
// wrong `kind` for the entry point called, or carries a syntactically invalid regex.
export class RepoSearchInvalidQueryError extends WorkspaceError {
  readonly code = WORKSPACE_CODES.REPO_SEARCH_INVALID_QUERY;

  constructor(message: string, secrets: readonly string[] = []) {
    super(message, secrets);
  }
}

// Raised when a readExcerpt request specifies a line range that is not a positive,
// increasing pair of integers, or a scopePath that fails the contracts validator.
export class RepoSearchInvalidRangeError extends WorkspaceError {
  readonly code = WORKSPACE_CODES.REPO_SEARCH_INVALID_RANGE;

  constructor(message: string, secrets: readonly string[] = []) {
    super(message, secrets);
  }
}

// Raised when readExcerpt is called on a file the facade refuses to read or interpret
// (for example: outside the selected scope, denied/ignored by policy, or binary content).
export class RepoSearchUnsupportedFileError extends WorkspaceError {
  readonly code = WORKSPACE_CODES.REPO_SEARCH_UNSUPPORTED_FILE;
  readonly reason: string;

  constructor(message: string, reason: string, secrets: readonly string[] = []) {
    super(message, secrets);
    this.reason = reason;
  }
}
