// The stack-frame and cause-chain reducer for the activity log's `frames`/`causeChain` fields
// (ADR-0173 D3).
//
// WHY DIST-ANCHORED, AND WHY THERE ARE NO SOURCE MAPS TO FOLLOW
//
// `tsconfig.base.json` sets no `sourceMap`, no `packages/*/tsconfig.json` overrides it, and the
// root bin's `tsconfig.build.json` explicitly sets `sourceMap: false` too — every workspace package
// and the root `keiko` CLI entrypoint ship WITHOUT a `.js.map` (only `declarationMap`, a build-time
// artifact, exists). Enabling runtime source maps would cost real startup time against
// GEN-PERF-CLI-001's budget and real package size, for a repository that already chose
// declarationMap-only deliberately. A real (non-vitest) V8 stack frame is therefore always a
// `dist/*.js` path, never `src/*.ts` — and this reducer anchors on that dist output, not on a
// source location it cannot recover. The agent-facing consequence (a frame names the `dist` output
// of the exact tagged product version; `tsc` reproduces that output deterministically from the tag)
// is documented in `docs/observability/reproduction-harness.md` and is unaffected by anything here.
//
// WHY THE ANCHOR IS "LAST OCCURRENCE", NOT A PREFIX
//
// The absolute prefix in front of `packages/<pkg>/(dist|src)/` differs by how Keiko is running: a
// dev checkout, a portable/installed product (which keeps the same `packages/<workspace>/...`
// layout under the install root), or a resolved `node_modules/@oscharko-dev/*` workspace symlink
// (Node reports the realpath with no `--preserve-symlinks`, so this collapses to the same shape
// anyway). Matching the LAST occurrence of the anchor — rather than requiring it to be a path
// prefix — makes the reducer correct under all three without special-casing any of them, exactly
// the same tradeoff `route-template.ts` already makes for route paths.
//
// WHY `PACKAGE_DIR_NAMES` IS DATA, NOT AN IMPORT, AND WHY IT IS DRIFT-TESTED
//
// The workspace package list could be read from the root `package.json`'s `workspaces` glob at
// runtime, but that would mean walking the filesystem from inside the redaction-adjacent hot path.
// It is carried here as a plain `Set` instead — the same "data, not an import, plus a drift test"
// tradeoff `route-template.ts` documents for its route-literal vocabulary —
// `stack-frames.test.ts` reads the real `packages/*` directory listing and asserts set equality, so
// a package added or removed without updating this file turns that test red rather than silently
// mis-anchoring (or over-anchoring) frames from the new package.
//
// WHY A NON-CONFORMING FRAME IS DROPPED, NEVER PARTIALLY REDACTED
//
// A frame from `node_modules`, `node:internal`, an `eval` site, or any path outside a known
// workspace root carries no invariant this reducer can safely reduce it to — attempting a partial
// redaction (e.g. keeping the last segment) would still leak an absolute path fragment. The frame
// is dropped in full instead, the same fail-closed direction `redactRoutePath` already takes for an
// unrecognised route.
//
// WHY `causeChain` DELEGATES TO `contentFreeErrorClass` INSTEAD OF ITS OWN CLASSIFIER
//
// `error-classification.ts` already hardens error-class extraction against a mutable,
// hostile-writable `.name`/`.constructor` (reads the constructor off the prototype, not the
// instance; falls back to the generic `"Error"` on any reflection failure). A second classifier
// here would either duplicate that hardening or, worse, drift from it. `causeChain` reuses
// `contentFreeErrorClass` verbatim — imported from that leaf module directly, not from
// `../diagnostics-log.js` (which re-exports the same function for backward compatibility): this
// module and `diagnostics-log.ts` both import `stack-frames.ts` (for `keikoStackFrames`/
// `causeChain`), so the reverse edge would cycle.

import { contentFreeErrorClass } from "./error-classification.js";

// One entry per `packages/*` directory name (root `package.json`'s `"workspaces": ["packages/*"]`).
// Pinned by the drift test in `stack-frames.test.ts` against the real directory listing.
export const PACKAGE_DIR_NAMES: ReadonlySet<string> = new Set([
  "keiko-cli",
  "keiko-connectors",
  "keiko-contracts",
  "keiko-editor",
  "keiko-evaluations",
  "keiko-evidence",
  "keiko-git",
  "keiko-harness",
  "keiko-local-knowledge",
  "keiko-memory-capture",
  "keiko-memory-consolidation",
  "keiko-memory-governance",
  "keiko-memory-retrieval",
  "keiko-memory-vault",
  "keiko-model-gateway",
  "keiko-quality-intelligence",
  "keiko-sandbox",
  "keiko-sdk",
  "keiko-security",
  "keiko-server",
  "keiko-tool-catalog",
  "keiko-tools",
  "keiko-ui",
  "keiko-verification",
  "keiko-workflows",
  "keiko-workspace",
]);

