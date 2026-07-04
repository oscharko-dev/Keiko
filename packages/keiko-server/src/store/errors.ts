// ADR-0013 — Typed errors with stable codes. NEVER include the raw path, SQL text, or system error
// strings in `.message` — these surface to the BFF error envelope and must be safe to log/expose.

export type UiStoreErrorCode =
  | "INVALID_PATH"
  | "PATH_NOT_DIRECTORY"
  | "PATH_NOT_FOUND"
  | "PROJECT_EXISTS"
  | "NOT_FOUND"
  | "INVALID_REQUEST"
  | "INTERNAL";

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
  return new UiStoreError("INVALID_PATH", message, 400);
}

export function pathNotDirectory(): UiStoreError {
  return new UiStoreError("PATH_NOT_DIRECTORY", "The path is not a directory.", 400);
}

export function pathNotFound(): UiStoreError {
  return new UiStoreError("PATH_NOT_FOUND", "The path does not exist.", 400);
}

export function notFound(entity: string): UiStoreError {
  return new UiStoreError("NOT_FOUND", `${entity} not found.`, 404);
}

export function invalidRequest(message: string): UiStoreError {
  return new UiStoreError("INVALID_REQUEST", message, 400);
}

export function projectExists(): UiStoreError {
  return new UiStoreError("PROJECT_EXISTS", "Project already registered.", 409);
}
