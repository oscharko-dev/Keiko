import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { causeChain, keikoStackFrames, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { correlationIdOrUnknown } from "../correlation.js";
import {
  REPOSITORY_ITEM_REFUSAL_REASONS,
  repositoryItemNameRefusal,
  sanitizeRepositoryItem,
  type RepositoryItemKind,
  type RepositoryItemRefusalReason,
} from "./codingRuntimeRepositoryItemSanitizer.js";
import {
  exactWorkspaceRead,
  type SecureWorkspaceNativeFileIO,
  type SecureWorkspaceTextReadPort,
} from "./secureWorkspaceTextRead.js";
import type { SecureWorkspaceNativeDirEntry } from "./secureWorkspaceTextReadProtocol.js";

/**
 * Repository agents, commands and skills as sanitized items (#3903, ADR-0137). The native profile
 * keeps the producer's whole project layer off (`OPENCODE_DISABLE_PROJECT_CONFIG`): that layer would
 * also import plugin modules before any permission is evaluated and merge a project provider above
 * Keiko's. The items that are only Markdown are admitted one by one instead. Each is read through the
 * same secure, bounded workspace read helper as the repository instructions (never a second file
 * reader), validated and re-rendered by `codingRuntimeRepositoryItemSanitizer.ts`, and written as a
 * copy into the run's private discovery directory, the configuration directory Keiko's own generated
 * plugins already load from. Nothing under the workspace is a configuration layer: `opencode.json`,
 * plugins, a skill's sibling files and `.claude/` (a tool-state path the always-on deny list refuses)
 * stay unadmitted.
 *
 * The discovery layout is the one the pinned 2.1.4 producer reads from a configuration directory,
 * proven against the original executable: `agents/<name>.md`, `commands/<name>.md` and
 * `skills/<name>/SKILL.md`, loaded after the location is first used.
 */
export const KEIKO_CODING_REPOSITORY_ITEMS_ENABLED_ENV = "KEIKO_CODING_REPOSITORY_ITEMS_ENABLED";

/** The repository directories each kind is admitted from, in precedence order (first name wins). */
const SOURCE_DIRECTORIES: Readonly<Record<RepositoryItemKind, readonly string[]>> = Object.freeze({
  agent: [".opencode/agents", ".opencode/agent"],
  command: [".opencode/commands", ".opencode/command"],
  skill: [".opencode/skills", ".opencode/skill", ".agents/skills"],
});
/** Where each kind's copy lives inside the discovery directory. */
const DESTINATION_DIRECTORY: Readonly<Record<RepositoryItemKind, string>> = Object.freeze({
  agent: "agents",
  command: "commands",
  skill: "skills",
});
const SKILL_FILE_NAME = "SKILL.md";
// The commands listing contract holds 64 entries and the producer's built-ins take two.
const MAX_ADMITTED: Readonly<Record<RepositoryItemKind, number>> = Object.freeze({
  agent: 16,
  command: 32,
  skill: 16,
});
const MAX_CANDIDATES: Readonly<Record<RepositoryItemKind, number>> = Object.freeze({
  agent: 32,
  command: 48,
  skill: 32,
});
const MAX_DIRECTORY_ENTRIES = 512;
const MAX_TOTAL_BYTES = 262_144;
const ADMISSION_TIMEOUT_MS = 20_000;

const ADMISSION_STATES = ["disabled", "unavailable", "empty", "completed", "failed"] as const;
type AdmissionState = (typeof ADMISSION_STATES)[number];
const ADMISSION_REASONS = [
  "source-unavailable",
  "listing-unavailable",
  "workspace-unavailable",
  "cancelled",
  "deadline",
  "write-failed",
  "exception",
] as const;
type AdmissionReason = (typeof ADMISSION_REASONS)[number];

const ADMISSION_ERROR_KINDS: Readonly<Record<AdmissionReason, ActivityLogErrorKind>> = {
  "source-unavailable": "unavailable",
  "listing-unavailable": "unavailable",
  "workspace-unavailable": "unavailable",
  cancelled: "cancelled",
  deadline: "timeout",
  "write-failed": "write-failed",
  exception: "internal",
};
// A scan that could not run is `unavailable`; one that ran and broke is `failed`.
const UNAVAILABLE_REASONS: ReadonlySet<AdmissionReason> = new Set([
  "source-unavailable",
  "listing-unavailable",
  "workspace-unavailable",
]);

const CODING_RUNTIME_REPOSITORY_ITEMS_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.repository-items.admitted",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeRepositoryItems.recordRepositoryItemsAdmission",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...ADMISSION_STATES],
    },
    agentAdmittedCount: { type: "integer", dataClass: "count", required: true },
    agentRefusedCount: { type: "integer", dataClass: "count", required: true },
    commandAdmittedCount: { type: "integer", dataClass: "count", required: true },
    commandRefusedCount: { type: "integer", dataClass: "count", required: true },
    skillAdmittedCount: { type: "integer", dataClass: "count", required: true },
    skillRefusedCount: { type: "integer", dataClass: "count", required: true },
    // Directories the helper could neither list nor prove absent (a link, a file, an unusable root).
    directoryFailureCount: { type: "integer", dataClass: "count", required: true },
    // Frontmatter keys dropped from the admitted copies: those that would have registered authority,
    // routed a model, switched a tool or loaded code, and every other unknown key.
    strippedAuthorityKeyCount: { type: "integer", dataClass: "count", required: true },
    strippedOtherKeyCount: { type: "integer", dataClass: "count", required: true },
    admittedByteCount: { type: "integer", dataClass: "count", required: true },
    // SHA-256 over the admitted copies (their destinations and content digests), so the exact set the
    // producer saw is reconstructable without a name, a path or a body in the log.
    contentSha256: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    refusalReasons: {
      type: "string-array",
      dataClass: "closed-enum",
      required: false,
      maxItems: 17,
      values: [...REPOSITORY_ITEM_REFUSAL_REASONS],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...ADMISSION_REASONS],
    },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  diagnosticWhen: [{ field: "state", values: ["unavailable", "failed"] }],
  failureClasses: ["coding-runtime-repository-items"],
  proofIds: ["coding-runtime.repository-items.admitted.emitted-line"],
  releaseImpact: "patch",
});

