// The route-template reducer for the activity log's `path` field.
//
// WHY A TEMPLATE AND NOT THE PATH
//
// The HTTP request line is the first thing an operator reads, and its most useful field is which
// route was hit. It used to log the raw pathname, kept legible by an exemption in the path guard:
// an absolute value whose first segment was `api`, `_next`, `health`, … was handed back verbatim.
// That exemption made the fail-closed path detector fail OPEN for the entire API surface, and the
// API surface is exactly where customer-chosen identifiers live — `capsuleId`, `sourceId`,
// `projectId`, `sessionHandle` are all values a customer typed or named. A single GET therefore
// wrote `/api/local-knowledge/capsules/Acme-Q3-Financials/index` to disk in clear, in a file whose
// entire contract is that it carries counts, hashes and statuses and never customer data.
//
// A route is now reduced to its TEMPLATE: every segment that is a literal in the server's declared
// route patterns survives, and every other segment is replaced by a fixed `{id}` placeholder. The
// direction of the unknown case is the whole point — an unrecognised segment is elided, never
// echoed — so a route added tomorrow degrades to a less readable line instead of leaking.
//
// The residual, stated honestly: a customer identifier that is character-for-character one of the
// declared route words (a capsule someone named `index`) survives, because the reducer cannot tell
// it apart from the route word in that position and the line it produces is identical either way.
// Nothing about that value is disclosed that the route table does not already publish.
//
// WHY THE VOCABULARY IS A CONSTANT AND NOT AN IMPORT
//
// The literal segments below are exactly the literals of `API_ROUTES` (`routes.ts`) plus the UI
// asset roots. They are duplicated as data rather than imported because `routes.ts` pulls in every
// route handler, and every route handler reaches the logger — importing it here would close a
// module cycle straight through the redaction choke point. `route-template.test.ts` imports
// `API_ROUTES` instead and asserts set equality, so the copy cannot drift silently: adding a route
// without adding its literals turns that test red rather than quietly eliding the new route.
//
// WHY THERE IS NO DIGEST HERE
//
// An earlier revision digested the segment so a request line could be joined to a job's own lines.
// That digest was an unsalted sha-256 over a low-entropy, customer-chosen value — reversible by
// brute force, and a stable per-value token for anything secret-shaped is an oracle that confirms a
// guess without ever being reversed. CodeQL found a flow reaching it from an api-key header name,
// and no guard placed in front of a fast hash makes that construction right.
//
// Nothing is lost. The join key an operator greps is the correlation id, which every line of a run
// carries, and the domain lines add `capsuleIdDigest` where a capsule is genuinely the subject
// (`indexingRouteLog`). The request line only has to say WHICH ROUTE was called.

// The declared route table is 8 segments deep at its deepest. 12 leaves room for growth and bounds
// the work this function can be made to do by a hostile request line.
const MAX_ROUTE_SEGMENTS = 12;

// A traversal segment means the value is a filesystem path wearing a route's clothes; the caller
// must fall through to the path guard rather than template it.
const TRAVERSAL_SEGMENT_PATTERN = /^\.\.?$/;

// The static roots the UI is served from. Not route literals — the static file server, not
// `API_ROUTES`, owns them — so they are declared separately and the drift test knows to expect
// exactly these on top of the route literals.
export const UI_ASSET_ROOT_SEGMENTS: ReadonlySet<string> = new Set(["_next", "assets", "static"]);

