import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type EvidenceAtom,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { evidenceAtomStableId } from "@oscharko-dev/keiko-workspace";

// A connected-folder question that names a subfolder ("the commands folder", "im
// components/PromptInput-Ordner") must be answered from that subtree, however deep it lies and
// however weakly its files match the question's prose (#4429). Ordinary lexical ranking cannot see
// a folder name as a target: the files below it rarely repeat the folder's name, so nothing clears
// the relevance floor and the keep-one fallback sends a single unrelated file. This module finds
// the named folders in the request's own admitted candidate inventory and retains a bounded,
// prioritized subset of their eligible text files as whole-file listing evidence, within the same
// byte capacity the known-fit scope context already uses. Descriptors are transient and body-free.

export const NAMED_DIRECTORY_FOCUS_MAX_DIRECTORIES = 4;
// Bounds the descriptors one focus scan may observe. Past it the scan stops observing, so the
// persistent index serves the rest of the walk again.
export const NAMED_DIRECTORY_FOCUS_MAX_OBSERVED_FILES = 2048;
export const NAMED_DIRECTORY_FOCUS_MAX_DOCUMENTS = 8;

const FOLDER_CUES: ReadonlySet<string> = new Set([
  "ordner",
  "ordners",
  "unterordner",
  "unterordners",
  "verzeichnis",
  "verzeichnisses",
  "unterverzeichnis",
  "folder",
  "subfolder",
  "folders",
  "subfolders",
  "directory",
  "subdirectory",
  "directories",
  "dir",
]);
// Hyphenated compounds name a folder only with an unambiguous cue: `add-dir` is a folder name.
const SUFFIX_CUES: ReadonlySet<string> = new Set([
  "ordner",
  "ordners",
  "unterordner",
  "unterordners",
  "verzeichnis",
  "verzeichnisses",
  "unterverzeichnis",
  "folder",
  "subfolder",
  "directory",
  "subdirectory",
]);
// Function words beside a cue never name the folder ("im Ordner X", "the X folder").
const CUE_NEIGHBOUR_STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "in",
  "of",
  "this",
  "that",
  "my",
  "our",
  "named",
  "called",
  "im",
  "ins",
  "der",
  "die",
  "das",
  "den",
  "dem",
  "des",
  "dieser",
  "diesem",
  "diesen",
  "namens",
  "von",
  "vom",
  "zum",
  "zur",
  "mein",
  "meinem",
  "unser",
  "unserem",
]);
// Tokens split on whitespace and on prose punctuation; path separators, dots, hyphens and
// underscores stay inside a token so `components/PromptInput` and `commands-Ordner` survive.
const TOKEN_SEPARATOR = /[\s,;:!?()[\]{}<>"'`«»„“”‚‘’*|]+/u;
const CUE_PROXIMITY = 2;
const MIN_NAME_LENGTH = 2;

export type NamedDirectoryFocusState =
  | "not-requested"
  | "no-match"
  | "applied"
  | "partial"
  | "empty"
  | "skipped-budget"
  | "skipped-stopped"
  | "incomplete-traversal";

export interface NamedDirectoryFocusObservation {
  readonly state: NamedDirectoryFocusState;
  readonly directoryCount: number;
  readonly ambiguousTermCount: number;
  readonly candidateFileCount: number;
  readonly observedFileCount: number;
  readonly retainedFileCount: number;
  readonly documentCount: number;
  readonly chargedBytes: number;
}

interface FocusTerm {
  readonly segments: readonly string[];
}

interface FocusDescriptor {
  readonly scopePath: string;
  readonly contentBytes: number;
  readonly lineCount: number;
}

export interface NamedDirectoryMatch {
  readonly directories: readonly string[];
  readonly ambiguousTermCount: number;
}

// Linear trimming without a backtracking-prone pattern: `./` prefixes, leading slashes, and
// trailing slashes or sentence dots.
function normalizedToken(raw: string): string {
  let token = raw.replaceAll("\\", "/").toLowerCase();
  while (token.startsWith("./")) token = token.slice(2);
  let start = 0;
  while (start < token.length && token[start] === "/") start += 1;
  let end = token.length;
  while (end > start && (token[end - 1] === "/" || token[end - 1] === ".")) end -= 1;
  return token.slice(start, end);
}

function cueSuffixStripped(token: string): string | undefined {
  const hyphen = token.lastIndexOf("-");
  if (hyphen <= 0) return undefined;
  return SUFFIX_CUES.has(token.slice(hyphen + 1)) ? token.slice(0, hyphen) : undefined;
}

function termFor(token: string): FocusTerm | undefined {
  const segments = token.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) return undefined;
  const last = segments.at(-1);
  if (last === undefined || last.length < MIN_NAME_LENGTH) return undefined;
  return { segments };
}

