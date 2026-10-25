import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { OwnerPrivateFileRefused, readOwnerPrivateFile } from "../ownerPrivateStateFile.js";
import {
  readGlobalConfigDocuments,
  readProjectConfigDocuments,
  type ConfigDocumentRefusal,
} from "./opencodeConfigDocuments.js";
import type {
  SecureWorkspaceNativeFileIO,
  SecureWorkspaceTextReadPort,
} from "./secureWorkspaceTextRead.js";

/**
 * The instruction sources a standalone OpenCode run loads besides the task workspace's own
 * `AGENTS.md` (#3900 AC3): the user's global `AGENTS.md` and the files its global `instructions`
 * names, every `AGENTS.md` above the workspace up to the producer's own stop (the home directory
 * when the workspace is inside it, otherwise the repository root), and the files the project's
 * `opencode.json` names in `instructions`. The run itself reads none of them: its kernel profile
 * keeps it inside the workspace, and its project layer stays off. Keiko reads each one here --
 * outside the workspace as an owner-private regular file opened without following a link, inside
 * it through the same secure workspace read the root `AGENTS.md` takes -- and the repository
 * instructions owner masks credentials, bounds and labels every text in the one copy the producer's
 * own instruction plugin loads and watches. A repository-named source never reaches outside the
 * workspace; a remote one (`https://`) is pulled only in Full access, through Keiko's egress.
 */
export type InstructionSourceKind = "global" | "ancestor" | "configured" | "remote";

export interface InstructionSourceText {
  readonly kind: InstructionSourceKind;
  /** How the copy names the source to the model: a path relative to the workspace or home, a URL. */
  readonly label: string;
  /** The text as read; the instructions owner masks credentials before anything is copied. */
  readonly text: string;
}

export const INSTRUCTION_SOURCE_REFUSALS = [
  "not-regular-file",
  "not-owner-private",
  "too-large",
  "linked-file",
  "not-text",
  "outside-workspace",
  "unsupported-format",
  "config-malformed",
  "unreadable",
  "limit-exceeded",
  "remote-unavailable",
] as const;
export type InstructionSourceRefusal = (typeof INSTRUCTION_SOURCE_REFUSALS)[number];

export interface InstructionSourceDiscovery {
  readonly sources: readonly InstructionSourceText[];
  /** `https://` entries the configurations name, in order; pulled by the caller in Full access. */
  readonly remote: readonly string[];
  readonly refused: readonly InstructionSourceRefusal[];
}

export interface InstructionSourceDiscoveryInput {
  readonly workspaceRoot: string;
  readonly home: string;
  /** The user's OpenCode configuration directory (`$XDG_CONFIG_HOME/opencode`, `~/.config/opencode`). */
  readonly globalConfigDirectory: string;
  /** The run's own secure workspace read, already bound to the run's workspace. */
  readonly workspace: SecureWorkspaceTextReadPort;
  readonly signal?: AbortSignal | undefined;
}

export const INSTRUCTION_SOURCE_FILE_NAME = "AGENTS.md";
/** The secure read helper's own content ceiling; the owner bounds what is copied far below it. */
const SOURCE_MAX_BYTES = 1_048_576;
const MAX_SOURCES = 32;
const MAX_ANCESTORS = 32;
const MAX_PATTERN_MATCHES = 16;
const MAX_PATTERN_DIRECTORIES = 256;
const GLOB_CHARACTER = /[*?[\]{}]/u;

/** `$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode`, as the producer resolves it. */
export function globalOpenCodeConfigDirectory(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const configured = env.XDG_CONFIG_HOME;
  const base =
    configured !== undefined && isAbsolute(configured) ? configured : join(home, ".config");
  return join(base, "opencode");
}

/**
 * The directories above the workspace whose `AGENTS.md` the producer loads, nearest first: up to
 * the home directory when the workspace lies inside it, otherwise up to the repository root that
 * contains the workspace (none when the workspace is that root, or in no repository).
 */
export function instructionAncestorDirectories(workspaceRoot: string, home: string): string[] {
  const stop = inside(home, workspaceRoot) ? home : repositoryRootAbove(workspaceRoot);
  if (stop === undefined) return [];
  const directories: string[] = [];
  for (let current = dirname(workspaceRoot); directories.length < MAX_ANCESTORS;) {
    directories.push(current);
    if (current === stop || dirname(current) === current) break;
    current = dirname(current);
  }
  return directories;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function repositoryRootAbove(workspaceRoot: string): string | undefined {
  for (let current = dirname(workspaceRoot); dirname(current) !== current;) {
    if (lstatSync(join(current, ".git"), { throwIfNoEntry: false }) !== undefined) return current;
    current = dirname(current);
  }
  return undefined;
}

class Tally {
  public readonly sources: InstructionSourceText[] = [];
  public readonly remote: string[] = [];
  public readonly refused: InstructionSourceRefusal[] = [];
  private readonly seen = new Set<string>();

  public add(key: string, source: InstructionSourceText): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.sources.length >= MAX_SOURCES) this.refused.push("limit-exceeded");
    else this.sources.push(source);
  }

  public refuse(reason: InstructionSourceRefusal): void {
    this.refused.push(reason);
  }
}