/**
 * Accepts the default (absent) and an explicit `true`; `false` and every other value disable the
 * admission. A typo must never admit repository-authored prompts, so unlike the neighbouring
 * `KEIKO_CODING_REPOSITORY_INSTRUCTIONS_ENABLED` an unrecognised value fails closed to off.
 */
export function configuredCodingRuntimeRepositoryItemsEnabled(value: string | undefined): boolean {
  return value === undefined || value.trim().toLowerCase() === "true";
}

export interface AdmittedRepositoryFile {
  readonly kind: RepositoryItemKind;
  /** Relative to the discovery directory, e.g. `agents/reviewer.md`. Built only from validated names. */
  readonly relativePath: string;
  readonly content: string;
}

export interface CodingRuntimeRepositoryItemsRequest {
  readonly runId: string;
  /** The run's private configuration directory (`openCodeConfigDirectory(stateRoot)`), created. */
  readonly discoveryRoot: string;
  readonly signal?: AbortSignal | undefined;
}

export interface CodingRuntimeRepositoryItemsPort {
  /**
   * Reads, sanitizes and writes the run's repository items, and records one line either way. It never
   * rejects: a run must start without them rather than fail because of them, and a failure admits
   * nothing.
   */
  readonly admitForRun: (request: CodingRuntimeRepositoryItemsRequest) => Promise<void>;
}

export interface CodingRuntimeRepositoryItemsInput {
  readonly enabled: boolean;
  /** The runtime host's secure workspace read port; absent on an unqualified host. */
  readonly source: SecureWorkspaceTextReadPort | undefined;
  /** Whether the workspace the secure read resolves to is still this run's own. */
  readonly isRunWorkspace: () => boolean;
  readonly activityLog: ServerLogSink | undefined;
}