function hasNearbyCue(tokens: readonly string[], index: number): boolean {
  const start = Math.max(0, index - CUE_PROXIMITY);
  const end = Math.min(tokens.length - 1, index + CUE_PROXIMITY);
  for (let position = start; position <= end; position += 1) {
    const token = tokens[position];
    if (position !== index && token !== undefined && FOLDER_CUES.has(token)) return true;
  }
  return false;
}

/** Folder references in prose: a cued name (`commands-Ordner`, `the commands folder`) or a path. */
export function namedDirectoryTerms(text: string): readonly FocusTerm[] {
  const tokens = text.split(TOKEN_SEPARATOR).map(normalizedToken);
  const terms = new Map<string, FocusTerm>();
  for (const [index, token] of tokens.entries()) {
    const term = termAt(tokens, index, token);
    if (term !== undefined) terms.set(term.segments.join("/"), term);
  }
  return [...terms.values()];
}

function termAt(tokens: readonly string[], index: number, token: string): FocusTerm | undefined {
  if (token.length === 0 || FOLDER_CUES.has(token)) return undefined;
  const suffixed = cueSuffixStripped(token);
  const cued = !CUE_NEIGHBOUR_STOPWORDS.has(token) && hasNearbyCue(tokens, index);
  const candidate = suffixed ?? (token.includes("/") || cued ? token : undefined);
  return candidate === undefined ? undefined : termFor(candidate);
}

function strictlyBelowScopeRoot(directory: string, scopeRoots: readonly string[]): boolean {
  if (scopeRoots.length === 0) return true;
  return scopeRoots.some((root) => directory.startsWith(`${root}/`));
}

/** Every directory that holds an admitted candidate file, keyed by its lower-cased path. */
function candidateDirectories(
  candidatePaths: readonly string[],
  scopeRoots: readonly string[],
): ReadonlyMap<string, string> {
  const directories = new Map<string, string>();
  for (const path of candidatePaths) {
    let slash = path.indexOf("/");
    while (slash > 0) {
      const directory = path.slice(0, slash);
      if (strictlyBelowScopeRoot(directory, scopeRoots))
        directories.set(directory.toLowerCase(), directory);
      slash = path.indexOf("/", slash + 1);
    }
  }
  return directories;
}

function directoryDepth(directory: string): number {
  return directory.split("/").length;
}

function compareDirectories(a: string, b: string): number {
  return directoryDepth(a) - directoryDepth(b) || compareStrings(a, b);
}

function termMatches(term: FocusTerm, directories: ReadonlyMap<string, string>): string[] {
  const suffix = term.segments.join("/");
  const matches: string[] = [];
  for (const [lower, directory] of directories) {
    if (lower === suffix || lower.endsWith(`/${suffix}`)) matches.push(directory);
  }
  return matches.sort(compareDirectories);
}

function withoutNestedDirectories(directories: readonly string[]): string[] {
  const sorted = [...new Set(directories)].sort(compareDirectories);
  return sorted.filter(
    (directory) =>
      !sorted.some((other) => other !== directory && directory.startsWith(`${other}/`)),
  );
}

/** Named folders of the question that exist in the request's admitted candidate inventory. */
export function namedScopeDirectories(
  text: string,
  candidatePaths: readonly string[],
  scopeRoots: readonly string[],
): NamedDirectoryMatch {
  const terms = namedDirectoryTerms(text);
  if (terms.length === 0) return { directories: [], ambiguousTermCount: 0 };
  const directories = candidateDirectories(candidatePaths, scopeRoots);
  const matched: string[] = [];
  let ambiguousTermCount = 0;
  for (const term of terms) {
    const matches = termMatches(term, directories);
    if (matches.length > NAMED_DIRECTORY_FOCUS_MAX_DIRECTORIES) ambiguousTermCount += 1;
    matched.push(...matches.slice(0, NAMED_DIRECTORY_FOCUS_MAX_DIRECTORIES));
  }
  return {
    directories: withoutNestedDirectories(matched).slice(0, NAMED_DIRECTORY_FOCUS_MAX_DIRECTORIES),
    ambiguousTermCount,
  };
}

export function isWithinDirectories(path: string, directories: readonly string[]): boolean {
  return directories.some((directory) => path.startsWith(`${directory}/`));
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).toLowerCase();
}

