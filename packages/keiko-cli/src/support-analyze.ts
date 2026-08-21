// `keiko support analyze` — pure logic: parsing, grouping, and ordering `server*.log` lines
// (whether raw, or copied verbatim into a `keiko support export` bundle) by `correlationId`. This is the MINIMAL Wave 1 `LogTimeline`: `lines`, `firstTs`,
// `lastTs`, `durationMs`, `errorKinds`. `frames`/`clusters`/`warnings`/`gatewayScript` are Wave 6
// fields — they read data (aggregated stack frames, gateway retry/replay detail, cross-timeline
// clustering) that no producer emits yet, so they are omitted here entirely rather than stubbed
// with placeholder values the analyzer would then have to lie about.
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
// `support.ts` owns argv parsing, file reads, and stdout/stderr; this file owns everything that
// can be exercised on an in-memory string.

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
  readonly frames?: readonly string[] | undefined;
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

export interface LogTimeline {
  readonly correlationId: string;
  readonly lines: readonly ServerLogLineView[];
  readonly firstTs: string;
  readonly lastTs: string;
  readonly durationMs: number;
  readonly errorKinds: readonly string[];
}

export interface AnalyzeAllResult {
  readonly timelines: readonly LogTimeline[];
  readonly malformedLineCount: number;
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
  const extra: Record<string, unknown> = {};
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
  const frames = optionalStringArray(record.frames);
  const extra = extraFields(record);
  return {
    ts,
    category,
    op,
    ...(identity.pid === undefined ? {} : { pid: identity.pid }),
    ...(identity.instanceId === undefined ? {} : { instanceId: identity.instanceId }),
    ...(identity.seq === undefined ? {} : { seq: identity.seq }),
    ...(level === undefined ? {} : { level }),
    ...(errorKind === undefined ? {} : { errorKind }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(frames === undefined ? {} : { frames }),
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
  return { correlationId, lines: views, firstTs: first, lastTs: last, durationMs, errorKinds };
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
  return { timelines, malformedLineCount };
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

export function renderHumanAllTimelines(result: AnalyzeAllResult): string {
  if (result.timelines.length === 0) return "No correlated events found.\n";
  return result.timelines.map((timeline) => renderHumanTimeline(timeline)).join("\n");
}
