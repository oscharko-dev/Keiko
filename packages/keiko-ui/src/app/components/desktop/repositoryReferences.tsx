"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { OpenEditorFileRequest, OpenEditorFileResult } from "./hooks/useWorkspace.types";
import { FileIcon } from "./widgets/shared/projectTree";
import { isPortableWorkspaceRelativePath } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";
import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/text-safety";
import { useTranslate } from "@/lib/i18n";

export interface RepositoryReference {
  readonly label: string;
  readonly path: string;
  readonly lineStart?: number | undefined;
  readonly lineEnd?: number | undefined;
}

export interface RepositoryReferenceRoot {
  readonly root: string;
  readonly label: string;
}

export type OpenRepositoryReference = (request: OpenEditorFileRequest) => OpenEditorFileResult;

export interface RepositoryReferenceTextPart {
  readonly kind: "text" | "reference";
  readonly text?: string;
  readonly reference?: RepositoryReference;
}

// Path depth and per-segment length are bounded (rather than left unbounded) so matching stays
// linear in input length. An unbounded `(?:segment\/)*segment` shape lets the engine retry the
// unmatched tail from every character offset in adversarial (non-matching) text: each retry costs
// up to O(n), and there are O(n) offsets to try, giving O(n^2) overall (S8786). Bounding both
// quantifiers caps the retry cost at a constant, restoring O(n).
//
// The two bounds are chosen on different grounds:
//   - Per-segment length (255) is a hard ceiling, not a headroom guess: it matches the real
//     NAME_MAX enforced by ext4/APFS/NTFS. No single path COMPONENT can legitimately exceed it on
//     any real filesystem, so this bound is exact, not lossy, and widening it further would only
//     accept segments that cannot exist as real filenames.
//   - Path depth (segment count) has no equivalent hard OS ceiling — it is an application-level
//     choice, and an earlier revision of this fix picked 64, which is comfortably exceeded by real
//     (if unusual) deeply-nested vendor/cache/monorepo trees (e.g. pnpm's `.pnpm` store, Bazel
//     sandbox output, or nested `node_modules`). Per this repo's ReDoS-remediation guidance, that
//     bound is raised generously — to 1000 — so that no realistic repository path can ever reach
//     the ceiling, while staying finite so the retry cost above stays a bounded constant and static
//     analysis still recognizes the quantifier as bounded.
const REPOSITORY_REFERENCE_SEGMENT = String.raw`[\p{L}\p{N}\p{M}_.-]{1,255}`;
const REPOSITORY_REFERENCE_PATH_CORE = String.raw`(?:${REPOSITORY_REFERENCE_SEGMENT}\/){0,1000}${REPOSITORY_REFERENCE_SEGMENT}\.[A-Za-z0-9][A-Za-z0-9]{0,15}`;
const REFERENCE_HORIZONTAL_SPACE = String.raw`[ \t\u00a0\u202f]{0,64}`;
function referenceLineRange(capture: boolean): string {
  const digits = capture ? String.raw`(\d{1,7})` : String.raw`\d{1,7}`;
  return String.raw`${REFERENCE_HORIZONTAL_SPACE}:${REFERENCE_HORIZONTAL_SPACE}${digits}(?:${REFERENCE_HORIZONTAL_SPACE}[-\u2010-\u2014\u2212]${REFERENCE_HORIZONTAL_SPACE}${digits})?`;
}
const REFERENCE_LINE_RANGE = referenceLineRange(true);
const FOLLOWING_REFERENCE_LINE_RANGE = new RegExp(`^${REFERENCE_LINE_RANGE}`, "u");
const REPOSITORY_REFERENCE_PATTERN = new RegExp(
  String.raw`\[[^\]]{1,4096}\]|@?(${REPOSITORY_REFERENCE_PATH_CORE})(?:${REFERENCE_LINE_RANGE})?`,
  "gu",
);
// Exact/bracketed references have a known boundary, so their filenames may contain spaces or
// other Unicode characters. The shared portable-path contract still owns path validity.
const EXACT_REPOSITORY_REFERENCE_PATTERN = new RegExp(
  String.raw`^@?([^:[\]\r\n]{1,4096}?)(?:${REFERENCE_LINE_RANGE})?$`,
  "u",
);
const REPOSITORY_REFERENCE_SOURCE = String.raw`@?${REPOSITORY_REFERENCE_PATH_CORE}(?:${referenceLineRange(false)})?`;
const REPOSITORY_REFERENCE_IN_BRACKETS_PATTERN = new RegExp(
  String.raw`\[\s*(${REPOSITORY_REFERENCE_SOURCE})\s*\]`,
  "giu",
);
// `[^\]]+` already allows whitespace, so a preceding `\s*` is redundant and only creates an
// ambiguous split point between two quantified atoms that can consume the same characters
// (S8786): with no closing bracket, the engine explores every way to divide a run of whitespace
// between `\s*` and `[^\]]+`, which is quadratic. Dropping the redundant `\s*` matches the exact
// same set of strings (proof: `\s* [^\]]+` requires >=1 total char, all drawn from `[^\]]`, which
// is exactly what `[^\]]+` alone requires) while removing the ambiguity entirely.
const SOURCE_LABEL_FRAGMENT = String.raw`\[source:[^\]]+\]`;
const BRACKETED_REFERENCE_DUPLICATE_PATTERN = new RegExp(
  String.raw`\[\s*(${REPOSITORY_REFERENCE_SOURCE})\s*\]\s*(?:${SOURCE_LABEL_FRAGMENT}\s*)?(${REPOSITORY_REFERENCE_SOURCE})`,
  "giu",
);
const ADJACENT_REFERENCE_DUPLICATE_PATTERN = new RegExp(
  String.raw`(${REPOSITORY_REFERENCE_SOURCE})\s+(?:${SOURCE_LABEL_FRAGMENT}\s*)?(${REPOSITORY_REFERENCE_SOURCE})`,
  "giu",
);
const SOURCE_LABEL_PATTERN = new RegExp(SOURCE_LABEL_FRAGMENT, "giu");

