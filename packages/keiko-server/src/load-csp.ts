// Loads the precomputed inline-script CSP hashes emitted by the UI build step (build:ui writes
// `dist/ui/csp-hashes.json`) and folds them into the policy. When the file is absent or malformed,
// the policy is built with no hashes — `script-src 'self'` — which fails closed (inline scripts are
// blocked) rather than weakening the policy with `'unsafe-inline'`.

import { readFile, stat } from "node:fs/promises";
import { buildCspHeader } from "./csp.js";

function parseHashes(raw: string): readonly string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

export async function loadCspHeader(hashesFile: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(hashesFile, "utf8");
  } catch {
    return buildCspHeader([]);
  }
  try {
    return buildCspHeader(parseHashes(raw));
  } catch {
    return buildCspHeader([]);
  }
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
