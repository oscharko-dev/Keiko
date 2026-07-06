// Static HTML manual crawl scope guard (Epic #1853, Issue #1873).
//
// The single, pure decision every crawl step routes a candidate link through BEFORE it is fetched
// or read. It layers an approved origin / path-prefix / local-root allowlist ON TOP of the base
// scope, failing closed on every scope-expansion vector: cross-origin links, parent-directory
// escapes, unsupported schemes, credentialed URLs, login/logout/action links, non-HTML targets, and
// hidden/credential files. It emits only body-free reason codes — never a raw denied URL or path.
//
// It is deliberately egress-free and side-effect-free (ADR-0019 trust-9): the DNS-resolution
// re-check (rebinding defence) for the http path lives in the injected fetcher's `gatewayFetch`
// egress layer (ADR-0038, `egress-policy.ts`), not here. Because every accepted http link is proven
// same-origin as the approved (non-metadata) origin, a metadata/link-local link is always refused
// here as `cross-origin` before any address is ever contacted.

import type { HtmlManualCrawlScope } from "@oscharko-dev/keiko-contracts";
import type { ManualCrawlDenyReason, ManualFetchTarget } from "./types.js";

export type CrawlLinkDecision =
  | {
      readonly allow: true;
      readonly target: ManualFetchTarget;
      readonly canonicalKey: string;
      readonly relativePath: string;
      readonly depth: number;
    }
  | { readonly allow: false; readonly reason: ManualCrawlDenyReason };

export interface EvaluateManualCrawlLinkInput {
  // The raw href/src exactly as found in the page.
  readonly rawLink: string;
  // Canonical key of the page the link was found on (a full URL for http, a root-relative path for
  // local). Used as the resolution base.
  readonly baseKey: string;
  readonly baseDepth: number;
  readonly scope: HtmlManualCrawlScope;
}

const HTML_EXTENSIONS = new Set([".html", ".htm", ".xhtml"]);
const ACTION_PATH_TOKENS = ["login", "logout", "signin", "signout", "logoff", "signoff"];
const CREDENTIAL_FILE_NAMES = new Set([
  ".htpasswd",
  ".htaccess",
  ".env",
  ".git",
  ".netrc",
  ".npmrc",
  "id_rsa",
  "id_dsa",
  "web.config",
]);

