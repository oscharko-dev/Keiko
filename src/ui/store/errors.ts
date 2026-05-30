// ADR-0013 — Typed errors with stable codes. NEVER include the raw path, SQL text, or system error
// strings in `.message` — these surface to the BFF error envelope and must be safe to log/expose.

export type UiStoreErrorCode =
  | "invalid_path"
  | "path_not_directory"
  | "path_not_found"
  | "project_exists"
  | "not_found"
  | "invalid_request"
  | "internal";

export class UiStoreError extends Error {
  public readonly code: UiStoreErrorCode;
  public readonly status: number;

  public constructor(code: UiStoreErrorCode, message: string, status: number) {
    super(message);
    this.name = "UiStoreError";
    this.code = code;
    this.status = status;
  }
}

export function invalidPath(message: string): UiStoreError {
  return new UiStoreError("invalid_path", message, 400);
}

export function pathNotDirectory(): UiStoreError {
  return new UiStoreError("path_not_directory", "The path is not a directory.", 400);
}

export function pathNotFound(): UiStoreError {
  return new UiStoreError("path_not_found", "The path does not exist.", 400);
}

export function notFound(entity: string): UiStoreError {
  return new UiStoreError("not_found", `${entity} not found.`, 404);
}

export function invalidRequest(message: string): UiStoreError {
  return new UiStoreError("invalid_request", message, 400);
}

export function projectExists(): UiStoreError {
  return new UiStoreError("project_exists", "Project already registered.", 409);
}
