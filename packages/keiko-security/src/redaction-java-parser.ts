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
// longer than the deadline. A worker that misses it, runs out of memory or grows past the heap it
// may keep is discarded, and the next parse starts a fresh one with empty caches. Only closed
// outcomes leave the worker: the tree's node names, token types, offsets and images, never a
// library diagnostic, which would carry source text.

import { createRequire } from "node:module";
import {
  MessageChannel,
  receiveMessageOnPort,
  Worker,
  type MessagePort,
} from "node:worker_threads";

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

// Ordinary Java parses at more than 1 MB/s; the deadline leaves a loaded machine several times
// that, and the largest file source projection accepts (2 MiB) still has about 5 s.
const DEADLINE_BASE_MS = 750;
const DEADLINE_MS_PER_KIB = 2;
// Loading the grammar runs its self-analysis once per worker.
const STARTUP_DEADLINE_MS = 15_000;
const HEAP_CEILING_MB = 512;
// A worker whose caches have grown past this is replaced after its answer.
const HEAP_RECYCLE_BYTES = 192 * 1024 * 1024;

// Plain JavaScript: the worker evaluates this source, so it needs no file beside the module and
// works the same from the TypeScript sources and from the built package. It reads Node's modules
// through process.getBuiltinModule, so it runs as a script or as a module alike, and a failure to
// load the grammar answers at once instead of leaving the caller to its startup deadline.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = process.getBuiltinModule("node:worker_threads");
const port = workerData.port;
const signal = new Int32Array(workerData.signal);
function answer(message) {
  port.postMessage({ ...message, heapBytes: process.memoryUsage().heapUsed });
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
  answer({ kind: "failed" });
}
if (parse !== undefined) {
  parentPort.on("message", (text) => answer(project(parse, text)));
  answer({ kind: "ready" });
}
`;

interface ParserWorker {
  readonly worker: Worker;
  readonly port: MessagePort;
  readonly signal: Int32Array;
  alive: boolean;
}

interface WorkerAnswer {
  readonly kind: "ready" | "failed" | JavaParseOutcome["kind"];
  readonly tree?: JavaCstTree;
  readonly heapBytes?: number;
}

const requireParser = createRequire(import.meta.url);
let current: ParserWorker | undefined;

function startWorker(): ParserWorker {
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      parserPath: requireParser.resolve("java-parser"),
      port: port2,
      signal: signal.buffer,
    },
    transferList: [port2],
    // Inherited flags such as --input-type=module would change how the source is evaluated.
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: HEAP_CEILING_MB },
  });
  const started: ParserWorker = { worker, port: port1, signal, alive: true };
  // An out-of-memory exit or a startup failure arrives as an event; it only retires the worker.
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

function retire(parser: ParserWorker): void {
  parser.alive = false;
  if (current === parser) current = undefined;
  void parser.worker.terminate();
  parser.port.close();
}

function awaitAnswer(parser: ParserWorker, deadlineMs: number): WorkerAnswer | undefined {
  const waited = Atomics.wait(parser.signal, 0, 0, deadlineMs);
  const received = receiveMessageOnPort(parser.port);
  Atomics.store(parser.signal, 0, 0);
  if (waited === "timed-out" || received === undefined) return undefined;
  return received.message as WorkerAnswer;
}

function readyWorker(): ParserWorker | undefined {
  if (current?.alive === true) return current;
  const parser = startWorker();
  if (awaitAnswer(parser, STARTUP_DEADLINE_MS)?.kind !== "ready") {
    retire(parser);
    return undefined;
  }
  current = parser;
  return parser;
}

export function javaParseDeadlineMs(text: string): number {
  return DEADLINE_BASE_MS + Math.ceil(text.length / 1024) * DEADLINE_MS_PER_KIB;
}

function outcomeOf(answer: WorkerAnswer | undefined): JavaParseOutcome {
  if (answer?.kind === "parsed" && answer.tree !== undefined)
    return { kind: "parsed", tree: answer.tree };
  if (answer?.kind === "syntax" || answer?.kind === "depth") return { kind: answer.kind };
  return { kind: "budget" };
}

// The same text is usually asked twice in a row: once to infer its language, once to project it.
let lastText: string | undefined;
let lastOutcome: JavaParseOutcome | undefined;

export function parseJavaBounded(text: string): JavaParseOutcome {
  if (text === lastText && lastOutcome !== undefined) return lastOutcome;
  const parser = readyWorker();
  if (parser === undefined) return { kind: "budget" };
  parser.worker.postMessage(text);
  const answer = awaitAnswer(parser, javaParseDeadlineMs(text));
  const outcome = outcomeOf(answer);
  if (answer === undefined || !parser.alive || (answer.heapBytes ?? 0) > HEAP_RECYCLE_BYTES) {
    retire(parser);
  }
  lastText = text;
  lastOutcome = outcome;
  return outcome;
}
