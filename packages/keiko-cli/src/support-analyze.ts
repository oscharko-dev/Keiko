// `keiko support analyze` — pure logic: parsing, grouping, and ordering `server*.log` lines
// (whether raw, or copied verbatim into a `keiko support export` bundle) by `correlationId`.
//
// Wave 6 (epic #3233 closeout, w6-log-analyze-full) extends the Wave 1 minimal `LogTimeline`
// (`lines`, `firstTs`, `lastTs`, `durationMs`, `errorKinds`) with `frames` (the union of every
// `frames[]` entry seen for the correlationId, occurrence order, capped) — OMITTED, never an
// empty array, when no line in the timeline carried frames, the same no-placeholder-stubbing
// discipline the rest of this file already follows. It also adds whole-file `clusters`
// (`OpCluster[]`, grouping every parsed line by `(category, op, errorKind)` regardless of
// correlationId) and `buildReproductionSeed`/`renderGatewayReplayScriptFixture`, which assemble a
// `ReproductionSeed` — a `gatewayScript`/`httpRequest`/`storeFingerprint`/`indexingJob`/
// `stackFrames`/`causeChain` reconstruction for one correlationId, plus a `warnings` field naming
// exactly what could NOT be reconstructed and why. `support.ts` owns argv parsing and wires these
// exports (plus `renderHumanReproductionSeed`, below) to `--clusters`/`--seed`/`--emit-fixture`.
//
// Ordering: `seq` has shipped unconditionally since the v2 envelope (schemaVersion 2), so within
// one process lifetime a v2 line is ordered by `seq` — never by its position in the file. ACROSS
// process lifetimes the envelope promises no order (ADR-0173 D2), so lifetimes are ranked by the
// position of their FIRST line in the file — the order the operator's machine actually produced
// them — and a lifetime's lines are kept together behind that rank. A line written before the v2
// envelope shipped (schemaVersion 1, no pid/instanceId/seq) can still be present in a server.log
// spanning the upgrade (the sink's own 7-day retention window); it has no lifetime to belong to, so
// it ranks by its own file position. The result is ONE total order (rank, then seq) rather than a
// comparator that switches rule per pair, which is not transitive and would hand `sort` an
// undefined result the moment a pre-v2 line sits between two v2 lines of the same process.
//
// `AnalyzeAllResult` (whole-file scope, unlike the per-`LogTimeline` fields above) carries three
// more fields the analyzer CAN populate honestly today (ADR-0173 D9/D10): `processes` — one
// summary per process lifetime, built from every line with a full (pid, instanceId, seq) triple
// regardless of correlationId, so the correlationId-less `process.*` lifecycle lines stay
// reconstructable; `legacyLineCount` — lines successfully parsed but missing that triple; and
// `warnings`, which carries exactly one entry naming `legacyLineCount` when it is nonzero. This is
// the honest machine-readable admission that file-position ordering was used for some lines, which
// Wave 6 extends rather than the analyzer silently omitting the caveat.
//
// `support.ts` owns argv parsing, file reads, and stdout/stderr; this file owns everything that
// can be exercised on an in-memory string.

import { createHash } from "node:crypto";
import type { StoreFingerprint } from "@oscharko-dev/keiko-contracts";
import { isStoreFingerprint } from "@oscharko-dev/keiko-contracts/runtime/store-fingerprint";

const KNOWN_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "ts",
  "schemaVersion",
  "pid",
  "instanceId",
  "seq",
  "level",
  "category",
  "op",
  "correlationId",
  "durationMs",
  "status",
  "errorKind",
  "frames",
  "causeChain",
]);