// Entry points summarize a folder best: its README first, then its index/main/module files.
function entryRank(path: string): number {
  const name = basenameOf(path);
  if (/^readme(?:\.|$)/u.test(name)) return 0;
  if (name === "package.json" || /^(?:index|main|mod|__init__|lib)\.[^.]+$/u.test(name)) return 1;
  return 2;
}

export function compareFocusPaths(a: string, b: string): number {
  return (
    entryRank(a) - entryRank(b) || directoryDepth(a) - directoryDepth(b) || compareStrings(a, b)
  );
}

export interface FocusAtomIdentity {
  readonly scopeId: string;
  readonly queryFingerprint: string;
  readonly emittedAtMs: number;
}

function focusAtom(file: FocusDescriptor, identity: FocusAtomIdentity): EvidenceAtom {
  const { scopeId, queryFingerprint, emittedAtMs } = identity;
  const lineRange = { startLine: 1, endLine: file.lineCount };
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: evidenceAtomStableId({
      scopeId,
      scopePath: file.scopePath,
      lineRange,
      provenanceKind: "file-listing",
      provenanceTool: "repo.findFiles",
      queryFingerprint,
    }),
    scopePath: file.scopePath,
    lineRange,
    score: 1,
    provenance: { kind: "file-listing", tool: "repo.findFiles", queryFingerprint },
    redactionState: "redacted",
    emittedAtMs,
    ledgerRef: undefined,
  };
}

export interface FocusRetention {
  readonly atoms: readonly EvidenceAtom[];
  readonly fileBytes: ReadonlyMap<string, number>;
  readonly chargedBytes: number;
  readonly droppedFileCount: number;
}

/**
 * Retains whole-file listing atoms in entry-first order within the known-fit byte capacity. The
 * charge matches the known-fit scope context: content bytes plus the serialized atom.
 */
export function retainFocusFiles(
  descriptors: readonly FocusDescriptor[],
  capacityBytes: number,
  identity: FocusAtomIdentity,
): FocusRetention {
  const atoms: EvidenceAtom[] = [];
  const fileBytes = new Map<string, number>();
  let chargedBytes = 0;
  let droppedFileCount = 0;
  const encoder = new TextEncoder();
  for (const file of [...descriptors].sort((a, b) => compareFocusPaths(a.scopePath, b.scopePath))) {
    const atom = focusAtom(file, identity);
    const charge = file.contentBytes + encoder.encode(JSON.stringify(atom)).length;
    if (chargedBytes + charge > capacityBytes) {
      droppedFileCount += 1;
      continue;
    }
    chargedBytes += charge;
    atoms.push(atom);
    fileBytes.set(file.scopePath, Math.max(1, file.contentBytes));
  }
  return { atoms, fileBytes, chargedBytes, droppedFileCount };
}

/** Collects eligible text descriptors below the focused folders, bounded by count. */
export class FocusDescriptorCollector {
  private readonly collected: FocusDescriptor[] = [];
  private observed = 0;

  public constructor(private readonly directories: readonly string[]) {}

  public observe = (file: FocusDescriptor): boolean => {
    if (this.observed >= NAMED_DIRECTORY_FOCUS_MAX_OBSERVED_FILES) return false;
    if (!isWithinDirectories(file.scopePath, this.directories)) return true;
    this.observed += 1;
    this.collected.push(file);
    return this.observed < NAMED_DIRECTORY_FOCUS_MAX_OBSERVED_FILES;
  };

  public descriptors(): readonly FocusDescriptor[] {
    return this.collected;
  }

  public observedCount(): number {
    return this.observed;
  }
}

/** Extractable documents below the focused folders, in the same entry-first order. */
export function focusDocumentPaths(
  candidatePaths: readonly string[],
  directories: readonly string[],
  isDocument: (path: string) => boolean,
): readonly string[] {
  return candidatePaths
    .filter((path) => isDocument(path) && isWithinDirectories(path, directories))
    .sort(compareFocusPaths)
    .slice(0, NAMED_DIRECTORY_FOCUS_MAX_DOCUMENTS);
}

export function emptyNamedDirectoryFocus(
  state: NamedDirectoryFocusState,
  match?: NamedDirectoryMatch,
): NamedDirectoryFocusObservation {
  return {
    state,
    directoryCount: match?.directories.length ?? 0,
    ambiguousTermCount: match?.ambiguousTermCount ?? 0,
    candidateFileCount: 0,
    observedFileCount: 0,
    retainedFileCount: 0,
    documentCount: 0,
    chargedBytes: 0,
  };
}