// The exact shape a reduced frame string is allowed to have — either a workspace-package frame
// (`packages/<pkg>/(dist|src)/<relative>.(js|ts):LINE:COL`) or the root `keiko` bin's own frame
// (`(dist|src)/cli/<relative>.(js|ts):LINE:COL`). Exported so `log-redaction.ts`'s field-name-keyed
// guard for the `frames` field (ADR-0173 D4) can re-validate a value structurally instead of
// trusting that only `keikoStackFrames` ever produced it. The `pkg` capture is `undefined` on the
// root-bin branch; a consumer that needs to reject a spoofed package name still has to check the
// captured name against `PACKAGE_DIR_NAMES` itself — this pattern only pins the SHAPE.
export const FRAME_SHAPE_PATTERN =
  /^(?:packages\/(?<pkg>keiko-[a-z0-9-]+)\/(?:dist|src)|(?:dist|src)\/cli)\/[A-Za-z0-9_./-]{1,160}\.(?:js|ts):\d{1,6}:\d{1,6}$/;

// A hostile `.stack` must never cost more than a bounded read: 16 KB truncates any multi-megabyte
// value before it is ever split into lines, and 64 lines bounds the frames actually scanned even
// once truncation still leaves an unreasonably tall stack.
const MAX_STACK_CHARS = 16 * 1024;
const MAX_STACK_LINES = 64;

// A V8 frame line, once trimmed of leading whitespace, always starts with this. Used both to skip
// a multi-line message (text before the first real frame line) and to recognise a frame line at all.
const FRAME_LINE_START_PATTERN = /^\s*at /;

const RELATIVE_PATH_PATTERN = /^[A-Za-z0-9_./-]{1,160}\.(?:js|ts)$/;
const TRAVERSAL_SEGMENT_PATTERN = /(?:^|\/)\.\.(?:$|\/)/;
const LINE_OR_COL_PATTERN = /^\d{1,6}$/;

// Reflective reads from a thrown value are hostile-input reads: an accessor or proxy trap may
// throw. Structurally identical to `error-classification.ts`'s exported `safeProperty` (guard the
// receiver shape, then wrap the read in try/catch) — kept as its own local copy rather than an
// import so this reducer's only dependency stays `contentFreeErrorClass` itself; consolidating the
// two is a follow-up, not required for the cycle this module already avoids.
function safeErrorProperty(value: unknown, property: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return undefined;
  }
  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

function safeStack(error: unknown): string | undefined {
  const stack = safeErrorProperty(error, "stack");
  return typeof stack === "string" ? stack : undefined;
}

// Drops the leading "Name: message" line unconditionally, then skips any further leading lines
// that are not themselves a frame line (a multi-line message), then caps the remainder at
// `MAX_STACK_LINES`. A stack with no frame line at all (e.g. only a message) yields no lines.
function frameLines(stack: string): readonly string[] {
  const withoutHeader = stack.split("\n").slice(1);
  const firstFrameIndex = withoutHeader.findIndex((line) => FRAME_LINE_START_PATTERN.test(line));
  if (firstFrameIndex === -1) return [];
  return withoutHeader.slice(firstFrameIndex, firstFrameIndex + MAX_STACK_LINES);
}

// Extracts the location text from one frame line: the last "(...)" group when the line ends in
// one (`at fn (loc)`, `at async fn (loc)`, `at new Ctor (loc)`), otherwise the remainder after
// "at " (`at loc`, and non-location lines like `at <anonymous>` that later fail to anchor).
function frameLocationText(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("at ")) return undefined;
  const afterAt = trimmed.slice(3);
  if (afterAt.endsWith(")")) {
    const openIndex = afterAt.lastIndexOf("(");
    if (openIndex === -1) return undefined;
    return afterAt.slice(openIndex + 1, -1);
  }
  return afterAt;
}

function normalizeLocationScheme(value: string): string {
  const forwardSlashed = value.replaceAll("\\", "/");
  return forwardSlashed.startsWith("file://")
    ? forwardSlashed.slice("file://".length)
    : forwardSlashed;
}

// Splits ":col" then ":line" off the end by `lastIndexOf`, never by a whole-string regex: a
// Windows drive letter ("C:/Users/...") puts an unrelated colon early in the string, so only the
// last two colons may be trusted to mean line/col.
function splitLineCol(
  location: string,
): { readonly path: string; readonly line: string; readonly col: string } | undefined {
  const lastColon = location.lastIndexOf(":");
  if (lastColon <= 0) return undefined;
  const col = location.slice(lastColon + 1);
  const withoutCol = location.slice(0, lastColon);
  const secondColon = withoutCol.lastIndexOf(":");
  if (secondColon <= 0) return undefined;
  const line = withoutCol.slice(secondColon + 1);
  if (!LINE_OR_COL_PATTERN.test(line) || !LINE_OR_COL_PATTERN.test(col)) return undefined;
  return { path: withoutCol.slice(0, secondColon), line, col };
}

