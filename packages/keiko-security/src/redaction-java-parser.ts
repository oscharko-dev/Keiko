// Parses Java in a resource-bounded worker thread behind a synchronous call.
//
// java-parser predicts with ALL(*) lookahead (chevrotain-allstar). On some invalid expressions its
// configuration sets grow superlinearly: 400 characters of "x x=y&x=y&…" took 21 s and 1,600
// exhausted a 4 GB heap, while 37 KB of ordinary Java parses in about 30 ms. The time is spent
// inside the library's prediction, not in reading tokens, and its DFA caches persist from one
// parse to the next, so neither a token budget nor a fresh parser object can bound it in process.
//
// Each parse therefore runs in a worker with a heap ceiling and a deadline that grows with the
// text. The caller blocks on a shared signal, as it blocked on the parse itself before, but for no
// longer than the deadline. A worker that misses it, runs out of memory, answers what this thread
// cannot read back, or grows past the heap it may keep is discarded, and the next parse starts a
// fresh one with empty caches. Only closed outcomes leave the worker: the tree's node names, token
// types, offsets and images, never a library diagnostic, which would carry source text. Every
// start, every routine replacement and every discarded worker is recorded on the Activity Log as
// counts and closed reasons, under one correlation per worker lifetime.

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  MessageChannel,
  receiveMessageOnPort,
  Worker,
  type MessagePort,
} from "node:worker_threads";

import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import { emitSecurityLogEvent, type SecurityLogSink } from "./log-port.js";

export interface JavaCstToken {
  readonly image: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly tokenType: { readonly name: string };
}

export interface JavaCstNode {
  readonly name: string;
  readonly children: Readonly<Record<string, readonly (JavaCstNode | JavaCstToken)[]>>;
}

export interface JavaCstTree extends JavaCstNode {
  readonly comments: readonly JavaCstToken[];
}

export type JavaParseOutcome =
  | { readonly kind: "parsed"; readonly tree: JavaCstTree }
  // The text is not Java the grammar accepts.
  | { readonly kind: "syntax" }
  // The parse ran out of stack, time or memory before it could answer.
  | { readonly kind: "depth" }
  | { readonly kind: "budget" };

// Parsing, projecting and passing the tree back take about 3.3 ms per KiB of ordinary Java (a
// 346 KiB file took 1.1 s); the deadline allows a loaded machine nearly twice that.
const DEADLINE_BASE_MS = 750;
const DEADLINE_MS_PER_KIB = 6;
// Loading the grammar runs its self-analysis once per worker.
const STARTUP_DEADLINE_MS = 15_000;
// A worker that could not start is not tried again before this, so a broken environment costs one
// startup deadline a minute instead of one per parse.
const START_RETRY_COOLDOWN_MS = 60_000;
const HEAP_CEILING_MB = 512;
// The stack the parse ran with in process. A deeper one would build trees this thread cannot read.
const STACK_SIZE_MB = 1;
// A worker whose caches have grown past this is replaced after its answer.
const HEAP_RECYCLE_BYTES = 192 * 1024 * 1024;
// A text refused on time is refused again at once for this long, so one hostile message that two
// callers parse in a row costs one deadline, not two. Afterwards it gets a fresh worker: the
// refusal described the machine's load at that moment as much as the text.
const REFUSAL_REUSE_MS = 5_000;

const RETIREMENT_REASONS = [
  "deadline",
  "exited",
  "transfer",
  "desync",
  "start-failed",
  "start-deadline",
] as const;
type RetirementReason = (typeof RETIREMENT_REASONS)[number];

const JAVA_PARSER_WORKER_STARTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "security.java-parser.worker-started",
  category: "security",
  owner: "keiko-security",
  emitter: "redaction-java-parser.emitWorkerStarted",
  fields: {
    workerOrdinal: { type: "integer", dataClass: "count", required: true },
    startupMs: { type: "integer", dataClass: "duration", required: true },
  },
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["security-java-parse-bound"],
  proofIds: ["security.java-parser.worker-started.line"],
  releaseImpact: "patch",
});

const JAVA_PARSER_WORKER_RECYCLED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "security.java-parser.worker-recycled",
  category: "security",
  owner: "keiko-security",
  emitter: "redaction-java-parser.emitWorkerRecycled",
  fields: {
    workerOrdinal: { type: "integer", dataClass: "count", required: true },
    parseCount: { type: "integer", dataClass: "count", required: true },
    workerAgeMs: { type: "integer", dataClass: "duration", required: true },
    heapMiB: { type: "integer", dataClass: "count", required: true },
  },
  causal: "none",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["security-java-parse-bound"],
  proofIds: ["security.java-parser.worker-recycled.line"],
  releaseImpact: "patch",
});