// An owner-private regular file outside the workspace, read without following a link. A missing
// file is no source; an ancestor with a second link may alias a file outside every root. A closed
// refusal is counted; any other failure propagates to the owner, which records it.
function hostText(path: string, tally: Tally, requireSingleLink: boolean): string | undefined {
  const probe = lstatSync(path, { throwIfNoEntry: false });
  if (probe === undefined) return undefined;
  if (requireSingleLink && probe.isFile() && probe.nlink > 1) {
    tally.refuse("linked-file");
    return undefined;
  }
  const bytes = ownerPrivateBytes(path, tally);
  if (bytes === undefined) return undefined;
  const text = strictText(bytes);
  if (text === undefined) tally.refuse("not-text");
  return text;
}

function ownerPrivateBytes(path: string, tally: Tally): Buffer | undefined {
  try {
    return readOwnerPrivateFile(path, SOURCE_MAX_BYTES);
  } catch (error) {
    if (!(error instanceof OwnerPrivateFileRefused)) throw error;
    tally.refuse(error.reason);
    return undefined;
  }
}

function strictText(bytes: Buffer): string | undefined {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) && !text.includes("\0") ? text : undefined;
}

function homeLabel(path: string, home: string): string {
  return inside(home, path) ? `~/${relative(home, path).split(sep).join("/")}` : path;
}

/** The string entries of a configuration document's `instructions`, or why there are none. */
export function configuredInstructionEntries(
  document: Readonly<Record<string, unknown>>,
): readonly string[] | "config-malformed" {
  const entries = document.instructions;
  if (entries === undefined) return [];
  return Array.isArray(entries)
    ? entries.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : "config-malformed";
}

function documentEntries(
  documents: readonly Readonly<Record<string, unknown>>[],
  refused: readonly ConfigDocumentRefusal[],
  tally: Tally,
): readonly string[] {
  for (const reason of refused) tally.refuse(reason);
  const entries: string[] = [];
  for (const document of documents) {
    const parsed = configuredInstructionEntries(document);
    if (parsed === "config-malformed") tally.refuse(parsed);
    else entries.push(...parsed);
  }
  return entries;
}

function globalAgents(input: InstructionSourceDiscoveryInput, tally: Tally): void {
  const path = join(input.globalConfigDirectory, INSTRUCTION_SOURCE_FILE_NAME);
  const text = hostText(path, tally, false);
  if (text !== undefined)
    tally.add(path, { kind: "global", label: homeLabel(path, input.home), text });
}

function ancestorAgents(input: InstructionSourceDiscoveryInput, tally: Tally): void {
  for (const directory of instructionAncestorDirectories(input.workspaceRoot, input.home)) {
    const path = join(directory, INSTRUCTION_SOURCE_FILE_NAME);
    const text = hostText(path, tally, true);
    if (text !== undefined)
      tally.add(path, { kind: "ancestor", label: homeLabel(path, input.home), text });
  }
}

// A global entry may name the user's own file anywhere they keep it; a workspace-relative entry,
// from either configuration, is a pattern inside the workspace and nothing above it.
async function configuredEntry(
  input: InstructionSourceDiscoveryInput,
  entry: string,
  global: boolean,
  tally: Tally,
): Promise<void> {
  if (entry.startsWith("https://")) {
    if (!tally.remote.includes(entry)) tally.remote.push(entry);
    return;
  }
  const hostPath = entry.startsWith("~/") ? join(input.home, entry.slice(2)) : entry;
  if (isAbsolute(hostPath)) {
    if (!global || GLOB_CHARACTER.test(hostPath)) {
      tally.refuse("outside-workspace");
      return;
    }
    const text = hostText(hostPath, tally, true);
    if (text !== undefined)
      tally.add(hostPath, { kind: "configured", label: homeLabel(hostPath, input.home), text });
    return;
  }
  await workspaceEntry(input, entry, tally);
}