const KNOWN_REPOSITORY_EXTENSIONS = new Set([
  "astro",
  "bash",
  "c",
  "cc",
  "cjs",
  "config",
  "cpp",
  "cs",
  "css",
  "csv",
  "cts",
  "go",
  "gradle",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsonc",
  "jsx",
  "kt",
  "kts",
  "less",
  "lock",
  "lua",
  "md",
  "mdx",
  "mjs",
  "mts",
  "php",
  "py",
  "rb",
  "rs",
  "sass",
  "scala",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

function boundaryBefore(value: string, index: number): boolean {
  if (index <= 0) return true;
  const previous = value.slice(Math.max(0, index - 2), index);
  return !/[\p{L}\p{N}\p{M}\p{S}_./:@-]$/u.test(previous);
}

function boundaryAfter(value: string, index: number): boolean {
  if (index >= value.length) return true;
  const next = value.slice(index, index + 2);
  return !/^[\p{L}\p{N}\p{M}\p{S}_/:+\u2010-\u2014\u2212-]/u.test(next);
}

// Plain string scans (not regexes) for leading/trailing slash trimming: an unanchored-at-start
// `+` quantifier retried at every offset of a non-matching string is O(n^2) (S8786); a manual
// scan is O(n) by construction and can never regress into that shape.
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function trimLeadingSlashes(value: string): string {
  let start = 0;
  while (start < value.length && value[start] === "/") start += 1;
  return value.slice(start);
}

export function normalizeReferencePath(path: string): string {
  return trimTrailingSlashes(trimLeadingSlashes(path.replaceAll("\\", "/")));
}

function referenceIdentity(reference: RepositoryReference | null): string | null {
  if (reference === null) return null;
  return [
    reference.path.toLowerCase(),
    reference.lineStart?.toString() ?? "",
    reference.lineEnd?.toString() ?? "",
  ].join(":");
}

function collapseDuplicateReferences(first: string, second: string, fallback: string): string {
  const firstIdentity = referenceIdentity(parseExactRepositoryReference(first));
  const secondIdentity = referenceIdentity(parseExactRepositoryReference(second));
  return firstIdentity !== null && firstIdentity === secondIdentity ? first : fallback;
}

function tidyEvidenceProse(source: string): string {
  // The first pass already collapses every run of 2+ space/tab characters down to a single " ",
  // so by the time the second pass runs, no two space/tab characters can ever be adjacent. The
  // trailing `+` in the second pass therefore only ever matches 0 or 1 characters in practice;
  // dropping it removes the unbounded-quantifier-next-to-a-group shape S8786 flags, with no
  // behavior change given that invariant.
  return source.replace(/[ \t]{2,}/gu, " ").replace(/[ \t]([,.;:!?])/gu, "$1");
}

function tidyEvidenceText(source: string): string {
  // Keep bracket contents byte-for-byte: whitespace can be part of a real filename, and
  // converting controls to spaces could invent a different valid citation path.
  return source
    .split(/(\[[^\]]{1,4096}\])/gu)
    .map((part) => (part.startsWith("[") && part.endsWith("]") ? part : tidyEvidenceProse(part)))
    .join("");
}

// Grounded model answers sometimes echo evidence as:
// `[path/to/file.ts:1-4] [source: api] path/to/file.ts:1-4`.
// The source label is transport metadata, and the repeated path creates duplicate editor links.
// Normalize that common evidence cluster into one selectable/clickable repository reference.
export function sanitizeRepositoryEvidenceText(source: string): string {
  return tidyEvidenceText(
    source
      .replace(
        BRACKETED_REFERENCE_DUPLICATE_PATTERN,
        (raw: string, first: string, second: string) =>
          collapseDuplicateReferences(first, second, raw.replace(SOURCE_LABEL_PATTERN, "")),
      )
      .replace(ADJACENT_REFERENCE_DUPLICATE_PATTERN, (raw: string, first: string, second: string) =>
        collapseDuplicateReferences(first, second, raw.replace(SOURCE_LABEL_PATTERN, "")),
      )
      .replace(REPOSITORY_REFERENCE_IN_BRACKETS_PATTERN, (raw: string, reference: string) =>
        parseExactRepositoryReference(reference) === null ? raw : reference,
      )
      .replace(SOURCE_LABEL_PATTERN, ""),
  );
}

function isSafeRawReferencePath(path: string): boolean {
  return (
    isPortableWorkspaceRelativePath(path) &&
    stripUnsafeFormatChars(path) === path &&
    !/\p{Cc}/u.test(path)
  );
}

function validRepositoryPath(path: string): boolean {
  if (!isSafeRawReferencePath(path)) return false;
  if (path.startsWith(".") || path.includes("..")) return false;
  if (!path.includes(".")) return false;
  const filename = path.split("/").at(-1) ?? "";
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return KNOWN_REPOSITORY_EXTENSIONS.has(extension);
}

function parseLine(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function validMatchedLineRange(
  match: RegExpExecArray,
  start: number | undefined,
  end: number | undefined,
): boolean {
  if (match[2] === undefined) return match[3] === undefined;
  return start !== undefined && (match[3] === undefined || (end !== undefined && end >= start));
}

function incompleteReferenceLineSuffix(source: string, offset: number): boolean {
  const tail = source.slice(offset, offset + 65).replace(/^[ \t\u00a0\u202f]{0,64}/u, "");
  return /^[:\u2010-\u2014\u2212-]/u.test(tail);
}

function validReferenceMatchBoundary(match: RegExpExecArray, source: string): boolean {
  const end = match.index + match[0].length;
  return (
    boundaryBefore(source, match.index) &&
    boundaryAfter(source, end) &&
    (match[2] === undefined || !incompleteReferenceLineSuffix(source, end))
  );
}

function referenceFromMatch(match: RegExpExecArray, source: string): RepositoryReference | null {
  const raw = match[0] ?? "";
  if (!validReferenceMatchBoundary(match, source)) {
    return null;
  }
  const path = match[1] ?? "";
  if (!validRepositoryPath(path)) return null;
  const lineStart = parseLine(match[2]);
  const rawLineEnd = parseLine(match[3]);
  if (!validMatchedLineRange(match, lineStart, rawLineEnd)) return null;
  const lineEnd = rawLineEnd ?? lineStart;
  return {
    label: raw,
    path,
    ...(lineStart === undefined ? {} : { lineStart }),
    ...(lineEnd === undefined ? {} : { lineEnd }),
  };
}

function referencesFromTextMatch(
  match: RegExpExecArray,
  source: string,
): readonly RepositoryReference[] {
  const token = match[0] ?? "";
  if (!token.startsWith("[")) {
    const reference = referenceFromMatch(match, source);
    return reference === null ? [] : [reference];
  }
  // Consume invalid bracketed paths atomically, never linking their relative-looking suffix.
  const contents = token.slice(1, -1);
  if (/\p{Cc}/u.test(contents)) return [];
  const reference = parseExactRepositoryReference(contents.trim(), true);
  if (reference !== null) return [reference];
  // A valid comma-bearing filename wins above. Lists need an explicit line range on every
  // member, and every member must validate before any link is exposed.
  const members = contents.split(",");
  if (members.length < 2) return [];
  const references: RepositoryReference[] = [];
  for (const member of members) {
    const parsed = parseExactRepositoryReference(member.trim(), true);
    if (parsed?.lineStart === undefined) return [];
    references.push(parsed);
  }
  return references;
}

function referenceParts(references: readonly RepositoryReference[]): RepositoryReferenceTextPart[] {
  const parts: RepositoryReferenceTextPart[] = [];
  for (const reference of references) {
    if (parts.length > 0) parts.push({ kind: "text", text: ", " });
    parts.push({ kind: "reference", reference });
  }
  return parts;
}

export function repositoryReferenceTextParts(
  source: string,
): readonly RepositoryReferenceTextPart[] {
  const parts: RepositoryReferenceTextPart[] = [];
  let lastIndex = 0;
  REPOSITORY_REFERENCE_PATTERN.lastIndex = 0;
  for (;;) {
    const match = REPOSITORY_REFERENCE_PATTERN.exec(source);
    if (match === null) break;
    const references = referencesFromTextMatch(match, source);
    if (references.length === 0) continue;
    if (match.index > lastIndex) {
      parts.push({ kind: "text", text: source.slice(lastIndex, match.index) });
    }
    parts.push(...referenceParts(references));
    lastIndex = match.index + (match[0]?.length ?? 0);
  }
  if (lastIndex === 0) return [{ kind: "text", text: source }];
  if (lastIndex < source.length) parts.push({ kind: "text", text: source.slice(lastIndex) });
  return parts;
}

export function parseExactRepositoryReference(
  source: string,
  allowSpaces = false,
): RepositoryReference | null {
  const match = EXACT_REPOSITORY_REFERENCE_PATTERN.exec(source);
  if (match?.index !== 0 || (match[0]?.length ?? 0) !== source.length) {
    return null;
  }
  if (!allowSpaces && /\s/u.test(match[1] ?? "")) return null;
  return referenceFromMatch(match, source);
}

/** A line suffix must be immediately adjacent to the code-wrapped path in the same text node. */
export function consumeRepositoryReferenceLineSuffix(
  path: string,
  followingText: string,
): { readonly reference: RepositoryReference; readonly length: number } | undefined {
  const match = FOLLOWING_REFERENCE_LINE_RANGE.exec(followingText);
  if (match === null || !boundaryAfter(followingText, match[0].length)) return undefined;
  if (incompleteReferenceLineSuffix(followingText, match[0].length)) return undefined;
  const reference = parseExactRepositoryReference(`${path}${match[0]}`, true);
  if (reference?.lineStart === undefined) return undefined;
  return { reference, length: match[0].length };
}

export function repositoryRootLabel(root: string): string {
  const normalized = trimTrailingSlashes(root.replaceAll("\\", "/"));
  const parts = normalized.split("/").filter((part) => part.length > 0);
  return parts.at(-1) ?? root;
}

export function repositoryReferenceRoots(
  roots: readonly string[],
): readonly RepositoryReferenceRoot[] {
  const seen = new Set<string>();
  const out: RepositoryReferenceRoot[] = [];
  for (const root of roots) {
    const normalized = root.trim();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ root: normalized, label: repositoryRootLabel(normalized) });
  }
  return out;
}