function validatedRelative(relative: string): boolean {
  return RELATIVE_PATH_PATTERN.test(relative) && !TRAVERSAL_SEGMENT_PATTERN.test(relative);
}

interface AnchorMatch {
  readonly prefix: string;
  readonly relativeStart: number;
}

// Scans every `/packages/<name>/(dist|src)/` occurrence and keeps the LAST one whose captured
// name is an actual workspace package — an occurrence naming an unknown directory does not count
// as an anchor at all, so it can never shadow a real one further left in the path.
function lastWorkspacePackageAnchor(path: string): AnchorMatch | undefined {
  const pattern = /\/packages\/([a-z0-9-]+)\/(dist|src)\//g;
  let match: RegExpExecArray | null;
  let found: AnchorMatch | undefined;
  while ((match = pattern.exec(path)) !== null) {
    const pkg = match[1];
    const kind = match[2];
    if (pkg !== undefined && kind !== undefined && PACKAGE_DIR_NAMES.has(pkg)) {
      found = { prefix: `packages/${pkg}/${kind}`, relativeStart: match.index + match[0].length };
    }
  }
  return found;
}

// The root `keiko` bin's own entrypoint lives outside every `packages/*` directory
// (`dist/cli/index.js` / `src/cli/index.ts` at the repo root), so it is anchored separately and
// only consulted once the workspace-package anchor above found nothing.
function lastRootBinAnchor(path: string): AnchorMatch | undefined {
  const pattern = /\/(dist|src)\/cli\//g;
  let match: RegExpExecArray | null;
  let found: AnchorMatch | undefined;
  while ((match = pattern.exec(path)) !== null) {
    const kind = match[1];
    if (kind !== undefined) {
      found = { prefix: `${kind}/cli`, relativeStart: match.index + match[0].length };
    }
  }
  return found;
}

function anchoredFramePath(path: string): string | undefined {
  const anchor = lastWorkspacePackageAnchor(path) ?? lastRootBinAnchor(path);
  if (anchor === undefined) return undefined;
  const relative = path.slice(anchor.relativeStart);
  return validatedRelative(relative) ? `${anchor.prefix}/${relative}` : undefined;
}

// Reduces one V8 stack-frame line to its dist/src-anchored form, or `undefined` when the frame is
// not evidence this reducer can safely emit (`node_modules`, `node:internal`, an `eval` site, or
// anything else outside a known workspace root) — the caller drops it entirely.
function anchorFrameLine(line: string): string | undefined {
  const location = frameLocationText(line);
  if (location === undefined) return undefined;
  const split = splitLineCol(normalizeLocationScheme(location));
  if (split === undefined) return undefined;
  const anchoredPath = anchoredFramePath(split.path);
  return anchoredPath === undefined ? undefined : `${anchoredPath}:${split.line}:${split.col}`;
}

// Reduces an error's stack to the Keiko-code frames it passed through, nearest-to-throw-site
// first: every `node_modules`/`node:internal`/foreign frame is dropped, never partially redacted.
export function keikoStackFrames(error: unknown, maxFrames = 8): readonly string[] {
  const raw = safeStack(error);
  if (raw === undefined) return [];
  const bounded = raw.length > MAX_STACK_CHARS ? raw.slice(0, MAX_STACK_CHARS) : raw;
  const anchored = frameLines(bounded)
    .map(anchorFrameLine)
    .filter((frame): frame is string => frame !== undefined);
  return anchored.slice(0, maxFrames);
}

// Walks `error.cause` repeatedly, classifying each link with `contentFreeErrorClass`. Stops at
// `maxDepth`, at the first non-object link (a primitive cause carries nothing this can classify
// beyond `typeof`, which `contentFreeErrorClass` already reports for a non-Error object — a
// primitive is simply not walked further), or the first cause already seen (a hostile circular
// `cause` graph).
export function causeChain(error: unknown, maxDepth = 5): readonly string[] {
  const classes: string[] = [];
  const seen = new WeakSet();
  if (typeof error === "object" && error !== null) seen.add(error);
  let current: unknown = error;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const cause = safeErrorProperty(current, "cause");
    if (typeof cause !== "object" || cause === null) break;
    if (seen.has(cause)) break;
    seen.add(cause);
    classes.push(contentFreeErrorClass(cause));
    current = cause;
  }
  return classes;
}