// Every literal (non-`:param`) segment of every pattern in `API_ROUTES`. Pinned by
// `route-template.test.ts`; see the note above on why this is data and not an import.
export const API_ROUTE_LITERAL_SEGMENTS: ReadonlySet<string> = new Set([
  "accept",
  "action-approvals",
  "action-sheet",
  "actions",
  "activate",
  "active",
  "activity",
  "agent",
  "agent-runs",
  "answer",
  "api",
  "app-session",
  "apply",
  "approval-review",
  "approvals",
  "approve",
  "archive",
  "atlassian-connectors",
  "attachments",
  "audit",
  "authorize",
  "autonomy-policy",
  "blame",
  "bootstrap",
  "branches",
  "breakpoints",
  "browser",
  "build",
  "cancel",
  "capabilities",
  "capability",
  "capsule-sets",
  "capsules",
  "capture-from-conversation",
  "catalog",
  "channel",
  "chat",
  "chats",
  "check",
  "citation-preview",
  "cleanup",
  "client",
  "clone",
  "code",
  "codex-subscription",
  "coding-sidecar",
  "coding-workbench",
  "commands",
  "commit",
  "completion",
  "completions",
  "config",
  "conflicts",
  "connection",
  "consolidation",
  "containers",
  "content",
  "context",
  "control",
  "copy",
  "correct",
  "correction-predecessors",
  "create",
  "credentials",
  "deactivate",
  "debug",
  "delete",
  "dependencies",
  "desktop",
  "diagnostics",
  "diff",
  "directories",
  "docs-browser",
  "document",
  "dryrun-figma",
  "dryrun-jira",
  "edit",
  "editor",
  "evaluate",
  "events",
  "evidence",
  "exception-breakpoints",
  "execute",
  "executions",
  "explain",
  "export",
  "fetch",
  "figma",
  "files",
  "focus",
  "follow-up",
  "forget",
  "gateway",
  "git",
  "git-delivery",
  "grounded",
  "handoff",
  "health",
  "health-scan",
  "history",
  "hot-exit",
  "image",
  "impact",
  "import",
  "index",
  "inline-completion",
  "instrumentation",
  "jobs",
  "json",
  "language",
  "local-branch",
  "local-history",
  "local-knowledge",
  "lsp",
  "maintenance",
  "manual-pods",
  "memory",
  "merge",
  "messages",
  "model-policy",
  "models",
  "native-file-dialog",
  "navigate",
  "open",
  "operations",
  "order",
  "orphans",
  "packs",
  "pair",
  "patch-apply",
  "pause",
  "pin",
  "policy",
  "pr",
  "preflight",
  "preview",
  "producer",
  "profile",
  "profiles",
  "projects",
  "prompt-enhancement",
  "proposals",
  "propose",
  "pull",
  "push",
  "quality-intelligence",
  "questions",
  "re-check",
  "read",
  "readiness",
  "recap",
  "reconciliation",
  "recovery-ack",
  "refresh",
  "regenerate",
  "regenerate-stale",
  "reindex",
  "reject",
  "relationships",
  "remediation",
  "remotes",
  "rename",
  "repair",
  "replace-apply",
  "replace-preview",
  "repo-search",
  "repositories",
  "research",
  "resolve",
  "resume",
  "retrieve",
  "retry",
  "review",
  "review-items",
  "review-queue",
  "revoke",
  "root",
  "roots",
  "rotate",
  "run-summary-pair",
  "runs",
  "runtime",
  "scopes",
  "screens",
  "screenshot",
  "search",
  "select",
  "semantic-tokens",
  "session",
  "sessions",
  "set",
  "settings",
  "setup",
  "sign-out",
  "snapshot",
  "snapshots",
  "snippets",
  "sources",
  "speak",
  "stack",
  "stage",
  "staging",
  "state",
  "status",
  "stop",
  "stream",
  "structured",
  "summary",
  "switch",
  "sync-jobs",
  "takeover",
  "task-workspaces",
  "telemetry",
  "terminal",
  "test-generation",
  "token",
  "tombstones",
  "traceability",
  "transcribe",
  "tree",
  "trust",
  "turn",
  "unpin",
  "unstage",
  "update",
  "validate",
  "variables",
  "verification",
  "verify",
  "verify-restart",
  "voice",
  "watches",
  "workflows",
  "workspace",
  "workspace-search",
  "workspace-symbols",
  "workspace-watch",
  "workspaces",
  "write",
]);

function isStaticRouteSegment(segment: string): boolean {
  return API_ROUTE_LITERAL_SEGMENTS.has(segment) || UI_ASSET_ROOT_SEGMENTS.has(segment);
}

// A dynamic segment is ELIDED, not pseudonymised. An earlier revision digested it so a request
// line could be joined to a job's own lines, but that digest was an unsalted sha-256 over a
// low-entropy, customer-chosen value — reversible by brute force, and a stable per-value token for
// anything secret-shaped is an oracle that confirms a guess without ever being reversed. CodeQL
// found a flow reaching it from an api-key header name, and no guard in front of a fast hash makes
// that construction right.
//
// Nothing is lost. The join key an operator actually greps is the correlation id, which every line
// of a run carries, and the domain lines add `capsuleIdDigest` where a capsule is genuinely the
// subject (`indexingRouteLog`). The request line only has to say WHICH ROUTE was called.
function elidedSegment(): string {
  return "{id}";
}

// Drops one trailing slash so `/api/health/` and `/api/health` produce the same template rather
// than one of them ending in a digest of the empty string.
function routeSegments(pathname: string): readonly string[] {
  const trimmed = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return trimmed.slice(1).split("/");
}

function isTemplatableRoute(segments: readonly string[]): boolean {
  if (segments.length > MAX_ROUTE_SEGMENTS) return false;
  if (segments.some((segment) => TRAVERSAL_SEGMENT_PATTERN.test(segment))) return false;
  return isStaticRouteSegment(segments[0] ?? "");
}

// Reduces an absolute request path to its route template, or returns `undefined` when the value is
// not a route this server serves — in which case the caller must treat it as a filesystem path and
// refuse it. `maxLength` is the caller's own string cap: eliding a short segment to a placeholder makes
// a template LONGER than the path it came from, and a value over the cap must be refused rather
// than truncated.
export function redactRoutePath(pathname: string, maxLength: number): string | undefined {
  if (!pathname.startsWith("/")) return undefined;
  if (pathname === "/") return "/";
  const segments = routeSegments(pathname);
  if (!isTemplatableRoute(segments)) return undefined;
  const template = segments
    .map((segment) => (isStaticRouteSegment(segment) ? segment : elidedSegment()))
    .join("/");
  return template.length + 1 > maxLength ? undefined : `/${template}`;
}