function referenceRangeLabel(reference: RepositoryReference): string {
  if (reference.lineStart === undefined) return "";
  if (reference.lineEnd === undefined || reference.lineEnd === reference.lineStart) {
    return ` at line ${String(reference.lineStart)}`;
  }
  return ` at lines ${String(reference.lineStart)}-${String(reference.lineEnd)}`;
}

interface ReferenceSuffixNode {
  count: number;
  readonly children: Map<string, ReferenceSuffixNode>;
}

function insertReferenceSuffix(root: ReferenceSuffixNode, parts: readonly string[]): void {
  let node = root;
  const reversedParts = [...parts];
  reversedParts.reverse();
  for (const part of reversedParts) {
    const child = node.children.get(part) ?? {
      count: 0,
      children: new Map<string, ReferenceSuffixNode>(),
    };
    child.count += 1;
    node.children.set(part, child);
    node = child;
  }
}

function shortestReferenceSuffix(root: ReferenceSuffixNode, parts: readonly string[]): string {
  let node: ReferenceSuffixNode | undefined = root;
  const suffix: string[] = [];
  for (const part of [...parts].reverse()) {
    suffix.push(part);
    node = node?.children.get(part);
    if (node === undefined || node.count === 1) break;
  }
  suffix.reverse();
  return suffix.join("/");
}