async function workspaceEntry(
  input: InstructionSourceDiscoveryInput,
  entry: string,
  tally: Tally,
): Promise<void> {
  const segments = entry.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) {
    tally.refuse("outside-workspace");
    return;
  }
  const paths = GLOB_CHARACTER.test(entry)
    ? await expandPattern(input, segments, tally)
    : [segments.join("/")];
  for (const relativePath of paths) {
    if (relativePath === INSTRUCTION_SOURCE_FILE_NAME) continue;
    const result = await input.workspace.readText({
      relativePath,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (result.ok)
      tally.add(join(input.workspaceRoot, relativePath), {
        kind: "configured",
        label: relativePath,
        text: result.text,
      });
    else if (result.reason !== "not-found") tally.refuse("unreadable");
  }
}

/** A glob segment as a whole-name expression: `*` and `?` stay inside one path segment. */
function segmentExpression(segment: string): RegExp | undefined {
  if (/[[\]{}]/u.test(segment)) return undefined;
  const source = segment
    .split("")
    .map((character) => {
      if (character === "*") return "[^/]*";
      if (character === "?") return "[^/]";
      return character.replace(/[.+^$()|\\]/gu, String.raw`\$&`);
    })
    .join("");
  return new RegExp(`^${source}$`, "u");
}

interface PatternWalk {
  readonly io: SecureWorkspaceNativeFileIO;
  readonly input: InstructionSourceDiscoveryInput;
  readonly matches: Set<string>;
  directories: number;
  truncated: boolean;
}

/**
 * The workspace files a pattern names, walked through the secure native listing from the pattern's
 * literal prefix: `*` and `?` within a segment, `**` across segments. Bounded in directories and
 * matches; a pattern this walker cannot express (`[...]`, `{...}`) is refused, never approximated.
 */
async function expandPattern(
  input: InstructionSourceDiscoveryInput,
  segments: readonly string[],
  tally: Tally,
): Promise<readonly string[]> {
  const io = input.workspace.nativeFileIO;
  if (io === undefined || segments.some((segment) => segmentExpression(segment) === undefined)) {
    tally.refuse("unsupported-format");
    return [];
  }
  const walk: PatternWalk = { io, input, matches: new Set(), directories: 0, truncated: false };
  await walkPattern(walk, "", segments);
  if (walk.truncated) tally.refuse("limit-exceeded");
  return [...walk.matches].sort(compareStrings);
}

async function walkPattern(
  walk: PatternWalk,
  directory: string,
  segments: readonly string[],
): Promise<void> {
  const [segment, ...rest] = segments;
  if (segment === undefined || walk.truncated) return;
  if (segment === "**") {
    // Zero segments here, or one more directory and the same `**` again.
    await walkPattern(walk, directory, rest);
    for (const child of await listed(walk, directory, "directory"))
      await walkPattern(walk, child, segments);
    return;
  }
  const expression = segmentExpression(segment);
  for (const name of await listed(walk, directory, rest.length === 0 ? "file" : "directory")) {
    if (expression?.test(name.slice(name.lastIndexOf("/") + 1)) !== true) continue;
    if (rest.length > 0) await walkPattern(walk, name, rest);
    else addMatch(walk, name);
  }
}

function addMatch(walk: PatternWalk, name: string): void {
  if (walk.matches.size >= MAX_PATTERN_MATCHES) walk.truncated = true;
  else walk.matches.add(name);
}

async function listed(
  walk: PatternWalk,
  directory: string,
  type: "file" | "directory",
): Promise<readonly string[]> {
  walk.directories += 1;
  if (walk.directories > MAX_PATTERN_DIRECTORIES) {
    walk.truncated = true;
    return [];
  }
  const result = await walk.io.list({
    relativePath: directory,
    ...(walk.input.signal === undefined ? {} : { signal: walk.input.signal }),
  });
  if (!result.ok) return [];
  return result.entries
    .filter((entry) => entry.type === type)
    .map((entry) => (directory.length === 0 ? entry.name : `${directory}/${entry.name}`))
    .sort(compareStrings);
}

/**
 * Every additional source of one run, in the producer's own order: the global `AGENTS.md`, the
 * ancestors' (nearest first), then each configured entry -- the user's global configuration's
 * first, then the project's.
 */
export async function discoverInstructionSources(
  input: InstructionSourceDiscoveryInput,
): Promise<InstructionSourceDiscovery> {
  const tally = new Tally();
  globalAgents(input, tally);
  ancestorAgents(input, tally);
  const global = readGlobalConfigDocuments(input.globalConfigDirectory);
  for (const entry of documentEntries(global.documents, global.refused, tally))
    await configuredEntry(input, entry, true, tally);
  const project = await readProjectConfigDocuments(input.workspace, input.signal);
  for (const entry of documentEntries(project.documents, project.refused, tally))
    await configuredEntry(input, entry, false, tally);
  return { sources: tally.sources, remote: tally.remote, refused: tally.refused };
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
