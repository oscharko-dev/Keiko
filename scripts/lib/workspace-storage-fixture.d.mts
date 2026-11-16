import type { Page } from "@playwright/test";

export interface WorkspaceStorageKeys {
  readonly workspace: string;
  readonly connections: string;
  readonly view: string;
}

/** Resolve fixture arguments through the current server installation and production key builder. */
export function workspaceStorageArgs<T>(
  page: Pick<Page, "request">,
  argument: T,
  origin?: string,
): Promise<{ readonly argument: T; readonly storageKeys: WorkspaceStorageKeys }>;