export function createCodingRuntimeRepositoryItemsPort(
  input: CodingRuntimeRepositoryItemsInput,
): CodingRuntimeRepositoryItemsPort {
  return { admitForRun: (request): Promise<void> => admitForRun(input, request) };
}

type PerKind = Record<RepositoryItemKind, number>;

interface Tally {
  readonly admitted: PerKind;
  readonly refused: PerKind;
  readonly reasons: Set<RepositoryItemRefusalReason>;
  directoryFailures: number;
  strippedAuthority: number;
  strippedOther: number;
  bytes: number;
}

interface Scan {
  readonly io: SecureWorkspaceNativeFileIO;
  readonly source: SecureWorkspaceTextReadPort;
  readonly signal: AbortSignal;
  readonly tally: Tally;
  readonly files: AdmittedRepositoryFile[];
  /** Agents admitted as subagents so far: the only agents a command may name. */
  readonly subagents: Set<string>;
}

interface Candidate {
  readonly name: string;
  readonly path: string;
}

type CandidateOrRefusal =
  { readonly candidate: Candidate } | { readonly refusal: RepositoryItemRefusalReason };

/** Ends the scan with a closed reason; nothing it read is written. */
class RepositoryItemsStop extends Error {
  public constructor(
    public readonly reason: AdmissionReason,
    options?: ErrorOptions,
  ) {
    super(reason, options);
    this.name = "RepositoryItemsStop";
  }
}

function newTally(): Tally {
  return {
    admitted: { agent: 0, command: 0, skill: 0 },
    refused: { agent: 0, command: 0, skill: 0 },
    reasons: new Set(),
    directoryFailures: 0,
    strippedAuthority: 0,
    strippedOther: 0,
    bytes: 0,
  };
}

async function admitForRun(
  input: CodingRuntimeRepositoryItemsInput,
  request: CodingRuntimeRepositoryItemsRequest,
): Promise<void> {
  const tally = newTally();
  try {
    // The directory always reflects exactly this admission: a copy a previous prepare of the same run
    // left behind, or one written while the operator switch was still on, never outlives it.
    clearAdmittedDirectories(request.discoveryRoot);
    if (!input.enabled) {
      recordRepositoryItemsAdmission(
        input.activityLog,
        request.runId,
        { state: "disabled" },
        tally,
      );
      return;
    }
    const files = await scanWorkspace(input, request, tally);
    if (files.length > 0) writeAdmittedRepositoryItems(request.discoveryRoot, files);
    const found = sum(tally.admitted) + sum(tally.refused) + tally.directoryFailures;
    recordRepositoryItemsAdmission(
      input.activityLog,
      request.runId,
      { state: found === 0 ? "empty" : "completed", contentSha256: admittedSetDigest(files) },
      tally,
    );
  } catch (error) {
    recordFailure(input.activityLog, request, error);
  }
}

function sum(counts: PerKind): number {
  return counts.agent + counts.command + counts.skill;
}

async function scanWorkspace(
  input: CodingRuntimeRepositoryItemsInput,
  request: CodingRuntimeRepositoryItemsRequest,
  tally: Tally,
): Promise<readonly AdmittedRepositoryFile[]> {
  if (input.source === undefined) throw new RepositoryItemsStop("source-unavailable");
  const source = exactWorkspaceRead(input.source, input.isRunWorkspace, "workspace-unavailable");
  if (source.nativeFileIO === undefined) throw new RepositoryItemsStop("listing-unavailable");
  const signal = AbortSignal.any([
    ...(request.signal === undefined ? [] : [request.signal]),
    AbortSignal.timeout(ADMISSION_TIMEOUT_MS),
  ]);
  const scan: Scan = {
    io: source.nativeFileIO,
    source,
    signal,
    tally,
    files: [],
    subagents: new Set(),
  };
  // The listings are independent. Reading is not: the budgets and, for a command, the agents
  // admitted before it are shared state, and the helper answers `busy` beyond eight live reads.
  const [agents, commands, skills] = await Promise.all([
    listCandidates("agent", scan),
    listCandidates("command", scan),
    listCandidates("skill", scan),
  ]);
  await admitFrom("agent", agents, 0, scan);
  await admitFrom("command", commands, 0, scan);
  await admitFrom("skill", skills, 0, scan);
  return scan.files;
}

