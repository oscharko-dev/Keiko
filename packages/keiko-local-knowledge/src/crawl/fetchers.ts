// Manual crawl fetcher implementations (Epic #1853, Issues #1872/#1874).
//
// Two egress-free implementations of the `ManualCrawlFetcher` port live here:
//   • `createWorkspaceFsManualFetcher` — the production reader for LOCAL manuals. It reads page
//     bytes through the boundary-checked `WorkspaceFs` port (realpath containment, byte cap) — the
//     same seam the discovery/extraction pipeline already uses. No network.
//   • `createInMemoryManualFetcher` — a deterministic fixture fetcher (tests + the http path's unit
//     proof) keyed by canonical target identity.
//
// The production HTTP reader is intentionally NOT here: network egress is forbidden in
// keiko-local-knowledge (ADR-0019 trust-9). `keiko-server` supplies a `gatewayFetch`-backed fetcher
// for real intranet manuals (ADR-0038 egress, DNS-rebinding-safe).

import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { isContained } from "../discovery/walk.js";
import type {
  ManualCrawlFetcher,
  ManualFetchOptions,
  ManualFetchResult,
  ManualFetchTarget,
} from "./types.js";

function targetKey(target: ManualFetchTarget): string {
  return target.kind === "http" ? target.url : target.relativePath;
}

export interface WorkspaceFsManualFetcherDeps {
  readonly fs: WorkspaceFs;
  // Absolute path to the resolved manual root. Every read is confined beneath it via realpath.
  readonly rootAbsolutePath: string;
}

async function readLocalPage(
  deps: WorkspaceFsManualFetcherDeps,
  relativePath: string,
  options: ManualFetchOptions,
): Promise<ManualFetchResult> {
  const readFileBytes = deps.fs.readFileBytes;
  if (readFileBytes === undefined) return { ok: false, reason: "fetch-failed" };
  const absolutePath = `${deps.rootAbsolutePath}/${relativePath}`.replace(/\/+/gu, "/");
  try {
    const realPath = deps.fs.realPath(absolutePath);
    if (!isContained(deps.rootAbsolutePath, realPath)) {
      return { ok: false, reason: "path-traversal" };
    }
    const truncated = deps.fs.stat(realPath).size > options.maxBytes;
    const bytes = await readFileBytes(absolutePath, options.maxBytes);
    return { ok: true, bytes, contentType: "text/html", truncated };
  } catch {
    return { ok: false, reason: "fetch-failed" };
  }
}

// Production fetcher for local manuals: reads only under the resolved root, via the WorkspaceFs
// boundary. An http target is refused (a local manual never contacts the network).
export function createWorkspaceFsManualFetcher(
  deps: WorkspaceFsManualFetcherDeps,
): ManualCrawlFetcher {
  return {
    fetchManualPage: (target, options): Promise<ManualFetchResult> => {
      if (target.kind !== "local") return Promise.resolve({ ok: false, reason: "fetch-failed" });
      return readLocalPage(deps, target.relativePath, options);
    },
  };
}

export interface InMemoryManualPage {
  // UTF-8 HTML content, or raw bytes when a specific encoding must be exercised.
  readonly html?: string;
  readonly bytes?: Uint8Array;
  readonly contentType?: string | null;
  // When set, the fetcher reports a refused redirect (followRedirects is always false).
  readonly redirected?: boolean;
}

function pageToResult(page: InMemoryManualPage, maxBytes: number): ManualFetchResult {
  if (page.redirected === true) {
    return {
      ok: true,
      bytes: new Uint8Array(0),
      contentType: page.contentType ?? null,
      redirected: true,
    };
  }
  const raw = page.bytes ?? new TextEncoder().encode(page.html ?? "");
  const truncated = raw.length > maxBytes;
  const bytes = truncated ? raw.subarray(0, maxBytes) : raw;
  return { ok: true, bytes, contentType: page.contentType ?? "text/html", truncated };
}

// Deterministic in-memory fetcher keyed by canonical target identity (http url or local relative
// path). Unknown targets resolve to a `fetch-failed` denial, exactly as a real 404 would.
export function createInMemoryManualFetcher(
  pages: ReadonlyMap<string, InMemoryManualPage>,
): ManualCrawlFetcher {
  return {
    fetchManualPage: (target, options): Promise<ManualFetchResult> => {
      const page = pages.get(targetKey(target));
      if (page === undefined) return Promise.resolve({ ok: false, reason: "fetch-failed" });
      return Promise.resolve(pageToResult(page, options.maxBytes));
    },
  };
}