const JAVA_PARSER_WORKER_RETIRED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "security.java-parser.worker-retired",
  category: "security",
  owner: "keiko-security",
  emitter: "redaction-java-parser.emitWorkerRetired",
  fields: {
    workerOrdinal: { type: "integer", dataClass: "count", required: true },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...RETIREMENT_REASONS],
    },
    parseCount: { type: "integer", dataClass: "count", required: true },
    workerAgeMs: { type: "integer", dataClass: "duration", required: true },
  },
  causal: "none",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["security-java-parse-bound"],
  proofIds: ["security.java-parser.worker-retired.line"],
  releaseImpact: "patch",
});

// Plain JavaScript: the worker evaluates this source, so it needs no file beside the module and
// works the same from the TypeScript sources and from the built package. It reads Node's modules
// through process.getBuiltinModule, so it runs as a script or as a module alike, and a failure to
// load the grammar answers at once instead of leaving the caller to its startup deadline. A tree
// too deep or too large to pass back answers as a depth refusal instead of leaving the caller to
// its deadline.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = process.getBuiltinModule("node:worker_threads");
const port = workerData.port;
const signal = new Int32Array(workerData.signal);
function answer(message) {
  const heapBytes = process.memoryUsage().heapUsed;
  try {
    port.postMessage({ ...message, heapBytes });
  } catch {
    port.postMessage({ id: message.id, kind: "depth", heapBytes });
  }
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
}
function token(t) {
  return { image: t.image, startOffset: t.startOffset, endOffset: t.endOffset, tokenType: { name: t.tokenType.name } };
}
function node(n) {
  const children = {};
  for (const [key, items] of Object.entries(n.children)) {
    children[key] = items.map((child) => ("children" in child ? node(child) : token(child)));
  }
  return { name: n.name, children };
}
function project(parse, text) {
  try {
    const cst = parse(text);
    return { kind: "parsed", tree: { ...node(cst), comments: (cst.comments ?? []).map(token) } };
  } catch (error) {
    return { kind: error instanceof RangeError ? "depth" : "syntax" };
  }
}
let parse;
try {
  const { createRequire } = process.getBuiltinModule("node:module");
  parse = createRequire(workerData.parserPath)(workerData.parserPath).parse;
} catch {
  answer({ id: 0, kind: "failed" });
}
if (parse !== undefined) {
  parentPort.on("message", ({ id, text }) => answer({ id, ...project(parse, text) }));
  answer({ id: 0, kind: "ready" });
}
`;

interface ParserWorker {
  readonly worker: Worker;
  readonly port: MessagePort;
  readonly signal: Int32Array;
  readonly ordinal: number;
  readonly startedAt: number;
  // Joins the start, the replacement or retirement of one worker lifetime on the Activity Log.
  readonly correlationId: string;
  parses: number;
  // Cleared by the worker's error and exit events, which arrive between calls.
  alive: boolean;
  retired: boolean;
}

const ANSWER_KINDS = new Set(["ready", "failed", "parsed", "syntax", "depth", "budget"]);

interface WorkerAnswer {
  readonly id: number;
  readonly kind: "ready" | "failed" | JavaParseOutcome["kind"];
  readonly tree?: JavaCstTree;
  readonly heapBytes?: number;
}

type Failure = "deadline" | "exited" | "transfer" | "desync";
type Received = { readonly answer: WorkerAnswer } | { readonly failure: Failure };

interface WorkerRecord {
  readonly ordinal: number;
  readonly parses: number;
  readonly startedAt: number;
  readonly correlationId: string;
}

const BUDGET: JavaParseOutcome = { kind: "budget" };
const DEPTH: JavaParseOutcome = { kind: "depth" };

const requireParser = createRequire(import.meta.url);
let current: ParserWorker | undefined;
let workerCount = 0;
let nextJobId = 1;
let startRefusedUntil = 0;
let logSink: SecurityLogSink | undefined;
let parserPathOverride: string | undefined;
let heapRecycleBytes = HEAP_RECYCLE_BYTES;

/** The Activity Log port for worker starts and retirements; the server installs it once. */
export function installJavaParserLogSink(sink: SecurityLogSink | undefined): void {
  logSink = sink;
}

function elapsedMs(since: number): number {
  return Math.max(0, Math.round(performance.now() - since));
}

function emitWorkerStarted(parser: ParserWorker): void {
  emitSecurityLogEvent(
    logSink,
    activityLogEvent(
      JAVA_PARSER_WORKER_STARTED_OPERATION,
      { correlationId: parser.correlationId },
      { workerOrdinal: parser.ordinal, startupMs: elapsedMs(parser.startedAt) },
    ),
  );
}

function emitWorkerRecycled(parser: ParserWorker, heapBytes: number): void {
  emitSecurityLogEvent(
    logSink,
    activityLogEvent(
      JAVA_PARSER_WORKER_RECYCLED_OPERATION,
      { correlationId: parser.correlationId },
      {
        workerOrdinal: parser.ordinal,
        parseCount: parser.parses,
        workerAgeMs: elapsedMs(parser.startedAt),
        heapMiB: Math.round(heapBytes / (1024 * 1024)),
      },
    ),
  );
}

function emitWorkerRetired(record: WorkerRecord, reason: RetirementReason): void {
  emitSecurityLogEvent(
    logSink,
    activityLogEvent(
      JAVA_PARSER_WORKER_RETIRED_OPERATION,
      { level: "warn", correlationId: record.correlationId },
      {
        workerOrdinal: record.ordinal,
        reason,
        parseCount: record.parses,
        workerAgeMs: elapsedMs(record.startedAt),
      },
    ),
  );
}

function startWorker(record: WorkerRecord): ParserWorker {
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      parserPath: parserPathOverride ?? requireParser.resolve("java-parser"),
      port: port2,
      signal: signal.buffer,
    },
    transferList: [port2],
    // Inherited flags such as --input-type=module would change how the source is evaluated.
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: HEAP_CEILING_MB, stackSizeMb: STACK_SIZE_MB },
  });
  const started: ParserWorker = {
    worker,
    port: port1,
    signal,
    ordinal: record.ordinal,
    startedAt: record.startedAt,
    correlationId: record.correlationId,
    parses: 0,
    alive: true,
    retired: false,
  };
  // An out-of-memory exit or a startup failure arrives as an event; it only marks the worker.
  worker.on("error", () => {
    started.alive = false;
  });
  worker.on("exit", () => {
    started.alive = false;
  });
  worker.unref();
  port1.unref();
  return started;
}

function discard(parser: ParserWorker): boolean {
  if (parser.retired) return false;
  parser.retired = true;
  parser.alive = false;
  if (current === parser) current = undefined;
  void parser.worker.terminate();
  parser.port.close();
  return true;
}

function recordRetirement(parser: ParserWorker, reason: RetirementReason): void {
  if (discard(parser)) emitWorkerRetired(parser, reason);
}

// Routine: a worker that answered but holds more heap than it may keep is replaced, not failed.
function recycle(parser: ParserWorker, heapBytes: number): void {
  if (discard(parser)) emitWorkerRecycled(parser, heapBytes);
}

// Between calls Node can report a worker that is no longer running as thread -1 before its exit
// event reaches this thread. During the synchronous wait neither changes, because both arrive on
// this thread's event loop: a worker that dies mid-parse is found at its deadline and retired as
// one, and an exit between calls is found before the next parse.
function isRunning(parser: ParserWorker): boolean {
  return parser.alive && parser.worker.threadId !== -1;
}

function answerOf(message: unknown): WorkerAnswer | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const { id, kind } = message as { readonly id?: unknown; readonly kind?: unknown };
  if (typeof id !== "number" || typeof kind !== "string" || !ANSWER_KINDS.has(kind)) {
    return undefined;
  }
  // A parse without its tree is a broken exchange, not a refusal of the text.
  const { tree } = message as { readonly tree?: unknown };
  if (kind === "parsed" && (typeof tree !== "object" || tree === null)) return undefined;
  return message as WorkerAnswer;
}

function awaitAnswer(parser: ParserWorker, id: number, deadlineMs: number): Received {
  try {
    if (Atomics.wait(parser.signal, 0, 0, deadlineMs) === "timed-out") {
      return { failure: isRunning(parser) ? "deadline" : "exited" };
    }
    const answer = answerOf(receiveMessageOnPort(parser.port)?.message);
    // Any other answer means the exchange lost step with the worker; it is not trusted further,
    // and nothing about the text follows from it.
    return answer?.id === id ? { answer } : { failure: "desync" };
  } catch {
    // A tree the worker could pass but this thread cannot read back. The worker is not trusted
    // further; its retirement is recorded here, and settle() finds it already retired.
    recordRetirement(parser, "transfer");
    return { failure: "transfer" };
  } finally {
    Atomics.store(parser.signal, 0, 0);
  }
}

function startReason(received: Received): RetirementReason {
  return "failure" in received && received.failure === "deadline"
    ? "start-deadline"
    : "start-failed";
}

function startedWorker(): ParserWorker | undefined {
  workerCount += 1;
  const record: WorkerRecord = {
    ordinal: workerCount,
    parses: 0,
    startedAt: performance.now(),
    correlationId: randomUUID(),
  };
  let parser: ParserWorker;
  try {
    parser = startWorker(record);
  } catch {
    // No worker, no parser module or no shared memory: every parse is refused, as on a deadline.
    emitWorkerRetired(record, "start-failed");
    return undefined;
  }
  const received = awaitAnswer(parser, 0, STARTUP_DEADLINE_MS);
  if ("answer" in received && received.answer.kind === "ready") {
    emitWorkerStarted(parser);
    return parser;
  }
  recordRetirement(parser, startReason(received));
  return undefined;
}

function readyWorker(): ParserWorker | undefined {
  if (current !== undefined && isRunning(current)) return current;
  if (current !== undefined) recordRetirement(current, "exited");
  if (performance.now() < startRefusedUntil) return undefined;
  const parser = startedWorker();
  if (parser === undefined) startRefusedUntil = performance.now() + START_RETRY_COOLDOWN_MS;
  current = parser;
  return parser;
}

export function javaParseDeadlineMs(text: string): number {
  return DEADLINE_BASE_MS + Math.ceil(text.length / 1024) * DEADLINE_MS_PER_KIB;
}

function outcomeOf(answer: WorkerAnswer): JavaParseOutcome {
  if (answer.kind === "parsed" && answer.tree !== undefined)
    return { kind: "parsed", tree: answer.tree };
  if (answer.kind === "syntax" || answer.kind === "depth") return { kind: answer.kind };
  return BUDGET;
}

function settle(parser: ParserWorker, received: Received): JavaParseOutcome {
  if ("failure" in received) {
    recordRetirement(parser, received.failure);
    // A tree too large to read back is a property of the text, like a stack overflow.
    return received.failure === "transfer" ? DEPTH : BUDGET;
  }
  const heapBytes = received.answer.heapBytes ?? 0;
  if (!isRunning(parser)) recordRetirement(parser, "exited");
  else if (heapBytes > heapRecycleBytes) recycle(parser, heapBytes);
  return outcomeOf(received.answer);
}

// The same text is usually asked twice in a row: once to infer its language, once to project it.
// Callers only read the tree. A refusal on time is kept only briefly (REFUSAL_REUSE_MS).
let lastText: string | undefined;
let lastOutcome: JavaParseOutcome | undefined;
let lastRefusedAt = 0;

function remembered(text: string): JavaParseOutcome | undefined {
  if (text !== lastText || lastOutcome === undefined) return undefined;
  if (lastOutcome.kind !== "budget") return lastOutcome;
  const age = performance.now() - lastRefusedAt;
  return age >= 0 && age < REFUSAL_REUSE_MS ? lastOutcome : undefined;
}

function remember(text: string, outcome: JavaParseOutcome): void {
  lastText = text;
  lastOutcome = outcome;
  if (outcome.kind === "budget") lastRefusedAt = performance.now();
}

export function parseJavaBounded(text: string): JavaParseOutcome {
  const known = remembered(text);
  if (known !== undefined) return known;
  const parser = readyWorker();
  if (parser === undefined) return BUDGET;
  const id = nextJobId;
  nextJobId += 1;
  parser.worker.postMessage({ id, text });
  const received = awaitAnswer(parser, id, javaParseDeadlineMs(text));
  parser.parses += 1;
  const outcome = settle(parser, received);
  // A lost exchange says nothing about the text, so the next call parses it afresh.
  if (!("failure" in received && received.failure === "desync")) remember(text, outcome);
  return outcome;
}

/**
 * Discards the worker, its last outcome and any start cooldown. For tests: `parserPath` replaces
 * the parser module the next worker loads, so a start failure or a lost exchange can be exercised,
 * and `heapRecycleBytes` replaces the heap a worker may keep, so a replacement can be.
 */
export function resetJavaParserWorker(
  options: { readonly parserPath?: string; readonly heapRecycleBytes?: number } = {},
): void {
  // Discarded on request, not retired: nothing went wrong that the log should report.
  if (current !== undefined) discard(current);
  current = undefined;
  startRefusedUntil = 0;
  lastText = undefined;
  lastOutcome = undefined;
  lastRefusedAt = 0;
  parserPathOverride = options.parserPath;
  heapRecycleBytes = options.heapRecycleBytes ?? HEAP_RECYCLE_BYTES;
}
