import { join } from "node:path";

import { OwnerPrivateFileRefused, readOwnerPrivateFile } from "../ownerPrivateStateFile.js";
import {
  PROJECT_CONFIG_FILES,
  parsedProjectConfigObject,
} from "./codingRuntimeRepositoryConfig.js";
import type { SecureWorkspaceTextReadPort } from "./secureWorkspaceTextRead.js";

/**
 * The OpenCode configuration documents a standalone run merges below its inline content: the
 * user's global `opencode.json`/`opencode.jsonc` and the project's `opencode.json` (#3900 AC3/AC4).
 * The native run loads neither itself -- its configuration directory is private and its project
 * layer stays off -- so Keiko reads them here, the global one as an owner-private regular file
 * opened without following a link, the project one through the run's own secure workspace read,
 * and admits from them only the settings it re-validates (`instructions`, `formatter`). Project and global JSONC
 * uses the same strict configuration parser as repository-item admission.
 */
export const CONFIG_DOCUMENT_REFUSALS = [
  "not-regular-file",
  "not-owner-private",
  "too-large",
  "not-text",
  "unsupported-format",
  "config-malformed",
] as const;
export type ConfigDocumentRefusal = (typeof CONFIG_DOCUMENT_REFUSALS)[number];

export interface ConfigDocuments {
  /** Parsed top-level objects, the global ones first, then the project's, in merge order. */
  readonly global: readonly Readonly<Record<string, unknown>>[];
  readonly project: readonly Readonly<Record<string, unknown>>[];
  readonly refused: readonly ConfigDocumentRefusal[];
}

const DOCUMENT_MAX_BYTES = 262_144;
const GLOBAL_CONFIG_FILES = ["opencode.json", "opencode.jsonc"] as const;

/** One configuration document's top-level object, or why it is none. */
export function parsedConfigDocument(
  text: string,
  format: "json" | "jsonc" = "json",
): Readonly<Record<string, unknown>> | "config-malformed" {
  return parsedProjectConfigObject(text, format) ?? "config-malformed";
}

function strictText(bytes: Buffer): string | undefined {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) && !text.includes("\0") ? text : undefined;
}

function globalDocumentText(path: string, refused: ConfigDocumentRefusal[]): string | undefined {
  let bytes: Buffer | undefined;
  try {
    bytes = readOwnerPrivateFile(path, DOCUMENT_MAX_BYTES);
  } catch (error) {
    if (!(error instanceof OwnerPrivateFileRefused)) throw error;
    refused.push(error.reason);
    return undefined;
  }
  if (bytes === undefined) return undefined;
  const text = strictText(bytes);
  if (text === undefined) refused.push("not-text");
  return text;
}

/** The user's global configuration documents, in the producer's merge order. */
export function readGlobalConfigDocuments(directory: string): {
  readonly documents: readonly Readonly<Record<string, unknown>>[];
  readonly refused: readonly ConfigDocumentRefusal[];
} {
  const refused: ConfigDocumentRefusal[] = [];
  const documents: Readonly<Record<string, unknown>>[] = [];
  for (const name of GLOBAL_CONFIG_FILES) {
    const text = globalDocumentText(join(directory, name), refused);
    if (text === undefined) continue;
    const document = parsedConfigDocument(text, name.endsWith(".jsonc") ? "jsonc" : "json");
    if (document === "config-malformed") refused.push(document);
    else documents.push(document);
  }
  return { documents, refused };
}

/** The project's configuration documents, read through the run's own secure workspace read. */
export async function readProjectConfigDocuments(
  workspace: SecureWorkspaceTextReadPort,
  signal?: AbortSignal,
): Promise<{
  readonly documents: readonly Readonly<Record<string, unknown>>[];
  readonly refused: readonly ConfigDocumentRefusal[];
}> {
  const documents: Readonly<Record<string, unknown>>[] = [];
  const refused: ConfigDocumentRefusal[] = [];
  for (const relativePath of PROJECT_CONFIG_FILES) {
    const result = await workspace.readText({
      relativePath,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!result.ok) continue;
    const document = parsedConfigDocument(
      result.text,
      relativePath.endsWith(".jsonc") ? "jsonc" : "json",
    );
    if (document === "config-malformed") refused.push(document);
    else documents.push(document);
  }
  return { documents, refused };
}

/** Both layers a native run merges, global first. */
export async function readConfigDocuments(
  globalConfigDirectory: string,
  workspace: SecureWorkspaceTextReadPort,
  signal?: AbortSignal,
): Promise<ConfigDocuments> {
  const global = readGlobalConfigDocuments(globalConfigDirectory);
  const project = await readProjectConfigDocuments(workspace, signal);
  return {
    global: global.documents,
    project: project.documents,
    refused: [...global.refused, ...project.refused],
  };
}
