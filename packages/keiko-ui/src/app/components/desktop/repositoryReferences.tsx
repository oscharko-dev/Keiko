"use client";

import { useCallback, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import type { OpenEditorFileRequest, OpenEditorFileResult } from "./hooks/useWorkspace.types";
import { FileIcon } from "./widgets/shared/projectTree";

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

const REPOSITORY_REFERENCE_PATTERN =
  /@?((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9][A-Za-z0-9]{0,15})(?::(\d{1,7})(?:-(\d{1,7}))?)?/gu;
const REPOSITORY_REFERENCE_SOURCE = String.raw`@?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9][A-Za-z0-9]{0,15}(?::\d{1,7}(?:-\d{1,7})?)?`;
const REPOSITORY_REFERENCE_IN_BRACKETS_PATTERN = new RegExp(
  String.raw`\[\s*(${REPOSITORY_REFERENCE_SOURCE})\s*\]`,
  "giu",
);
const BRACKETED_REFERENCE_DUPLICATE_PATTERN = new RegExp(
  String.raw`\[\s*(${REPOSITORY_REFERENCE_SOURCE})\s*\]\s*(?:\[source:\s*[^\]]+\]\s*)?(${REPOSITORY_REFERENCE_SOURCE})`,
  "giu",
);
const ADJACENT_REFERENCE_DUPLICATE_PATTERN = new RegExp(
  String.raw`(${REPOSITORY_REFERENCE_SOURCE})\s+(?:\[source:\s*[^\]]+\]\s*)?(${REPOSITORY_REFERENCE_SOURCE})`,
  "giu",
);
const SOURCE_LABEL_PATTERN = /\[source:\s*[^\]]+\]/giu;

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
  const previous = value[index - 1] ?? "";
  return !/[A-Za-z0-9_./:@-]/u.test(previous);
}

function boundaryAfter(value: string, index: number): boolean {
  if (index >= value.length) return true;
  const next = value[index] ?? "";
  return !/[A-Za-z0-9_/:+-]/u.test(next);
}

function normalizeReferencePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\/+/u, "").replace(/\/+$/u, "");
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

function tidyEvidenceText(source: string): string {
  return source.replace(/[ \t]{2,}/gu, " ").replace(/[ \t]+([,.;:!?])/gu, "$1");
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

function validRepositoryPath(path: string): boolean {
  const normalized = normalizeReferencePath(path);
  if (normalized.length === 0 || normalized !== path) return false;
  if (normalized.startsWith(".") || normalized.includes("..")) return false;
  if (!normalized.includes(".")) return false;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return false;
  }
  const filename = segments[segments.length - 1] ?? "";
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return KNOWN_REPOSITORY_EXTENSIONS.has(extension);
}

function parseLine(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function referenceFromMatch(match: RegExpExecArray, source: string): RepositoryReference | null {
  const raw = match[0] ?? "";
  const matchIndex = match.index;
  if (!boundaryBefore(source, matchIndex) || !boundaryAfter(source, matchIndex + raw.length)) {
    return null;
  }
  const path = normalizeReferencePath(match[1] ?? "");
  if (!validRepositoryPath(path)) return null;
  const lineStart = parseLine(match[2]);
  const rawLineEnd = parseLine(match[3]);
  const lineEnd =
    lineStart === undefined ? undefined : Math.max(lineStart, rawLineEnd ?? lineStart);
  return {
    label: raw,
    path,
    ...(lineStart === undefined ? {} : { lineStart }),
    ...(lineEnd === undefined ? {} : { lineEnd }),
  };
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
    const reference = referenceFromMatch(match, source);
    if (reference === null) continue;
    if (match.index > lastIndex) {
      parts.push({ kind: "text", text: source.slice(lastIndex, match.index) });
    }
    parts.push({ kind: "reference", reference });
    lastIndex = match.index + (match[0]?.length ?? 0);
  }
  if (lastIndex === 0) return [{ kind: "text", text: source }];
  if (lastIndex < source.length) parts.push({ kind: "text", text: source.slice(lastIndex) });
  return parts;
}

export function parseExactRepositoryReference(source: string): RepositoryReference | null {
  REPOSITORY_REFERENCE_PATTERN.lastIndex = 0;
  const match = REPOSITORY_REFERENCE_PATTERN.exec(source);
  if (match === null || match.index !== 0 || (match[0]?.length ?? 0) !== source.length) {
    return null;
  }
  return referenceFromMatch(match, source);
}

export function repositoryRootLabel(root: string): string {
  const normalized = root.replace(/\\/gu, "/").replace(/\/+$/u, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? root;
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

function referenceVisibleLabel(reference: RepositoryReference): string {
  const fileName = reference.path.split("/").filter(Boolean).pop() ?? reference.path;
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
  const normalized = root.replace(/\\/gu, "/").replace(/\/+$/u, "");
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
}

export function RepositoryReferenceInline({
  reference,
  roots,
  openReference,
  className = "repo-ref-link",
}: RepositoryReferenceInlineProps): ReactNode {
  const [status, setStatus] = useState<"idle" | "choosing" | "opening" | "opened" | "failed">(
    "idle",
  );
  const [message, setMessage] = useState("");
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
        window.setTimeout(() => {
          setStatus("idle");
          setMessage("");
        }, 1800);
        return;
      }
      setStatus("failed");
      setMessage(result.message);
    },
    [openReference, reference],
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
    return <span title={reference.label}>{referenceVisibleLabel(reference)}</span>;
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
        <span>{referenceVisibleLabel(reference)}</span>
      </button>
      {status === "choosing" ? (
        <span className="repo-ref-picker" role="dialog" aria-label="Select repository source">
          {bestRootOptions.map((root) => (
            <button
              key={root.root}
              type="button"
              className="repo-ref-root"
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
