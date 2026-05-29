// Path-traversal-safe static file serving of the exported UI (ADR-0011 D5/D6). The BFF serves only
// files contained within `dist/ui/static/`. The request path is decoded, normalized, and resolved
// against the static root; the resolved path must remain inside the root or the request is refused.
// There is no shell and no user-controlled path beyond the contained root.

import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { join, normalize, resolve, sep, extname } from "node:path";
import type { ServerResponse } from "node:http";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

// Resolves a URL pathname to an absolute path strictly contained within `root`, or `undefined` when
// the request escapes the root (traversal) or cannot be decoded. Containment is enforced on the
// resolved, normalized path: it must equal `root` or start with `root + sep`.
export function resolveContainedPath(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) {
    return undefined;
  }
  // Containment is enforced below on the resolved path, so traversal segments cannot escape the
  // root regardless of their position; `normalize` only collapses redundant separators here.
  const candidate = resolve(join(root, normalize(decoded)));
  const containedRoot = resolve(root);
  if (candidate !== containedRoot && !candidate.startsWith(containedRoot + sep)) {
    return undefined;
  }
  return candidate;
}

// Streams the file at `filePath` with the correct content type. Returns false when the path is not
// a regular file (caller then falls back to the SPA index or a 404). Uses `lstat` (not `stat`) so a
// symlink planted in the static root is NOT followed: a regular file is served, a symlink is refused
// even when it points back inside the root — matching the audit store's never-follow-a-symlink rule
// (defense in depth; the export pipeline emits only regular files).
export async function serveFile(res: ServerResponse, filePath: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(filePath);
  } catch {
    return false;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return false;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypeFor(filePath));
  res.setHeader("Content-Length", info.size);
  createReadStream(filePath).pipe(res);
  return true;
}