function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new RepositoryItemsStop("cancelled");
}

function refuse(
  scan: Scan,
  kind: RepositoryItemKind,
  reason: RepositoryItemRefusalReason,
  count = 1,
): void {
  scan.tally.refused[kind] += count;
  scan.tally.reasons.add(reason);
}

async function listCandidates(kind: RepositoryItemKind, scan: Scan): Promise<Candidate[]> {
  const listings = await Promise.all(
    SOURCE_DIRECTORIES[kind].map((directory) => listDirectory(scan, directory)),
  );
  const seen = new Set<string>();
  const collected: Candidate[] = [];
  listings.forEach((entries, index) => {
    const directory = SOURCE_DIRECTORIES[kind][index] ?? "";
    for (const outcome of candidatesIn(kind, directory, entries ?? [])) {
      if ("refusal" in outcome) refuse(scan, kind, outcome.refusal);
      else if (seen.has(outcome.candidate.name)) refuse(scan, kind, "duplicate-name");
      else {
        seen.add(outcome.candidate.name);
        collected.push(outcome.candidate);
      }
    }
  });
  const excess = collected.splice(MAX_CANDIDATES[kind]);
  if (excess.length > 0) refuse(scan, kind, "limit-exceeded", excess.length);
  return collected;
}

async function listDirectory(
  scan: Scan,
  path: string,
): Promise<readonly SecureWorkspaceNativeDirEntry[] | undefined> {
  throwIfStopped(scan.signal);
  const result = await scan.io.list({ relativePath: path, signal: scan.signal });
  if (result.ok) return result.entries;
  switch (result.reason) {
    case "not-found":
      return undefined;
    case "cancelled":
      throw new RepositoryItemsStop("cancelled");
    case "workspace-unavailable":
      throw new RepositoryItemsStop("workspace-unavailable");
    case "native-io-unavailable":
    case "unsupported-platform":
    case "artifact-unverified":
      throw new RepositoryItemsStop("listing-unavailable");
    default:
      scan.tally.directoryFailures += 1;
      scan.tally.reasons.add("directory-unreadable");
      return undefined;
  }
}

