import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { causeChain, keikoStackFrames, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  gatewayFetch,
  readBytesCapped,
  type OutboundHttpEgressConfig,
} from "@oscharko-dev/keiko-model-gateway/internal/http";

import {
  OWNER_PRIVATE_FILE_REFUSALS,
  OwnerPrivateFileRefused,
  readOwnerPrivateFile,
} from "../ownerPrivateStateFile.js";
import { onlyKeys, plainRecord } from "../operatorRegistryJson.js";
import { correlationIdOrUnknown } from "../correlation.js";
import { CODING_RUNTIME_FAILURE_TRACE_FIELDS } from "./codingRuntimeActivityOperations.js";
import {
  REPOSITORY_ITEM_MAX_BYTES,
  REPOSITORY_ITEM_REFUSAL_REASONS,
  repositoryItemNameRefusal,
  type RepositoryItemRefusalReason,
  sanitizeRepositoryItem,
} from "./codingRuntimeRepositoryItemSanitizer.js";
import { writeAdmittedRepositoryItems } from "./codingRuntimeRepositoryItems.js";

/**
 * Remote skill sources (#3903 AC3, parity row T17): the original runtime pulls a skill index from a
 * URL named in its `skills` setting (`<source>/index.json`, then each skill's files from the same
 * origin) and loads what it pulled as skills, unsanitized and over the runtime's own egress. Keiko
 * keeps that setting its own and pulls instead: only sources the operator names in the owner-private
 * registry `<stateDir>/opencode-skill-sources.json`, only for a run launched in Full access (the mode
 * whose internet use proceeds without a per-action decision), through Keiko's egress configuration
 * with no redirect and no loopback or private target. Each skill's `SKILL.md` passes the sanitizer
 * the repository skills pass and is written to the run's private `skill/` discovery directory, where
 * the producer's own `skill` tool lists and loads it; sibling files are not copied, as for a
 * repository skill. A name the repository already uses stays the repository's.
 */
export const OPENCODE_SKILL_SOURCES_FILE = "opencode-skill-sources.json";
const MAX_REGISTRY_BYTES = 8_192;
const MAX_SOURCES = 4;
const MAX_INDEX_BYTES = 65_536;
const MAX_INDEX_ENTRIES = 64;
/** Across every source of a run, as for the repository's own skills. */
const MAX_REMOTE_SKILLS = 16;
const FETCH_TIMEOUT_MS = 10_000;
const FULL_ACCESS = "autonomous-delivery";
/** Beside the repository's `skills/`; the producer discovers both. */
const REMOTE_SKILL_DIRECTORY = "skill";
const REPOSITORY_SKILL_DIRECTORY = "skills";

const REGISTRY_REASONS = [
  "malformed",
  "schema-version",
  "too-many-sources",
  "source-invalid",
  "duplicate-source",
  "not-json",
  ...OWNER_PRIVATE_FILE_REFUSALS,
] as const;
type RegistryReason = (typeof REGISTRY_REASONS)[number];

export type SkillSourceRegistry =
  | { readonly state: "absent" | "loaded"; readonly sources: readonly string[] }
  | { readonly state: "refused"; readonly sources: readonly []; readonly reason: RegistryReason };

/** The closed grammar: `{ "schemaVersion": 1, "sources": [{ "url": "https://…/" }] }`. */
export function parseSkillSourceRegistry(
  value: unknown,
):
  | { readonly ok: true; readonly sources: readonly string[] }
  | { readonly ok: false; readonly reason: RegistryReason } {
  const document = plainRecord(value);
  if (document === undefined || !onlyKeys(document, ["schemaVersion", "sources"]))
    return { ok: false, reason: "malformed" };
  if (document.schemaVersion !== 1) return { ok: false, reason: "schema-version" };
  if (!Array.isArray(document.sources)) return { ok: false, reason: "malformed" };
  if (document.sources.length > MAX_SOURCES) return { ok: false, reason: "too-many-sources" };
  const sources: string[] = [];
  for (const entry of document.sources as readonly unknown[]) {
    const source = sourceUrl(entry);
    if (source === undefined) return { ok: false, reason: "source-invalid" };
    if (sources.includes(source)) return { ok: false, reason: "duplicate-source" };
    sources.push(source);
  }
  return { ok: true, sources };
}

