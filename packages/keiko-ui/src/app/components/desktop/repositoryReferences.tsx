"use client";

import {
  useOptionalWidgetTranslate as useTranslate,
  type OptionalWidgetTranslate as I18nTranslate,
} from "@/lib/optional-widget-i18n";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { OpenEditorFileRequest, OpenEditorFileResult } from "./hooks/useWorkspace.types";
import { FileIcon } from "./widgets/shared/projectTree";
import { isPortableWorkspaceRelativePath } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";
import type { ClientDiagnosticCitationActivation } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/text-safety";

import type { ChatConnectedScope } from "@/lib/types";
import { connectedScopeFingerprint } from "./hooks/workspaceScopeIdentity";

export interface RepositoryReference {
  readonly label: string;
  readonly path: string;
  readonly lineStart?: number | undefined;
  readonly lineEnd?: number | undefined;
}

export interface RepositoryReferenceRoot {
  readonly root: string;
  readonly label: string;
  readonly scopeFingerprints?: readonly string[] | undefined;
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
function referenceLineRange(
  capture: boolean,
  afterColon = String.raw`[\u00a0\u202f]{0,64}`,
): string {
  const digits = capture ? String.raw`(\d{1,7})` : String.raw`\d{1,7}`;
  // Nonbreaking typographic spacing belongs to a citation; ordinary ': 5 files' is prose.
  return String.raw`${REFERENCE_HORIZONTAL_SPACE}:${afterColon}${digits}(?:${REFERENCE_HORIZONTAL_SPACE}[-\u2010-\u2014\u2212]${REFERENCE_HORIZONTAL_SPACE}${digits})?`;
}
const REFERENCE_LINE_RANGE = referenceLineRange(true);
const FOLLOWING_REFERENCE_LINE_RANGE = new RegExp(`^${REFERENCE_LINE_RANGE}`, "u");
const REPOSITORY_REFERENCE_PATTERN = new RegExp(
  String.raw`\[[^\[\]]{1,4096}\]|@?(${REPOSITORY_REFERENCE_PATH_CORE})(?:${REFERENCE_LINE_RANGE})?`,
  "gu",
);
// Exact/bracketed references have a known boundary, so their filenames may contain spaces or
// other Unicode characters. The shared portable-path contract still owns path validity.
const EXACT_REPOSITORY_REFERENCE_PATTERN = new RegExp(
  String.raw`^@?([^:[\]\r\n]{1,4096}?)(?:${referenceLineRange(true, REFERENCE_HORIZONTAL_SPACE)})?$`,
  "u",
);
const REPOSITORY_REFERENCE_SOURCE = `@?${REPOSITORY_REFERENCE_PATH_CORE}(?:${referenceLineRange(false)})?`;
const REPOSITORY_REFERENCE_IN_BRACKETS_PATTERN = new RegExp(
  String.raw`\[\s*(${REPOSITORY_REFERENCE_SOURCE})\s*\]`,
  "giu",
);
// An unterminated label must stop at the next opening bracket. Otherwise every repeated
// `[source:` prefix scans the entire remaining answer again, making streamed rendering quadratic.
const SOURCE_LABEL_FRAGMENT = String.raw`\[source:[^\[\]]+\]`;
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
  return !/[\p{L}\p{N}\p{M}\p{Sc}_./:@+^~\x60-]$/u.test(previous);
}

function boundaryAfter(value: string, index: number): boolean {
  if (index >= value.length) return true;
  const next = value.slice(index, index + 2);
  return !/^[\p{L}\p{N}\p{M}\p{Sc}_/:+$^~\x60\u2010-\u2014\u2212-]/u.test(next);
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
    .split(/(\[[^[\]]{1,4096}\])/gu)
    .map((part) => (part.startsWith("[") && part.endsWith("]") ? part : tidyEvidenceProse(part)))
    .join("");
}