function compareNames(a: SecureWorkspaceNativeDirEntry, b: SecureWorkspaceNativeDirEntry): number {
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

function candidatesIn(
  kind: RepositoryItemKind,
  directory: string,
  entries: readonly SecureWorkspaceNativeDirEntry[],
): CandidateOrRefusal[] {
  const sorted = [...entries].sort(compareNames);
  const outcomes = sorted
    .slice(0, MAX_DIRECTORY_ENTRIES)
    .flatMap((entry) => candidateOf(kind, directory, entry));
  return sorted.length > MAX_DIRECTORY_ENTRIES
    ? [...outcomes, { refusal: "limit-exceeded" }]
    : outcomes;
}

// The producer skips hidden entries, so a name only matters once it could be an item.
function candidateOf(
  kind: RepositoryItemKind,
  directory: string,
  entry: SecureWorkspaceNativeDirEntry,
): CandidateOrRefusal[] {
  if (entry.name.startsWith(".")) return [];
  if (kind === "skill") return skillEntry(directory, entry);
  if (!entry.name.endsWith(".md")) return [];
  return namedCandidate(
    entry.type === "file",
    entry.name.slice(0, -3),
    `${directory}/${entry.name}`,
  );
}

// A skill is a directory holding SKILL.md; a loose file beside the directories is not one here.
function skillEntry(directory: string, entry: SecureWorkspaceNativeDirEntry): CandidateOrRefusal[] {
  if (entry.type === "file") return [];
  return namedCandidate(
    entry.type === "directory",
    entry.name,
    `${directory}/${entry.name}/${SKILL_FILE_NAME}`,
  );
}

function namedCandidate(regular: boolean, name: string, path: string): CandidateOrRefusal[] {
  if (!regular) return [{ refusal: "not-regular-file" }];
  const refusal = repositoryItemNameRefusal(name);
  return refusal === undefined ? [{ candidate: { name, path } }] : [{ refusal }];
}

// Sequential on purpose: each admission spends budgets the next one is checked against.
async function admitFrom(
  kind: RepositoryItemKind,
  candidates: readonly Candidate[],
  index: number,
  scan: Scan,
): Promise<void> {
  const candidate = candidates[index];
  if (candidate === undefined) return;
  throwIfStopped(scan.signal);
  await admitCandidate(kind, candidate, scan);
  await admitFrom(kind, candidates, index + 1, scan);
}

async function admitCandidate(
  kind: RepositoryItemKind,
  candidate: Candidate,
  scan: Scan,
): Promise<void> {
  if (scan.tally.admitted[kind] >= MAX_ADMITTED[kind]) {
    refuse(scan, kind, "limit-exceeded");
    return;
  }
  const read = await scan.source.readText({ relativePath: candidate.path, signal: scan.signal });
  if (!read.ok) {
    refuseRead(scan, kind, read.reason);
    return;
  }
  const outcome = sanitizeRepositoryItem(kind, candidate.name, read.text, {
    admittedSubagents: scan.subagents,
  });
  if (!outcome.ok) {
    refuse(scan, kind, outcome.reason);
    return;
  }
  const bytes = Buffer.byteLength(outcome.content, "utf8");
  if (scan.tally.bytes + bytes > MAX_TOTAL_BYTES) {
    refuse(scan, kind, "limit-exceeded");
    return;
  }
  scan.files.push({
    kind,
    relativePath: destinationOf(kind, candidate.name),
    content: outcome.content,
  });
  scan.tally.admitted[kind] += 1;
  scan.tally.bytes += bytes;
  scan.tally.strippedAuthority += outcome.strippedAuthorityKeyCount;
  scan.tally.strippedOther += outcome.strippedOtherKeyCount;
  if (outcome.mode === "subagent") scan.subagents.add(candidate.name);
}

function destinationOf(kind: RepositoryItemKind, name: string): string {
  const directory = DESTINATION_DIRECTORY[kind];
  return kind === "skill" ? `${directory}/${name}/${SKILL_FILE_NAME}` : `${directory}/${name}.md`;
}

function refuseRead(scan: Scan, kind: RepositoryItemKind, reason: string): void {
  if (reason === "cancelled") throw new RepositoryItemsStop("cancelled");
  if (reason === "workspace-unavailable") throw new RepositoryItemsStop("workspace-unavailable");
  // A directory without a SKILL.md is a container, not a skill.
  if (reason === "not-found" && kind === "skill") return;
  refuse(scan, kind, reason === "too-large" ? "oversize" : "unreadable");
}

function clearAdmittedDirectories(discoveryRoot: string): void {
  try {
    for (const directory of Object.values(DESTINATION_DIRECTORY)) {
      rmSync(join(discoveryRoot, directory), { recursive: true, force: true });
    }
  } catch (error) {
    throw new RepositoryItemsStop("write-failed", { cause: error });
  }
}

/**
 * Writes the admitted copies, each below the discovery directory by construction and checked again
 * here, and removes what it wrote if any write fails. Exported for its own containment proof.
 */
export function writeAdmittedRepositoryItems(
  discoveryRoot: string,
  files: readonly AdmittedRepositoryFile[],
): void {
  const written: string[] = [];
  try {
    for (const file of files) {
      const target = join(discoveryRoot, file.relativePath);
      assertInside(discoveryRoot, target);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      // Exclusive: an admitted copy never replaces a file that is already there.
      writeFileSync(target, file.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      written.push(target);
      chmodSync(target, 0o600);
    }
  } catch (error) {
    for (const target of written) rmSync(target, { force: true });
    throw new RepositoryItemsStop("write-failed", { cause: error });
  }
}

function assertInside(root: string, target: string): void {
  const path = relative(root, target);
  if (path === "" || path.startsWith("..") || isAbsolute(path)) {
    throw new RangeError("repository-item-path-invalid");
  }
}

function admittedSetDigest(files: readonly AdmittedRepositoryFile[]): string | undefined {
  if (files.length === 0) return undefined;
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1))) {
    const content = createHash("sha256").update(file.content, "utf8").digest("hex");
    hash.update(`${file.relativePath}\n${content}\n`, "utf8");
  }
  return hash.digest("hex");
}

