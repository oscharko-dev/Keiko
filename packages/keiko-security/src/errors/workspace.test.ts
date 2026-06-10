import { describe, expect, it } from "vitest";
import {
  FileTooLargeError,
  PathDeniedError,
  PathEscapeError,
  RepoSearchInvalidQueryError,
  RepoSearchInvalidRangeError,
  RepoSearchUnsupportedFileError,
  WORKSPACE_CODES,
  WorkspaceError,
  WorkspaceNotFoundError,
  WorkspaceReadError,
} from "./workspace.js";

describe("workspace errors", () => {
  it("redacts the message at construction", () => {
    const secret = ["sk-", "abcdef0123456789ABCDEF"].join("");
    const error = new PathEscapeError(`leak ${secret} here`, "..");
    expect(error.message).not.toContain(secret);
    expect(error.message).toContain("[REDACTED]");
  });

  it("redacts caller-supplied additional secrets", () => {
    const error = new WorkspaceReadError("contains topsecret value", "/p", ["topsecret"]);
    expect(error.message).not.toContain("topsecret");
  });

  it("sets name to the concrete subclass name", () => {
    expect(new PathEscapeError("m", "x").name).toBe("PathEscapeError");
    expect(new PathDeniedError("m", "x").name).toBe("PathDeniedError");
    expect(new WorkspaceNotFoundError("m", "x").name).toBe("WorkspaceNotFoundError");
    expect(new FileTooLargeError("m", "x", 10, 5).name).toBe("FileTooLargeError");
    expect(new WorkspaceReadError("m", "x").name).toBe("WorkspaceReadError");
  });

  it("carries stable codes", () => {
    expect(new PathEscapeError("m", "x").code).toBe(WORKSPACE_CODES.PATH_ESCAPE);
    expect(new PathDeniedError("m", "x").code).toBe(WORKSPACE_CODES.PATH_DENIED);
    expect(new WorkspaceNotFoundError("m", "x").code).toBe(WORKSPACE_CODES.NOT_FOUND);
    expect(new FileTooLargeError("m", "x", 10, 5).code).toBe(WORKSPACE_CODES.FILE_TOO_LARGE);
    expect(new WorkspaceReadError("m", "x").code).toBe(WORKSPACE_CODES.READ_FAILED);
  });

  it("carries useful readonly fields", () => {
    expect(new PathEscapeError("m", "../etc").requestedPath).toBe("../etc");
    expect(new PathDeniedError("m", ".env").requestedPath).toBe(".env");
    expect(new WorkspaceNotFoundError("m", "/start/dir").startDir).toBe("/start/dir");
    const tooLarge = new FileTooLargeError("m", "big.bin", 4096, 1024);
    expect(tooLarge.sizeBytes).toBe(4096);
    expect(tooLarge.limitBytes).toBe(1024);
    expect(tooLarge.requestedPath).toBe("big.bin");
    expect(new WorkspaceReadError("m", "r.txt").requestedPath).toBe("r.txt");
  });

  it("instances are WorkspaceError subclasses and real Errors", () => {
    const error = new PathDeniedError("m", "x");
    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error).toBeInstanceOf(Error);
  });

  it("repo-search invalid-query carries the right code, name, and redaction", () => {
    const secret = ["sk-", "abcdef0123456789ABCDEF"].join("");
    const error = new RepoSearchInvalidQueryError(`contains ${secret}`);
    expect(error.code).toBe(WORKSPACE_CODES.REPO_SEARCH_INVALID_QUERY);
    expect(error.name).toBe("RepoSearchInvalidQueryError");
    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error.message).not.toContain(secret);
  });

  it("repo-search invalid-range carries the right code and name", () => {
    const error = new RepoSearchInvalidRangeError("range must be 1-based and increasing");
    expect(error.code).toBe(WORKSPACE_CODES.REPO_SEARCH_INVALID_RANGE);
    expect(error.name).toBe("RepoSearchInvalidRangeError");
    expect(error).toBeInstanceOf(WorkspaceError);
  });

  it("repo-search unsupported-file carries reason and the right code", () => {
    const error = new RepoSearchUnsupportedFileError("binary content", "binary");
    expect(error.code).toBe(WORKSPACE_CODES.REPO_SEARCH_UNSUPPORTED_FILE);
    expect(error.name).toBe("RepoSearchUnsupportedFileError");
    expect(error.reason).toBe("binary");
    expect(error).toBeInstanceOf(WorkspaceError);
  });
});