// A reversed segment trie finds the shortest distinct suffix in linear work over source paths.
// Repeated line references to the same path do not make that file ambiguous.
export function repositoryReferencePathLabels(
  paths: readonly string[],
): ReadonlyMap<string, string> {
  const partsByPath = new Map([...new Set(paths)].map((path) => [path, path.split("/")]));
  const root: ReferenceSuffixNode = { count: 0, children: new Map() };
  for (const parts of partsByPath.values()) insertReferenceSuffix(root, parts);
  return new Map(
    [...partsByPath].map(([path, parts]) => [path, shortestReferenceSuffix(root, parts)]),
  );
}

function referenceVisibleLabel(reference: RepositoryReference, displayPath?: string): string {
  const parts = reference.path.split("/");
  parts.reverse();
  const fileName = displayPath ?? parts.find(Boolean) ?? reference.path;
  if (reference.lineStart === undefined) return fileName;
  if (reference.lineEnd === undefined || reference.lineEnd === reference.lineStart) {
    return `${fileName}:${String(reference.lineStart)}`;
  }
  return `${fileName}:${String(reference.lineStart)}-${String(reference.lineEnd)}`;
}

function referencePathForRoot(referencePath: string, root: string): string {
  const normalizedPath = normalizeReferencePath(referencePath);
  const rootLabel = normalizeReferencePath(repositoryRootLabel(root));
  if (rootLabel.length > 0 && normalizedPath.startsWith(`${rootLabel}/`)) {
    return normalizedPath.slice(rootLabel.length + 1);
  }
  return normalizedPath;
}