function lastPathSegment(pathname: string): string {
  const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

function extensionOf(segment: string): string {
  const dot = segment.lastIndexOf(".");
  return dot <= 0 ? "" : segment.slice(dot).toLowerCase();
}

// A path targets an HTML document when it has an HTML extension, or no extension at all (a
// directory-style URL a static server resolves to an index page). Any other extension (.css, .js,
// .png, .pdf, …) is a non-document asset.
function isHtmlDocumentPath(pathname: string): boolean {
  const ext = extensionOf(lastPathSegment(pathname));
  return ext === "" || HTML_EXTENSIONS.has(ext);
}

function hasActionToken(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return ACTION_PATH_TOKENS.some((token) => lower.split(/[/._-]/u).includes(token));
}

function isHiddenOrCredentialPath(relativePath: string): boolean {
  for (const segment of relativePath.split("/")) {
    if (segment.startsWith(".") && segment !== "." && segment !== "..") return true;
    if (CREDENTIAL_FILE_NAMES.has(segment.toLowerCase())) return true;
  }
  return false;
}

function pathUnderPrefix(pathname: string, prefix: string | null): boolean {
  if (prefix === null || prefix === "/") return true;
  const normalizedPrefix = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return pathname === normalizedPrefix || pathname.startsWith(`${normalizedPrefix}/`);
}

// Map an http path to a stable root-relative page path: strip the leading slash and resolve
// directory-style targets to an index document, so query variants and dir/index forms dedup to one
// deterministic key.
function httpPathToRelative(pathname: string): string {
  const stripped = pathname.replace(/^\/+/u, "");
  if (stripped === "" || stripped.endsWith("/")) return `${stripped}index.html`;
  return isHtmlDocumentPath(pathname) && extensionOf(lastPathSegment(pathname)) === ""
    ? `${stripped}/index.html`
    : stripped;
}

function evaluateHttpLink(
  input: EvaluateManualCrawlLinkInput,
  origin: string,
  pathPrefix: string | null,
): CrawlLinkDecision {
  let url: URL;
  try {
    url = new URL(input.rawLink, input.baseKey);
  } catch {
    return { allow: false, reason: "unsupported-scheme" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allow: false, reason: "unsupported-scheme" };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { allow: false, reason: "credentialed-url" };
  }
  if (url.origin !== origin) return { allow: false, reason: "cross-origin" };
  if (!pathUnderPrefix(url.pathname, pathPrefix)) {
    return { allow: false, reason: "outside-path-prefix" };
  }
  if (hasActionToken(url.pathname)) return { allow: false, reason: "action-link" };
  if (!isHtmlDocumentPath(url.pathname)) return { allow: false, reason: "non-html" };
  const relativePath = httpPathToRelative(url.pathname);
  return {
    allow: true,
    target: { kind: "http", url: `${url.origin}${url.pathname}` },
    // Canonicalised through the same dir/index normalisation as `relativePath`, so a directory-style
    // link ("/", "/chapters/") and its explicit-index equivalent ("/index.html",
    // "/chapters/index.html") dedup to one fetch instead of silently double-fetching the same page
    // under two seen-set keys.
    canonicalKey: `${url.origin}/${relativePath}`,
    relativePath,
    depth: input.baseDepth + 1,
  };
}

// Join a relative link onto the base page's directory and normalise `.`/`..` segments. Returns null
// when the result escapes above the manual root.
function resolveLocalPath(baseKey: string, rawLink: string): string | null {
  const baseDir = baseKey.includes("/") ? baseKey.slice(0, baseKey.lastIndexOf("/")) : "";
  const joined = rawLink.startsWith("/") ? rawLink.slice(1) : `${baseDir}/${rawLink}`;
  const out: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

// A link with an explicit URL scheme cannot be a same-manual local link: http(s) is an external
// origin; every other scheme (mailto:, javascript:, tel:, data:, …) is unsupported.
function localSchemeDenial(withoutQuery: string): ManualCrawlDenyReason | null {
  if (!/^[a-z][a-z0-9+.-]*:/iu.test(withoutQuery)) return null;
  return /^https?:/iu.test(withoutQuery) ? "cross-origin" : "unsupported-scheme";
}

// Reason a resolved (traversal-normalised) local page path must be refused, or null when accepted.
function resolvedLocalPathDenial(relativePath: string): ManualCrawlDenyReason | null {
  if (isHiddenOrCredentialPath(relativePath)) return "path-traversal";
  if (hasActionToken(relativePath)) return "action-link";
  if (!isHtmlDocumentPath(relativePath)) return "non-html";
  return null;
}

function evaluateLocalLink(
  input: EvaluateManualCrawlLinkInput,
  rootPath: string,
): CrawlLinkDecision {
  const [rawPath = ""] = input.rawLink.split("#");
  const withoutQuery = rawPath.split("?")[0] ?? "";
  const schemeReason = localSchemeDenial(withoutQuery);
  if (schemeReason !== null) return { allow: false, reason: schemeReason };
  if (withoutQuery.length === 0) return { allow: false, reason: "non-html" };
  const relativePath = resolveLocalPath(input.baseKey, withoutQuery);
  if (relativePath === null || relativePath.length === 0) {
    return { allow: false, reason: "path-traversal" };
  }
  const denial = resolvedLocalPathDenial(relativePath);
  if (denial !== null) return { allow: false, reason: denial };
  return {
    allow: true,
    target: { kind: "local", rootPath, relativePath },
    canonicalKey: relativePath,
    relativePath,
    depth: input.baseDepth + 1,
  };
}

// Decide whether a discovered link is inside the approved crawl scope. Pure and fail-closed: any
// parse failure, scheme surprise, or scope-escape resolves to a denial with a stable reason code.
export function evaluateManualCrawlLink(input: EvaluateManualCrawlLinkInput): CrawlLinkDecision {
  if (input.scope.kind === "html-manual-http") {
    return evaluateHttpLink(input, input.scope.origin, input.scope.pathPrefix);
  }
  return evaluateLocalLink(input, input.scope.rootPath);
}
