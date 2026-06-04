// The single controlled filesystem-WRITE boundary (ADR-0006 D2). WorkspaceFs stays read-only
// (ADR-0005); all mutation goes through this port so the apply phase is auditable and testable
// with an in-memory fake. Callers (patch.ts) MUST pre-validate every absolute path via
// resolveWithinWorkspace + isDenied before handing it here; this adapter does no validation
// itself — it is the effectful edge, kept deliberately thin. Synchronous, mirroring nodeWorkspaceFs.

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";

export interface WorkspaceWriter {
  readonly writeFileUtf8: (absolutePath: string, content: string) => void;
  readonly mkdirp: (absoluteDir: string) => void;
  readonly remove: (absolutePath: string) => void;
  readonly rename: (fromAbsolute: string, toAbsolute: string) => void;
}

export const nodeWorkspaceWriter: WorkspaceWriter = {
  writeFileUtf8: (absolutePath: string, content: string): void => {
    writeFileSync(absolutePath, content, "utf8");
  },
  mkdirp: (absoluteDir: string): void => {
    mkdirSync(absoluteDir, { recursive: true });
  },
  remove: (absolutePath: string): void => {
    rmSync(absolutePath, { force: true });
  },
  rename: (fromAbsolute: string, toAbsolute: string): void => {
    renameSync(fromAbsolute, toAbsolute);
  },
};