function repositoryRootSuffix(root: string): string {
  const normalized = trimTrailingSlashes(root.replaceAll("\\", "/"));
  const parts = normalized.split("/").filter((part) => part.length > 0);
  return parts.slice(-2).join("/");
}

function rootLabelPrefixForReference(
  referencePath: string,
  roots: readonly RepositoryReferenceRoot[],
): string | null {
  const firstSegment = normalizeReferencePath(referencePath).split("/")[0]?.toLocaleLowerCase();
  if (firstSegment === undefined || firstSegment.length === 0) return null;
  return roots.some((root) => repositoryRootLabel(root.root).toLocaleLowerCase() === firstSegment)
    ? firstSegment
    : null;
}

function rootCanOpenReference(
  referencePath: string,
  root: RepositoryReferenceRoot,
  roots: readonly RepositoryReferenceRoot[],
): boolean {
  const requiredRootLabel = rootLabelPrefixForReference(referencePath, roots);
  if (requiredRootLabel === null) return true;
  return repositoryRootLabel(root.root).toLocaleLowerCase() === requiredRootLabel;
}

interface RankedRepositoryRoot extends RepositoryReferenceRoot {
  readonly openPath: string;
}

function rankedRootsForReference(
  reference: RepositoryReference,
  roots: readonly RepositoryReferenceRoot[],
): readonly RankedRepositoryRoot[] {
  return roots
    .filter((root) => rootCanOpenReference(reference.path, root, roots))
    .map((root) => ({ ...root, openPath: referencePathForRoot(reference.path, root.root) }))
    .sort((a, b) => a.openPath.length - b.openPath.length || a.root.localeCompare(b.root));
}

interface RepositoryReferenceInlineProps {
  readonly reference: RepositoryReference;
  readonly roots: readonly RepositoryReferenceRoot[];
  readonly openReference: OpenRepositoryReference | undefined;
  readonly className?: string | undefined;
  readonly displayPath?: string | undefined;
}

const OPENED_CONFIRMATION_MS = 1800;

// Schedules a callback once. The pending timer is cleared before a new one is scheduled and when
// the component unmounts, so it can never set state on a component that is gone. The uncleared
// timer was a latent race: a test file finishing inside the delay let it fire after jsdom was torn
// down, React threw "window is not defined", and the required keiko-ui coverage job went red on a
// pull request that had not touched this file (#3573).
function useClearedTimeout(callback: () => void): (delayMs: number) => void {
  const timerRef = useRef<number | undefined>(undefined);
  const clear = useCallback((): void => {
    if (timerRef.current === undefined) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);
  useEffect(() => clear, [clear]);
  return useCallback(
    (delayMs: number): void => {
      clear();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined;
        callback();
      }, delayMs);
    },
    [callback, clear],
  );
}

