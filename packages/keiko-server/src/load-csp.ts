import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildCspHeader, extractInlineScriptHashes } from "./csp.js";

function parseHashes(raw: string): readonly string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

async function collectHtmlFiles(staticRoot: string): Promise<readonly string[]> {
  let entries: { isDirectory: () => boolean; name: string }[];
  try {
    const raw = await readdir(staticRoot, { withFileTypes: true });
    entries = raw.map(
      (entry: {
        isDirectory: () => boolean;
        name: string;
      }): { isDirectory: () => boolean; name: string } => ({
        isDirectory: () => entry.isDirectory(),
        name: entry.name,
      }),
    );
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const resolved = join(staticRoot, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectHtmlFiles(resolved)));
      continue;
    }
    if (entry.name.endsWith(".html")) {
      files.push(resolved);
    }
  }
  return files;
}

function normalizeHashes(raw: readonly string[]): readonly string[] {
  return [...raw].filter((value) => value !== "").sort();
}

function hashesMatch(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

async function loadHashesFromFile(hashesFile: string): Promise<readonly string[]> {
  try {
    const raw = await readFile(hashesFile, "utf8");
    return normalizeHashes(parseHashes(raw));
  } catch {
    return [];
  }
}

async function loadHashesFromExport(staticRoot: string): Promise<readonly string[]> {
  const htmlFiles = await collectHtmlFiles(staticRoot);
  if (htmlFiles.length === 0) {
    return [];
  }
  try {
    const documents = await Promise.all(htmlFiles.map((file) => readFile(file, "utf8")));
    return normalizeHashes(extractInlineScriptHashes(documents));
  } catch {
    return [];
  }
}

export async function loadCspHeader(hashesFile: string): Promise<string> {
  const fileHashes = await loadHashesFromFile(hashesFile);
  const staticRoot = join(dirname(hashesFile), "static");
  const exportHashes = await loadHashesFromExport(staticRoot);

  // If persisted hashes are stale or incompatible with current exported HTML,
  // prefer derived hashes so startup can recover from stale artifacts.
  const hashes =
    exportHashes.length > 0 && !hashesMatch(fileHashes, exportHashes) ? exportHashes : fileHashes;
  return buildCspHeader(hashes);
}

interface LiveCspCache {
  signature: string | undefined;
  header: string;
}

function signatureFor(stats: { mtimeMs: number; size: number }): string {
  return `${String(stats.mtimeMs)}:${String(stats.size)}`;
}

export function createLiveCspHeaderProvider(hashesFile: string): () => Promise<string> {
  const cache: LiveCspCache = { signature: undefined, header: buildCspHeader([]) };
  return async () => {
    let signature: string;
    try {
      signature = signatureFor(await stat(hashesFile));
    } catch {
      cache.signature = undefined;
      cache.header = buildCspHeader([]);
      return cache.header;
    }
    if (signature !== cache.signature) {
      cache.signature = signature;
      cache.header = await loadCspHeader(hashesFile);
    }
    return cache.header;
  };
}