// An https base without credentials, query or fragment, normalized to end in `/` as the runtime does.
function sourceUrl(value: unknown): string | undefined {
  const entry = plainRecord(value);
  if (entry === undefined || !onlyKeys(entry, ["url"]) || typeof entry.url !== "string")
    return undefined;
  if (entry.url.length > 1_024 || !URL.canParse(entry.url)) return undefined;
  const url = new URL(entry.url);
  if (!plainHttpsBase(url)) return undefined;
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

function plainHttpsBase(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
}

/**
 * Reads the operator's skill source registry. A missing file is no source; a file Keiko cannot
 * trust or that is not JSON throws, and the admission records it as a refused registry.
 */
export function loadSkillSourceRegistry(stateDir: string): SkillSourceRegistry {
  const bytes = readOwnerPrivateFile(
    join(stateDir, OPENCODE_SKILL_SOURCES_FILE),
    MAX_REGISTRY_BYTES,
  );
  if (bytes === undefined) return { state: "absent", sources: [] };
  const parsed = parseSkillSourceRegistry(JSON.parse(bytes.toString("utf8")) as unknown);
  return parsed.ok
    ? { state: "loaded", sources: parsed.sources }
    : { state: "refused", sources: [], reason: parsed.reason };
}

export interface RemoteSkillsAdmissionRequest {
  readonly runId: string;
  /** The run's private configuration directory (`openCodeConfigDirectory(stateRoot)`), created. */
  readonly discoveryRoot: string;
  /** The run's launch mode (`KEIKO_CODING_MODE`); only Full access pulls a remote source. */
  readonly mode: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface RemoteSkillsAdmissionInput {
  readonly registry: () => SkillSourceRegistry;
  readonly egress: () => OutboundHttpEgressConfig | undefined;
  readonly activityLog: ServerLogSink | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface RemoteSkillsPort {
  /**
   * Writes the admitted copies and records its lines. A source or a skill it cannot admit is
   * refused, never thrown; it rejects only when it cannot clear an earlier admission.
   */
  readonly admitForRun: (request: RemoteSkillsAdmissionRequest) => Promise<void>;
}

export function createRemoteSkillsPort(input: RemoteSkillsAdmissionInput): RemoteSkillsPort {
  return { admitForRun: (request) => admitRemoteSkills(input, request) };
}

const REMOTE_ONLY_REFUSALS = ["skill-invalid", "skill-unavailable"] as const;
/** The sanitizer's closed reasons, and the two only a remote source has. */
type SkillRefusal = RepositoryItemRefusalReason | (typeof REMOTE_ONLY_REFUSALS)[number];

interface Pull {
  readonly names: Set<string>;
  readonly files: {
    readonly kind: "skill";
    readonly relativePath: string;
    readonly content: string;
  }[];
}

async function admitRemoteSkills(
  input: RemoteSkillsAdmissionInput,
  request: RemoteSkillsAdmissionRequest,
): Promise<void> {
  try {
    rmSync(join(request.discoveryRoot, REMOTE_SKILL_DIRECTORY), { recursive: true, force: true });
    const registry = input.registry();
    if (
      registry.state === "refused" ||
      registry.sources.length === 0 ||
      request.mode !== FULL_ACCESS
    ) {
      recordRemoteSkills(input.activityLog, request.runId, registryLine(registry));
      return;
    }
    const pull: Pull = { names: repositorySkillNames(request.discoveryRoot), files: [] };
    for (const source of registry.sources) await pullSource(input, request, source, pull); // NOSONAR typescript:S9382 -- an earlier source's skills take their names first, and the cap spans sources
    writeAdmittedRepositoryItems(request.discoveryRoot, pull.files);
  } catch (error) {
    recordRemoteSkills(
      input.activityLog,
      request.runId,
      { scope: "registry", ...failedState(error) },
      error,
    );
    rmSync(join(request.discoveryRoot, REMOTE_SKILL_DIRECTORY), { recursive: true, force: true });
  }
}

function repositorySkillNames(discoveryRoot: string): Set<string> {
  const directory = join(discoveryRoot, REPOSITORY_SKILL_DIRECTORY);
  return new Set(existsSync(directory) ? readdirSync(directory) : []);
}

interface IndexEntry {
  readonly name: string;
  readonly files: readonly string[];
}

// One source pulls whole or contributes nothing: a transport failure part-way drops what it pulled.
async function pullSource(
  input: RemoteSkillsAdmissionInput,
  request: RemoteSkillsAdmissionRequest,
  source: string,
  pull: Pull,
): Promise<void> {
  const line = {
    scope: "source",
    sourceSha256: createHash("sha256").update(source, "utf8").digest("hex"),
  } as const;
  try {
    const index = await fetchIndex(input, source, request.signal);
    if (index === undefined) {
      recordRemoteSkills(input.activityLog, request.runId, { ...line, state: "index-invalid" });
      return;
    }
    const pulled = await pullSkills(input, request, source, index, pull);
    for (const file of pulled.files) pull.files.push(file);
    for (const name of pulled.names) pull.names.add(name);
    recordRemoteSkills(input.activityLog, request.runId, {
      ...line,
      state: "admitted",
      admittedCount: pulled.files.length,
      refusedCount: pulled.refusedCount,
      refusalReasons: pulled.refusals,
      contentSha256: contentDigest(pulled.files),
    });
  } catch (error) {
    recordRemoteSkills(
      input.activityLog,
      request.runId,
      { ...line, state: "source-failed" },
      error,
    );
  }
}

async function pullSkills(
  input: RemoteSkillsAdmissionInput,
  request: RemoteSkillsAdmissionRequest,
  source: string,
  index: readonly IndexEntry[],
  pull: Pull,
): Promise<{
  readonly files: Pull["files"];
  readonly names: ReadonlySet<string>;
  readonly refusals: readonly SkillRefusal[];
  readonly refusedCount: number;
}> {
  const files: Pull["files"][number][] = [];
  const names = new Set<string>();
  const refusals: SkillRefusal[] = [];
  for (const entry of index) {
    const refusal = entryRefusal(entry, pull, names, files.length);
    if (refusal !== undefined) {
      refusals.push(refusal);
      continue;
    }
    const url = new URL(`${encodeURIComponent(entry.name)}/SKILL.md`, source).href;
    const text = await fetchText(input, url, request.signal); // NOSONAR typescript:S9382 -- whether a later entry fits the cap depends on this one's outcome
    const outcome =
      text === undefined
        ? ({ ok: false, reason: "skill-unavailable" } as const)
        : sanitizeRepositoryItem("skill", entry.name, text, { admittedSubagents: new Set() });
    if (!outcome.ok) {
      refusals.push(outcome.reason);
      continue;
    }
    names.add(entry.name);
    files.push({
      kind: "skill",
      relativePath: `${REMOTE_SKILL_DIRECTORY}/${entry.name}/SKILL.md`,
      content: outcome.content,
    });
  }
  return {
    files,
    names,
    refusals: [...new Set(refusals)].sort((a, b) => a.localeCompare(b)),
    refusedCount: refusals.length,
  };
}

function entryRefusal(
  entry: IndexEntry,
  pull: Pull,
  names: ReadonlySet<string>,
  pulled: number,
): SkillRefusal | undefined {
  const nameRefusal = repositoryItemNameRefusal(entry.name);
  if (nameRefusal !== undefined) return nameRefusal;
  if (!entry.files.includes("SKILL.md")) return "skill-invalid";
  if (pull.names.has(entry.name) || names.has(entry.name)) return "duplicate-name";
  return pull.files.length + pulled >= MAX_REMOTE_SKILLS ? "limit-exceeded" : undefined;
}

// `undefined`: the index is absent or not the runtime's shape; a transport failure throws.
async function fetchIndex(
  input: RemoteSkillsAdmissionInput,
  source: string,
  signal: AbortSignal | undefined,
): Promise<readonly IndexEntry[] | undefined> {
  const text = await fetchText(input, new URL("index.json", source).href, signal, MAX_INDEX_BYTES);
  if (text === undefined) return undefined;
  const skills = plainRecord(parsedJson(text))?.skills;
  if (!Array.isArray(skills) || skills.length > MAX_INDEX_ENTRIES) return undefined;
  const entries = (skills as readonly unknown[]).map(indexEntry);
  return entries.every((entry) => entry !== undefined) ? entries : undefined;
}

function indexEntry(value: unknown): IndexEntry | undefined {
  const entry = plainRecord(value);
  const files = entry?.files;
  if (typeof entry?.name !== "string" || !Array.isArray(files)) return undefined;
  const names = files.filter((file): file is string => typeof file === "string");
  return names.length === files.length ? { name: entry.name, files: names } : undefined;
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    // Not JSON is not an index; anything else is a defect that must surface.
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

// The text of one same-origin file of the source, or `undefined` when it does not answer 200 with
// bounded UTF-8. No redirect is followed, and a loopback or private target is refused.
async function fetchText(
  input: RemoteSkillsAdmissionInput,
  url: string,
  signal: AbortSignal | undefined,
  maxBytes = REPOSITORY_ITEM_MAX_BYTES,
): Promise<string | undefined> {
  const response = await gatewayFetch(url, {
    method: "GET",
    redirect: "manual",
    egress: { ...input.egress(), denyLoopback: true, pinProxiedConnectTarget: true },
    timeoutMs: FETCH_TIMEOUT_MS,
    maxResponseBytes: maxBytes,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    return undefined;
  }
  const bytes = await readBytesCapped(response, maxBytes);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

function contentDigest(files: Pull["files"]): string | undefined {
  if (files.length === 0) return undefined;
  const lines = files
    .map(
      (file) =>
        `${file.relativePath}:${createHash("sha256").update(file.content, "utf8").digest("hex")}`,
    )
    .sort((left, right) => left.localeCompare(right));
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

const STATES = [
  "absent",
  "registry-refused",
  "mode-restricted",
  "failed",
  "admitted",
  "index-invalid",
  "source-failed",
] as const;
type RemoteSkillsState = (typeof STATES)[number];

interface RemoteSkillsLine {
  readonly scope: "registry" | "source";
  readonly state: RemoteSkillsState;
  readonly registryReason?: RegistryReason | undefined;
  readonly sourceCount?: number | undefined;
  readonly sourceSha256?: string | undefined;
  readonly admittedCount?: number | undefined;
  readonly refusedCount?: number | undefined;
  readonly refusalReasons?: readonly string[] | undefined;
  readonly contentSha256?: string | undefined;
}

// Recorded only for a registry that pulls nothing: refused, empty, or a run below Full access.
function registryLine(registry: SkillSourceRegistry): RemoteSkillsLine {
  if (registry.state === "refused")
    return { scope: "registry", state: "registry-refused", registryReason: registry.reason };
  if (registry.sources.length === 0) return { scope: "registry", state: "absent" };
  return { scope: "registry", state: "mode-restricted", sourceCount: registry.sources.length };
}

// A registry file Keiko cannot trust or parse refuses the registry; anything else is a failure.
function failedState(error: unknown): Pick<RemoteSkillsLine, "state" | "registryReason"> {
  if (error instanceof OwnerPrivateFileRefused)
    return { state: "registry-refused", registryReason: error.reason };
  if (error instanceof SyntaxError)
    return { state: "registry-refused", registryReason: "not-json" };
  return { state: "failed" };
}

const COUNT = { type: "integer", dataClass: "count", required: false } as const;

const REMOTE_SKILLS_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.remote-skills.admitted",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeRemoteSkills.recordRemoteSkills",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    scope: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["registry", "source"],
    },
    state: { type: "string", dataClass: "closed-enum", required: true, values: [...STATES] },
    registryReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...REGISTRY_REASONS],
    },
    sourceCount: COUNT,
    // SHA-256 of the source URL: which source, without its address.
    sourceSha256: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    admittedCount: COUNT,
    refusedCount: COUNT,
    refusalReasons: {
      type: "string-array",
      dataClass: "closed-enum",
      required: false,
      maxItems: 24,
      values: [...REPOSITORY_ITEM_REFUSAL_REASONS, ...REMOTE_ONLY_REFUSALS],
    },
    contentSha256: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    ...CODING_RUNTIME_FAILURE_TRACE_FIELDS,
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  diagnosticWhen: [
    { field: "state", values: ["registry-refused", "failed", "index-invalid", "source-failed"] },
  ],
  failureClasses: ["coding-runtime-remote-skills"],
  proofIds: ["coding-runtime.remote-skills.admitted.emitted-line"],
  releaseImpact: "patch",
});

/** Closed values, counts and digests only; never a URL, a skill name or a byte of a skill. */
export function recordRemoteSkills(
  activityLog: ServerLogSink | undefined,
  runId: string,
  line: RemoteSkillsLine,
  error?: unknown,
): void {
  const { scope, state, ...optional } = line;
  const warn = state !== "absent" && state !== "admitted" && state !== "mode-restricted";
  activityLog?.write(
    activityLogEvent(
      REMOTE_SKILLS_OPERATION,
      {
        correlationId: correlationIdOrUnknown(runId),
        ...(warn ? { level: "warn" as const } : {}),
        ...(state === "failed" || state === "source-failed"
          ? { errorKind: "read-failed" as const }
          : {}),
      },
      {
        runId,
        scope,
        state,
        ...definedFields(optional),
        ...(error === undefined
          ? {}
          : { frames: keikoStackFrames(error), causeChain: causeChain(error) }),
      },
    ),
  );
}

function definedFields(
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0),
    ),
  );
}