export function RepositoryReferenceInline({
  reference,
  roots,
  openReference,
  className = "repo-ref-link",
  displayPath,
}: RepositoryReferenceInlineProps): ReactNode {
  const t = useTranslate();
  const [status, setStatus] = useState<"idle" | "choosing" | "opening" | "opened" | "failed">(
    "idle",
  );
  const [message, setMessage] = useState("");
  const resetToIdle = useCallback((): void => {
    setStatus("idle");
    setMessage("");
  }, []);
  const scheduleIdleReset = useClearedTimeout(resetToIdle);
  const rootOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: RepositoryReferenceRoot[] = [];
    for (const root of roots) {
      const normalized = root.root.trim();
      if (normalized.length === 0 || seen.has(normalized)) continue;
      seen.add(normalized);
      const label = root.label.trim();
      out.push({
        root: normalized,
        label: label.length > 0 ? label : repositoryRootLabel(normalized),
      });
    }
    return out;
  }, [roots]);
  const rankedRootOptions = useMemo(
    () => rankedRootsForReference(reference, rootOptions),
    [reference, rootOptions],
  );
  const bestRootOptions = useMemo(() => {
    const best = rankedRootOptions[0];
    if (best === undefined) return [];
    return rankedRootOptions.filter((root) => root.openPath.length === best.openPath.length);
  }, [rankedRootOptions]);

  const openForRoot = useCallback(
    (root: RankedRepositoryRoot): void => {
      if (openReference === undefined) return;
      const path = root.openPath;
      setStatus("opening");
      setMessage(`Opening ${path}…`);
      const result = openReference({
        root: root.root,
        path,
        ...(reference.lineStart === undefined ? {} : { lineStart: reference.lineStart }),
        ...(reference.lineEnd === undefined ? {} : { lineEnd: reference.lineEnd }),
      });
      if (result.ok) {
        setStatus("opened");
        setMessage(`Opened ${path} in editor.`);
        scheduleIdleReset(OPENED_CONFIRMATION_MS);
        return;
      }
      setStatus("failed");
      setMessage(result.message);
    },
    [openReference, reference, scheduleIdleReset],
  );

  const activate = useCallback((): void => {
    if (openReference === undefined || rootOptions.length === 0) {
      setStatus("failed");
      setMessage("Connect a Files window to open repository references.");
      return;
    }
    if (rankedRootOptions.length === 0) {
      setStatus("failed");
      setMessage("This repository reference does not match any connected source.");
      return;
    }
    if (bestRootOptions.length === 1) {
      const root = bestRootOptions[0];
      if (root !== undefined) openForRoot(root);
      return;
    }
    setStatus((current) => (current === "choosing" ? "idle" : "choosing"));
    setMessage("Select a repository source.");
  }, [bestRootOptions, openForRoot, openReference, rankedRootOptions.length, rootOptions.length]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>): void => {
      if (event.key === "Escape") {
        setStatus("idle");
        setMessage("");
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    },
    [activate],
  );

  if (openReference === undefined) {
    return <span title={reference.label}>{referenceVisibleLabel(reference, displayPath)}</span>;
  }

  const alert = status === "failed";
  return (
    <span className="repo-ref">
      <button
        type="button"
        className={className}
        aria-label={`Open ${reference.path}${referenceRangeLabel(reference)} in editor`}
        aria-expanded={bestRootOptions.length > 1 ? status === "choosing" : undefined}
        data-state={status}
        title={reference.label}
        onClick={activate}
        onKeyDown={onKeyDown}
      >
        <span className="repo-ref-file-icon" aria-hidden="true">
          <FileIcon name={reference.path} />
        </span>
        <span>{referenceVisibleLabel(reference, displayPath)}</span>
      </button>
      {status === "choosing" ? (
        <span className="repo-ref-picker">
          {bestRootOptions.map((root) => (
            <button
              key={root.root}
              type="button"
              className="repo-ref-root"
              aria-label={t("chat.repository.selectSource", { label: root.label })}
              onClick={() => openForRoot(root)}
            >
              <span>{root.label}</span>
              {repositoryRootSuffix(root.root) === root.label ? null : (
                <span className="repo-ref-root-path">{repositoryRootSuffix(root.root)}</span>
              )}
            </button>
          ))}
        </span>
      ) : null}
      {message.length > 0 ? (
        <span role={alert ? "alert" : "status"} className="repo-ref-status">
          {message}
        </span>
      ) : null}
    </span>
  );
}