function stripEvidenceSourceLabel(raw: string): string {
  const contents = raw.slice(1, -1);
  const value = contents.slice(contents.indexOf(":") + 1).trim();
  return parseExactRepositoryReference(value, true) === null ? "" : raw;
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
          collapseDuplicateReferences(
            first,
            second,
            raw.replace(SOURCE_LABEL_PATTERN, stripEvidenceSourceLabel),
          ),
      )
      .replace(ADJACENT_REFERENCE_DUPLICATE_PATTERN, (raw: string, first: string, second: string) =>
        collapseDuplicateReferences(
          first,
          second,
          raw.replace(SOURCE_LABEL_PATTERN, stripEvidenceSourceLabel),
        ),
      )
      .replace(REPOSITORY_REFERENCE_IN_BRACKETS_PATTERN, (raw: string, reference: string) =>
        parseExactRepositoryReference(reference) === null ? raw : reference,
      )
      .replace(SOURCE_LABEL_PATTERN, stripEvidenceSourceLabel),
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
  if (/[*?{}<>|"]|^\$[^/]*$/u.test(path)) return false;
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

function hasExplanatoryReferenceSuffix(source: string, offset: number): boolean {
  return /^[:\u2010-\u2014\u2212-][ \t\u00a0\u202f]{1,64}[^\d\s]/u.test(
    source.slice(offset, offset + 131),
  );
}

function incompleteReferenceLineSuffix(source: string, offset: number): boolean {
  if (hasExplanatoryReferenceSuffix(source, offset)) return false;
  const tail = source.slice(offset, offset + 131);
  return (
    /^[:\u2010-\u2014\u2212-]/u.test(tail) ||
    /^[ \t\u00a0\u202f]{1,64}[:\u2010-\u2014\u2212-][ \t\u00a0\u202f]{0,64}\d/u.test(tail)
  );
}

function validReferenceMatchBoundary(match: RegExpExecArray, source: string): boolean {
  const end = match.index + match[0].length;
  return (
    boundaryBefore(source, match.index) &&
    (boundaryAfter(source, end) ||
      (match[2] !== undefined && hasExplanatoryReferenceSuffix(source, end))) &&
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

function containsUnsafeBracketPath(contents: string): boolean {
  return (
    stripUnsafeFormatChars(contents) !== contents ||
    /(?:^|[\s,])(?:\/|[A-Za-z]:\/|\.\.?\/)/u.test(contents) ||
    /\/\.\.?\//u.test(contents)
  );
}

function bracketReferenceParts(contents: string): readonly RepositoryReferenceTextPart[] {
  if (containsUnsafeBracketPath(contents)) return [];
  const members = contents.split(",");
  const references = members.map((member) => parseExactRepositoryReference(member.trim(), true));
  if (members.length > 1 && references.every((reference) => reference !== null)) {
    return referenceParts(references);
  }
  // Only separators may contain line breaks; never invent a path by normalizing its controls.
  if (/\p{Cc}/u.test(contents)) return [];
  const reference = parseExactRepositoryReference(contents.trim(), true);
  // An explicit, valid whole path owns its spaces. Prose-shaped filenames are still filenames;
  // selecting a guessed suffix would silently change the navigation target.
  if (reference !== null) return referenceParts([reference]);
  const inline = repositoryReferenceTextParts(contents);
  const inlineCount = inline.filter((part) => part.kind === "reference").length;
  if (inlineCount === 0) return [];
  // Preserve prose around individually validated paths instead of treating it as a filename.
  return [{ kind: "text", text: "[" }, ...inline, { kind: "text", text: "]" }];
}

function referencePartsFromTextMatch(
  match: RegExpExecArray,
  source: string,
): readonly RepositoryReferenceTextPart[] {
  const token = match[0] ?? "";
  if (token.startsWith("[")) return bracketReferenceParts(token.slice(1, -1));
  const reference = referenceFromMatch(match, source);
  return reference === null ? [] : referenceParts([reference]);
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
  const pattern = new RegExp(REPOSITORY_REFERENCE_PATTERN);
  for (;;) {
    const match = pattern.exec(source);
    if (match === null) break;
    const references = referencePartsFromTextMatch(match, source);
    if (references.length === 0) continue;
    if (match.index > lastIndex) {
      parts.push({ kind: "text", text: source.slice(lastIndex, match.index) });
    }
    parts.push(...references);
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
  if (match === null) return undefined;
  if (
    !boundaryAfter(followingText, match[0].length) &&
    !hasExplanatoryReferenceSuffix(followingText, match[0].length)
  )
    return undefined;
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

export function repositoryReferenceRootsForScopes(
  scopes: readonly ChatConnectedScope[],
  fallbackRoot: string,
): readonly RepositoryReferenceRoot[] {
  const roots = new Map<string, { root: string; label: string; scopeFingerprints: string[] }>();
  for (const scope of scopes) {
    const root = scope.root ?? fallbackRoot;
    if (root.length === 0) continue;
    const option = roots.get(root) ?? {
      root,
      label: repositoryRootLabel(root),
      scopeFingerprints: [],
    };
    const fingerprint = connectedScopeFingerprint({ ...scope, root });
    if (!option.scopeFingerprints.includes(fingerprint)) {
      option.scopeFingerprints.push(fingerprint);
    }
    roots.set(root, option);
  }
  return [...roots.values()];
}

function referenceRangeLabel(reference: RepositoryReference, t: I18nTranslate): string {
  if (reference.lineStart === undefined) return "";
  if (reference.lineEnd === undefined || reference.lineEnd === reference.lineStart) {
    return t("chat.repository.line", { start: reference.lineStart });
  }
  return t("chat.repository.lines", { start: reference.lineStart, end: reference.lineEnd });
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
  const visibleByPath = new Map(
    [...new Set(paths)].map((path) => [path, referenceLabelPath(path, false)]),
  );
  const visibleCounts = new Map<string, number>();
  for (const visible of visibleByPath.values()) {
    visibleCounts.set(visible, (visibleCounts.get(visible) ?? 0) + 1);
  }
  const partsByPath = new Map(
    [...visibleByPath].map(([path, visible]) => [path, visible.split("/")]),
  );
  const root: ReferenceSuffixNode = { count: 0, children: new Map() };
  for (const parts of partsByPath.values()) insertReferenceSuffix(root, parts);
  return new Map(
    [...partsByPath].map(([path, parts]) => [
      path,
      (visibleCounts.get(visibleByPath.get(path) ?? "") ?? 0) > 1
        ? escapedUnsafeReferencePath(path)
        : shortestReferenceSuffix(root, parts),
    ]),
  );
}

function escapedUnsafeReferencePath(path: string): string {
  return referenceLabelPath(path, true);
}

function referenceLabelCharacter(character: string, includeUnsafe: boolean): string {
  const reserved = character === "⟦" || character === "⟧";
  const unsafe =
    includeUnsafe && (stripUnsafeFormatChars(character) !== character || /\p{Cc}/u.test(character));
  if (!reserved && !unsafe) return character;
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) throw new TypeError("Missing reference label code point");
  return `⟦U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}⟧`;
}

function referenceLabelPath(path: string, includeUnsafe: boolean): string {
  return repositoryReferenceDisplayPath(
    Array.from(path, (character): string => referenceLabelCharacter(character, includeUnsafe)).join(
      "",
    ),
  );
}

export function repositoryReferenceDisplayPath(path: string): string {
  return stripUnsafeFormatChars(path)
    .replaceAll("\t", "␉")
    .replaceAll("\r", "␍")
    .replaceAll("\n", "␊");
}

function referenceVisibleLabel(reference: RepositoryReference, displayPath?: string): string {
  const parts = reference.path.split("/");
  parts.reverse();
  const fileName = repositoryReferenceDisplayPath(
    displayPath ?? parts.find(Boolean) ?? reference.path,
  );
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
  readonly sourceLabel?: string | undefined;
  readonly requireRootChoice?: boolean | undefined;
  readonly rootRelative?: boolean | undefined;
  readonly citationActivation?: Omit<ClientDiagnosticCitationActivation, "outcome"> | undefined;
}

function sourceChoiceLabel(
  root: RepositoryReferenceRoot,
  roots: readonly RepositoryReferenceRoot[],
): string {
  const sameLabel = roots.filter((candidate) => candidate.label === root.label).length > 1;
  return sameLabel ? `${root.label} · ${repositoryReferenceDisplayPath(root.root)}` : root.label;
}

function sourceChoiceDetail(
  root: RepositoryReferenceRoot,
  roots: readonly RepositoryReferenceRoot[],
): ReactNode {
  const disambiguated = sourceChoiceLabel(root, roots) !== root.label;
  const detail = disambiguated
    ? repositoryReferenceDisplayPath(root.root)
    : repositoryRootSuffix(root.root);
  if (!disambiguated && detail === root.label) return null;
  return <span className="repo-ref-root-path">{detail}</span>;
}

const OPENED_CONFIRMATION_MS = 1800;

// Schedules a callback once. The pending timer is cleared before a new one is scheduled and when
// the component unmounts, so it can never set state on a component that is gone. The uncleared
// timer was a latent race: a test file finishing inside the delay let it fire after jsdom was torn
// down, React threw "window is not defined", and the required keiko-ui coverage job went red on a
// pull request that had not touched this file (#3573).
interface ClearedTimeout {
  readonly schedule: (delayMs: number) => void;
  readonly clear: () => void;
}

function useClearedTimeout(callback: () => void): ClearedTimeout {
  const timerRef = useRef<number | undefined>(undefined);
  const clear = useCallback((): void => {
    if (timerRef.current === undefined) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);
  useEffect(() => clear, [clear]);
  const schedule = useCallback(
    (delayMs: number): void => {
      clear();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined;
        callback();
      }, delayMs);
    },
    [callback, clear],
  );
  return { schedule, clear };
}

function referenceAccessiblePath(
  path: string,
  sourceLabel: string | undefined,
  visibleLabel: string | undefined,
): string {
  let displayPath = repositoryReferenceDisplayPath(path);
  if (stripUnsafeFormatChars(path) !== path && visibleLabel !== undefined) {
    const safeLabel = repositoryReferenceDisplayPath(visibleLabel);
    if (safeLabel !== displayPath && !displayPath.endsWith(`/${safeLabel}`))
      displayPath += ` · ${safeLabel}`;
  }
  return sourceLabel === undefined
    ? displayPath
    : `${repositoryReferenceDisplayPath(sourceLabel)} · ${displayPath}`;
}

export function RepositoryReferenceInline({
  reference,
  roots,
  openReference,
  className = "repo-ref-link",
  displayPath,
  sourceLabel,
  requireRootChoice = false,
  rootRelative,
  citationActivation,
}: RepositoryReferenceInlineProps): ReactNode {
  const t = useTranslate();
  const pickerId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLSpanElement>(null);
  const activationCorrelation = useRef<string | undefined>(undefined);
  const recordActivation = useCallback(
    (outcome: ClientDiagnosticCitationActivation["outcome"]): void => {
      if (citationActivation === undefined) return;
      activationCorrelation.current ??= newClientCorrelationId();
      reportClientDiagnostic("[keiko] citation activation settled", {
        correlationId: activationCorrelation.current,
        citationActivation: { ...citationActivation, outcome },
      });
    },
    [citationActivation],
  );
  const [status, setStatus] = useState<"idle" | "choosing" | "opening" | "opened" | "failed">(
    "idle",
  );
  const [message, setMessage] = useState("");
  const resetToIdle = useCallback((): void => {
    setStatus("idle");
    setMessage("");
  }, []);
  const { schedule: scheduleIdleReset, clear: clearIdleReset } = useClearedTimeout(resetToIdle);
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
    () =>
      requireRootChoice || rootRelative
        ? rootOptions.map((root) => ({ ...root, openPath: normalizeReferencePath(reference.path) }))
        : rankedRootsForReference(reference, rootOptions),
    [reference, requireRootChoice, rootOptions, rootRelative],
  );
  const bestRootOptions = useMemo(() => {
    const best = rankedRootOptions[0];
    if (best === undefined) return [];
    return rankedRootOptions.filter((root) => root.openPath.length === best.openPath.length);
  }, [rankedRootOptions]);

  const openForRoot = useCallback(
    (root: RankedRepositoryRoot): void => {
      if (openReference === undefined) return;
      clearIdleReset();
      if (pickerRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
      const path = root.openPath;
      setStatus("opening");
      setMessage(t("chat.repository.opening", { path: repositoryReferenceDisplayPath(path) }));
      const result = openReference({
        root: root.root,
        path,
        ...(reference.lineStart === undefined ? {} : { lineStart: reference.lineStart }),
        ...(reference.lineEnd === undefined ? {} : { lineEnd: reference.lineEnd }),
      });
      if (result.ok) {
        recordActivation("opened");
        setStatus("opened");
        setMessage(t("chat.repository.opened", { path: repositoryReferenceDisplayPath(path) }));
        scheduleIdleReset(OPENED_CONFIRMATION_MS);
        return;
      }
      recordActivation("open-refused");
      setStatus("failed");
      setMessage(result.message);
    },
    [clearIdleReset, openReference, recordActivation, reference, scheduleIdleReset, t],
  );

  const activate = useCallback((): void => {
    clearIdleReset();
    if (status !== "choosing") activationCorrelation.current = undefined;
    if (openReference === undefined || rootOptions.length === 0) {
      setStatus("failed");
      setMessage(t("chat.repository.connectFirst"));
      recordActivation("refused");
      return;
    }
    if (rankedRootOptions.length === 0) {
      setStatus("failed");
      setMessage(t("chat.repository.sourceMismatch"));
      recordActivation("refused");
      return;
    }
    if (bestRootOptions.length === 1 && !requireRootChoice) {
      const root = bestRootOptions[0];
      if (root !== undefined) openForRoot(root);
      return;
    }
    recordActivation(status === "choosing" ? "picker-dismissed" : "picker-opened");
    setStatus((current) => (current === "choosing" ? "idle" : "choosing"));
    setMessage(t("chat.repository.chooseSource"));
  }, [
    bestRootOptions,
    clearIdleReset,
    openForRoot,
    openReference,
    rankedRootOptions.length,
    recordActivation,
    status,
    requireRootChoice,
    rootOptions.length,
    t,
  ]);

  const dismissOnEscape = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>): void => {
      if (event.key !== "Escape" || status === "idle") return;
      if (status === "choosing") {
        event.preventDefault();
        event.stopPropagation();
        recordActivation("picker-dismissed");
      }
      clearIdleReset();
      resetToIdle();
      triggerRef.current?.focus();
    },
    [clearIdleReset, recordActivation, resetToIdle, status],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>): void => {
      if (event.key === "Escape") return dismissOnEscape(event);
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    },
    [activate, dismissOnEscape],
  );

  if (openReference === undefined) {
    return (
      <span title={repositoryReferenceDisplayPath(reference.label)}>
        {referenceVisibleLabel(reference, displayPath)}
      </span>
    );
  }

  const alert = status === "failed";
  return (
    <span className="repo-ref">
      <button
        ref={triggerRef}
        type="button"
        className={className}
        aria-label={t("chat.repository.openInEditor", {
          path: referenceAccessiblePath(reference.path, sourceLabel, displayPath),
          range: referenceRangeLabel(reference, t),
        })}
        aria-expanded={
          bestRootOptions.length > 1 || requireRootChoice ? status === "choosing" : undefined
        }
        aria-controls={status === "choosing" ? pickerId : undefined}
        data-state={status}
        title={repositoryReferenceDisplayPath(reference.label)}
        onClick={activate}
        onKeyDown={onKeyDown}
      >
        <span className="repo-ref-file-icon" aria-hidden="true">
          <FileIcon name={reference.path} />
        </span>
        <span>{referenceVisibleLabel(reference, displayPath)}</span>
      </button>
      {status === "choosing" ? (
        <span ref={pickerRef} id={pickerId} className="repo-ref-picker">
          {bestRootOptions.map((root) => (
            <button
              key={root.root}
              type="button"
              className="repo-ref-root"
              aria-label={t("chat.repository.selectSource", {
                label: sourceChoiceLabel(root, bestRootOptions),
              })}
              onClick={() => openForRoot(root)}
              onKeyDown={dismissOnEscape}
            >
              <span>{root.label}</span>
              {sourceChoiceDetail(root, bestRootOptions)}
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
