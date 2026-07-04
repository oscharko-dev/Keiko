// File-backed tool-result artifact store. Shapers stay pure at the harness boundary; production
// wiring injects this synchronous writer/reader from the evidence layer so compacted tool
// observations can be rehydrated without embedding raw output in model context.

import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { replaceViaDurableTempFile } from "./durable-write.js";
import { EvidenceReadError, EvidenceWriteError } from "./errors.js";
import { existingOwnedDirectory, ownedChildPath, prepareOwnedDirectory } from "./fs-safety.js";

export const TOOL_RESULT_ARTIFACT_SUBDIR = "tool-results";
export const TOOL_RESULT_ARTIFACT_SUFFIX = ".tool-result.txt";

export interface ToolResultArtifactStore {
  readonly write: (artifactId: string, content: string) => void;
  readonly read: (artifactId: string) => string | undefined;
  readonly location: (artifactId: string) => string;
}

export interface NodeToolResultArtifactStoreOptions {
  readonly fs?: WorkspaceFs | undefined;
  readonly randomSuffix?: (() => string) | undefined;
}

function isLowerHex(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 102);
}

function assertValidArtifactId(artifactId: string): void {
  if (artifactId.length !== 64) {
    throw new EvidenceWriteError("tool-result artifactId must be a 64-character sha256 hex id");
  }
  for (let i = 0; i < artifactId.length; i += 1) {
    if (!isLowerHex(artifactId.charCodeAt(i))) {
      throw new EvidenceWriteError("tool-result artifactId contains a disallowed character");
    }
  }
}

function artifactDir(baseDir: string): string {
  return join(baseDir, TOOL_RESULT_ARTIFACT_SUBDIR);
}

function artifactName(artifactId: string): string {
  assertValidArtifactId(artifactId);
  return `${artifactId}${TOOL_RESULT_ARTIFACT_SUFFIX}`;
}

function prepareArtifactDir(baseDir: string, fs: WorkspaceFs): string {
  const dir = artifactDir(baseDir);
  return prepareOwnedDirectory(dir, fs, "tool-result artifact directory", { mode: 0o700 });
}

function existingArtifactDir(baseDir: string, fs: WorkspaceFs): string | undefined {
  const dir = artifactDir(baseDir);
  return existingOwnedDirectory(dir, fs, "tool-result artifact directory");
}

function artifactPath(realDir: string, artifactId: string): string {
  return ownedChildPath(realDir, artifactName(artifactId));
}

function isSingleLinkRegularFile(path: string, fs: WorkspaceFs): boolean {
  try {
    const stat = fs.stat(path);
    return stat.isFile && (stat.hardLinkCount ?? 1) <= 1;
  } catch (error) {
    throw new EvidenceReadError(
      `cannot inspect tool-result artifact: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function assertWritableArtifact(target: string, fs: WorkspaceFs): void {
  const entry = lstatSync(target, { throwIfNoEntry: false });
  if (entry === undefined) {
    return;
  }
  if (!entry.isFile() || !isSingleLinkRegularFile(target, fs)) {
    throw new EvidenceWriteError("cannot overwrite a non-ledger tool-result artifact");
  }
}

function atomicWriteText(target: string, content: string, randomSuffix: () => string): void {
  const temp = `${target}.${randomSuffix()}.tmp`;
  try {
    replaceViaDurableTempFile(target, temp, content);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new EvidenceWriteError(
      `tool-result artifact write failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
}

function readArtifact(target: string, fs: WorkspaceFs): string | undefined {
  const entry = lstatSync(target, { throwIfNoEntry: false });
  if (entry === undefined) {
    return undefined;
  }
  if (!entry.isFile() || !isSingleLinkRegularFile(target, fs)) {
    throw new EvidenceReadError("cannot read a non-ledger tool-result artifact");
  }
  return readFileSync(target, "utf8");
}

export function createNodeToolResultArtifactStore(
  baseDir: string,
  options: NodeToolResultArtifactStoreOptions = {},
): ToolResultArtifactStore {
  const fs = options.fs ?? nodeWorkspaceFs;
  const randomSuffix = options.randomSuffix ?? randomUUID;
  return {
    write: (artifactId: string, content: string): void => {
      const realDir = prepareArtifactDir(baseDir, fs);
      const target = artifactPath(realDir, artifactId);
      assertWritableArtifact(target, fs);
      atomicWriteText(target, content, randomSuffix);
    },
    read: (artifactId: string): string | undefined => {
      assertValidArtifactId(artifactId);
      const realDir = existingArtifactDir(baseDir, fs);
      if (realDir === undefined) {
        return undefined;
      }
      return readArtifact(artifactPath(realDir, artifactId), fs);
    },
    location: (artifactId: string): string => {
      assertValidArtifactId(artifactId);
      const realDir = existingArtifactDir(baseDir, fs);
      return realDir === undefined
        ? join(resolve(artifactDir(baseDir)), artifactName(artifactId))
        : artifactPath(realDir, artifactId);
    },
  };
}