interface AdmissionOutcome {
  readonly state: AdmissionState;
  readonly reason?: AdmissionReason;
  readonly contentSha256?: string | undefined;
  readonly error?: unknown;
}

// A scan that stopped never wrote anything, so the line reports no item as admitted and no count of
// what it had read: only the closed reason and, for a technical failure, the error's frames.
function recordFailure(
  activityLog: ServerLogSink | undefined,
  request: CodingRuntimeRepositoryItemsRequest,
  error: unknown,
): void {
  const stop = error instanceof RepositoryItemsStop ? error : undefined;
  const reason = stopReasonOf(stop?.reason, request.signal);
  const cause = stop === undefined ? error : stop.cause;
  recordRepositoryItemsAdmission(
    activityLog,
    request.runId,
    {
      state: UNAVAILABLE_REASONS.has(reason) ? "unavailable" : "failed",
      reason,
      ...(cause === undefined ? {} : { error: cause }),
    },
    newTally(),
  );
}

// A scan stopped by its own deadline reports `deadline`; a caller's abort reports `cancelled`.
function stopReasonOf(
  reason: AdmissionReason | undefined,
  caller: AbortSignal | undefined,
): AdmissionReason {
  if (reason === "cancelled" && caller?.aborted !== true) return "deadline";
  return reason ?? "exception";
}

function recordRepositoryItemsAdmission(
  activityLog: ServerLogSink | undefined,
  runId: string,
  outcome: AdmissionOutcome,
  tally: Tally,
): void {
  const { state, reason, contentSha256, error } = outcome;
  const errorKind = reason === undefined ? undefined : ADMISSION_ERROR_KINDS[reason];
  activityLog?.write(
    activityLogEvent(
      CODING_RUNTIME_REPOSITORY_ITEMS_OPERATION,
      {
        correlationId: correlationIdOrUnknown(runId),
        ...(errorKind === undefined ? {} : { level: "warn" as const, errorKind }),
      },
      {
        runId,
        state,
        agentAdmittedCount: tally.admitted.agent,
        agentRefusedCount: tally.refused.agent,
        commandAdmittedCount: tally.admitted.command,
        commandRefusedCount: tally.refused.command,
        skillAdmittedCount: tally.admitted.skill,
        skillRefusedCount: tally.refused.skill,
        directoryFailureCount: tally.directoryFailures,
        strippedAuthorityKeyCount: tally.strippedAuthority,
        strippedOtherKeyCount: tally.strippedOther,
        admittedByteCount: tally.bytes,
        ...(contentSha256 === undefined ? {} : { contentSha256 }),
        ...(tally.reasons.size === 0 ? {} : { refusalReasons: [...tally.reasons].sort() }),
        ...(reason === undefined ? {} : { reason }),
        ...(error === undefined
          ? {}
          : { frames: keikoStackFrames(error), causeChain: causeChain(error) }),
      },
    ),
  );
}
