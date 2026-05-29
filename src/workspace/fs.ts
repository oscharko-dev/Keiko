// The single filesystem boundary for the workspace layer (ADR-0005 D1). Every other module
// depends on the `WorkspaceFs` port, never on `node:fs` directly, so discovery/detection are
// testable with an in-memory fake and all real IO is auditable in one place. Synchronous, to
// mirror the existing `loadConfigFromFile`/`readFileSync` usage in the gateway.

import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";

export interface WorkspaceStat {
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

export interface WorkspaceDirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

export interface WorkspaceFs {
  readonly readFileUtf8: (absolutePath: string) => string;
  readonly stat: (absolutePath: string) => WorkspaceStat;
  readonly readDir: (absolutePath: string) => readonly WorkspaceDirEntry[];
  readonly realPath: (absolutePath: string) => string;
  readonly exists: (absolutePath: string) => boolean;
}

function isSymlink(absolutePath: string): boolean {
  return lstatSync(absolutePath, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
}

export const nodeWorkspaceFs: WorkspaceFs = {
  readFileUtf8: (absolutePath: string): string => readFileSync(absolutePath, "utf8"),
  stat: (absolutePath: string): WorkspaceStat => {
    const stats = statSync(absolutePath, { throwIfNoEntry: true });
    return {
      size: stats.size,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      isSymbolicLink: isSymlink(absolutePath),
    };
  },
  readDir: (absolutePath: string): readonly WorkspaceDirEntry[] =>
    readdirSync(absolutePath, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      isSymbolicLink: entry.isSymbolicLink(),
    })),
  realPath: (absolutePath: string): string => realpathSync(absolutePath),
  exists: (absolutePath: string): boolean => {
    try {
      return statSync(absolutePath, { throwIfNoEntry: false }) !== undefined;
    } catch {
      return false;
    }
  },
};