export interface ServerLogLineView {
  readonly ts: string;
  readonly pid?: number | undefined;
  readonly instanceId?: string | undefined;
  readonly seq?: number | undefined;
  readonly level?: string | undefined;
  readonly category: string;
  readonly op: string;
  readonly errorKind?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly status?: number | undefined;
  readonly frames?: readonly string[] | undefined;
  // Sibling of `frames`: `redactLogObject` special-cases both by name the same way (ADR-0173
  // §4.4), and `formatServerLogLine` flattens both onto the top level of the written JSON.
  readonly causeChain?: readonly string[] | undefined;
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

export interface LogTimeline {
  readonly correlationId: string;
  readonly lines: readonly ServerLogLineView[];
  readonly firstTs: string;
  readonly lastTs: string;
  readonly durationMs: number;
  readonly errorKinds: readonly string[];
  // Wave 6: the union of every `frames[]` entry seen across this timeline's lines, occurrence
  // order, capped at `MAX_TIMELINE_FRAMES`. Omitted (never `[]`) when no line carried frames.
  readonly frames?: readonly string[] | undefined;
}

// A process lifetime summarised across ALL its lines, not only the ones that carry a
// correlationId — `process.started`/`process.heartbeat`/`process.exiting` lines have none (ADR-0173
// D9), so a timeline built only from `groupByCorrelationId` can never reconstruct them. Ordered
// (like `timelines`) by first appearance in the file.
export interface ProcessSummary {
  readonly pid: number;
  readonly instanceId: string;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly lineCount: number;
  readonly firstTs: string;
  readonly lastTs: string;
  // The `process.started` line's `extra` bucket for this lifetime, when one was seen.
  readonly started?: Readonly<Record<string, unknown>> | undefined;
  // The `reason` field of the `process.exiting` line's `extra` bucket, when one was seen.
  readonly exitReason?: string | undefined;
}

export interface AnalyzeAllResult {
  readonly timelines: readonly LogTimeline[];
  readonly malformedLineCount: number;
  readonly processes: readonly ProcessSummary[];
  // Lines successfully parsed as log records but missing the full (pid, instanceId, seq) v2
  // identity triple — pre-v2 lines the sink's own retention window can still be holding.
  readonly legacyLineCount: number;
  // Exactly one entry when legacyLineCount > 0, naming the count; empty otherwise. The honest
  // machine-readable admission that this analyzer fell back to file-position ordering for some
  // lines — Wave 6 extends this rather than the analyzer silently omitting the caveat.
  readonly warnings: readonly string[];
  // Wave 6: every parsed line (correlated or not) grouped by (category, op, errorKind),
  // first-occurrence order — always present, empty when there are no parsed lines, the same
  // "real empty state, not a placeholder" convention `processes`/`timelines` already use.
  readonly clusters: readonly OpCluster[];
}

export type SourceKind = "bundle" | "raw-log";

function splitLines(text: string): readonly string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function tryParseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// A support bundle's first line is a manifest object tagged `$section: "manifest"`; a raw
// server.log's first line is an ordinary log record (ts+category+op, no `$section`). Any other
// shape (unparseable, empty file) is treated as a raw log — its own line-level malformed-line
// accounting handles the rest.
export function detectSourceKind(firstLine: string | undefined): SourceKind {
  if (firstLine === undefined) return "raw-log";
  const parsed = tryParseJsonObject(firstLine);
  return parsed?.$section === "manifest" ? "bundle" : "raw-log";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function optionalStringArray(value: unknown): readonly string[] | undefined {
  return isStringArray(value) ? value : undefined;
}

// Bucketing every OTHER top-level key on the parsed record: `formatServerLogLine` flattens an
// event's `extra` object onto the top level of the written JSON (there is no nested `.extra` key
// on disk), so reconstructing a display-only `extra` bucket means collecting whatever survived
// redaction beyond the known envelope keys.
function extraFields(
  record: Record<string, unknown>,
): Readonly<Record<string, unknown>> | undefined {
  // Null prototype: a `"__proto__"` key parsed out of a log line is an ordinary own property on
  // `record` (`JSON.parse` defines it via `[[DefineOwnProperty]]`, not the exotic setter), but
  // assigning it onto a plain `{}` here would hit `Object.prototype`'s inherited `__proto__`
  // setter instead of defining an own property — silently dropping the field from the reported
  // `extra` bucket (and, for an object value, replacing `extra`'s own prototype) rather than
  // reporting it, which is exactly the silent skip this module's header states it must not do.
  const extra: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let hasAny = false;
  for (const key of Object.keys(record)) {
    if (KNOWN_ENVELOPE_KEYS.has(key)) continue;
    extra[key] = record[key];
    hasAny = true;
  }
  return hasAny ? extra : undefined;
}

interface Identity {
  readonly pid: number | undefined;
  readonly instanceId: string | undefined;
  readonly seq: number | undefined;
}

function readIdentity(record: Record<string, unknown>): Identity {
  return {
    pid: optionalNumber(record, "pid"),
    instanceId: optionalString(record, "instanceId"),
    seq: optionalNumber(record, "seq"),
  };
}

// Split out of `buildView` purely to keep that function's cyclomatic complexity under the
// repository's ceiling (AGENTS.md §6) — the three identity fields are optional for exactly the
// same "a pre-v2 line has none" reason as every other field there.
function identityFields(identity: Identity): Pick<ServerLogLineView, "pid" | "instanceId" | "seq"> {
  return {
    ...(identity.pid === undefined ? {} : { pid: identity.pid }),
    ...(identity.instanceId === undefined ? {} : { instanceId: identity.instanceId }),
    ...(identity.seq === undefined ? {} : { seq: identity.seq }),
  };
}

function buildView(
  ts: string,
  category: string,
  op: string,
  record: Record<string, unknown>,
  identity: Identity,
): ServerLogLineView {
  const level = optionalString(record, "level");
  const errorKind = optionalString(record, "errorKind");
  const durationMs = optionalNumber(record, "durationMs");
  const status = optionalNumber(record, "status");
  const frames = optionalStringArray(record.frames);
  const causeChain = optionalStringArray(record.causeChain);
  const extra = extraFields(record);
  return {
    ts,
    category,
    op,
    ...identityFields(identity),
    ...(level === undefined ? {} : { level }),
    ...(errorKind === undefined ? {} : { errorKind }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(status === undefined ? {} : { status }),
    ...(frames === undefined ? {} : { frames }),
    ...(causeChain === undefined ? {} : { causeChain }),
    ...(extra === undefined ? {} : { extra }),
  };
}

interface ParsedLine {
  readonly view: ServerLogLineView;
  readonly correlationId: string | undefined;
  readonly hasFullIdentity: boolean;
  readonly fileIndex: number;
}

type LineClassification =
  | { readonly kind: "line"; readonly parsed: ParsedLine }
  | { readonly kind: "section" }
  | { readonly kind: "malformed" };

// A line is malformed when it is not valid JSON, or is valid JSON that is not shaped like a log
// record (missing ts/category/op) — evidence of corruption, per AGENTS.md §7 never silently
// skipped. A `$section`-tagged line is bundle metadata, not corruption: it is skipped, not counted.
function classifyLine(raw: string, fileIndex: number): LineClassification {
  const record = tryParseJsonObject(raw);
  if (record === undefined) return { kind: "malformed" };
  if (typeof record.$section === "string") return { kind: "section" };
  const ts = optionalString(record, "ts");
  const category = optionalString(record, "category");
  const op = optionalString(record, "op");
  if (ts === undefined || category === undefined || op === undefined) {
    return { kind: "malformed" };
  }
  const identity = readIdentity(record);
  return {
    kind: "line",
    parsed: {
      view: buildView(ts, category, op, record, identity),
      correlationId: optionalString(record, "correlationId"),
      hasFullIdentity:
        identity.pid !== undefined &&
        identity.instanceId !== undefined &&
        identity.seq !== undefined,
      fileIndex,
    },
  };
}

function groupByCorrelationId(records: readonly ParsedLine[]): ReadonlyMap<string, ParsedLine[]> {
  const groups = new Map<string, ParsedLine[]>();
  for (const record of records) {
    if (record.correlationId === undefined) continue;
    const existing = groups.get(record.correlationId);
    if (existing === undefined) {
      groups.set(record.correlationId, [record]);
    } else {
      existing.push(record);
    }
  }
  return groups;
}

function orZero(value: number | undefined): number {
  return value ?? 0;
}

function orEmpty(value: string | undefined): string {
  return value ?? "";
}

// The process-lifetime key of a v2 line; a pre-v2 line has none.
function lifetimeKey(line: ParsedLine): string | undefined {
  return line.hasFullIdentity
    ? `${String(orZero(line.view.pid))}:${orEmpty(line.view.instanceId)}`
    : undefined;
}

interface OrderedLine {
  readonly line: ParsedLine;
  // The file position of the first line of this line's process lifetime (its own position for a
  // pre-v2 line), then `seq` inside the lifetime (file position again for a pre-v2 line).
  readonly rank: number;
  readonly within: number;
}

function assignOrder(group: readonly ParsedLine[]): readonly OrderedLine[] {
  const firstSeen = new Map<string, number>();
  return group.map((line) => {
    const key = lifetimeKey(line);
    if (key === undefined) return { line, rank: line.fileIndex, within: line.fileIndex };
    const rank = firstSeen.get(key) ?? line.fileIndex;
    firstSeen.set(key, rank);
    return { line, rank, within: orZero(line.view.seq) };
  });
}

function compareOrdered(a: OrderedLine, b: OrderedLine): number {
  return a.rank === b.rank ? a.within - b.within : a.rank - b.rank;
}

function distinctInOrder(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function minMaxTs(values: readonly string[]): { readonly first: string; readonly last: string } {
  let first = values[0] ?? "";
  let last = values[0] ?? "";
  for (const value of values) {
    if (value < first) first = value;
    if (value > last) last = value;
  }
  return { first, last };
}

// Wave 6 cap on `LogTimeline.frames`: the union is aggregated across every line in a (potentially
// long-running) timeline, not one line's own already-capped `frames[]` — a generous ceiling well
// above any single line's own 8-frame cap (ADR-0173 §2), never unbounded.
const MAX_TIMELINE_FRAMES = 32;

function aggregateFrames(views: readonly ServerLogLineView[]): readonly string[] {
  const all: string[] = [];
  for (const view of views) {
    if (view.frames === undefined) continue;
    all.push(...view.frames);
  }
  return distinctInOrder(all).slice(0, MAX_TIMELINE_FRAMES);
}

function buildTimeline(correlationId: string, group: readonly ParsedLine[]): LogTimeline {
  const views = [...assignOrder(group)].sort(compareOrdered).map((ordered) => ordered.line.view);
  const { first, last } = minMaxTs(views.map((view) => view.ts));
  const parsedFirst = Date.parse(first);
  const parsedLast = Date.parse(last);
  const durationMs =
    Number.isFinite(parsedFirst) && Number.isFinite(parsedLast) ? parsedLast - parsedFirst : 0;
  const errorKinds = distinctInOrder(
    views.map((view) => view.errorKind).filter((kind): kind is string => kind !== undefined),
  );
  const frames = aggregateFrames(views);
  return {
    correlationId,
    lines: views,
    firstTs: first,
    lastTs: last,
    durationMs,
    errorKinds,
    ...(frames.length === 0 ? {} : { frames }),
  };
}

interface ProcessAccum {
  pid: number;
  instanceId: string;
  firstSeq: number;
  lastSeq: number;
  lineCount: number;
  firstTs: string;
  lastTs: string;
  started: Readonly<Record<string, unknown>> | undefined;
  exitReason: string | undefined;
}

function exitReasonOf(view: ServerLogLineView): string | undefined {
  const reason = view.extra?.reason;
  return typeof reason === "string" ? reason : undefined;
}

function newProcessAccum(view: ServerLogLineView, pid: number, instanceId: string): ProcessAccum {
  const seq = orZero(view.seq);
  return {
    pid,
    instanceId,
    firstSeq: seq,
    lastSeq: seq,
    lineCount: 1,
    firstTs: view.ts,
    lastTs: view.ts,
    started: view.op === "process.started" ? view.extra : undefined,
    exitReason: view.op === "process.exiting" ? exitReasonOf(view) : undefined,
  };
}

function mergeIntoProcessAccum(accum: ProcessAccum, view: ServerLogLineView): void {
  const seq = orZero(view.seq);
  accum.lineCount += 1;
  accum.firstSeq = Math.min(accum.firstSeq, seq);
  accum.lastSeq = Math.max(accum.lastSeq, seq);
  if (view.ts < accum.firstTs) accum.firstTs = view.ts;
  if (view.ts > accum.lastTs) accum.lastTs = view.ts;
  if (view.op === "process.started" && view.extra !== undefined) accum.started = view.extra;
  if (view.op === "process.exiting") {
    const reason = exitReasonOf(view);
    if (reason !== undefined) accum.exitReason = reason;
  }
}

// Summarises every process lifetime seen across ALL parsed lines — including the lifecycle lines
// (`process.started`/`process.heartbeat`/`process.exiting`) that carry no correlationId and so
// never enter a `LogTimeline` — in first-file-appearance order (a `Map`'s insertion order, the
// same ranking rule `assignOrder` uses for timelines).
function buildProcessSummaries(lines: readonly ParsedLine[]): readonly ProcessSummary[] {
  const accums = new Map<string, ProcessAccum>();
  for (const { view, hasFullIdentity } of lines) {
    if (!hasFullIdentity || view.pid === undefined || view.instanceId === undefined) continue;
    const key = `${String(view.pid)}:${view.instanceId}`;
    const existing = accums.get(key);
    if (existing === undefined) {
      accums.set(key, newProcessAccum(view, view.pid, view.instanceId));
    } else {
      mergeIntoProcessAccum(existing, view);
    }
  }
  return [...accums.values()];
}

// Wave 6: a whole-artifact frequency view, independent of correlationId — "what kept happening"
// rather than "what happened on one request". Grouped by (category, op, errorKind) so a reader can
// see, e.g., "gateway.retry.scheduled with GATEWAY_RATE_LIMIT happened 40 times across 12 calls"
// without opening every one of those 12 timelines individually.
export interface OpCluster {
  readonly category: string;
  readonly op: string;
  readonly errorKind: string | null;
  readonly count: number;
  readonly sampleCorrelationIds: readonly string[];
}

const MAX_CLUSTER_SAMPLE_IDS = 5;

interface ClusterAccum {
  category: string;
  op: string;
  errorKind: string | null;
  count: number;
  sampleCorrelationIds: string[];
  seenIds: Set<string>;
}

function clusterKey(category: string, op: string, errorKind: string | null): string {
  return `${category}\0${op}\0${errorKind ?? ""}`;
}

function newClusterAccum(category: string, op: string, errorKind: string | null): ClusterAccum {
  return { category, op, errorKind, count: 0, sampleCorrelationIds: [], seenIds: new Set() };
}

function addClusterSample(accum: ClusterAccum, correlationId: string | undefined): void {
  if (correlationId === undefined || accum.seenIds.has(correlationId)) return;
  accum.seenIds.add(correlationId);
  if (accum.sampleCorrelationIds.length < MAX_CLUSTER_SAMPLE_IDS) {
    accum.sampleCorrelationIds.push(correlationId);
  }
}

// Groups ALL parsed lines (correlated or not) by (category, op, errorKind), first-occurrence
// order — a `Map`'s insertion order, the same ranking rule every other aggregate in this file uses.
function buildOpClusters(lines: readonly ParsedLine[]): readonly OpCluster[] {
  const accums = new Map<string, ClusterAccum>();
  for (const { view, correlationId } of lines) {
    const errorKind = view.errorKind ?? null;
    const key = clusterKey(view.category, view.op, errorKind);
    const accum = accums.get(key) ?? newClusterAccum(view.category, view.op, errorKind);
    accum.count += 1;
    addClusterSample(accum, correlationId);
    accums.set(key, accum);
  }
  return [...accums.values()].map((accum) => ({
    category: accum.category,
    op: accum.op,
    errorKind: accum.errorKind,
    count: accum.count,
    sampleCorrelationIds: accum.sampleCorrelationIds,
  }));
}

function buildWarnings(legacyLineCount: number): readonly string[] {
  return legacyLineCount > 0
    ? [
        `${String(legacyLineCount)} line(s) predate the v2 envelope and were ordered by file position`,
      ]
    : [];
}

// Parses `text` (the full content of a raw server.log OR a support bundle), groups every line
// that carries a correlationId into one LogTimeline per id (first-occurrence order), and counts
// every line that could not be read as a log record. A line with no correlationId at all
// (`process.*` lines, a first-ever request before any id was assigned) belongs to no timeline and
// is neither malformed nor counted — this module only reconstructs correlated request/run stories.
export function analyzeLogText(text: string): AnalyzeAllResult {
  const lines = splitLines(text);
  const kind = detectSourceKind(lines[0]);
  const contentLines = kind === "bundle" ? lines.slice(1) : lines;
  const parsedLines: ParsedLine[] = [];
  let malformedLineCount = 0;
  for (const [index, raw] of contentLines.entries()) {
    const classification = classifyLine(raw, index);
    if (classification.kind === "malformed") malformedLineCount += 1;
    if (classification.kind === "line") parsedLines.push(classification.parsed);
  }
  const groups = groupByCorrelationId(parsedLines);
  const timelines = [...groups.entries()].map(([correlationId, group]) =>
    buildTimeline(correlationId, group),
  );
  const processes = buildProcessSummaries(parsedLines);
  const legacyLineCount = parsedLines.filter((parsed) => !parsed.hasFullIdentity).length;
  const warnings = buildWarnings(legacyLineCount);
  const clusters = buildOpClusters(parsedLines);
  return { timelines, malformedLineCount, processes, legacyLineCount, warnings, clusters };
}

export function findTimeline(
  result: AnalyzeAllResult,
  correlationId: string,
): LogTimeline | undefined {
  return result.timelines.find((timeline) => timeline.correlationId === correlationId);
}

function renderEventLine(view: ServerLogLineView): string {
  const seq = view.seq !== undefined ? String(view.seq) : "-";
  const level = view.level ?? "-";
  const suffix = [
    view.errorKind === undefined ? undefined : `[${view.errorKind}]`,
    view.durationMs === undefined ? undefined : `[${String(view.durationMs)}ms]`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  const base = `${view.ts} ${seq} ${level} ${view.category} ${view.op}`;
  return suffix.length > 0 ? `${base} ${suffix}` : base;
}

export function renderHumanTimeline(timeline: LogTimeline): string {
  const header = `correlationId=${timeline.correlationId} lines=${String(timeline.lines.length)} durationMs=${String(timeline.durationMs)}\n`;
  if (timeline.lines.length === 0) return header;
  const body = timeline.lines.map((line) => `  ${renderEventLine(line)}`).join("\n");
  return `${header}${body}\n`;
}

function renderProcessSummary(process: ProcessSummary): string {
  const seqRange = `${String(process.firstSeq)}-${String(process.lastSeq)}`;
  const started = process.started === undefined ? "" : " started=yes";
  const exit = process.exitReason === undefined ? "" : ` exitReason=${process.exitReason}`;
  return (
    `  pid=${String(process.pid)} instanceId=${process.instanceId} ` +
    `lines=${String(process.lineCount)} seq=${seqRange} ts=${process.firstTs}..${process.lastTs}` +
    `${started}${exit}`
  );
}

function renderProcessSummaries(processes: readonly ProcessSummary[]): string {
  const header = `Processes: ${String(processes.length)}\n`;
  const body = processes.map((process) => renderProcessSummary(process)).join("\n");
  return `${header}${body}\n`;
}

function renderWarnings(warnings: readonly string[]): string {
  const lines = warnings.map((warning) => `warning: ${warning}`);
  return `${lines.join("\n")}\n`;
}

function renderCluster(cluster: OpCluster): string {
  const errorKind = cluster.errorKind ?? "-";
  const samples = cluster.sampleCorrelationIds.join(",");
  return (
    `  ${cluster.category} ${cluster.op} [${errorKind}] count=${String(cluster.count)}` +
    (samples.length > 0 ? ` sample=${samples}` : "")
  );
}

// Standalone, Wave 6: not called from `renderHumanAllTimelines` (a `--clusters` view is a
// deliberately DIFFERENT report from the default per-timeline one, not a section folded into it),
// exported for a future `--clusters` CLI flag to call directly.
export function renderHumanClusters(clusters: readonly OpCluster[]): string {
  const header = `Clusters: ${String(clusters.length)}\n`;
  if (clusters.length === 0) return header;
  return `${header}${clusters.map((cluster) => renderCluster(cluster)).join("\n")}\n`;
}

export function renderHumanAllTimelines(result: AnalyzeAllResult): string {
  const sections: string[] = [];
  if (result.warnings.length > 0) sections.push(renderWarnings(result.warnings));
  if (result.processes.length > 0) sections.push(renderProcessSummaries(result.processes));
  sections.push(
    result.timelines.length === 0
      ? "No correlated events found.\n"
      : result.timelines.map((timeline) => renderHumanTimeline(timeline)).join("\n"),
  );
  return sections.join("\n");
}

// ─── Wave 6: ReproductionSeed (`--seed`) ────────────────────────────────────────────────────────
//
// Everything below assembles a `ReproductionSeed` for one correlationId: a `gatewayScript`
// (scanning `gateway.chat.*`/`gateway.stream.*`/`gateway.retry.*` lines for the httpStatus/
// retryAfterMs/finishReason/usage/firstTokenMs fields ADR-0173 Wave 3 added), an `httpRequest`
// (the timeline's `http`/`request` and `http`/`sse.stream.closed` lines), a `storeFingerprint`
// (the bundle manifest's `storeFingerprints`, Wave 4a — undefined for a raw server.log, which
// carries no manifest), an `indexingJob` (the timeline's `indexing.job.started` line, Wave 4a),
// `stackFrames`/`causeChain` (straight off the timeline), and a `warnings` field naming exactly
// what could not be reconstructed and why — never silently omitted.

export interface GatewayReplayAttempt {
  readonly outcome: "success" | "provider-error" | "rate-limit" | "timeout" | "transport-error";
  readonly httpStatus?: number | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly durationMs: number;
  readonly finishReason?: string | undefined;
  readonly usage?: { readonly promptTokens: number; readonly completionTokens: number } | undefined;
  readonly toolCallCount?: number | undefined;
  readonly firstTokenMs?: number | undefined;
}

export interface GatewayReplayScript {
  readonly modelId: string;
  readonly attempts: readonly GatewayReplayAttempt[];
}

const GATEWAY_RETRY_OPS: ReadonlySet<string> = new Set([
  "gateway.retry.scheduled",
  "gateway.retry.exhausted",
  "gateway.retry.budget-exhausted",
]);
const GATEWAY_SUCCESS_OPS: ReadonlySet<string> = new Set([
  "gateway.chat.completed",
  "gateway.stream.completed",
]);
const GATEWAY_FAILURE_OPS: ReadonlySet<string> = new Set([
  "gateway.chat.failed",
  "gateway.stream.failed",
  "gateway.stream.abandoned",
]);

function isGatewayAttemptLine(view: ServerLogLineView): boolean {
  if (view.category !== "gateway") return false;
  return (
    GATEWAY_RETRY_OPS.has(view.op) ||
    GATEWAY_SUCCESS_OPS.has(view.op) ||
    GATEWAY_FAILURE_OPS.has(view.op)
  );
}

// `errorKind` is the gateway's own `GatewayError.code` (`logErrorKind`, keiko-model-gateway's
// observability.ts) — this maps the 4 codes a replay script cares about onto the narrower
// `GatewayReplayAttempt.outcome` vocabulary; anything else (circuit-open, cancelled, unknown)
// falls into the generic "provider-error" bucket rather than growing the outcome union for a
// distinction a replay fixture does not need to make.
function attemptOutcome(errorKind: string | undefined): GatewayReplayAttempt["outcome"] {
  if (errorKind === "GATEWAY_RATE_LIMIT") return "rate-limit";
  if (errorKind === "GATEWAY_TIMEOUT") return "timeout";
  if (errorKind === "GATEWAY_TRANSPORT") return "transport-error";
  return "provider-error";
}

function attemptUsage(
  extra: Readonly<Record<string, unknown>>,
): { readonly promptTokens: number; readonly completionTokens: number } | undefined {
  const promptTokens = optionalNumber(extra, "promptTokens");
  const completionTokens = optionalNumber(extra, "completionTokens");
  return promptTokens === undefined || completionTokens === undefined
    ? undefined
    : { promptTokens, completionTokens };
}

function gatewayAttemptFrom(view: ServerLogLineView): GatewayReplayAttempt {
  const extra = view.extra ?? {};
  const outcome = GATEWAY_SUCCESS_OPS.has(view.op) ? "success" : attemptOutcome(view.errorKind);
  const httpStatus = optionalNumber(extra, "httpStatus");
  const retryAfterMs = optionalNumber(extra, "retryAfterMs");
  const finishReason = optionalString(extra, "finishReason");
  const usage = attemptUsage(extra);
  const toolCallCount = optionalNumber(extra, "toolCallCount");
  const firstTokenMs = optionalNumber(extra, "firstTokenMs");
  return {
    outcome,
    durationMs: view.durationMs ?? 0,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(usage === undefined ? {} : { usage }),
    ...(toolCallCount === undefined ? {} : { toolCallCount }),
    ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
  };
}

function gatewayModelId(lines: readonly ServerLogLineView[]): string {
  for (const view of lines) {
    const modelId = optionalString(view.extra ?? {}, "modelId");
    if (modelId !== undefined) return modelId;
  }
  return "unknown-model";
}

// Undefined when the timeline carries no gateway line at all — distinct from an attempts array
// that IS populated but every attempt failed, which is a real, reportable replay script.
export function buildGatewayReplayScript(
  lines: readonly ServerLogLineView[],
): GatewayReplayScript | undefined {
  const attemptLines = lines.filter(isGatewayAttemptLine);
  if (attemptLines.length === 0) return undefined;
  return { modelId: gatewayModelId(lines), attempts: attemptLines.map(gatewayAttemptFrom) };
}

// Field names match `server.ts`'s `buildHttpRequestExtra`/`sse-write.ts`'s `emitSseStreamClosed`
// exactly (verified against the current checkout, ADR-0173 §9) — never restated as a formula, only
// read back off whatever those producers actually wrote.
export interface HttpRequestSeed {
  readonly method?: string | undefined;
  readonly routeTemplate?: string | undefined;
  readonly queryParamNames?: readonly string[] | undefined;
  readonly responseBytes?: number | undefined;
  readonly status?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly aborted?: boolean | undefined;
  readonly frameCount?: number | undefined;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function buildHttpRequestSeed(lines: readonly ServerLogLineView[]): HttpRequestSeed | undefined {
  const requestLine = lines.find((view) => view.category === "http" && view.op === "request");
  const sseLine = lines.find((view) => view.category === "http" && view.op === "sse.stream.closed");
  if (requestLine === undefined && sseLine === undefined) return undefined;
  const extra = requestLine?.extra ?? {};
  const frameCount = optionalNumber(sseLine?.extra ?? {}, "frameCount");
  return {
    method: optionalString(extra, "method"),
    routeTemplate: optionalString(extra, "routeTemplate"),
    queryParamNames: optionalStringArray(extra.queryParamNames),
    responseBytes: optionalNumber(extra, "responseBytes"),
    status: requestLine?.status,
    durationMs: requestLine?.durationMs,
    aborted: optionalBoolean(extra, "aborted"),
    frameCount,
  };
}

// Field names match `orchestrator.ts`'s `emitJobStarted`/`chunkerConfigExtra` exactly (verified
// against the current checkout, ADR-0173 §8/g16).
export interface IndexingJobSeed {
  readonly sourceCount?: number | undefined;
  readonly batchSize?: number | undefined;
  readonly concurrency?: number | undefined;
  readonly minChunkTokens?: number | undefined;
  readonly maxChunkTokens?: number | undefined;
  readonly overlapTokens?: number | undefined;
  readonly tokenizerKind?: string | undefined;
}

function buildIndexingJobSeed(lines: readonly ServerLogLineView[]): IndexingJobSeed | undefined {
  const started = lines.find(
    (view) => view.category === "indexing" && view.op === "indexing.job.started",
  );
  if (started === undefined) return undefined;
  const extra = started.extra ?? {};
  return {
    sourceCount: optionalNumber(extra, "sourceCount"),
    batchSize: optionalNumber(extra, "batchSize"),
    concurrency: optionalNumber(extra, "concurrency"),
    minChunkTokens: optionalNumber(extra, "minChunkTokens"),
    maxChunkTokens: optionalNumber(extra, "maxChunkTokens"),
    overlapTokens: optionalNumber(extra, "overlapTokens"),
    tokenizerKind: optionalString(extra, "tokenizerKind"),
  };
}

// A bundle's manifest line (index 0, `$section: "manifest"`) carries `storeFingerprints` when the
// exporter is Wave-4a-or-later. `classifyLine` treats it as bundle metadata and never parses its
// content, so this reads it directly, independent of `analyzeLogText`. Every candidate is
// re-validated with the contract's own `isStoreFingerprint` guard (never trusted merely because it
// parsed as JSON) — a raw server.log, which has no manifest line at all, always returns undefined.
function extractManifestStoreFingerprints(text: string): readonly StoreFingerprint[] | undefined {
  const [firstLine] = splitLines(text);
  if (firstLine === undefined) return undefined;
  const record = tryParseJsonObject(firstLine);
  if (record?.$section !== "manifest" || !Array.isArray(record.storeFingerprints)) {
    return undefined;
  }
  const valid = record.storeFingerprints.filter(isStoreFingerprint);
  return valid.length > 0 ? valid : undefined;
}

const MAX_SEED_CAUSE_CHAIN = 16;

function aggregateCauseChain(lines: readonly ServerLogLineView[]): readonly string[] {
  const all: string[] = [];
  for (const view of lines) {
    if (view.causeChain === undefined) continue;
    all.push(...view.causeChain);
  }
  return distinctInOrder(all).slice(0, MAX_SEED_CAUSE_CHAIN);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface ReproductionSeed {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly sourceArtifact: {
    readonly kind: SourceKind;
    readonly lineCount: number;
    readonly sha256: string;
  };
  readonly correlationId: string;
  readonly timeline: readonly ServerLogLineView[];
  readonly gatewayScript?: GatewayReplayScript | undefined;
  readonly httpRequest?: HttpRequestSeed | undefined;
  readonly storeFingerprint?: readonly StoreFingerprint[] | undefined;
  readonly indexingJob?: IndexingJobSeed | undefined;
  readonly stackFrames?: readonly string[] | undefined;
  readonly causeChain?: readonly string[] | undefined;
  // What could NOT be reconstructed from this artifact, and why — GRAFTED FROM DESIGN C
  // (ADR-0173 §10). Never empty in practice: every seed at minimum names the standing
  // by-design gap that no prompt/response body is ever logged.
  readonly warnings: readonly string[];
}

const REPRODUCTION_SEED_SCHEMA_VERSION = 1;

const NO_BODY_WARNING =
  "no prompt/response body was ever logged by design — content-shape only " +
  "(counts, ids, and closed-vocabulary labels, never message/completion text)";

function framesWarning(frames: readonly string[]): string | undefined {
  return frames.length === 0
    ? "no frames recorded for this correlationId — either no error occurred on this call, or " +
        "this artifact predates Wave 2's frame capture"
    : undefined;
}

function gatewayScriptWarning(script: GatewayReplayScript | undefined): string | undefined {
  return script === undefined
    ? "no gateway.chat.*/gateway.stream.*/gateway.retry.* lines found for this correlationId — " +
        "either no gateway call occurred, or this artifact predates Wave 3's provider detail"
    : undefined;
}

function httpRequestWarning(seed: HttpRequestSeed | undefined): string | undefined {
  return seed === undefined
    ? "no http.request line found for this correlationId — this artifact may cover only an " +
        "internal/background operation with no HTTP request boundary"
    : undefined;
}

function storeFingerprintWarning(
  kind: SourceKind,
  fingerprints: readonly StoreFingerprint[] | undefined,
): string | undefined {
  if (fingerprints !== undefined) return undefined;
  return kind === "raw-log"
    ? "a raw server.log carries no store fingerprints — export a support bundle " +
        "(`keiko support export`) to include them"
    : "no store fingerprints found in this bundle's manifest — either the exporter predates " +
        "Wave 4a, or every store was unavailable at export time";
}

interface SeedWarningInputs {
  readonly kind: SourceKind;
  readonly frames: readonly string[];
  readonly gatewayScript: GatewayReplayScript | undefined;
  readonly httpRequest: HttpRequestSeed | undefined;
  readonly storeFingerprint: readonly StoreFingerprint[] | undefined;
}

function buildSeedWarnings(input: SeedWarningInputs): readonly string[] {
  return [
    NO_BODY_WARNING,
    framesWarning(input.frames),
    gatewayScriptWarning(input.gatewayScript),
    httpRequestWarning(input.httpRequest),
    storeFingerprintWarning(input.kind, input.storeFingerprint),
  ].filter((warning): warning is string => warning !== undefined);
}

// Assembles a full `ReproductionSeed` for one correlationId out of `text` (a raw server.log or a
// support bundle — auto-detected, same as `analyzeLogText`). Undefined when no timeline exists for
// `correlationId`, mirroring `findTimeline`. `generatedAt` is caller-supplied (never `new Date()`
// read here) so this stays pure and deterministic, like every other export in this file.
export function buildReproductionSeed(
  text: string,
  correlationId: string,
  generatedAt: Date,
): ReproductionSeed | undefined {
  const timeline = findTimeline(analyzeLogText(text), correlationId);
  if (timeline === undefined) return undefined;

  const kind = detectSourceKind(splitLines(text)[0]);
  const gatewayScript = buildGatewayReplayScript(timeline.lines);
  const httpRequest = buildHttpRequestSeed(timeline.lines);
  const indexingJob = buildIndexingJobSeed(timeline.lines);
  const storeFingerprint = extractManifestStoreFingerprints(text);
  const stackFrames = timeline.frames ?? [];
  const causeChain = aggregateCauseChain(timeline.lines);

  return {
    schemaVersion: REPRODUCTION_SEED_SCHEMA_VERSION,
    generatedAt: generatedAt.toISOString(),
    sourceArtifact: { kind, lineCount: splitLines(text).length, sha256: sha256Hex(text) },
    correlationId,
    timeline: timeline.lines,
    ...(gatewayScript === undefined ? {} : { gatewayScript }),
    ...(httpRequest === undefined ? {} : { httpRequest }),
    ...(storeFingerprint === undefined ? {} : { storeFingerprint }),
    ...(indexingJob === undefined ? {} : { indexingJob }),
    ...(stackFrames.length === 0 ? {} : { stackFrames }),
    ...(causeChain.length === 0 ? {} : { causeChain }),
    warnings: buildSeedWarnings({
      kind,
      frames: stackFrames,
      gatewayScript,
      httpRequest,
      storeFingerprint,
    }),
  };
}

// ─── Wave 6: `--emit-fixture` ───────────────────────────────────────────────────────────────────
//
// Renders `script` as a ready-to-paste TypeScript module: a `GatewayReplayScriptEntry[]` literal
// for `createScriptedGatewayFetch` (`@oscharko-dev/keiko-model-gateway`'s replay.ts). Built via
// `JSON.stringify` on a plain-data shape rather than hand-assembled template strings, so the
// output's syntax is guaranteed valid (a JSON object/array literal is always a valid TS/JS object
// literal) — there is no manual quoting/escaping step that could produce broken source.

const FAILURE_STATUS_FALLBACK: Readonly<Record<GatewayReplayAttempt["outcome"], number>> = {
  success: 200,
  "rate-limit": 429,
  timeout: 504,
  "provider-error": 500,
  "transport-error": 0,
};

type FixtureEntry =
  | {
      readonly status: number;
      readonly headers?: Record<string, string>;
      readonly bodyJson: unknown;
      readonly latencyMs: number;
    }
  | { readonly networkError: true };

function successFixtureBody(attempt: GatewayReplayAttempt): unknown {
  return {
    choices: [
      {
        finish_reason: attempt.finishReason ?? "stop",
        message: { role: "assistant", content: "" },
      },
    ],
    ...(attempt.usage === undefined
      ? {}
      : {
          usage: {
            prompt_tokens: attempt.usage.promptTokens,
            completion_tokens: attempt.usage.completionTokens,
          },
        }),
  };
}

function failureFixtureEntry(attempt: GatewayReplayAttempt): FixtureEntry {
  if (attempt.outcome === "transport-error") return { networkError: true };
  const status = attempt.httpStatus ?? FAILURE_STATUS_FALLBACK[attempt.outcome];
  const headers =
    attempt.retryAfterMs === undefined
      ? undefined
      : { "retry-after": String(Math.ceil(attempt.retryAfterMs / 1000)) };
  return {
    status,
    ...(headers === undefined ? {} : { headers }),
    bodyJson: { error: { message: "reconstructed from ReproductionSeed", type: attempt.outcome } },
    latencyMs: attempt.durationMs,
  };
}

function fixtureEntryFor(attempt: GatewayReplayAttempt): FixtureEntry {
  return attempt.outcome === "success"
    ? { status: 200, bodyJson: successFixtureBody(attempt), latencyMs: attempt.durationMs }
    : failureFixtureEntry(attempt);
}

// Returns undefined (never an empty-array fixture) when `script` has no attempts — there is
// nothing meaningful to paste.
export function renderGatewayReplayScriptFixture(script: GatewayReplayScript): string | undefined {
  if (script.attempts.length === 0) return undefined;
  const entries = script.attempts.map(fixtureEntryFor);
  return (
    "// Generated by `keiko support analyze --emit-fixture` from a ReproductionSeed's gatewayScript.\n" +
    "// Ready to paste into a *.test.ts for createScriptedGatewayFetch (@oscharko-dev/keiko-model-gateway).\n" +
    'import type { GatewayReplayScriptEntry } from "@oscharko-dev/keiko-model-gateway";\n\n' +
    `export const gatewayReplayScript: GatewayReplayScriptEntry[] = ${JSON.stringify(entries, null, 2)};\n`
  );
}

// Human rendering for `keiko support analyze --seed` (without --json). Each structured sub-field
// is printed as its own compact JSON line rather than a hand-formatted table — a seed's whole
// point is to be read back by an agent, so the human view stays a thin, honest read of the exact
// same data `--json` emits, never a second formula computing something new from it (AGENTS.md §7).
export function renderHumanReproductionSeed(seed: ReproductionSeed): string {
  const lines = [
    `correlationId=${seed.correlationId} schemaVersion=${String(seed.schemaVersion)}`,
    `source: kind=${seed.sourceArtifact.kind} lines=${String(seed.sourceArtifact.lineCount)} ` +
      `sha256=${seed.sourceArtifact.sha256}`,
  ];
  if (seed.gatewayScript !== undefined) {
    lines.push(`gatewayScript: ${JSON.stringify(seed.gatewayScript)}`);
  }
  if (seed.httpRequest !== undefined) {
    lines.push(`httpRequest: ${JSON.stringify(seed.httpRequest)}`);
  }
  if (seed.indexingJob !== undefined) {
    lines.push(`indexingJob: ${JSON.stringify(seed.indexingJob)}`);
  }
  if (seed.storeFingerprint !== undefined) {
    lines.push(`storeFingerprint: ${JSON.stringify(seed.storeFingerprint)}`);
  }
  if (seed.stackFrames !== undefined && seed.stackFrames.length > 0) {
    const frameLines = seed.stackFrames.map((frame) => `  ${frame}`).join("\n");
    lines.push(`stackFrames:\n${frameLines}`);
  }
  if (seed.causeChain !== undefined && seed.causeChain.length > 0) {
    lines.push(`causeChain: ${seed.causeChain.join(" -> ")}`);
  }
  const warningLines = seed.warnings.map((warning) => `  - ${warning}`).join("\n");
  lines.push(`warnings:\n${warningLines}`);
  return `${lines.join("\n")}\n`;
}
