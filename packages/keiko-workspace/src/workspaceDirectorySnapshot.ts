import { createHash } from "node:crypto";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";

export interface WorkspaceDirectorySnapshot {
  readonly scopePath: string;
  readonly fingerprint: string;
}

export function workspaceDirectoryFingerprint(
  entries: readonly {
    readonly name: string;
    readonly isDirectory: boolean;
    readonly isFile: boolean;
  }[],
): string {
  const shape = entries
    .map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory,
      isFile: entry.isFile,
    }))
    .sort((a, b) => compareStrings(a.name, b.name));
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}
