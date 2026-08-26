// Process-level catch-alls for the CLI/BFF process. Request-scoped errors are already redacted
// and correlation-keyed inside keiko-server, but an async error OUTSIDE any request (timer,
// fire-and-forget promise, spawn bookkeeping) previously crashed the process with a raw
// `${error.name}: ${error.message}` line — the message is foreign free text (it can carry
// anything a thrown value's constructor put there, including request/secret content), and every
// other instrumentation site in this repository already refuses to surface one. These guards keep
// the fail-fast exit (state correctness over limping on) while emitting one clean, body-free
// stderr line — the error's CONTENT-FREE CLASS only, never a message, never a stack — and, when a
// state directory is in scope, ALSO a structured `process.fatal` activity-log line carrying the
// same dist/src-anchored stack frames and content-free `.cause` chain every other diagnostic
// record on this log already carries (ADR-0173 D3/D11).
//
// WHY THE CLASSIFIER LOADS DYNAMICALLY, INSIDE THE HANDLER, NEVER AT MODULE SCOPE
//
// `installProcessGuards()` runs unconditionally on EVERY `keiko` invocation, including a one-shot
// `--version` (GEN-PERF-CLI-001: the eager keiko-server module graph cost ~410ms of ESM loading on
// every command before that budget was fixed). The classifier this file needs
// (`contentFreeErrorClass`, folded into `describeError`) lives in keiko-server, so it is loaded
// with a dynamic `import()` reached ONLY from inside the uncaughtException/unhandledRejection
// handler itself — a path taken at most once, on an actual crash, where the startup budget no
// longer applies. Module scope stays `import type` only (zero runtime cost; see `ServerModule`
// below), exactly the pattern `lazy-modules.ts` and every other CLI command module already uses
// for their own heavy graphs.
//
// WHY THE IMPORT IS BOUNDED BY A TIMEOUT
//
// A crash handler that can be kept alive by a hung dynamic import (a broken install, an
// unresolvable module graph) would trade one failure mode for a worse one: the process never
// exits at all. `FATAL_IMPORT_TIMEOUT_MS` races the import; whichever settles first — the real
// classification or the bounded fallback — is the one and only path that writes stderr and exits.
// The fallback never reads `.message` either: see `fallbackErrorKind`.

import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-server";

// The narrow slice of keiko-server's public surface the fatal path needs, loaded only inside the
// handler (see the file banner). `describeError` is reused rather than re-derived from its parts:
// it already computes the content-free error CLASS, the code-first machine token, the
// dist/src-anchored stack frames, and the content-free `.cause`-chain classes — the SAME
// computation `diagnostics-log.ts`'s own sink uses — so this file never maintains a second,
// possibly-drifting copy of that logic (`errorKindOf`'s code-first rule is reproduced by reading
// `described.code` first, since `errorKindOf` itself is not part of keiko-server's public surface).
type ServerModule = typeof import("@oscharko-dev/keiko-server");
export type FatalDiagnosticsModule = Pick<
  ServerModule,
  "createFileServerLogSink" | "describeError"
>;

export interface ProcessGuardSink {
  // KEIKO-0837: err may return a Promise so the caller can drain the stderr write
  // BEFORE process.exit() is invoked. The default sink still returns void (Node's
  // process.stderr.write is synchronous for TTY/pipes on POSIX), but a test seam or a
  // consumer that pipes stderr through an async transport can now be sure the fatal line
  // actually reached its destination.
  readonly err: (text: string) => void | Promise<void>;
  readonly exit: (code: number) => void;
  // Test seam: injects a fake (or deliberately hanging) keiko-server module without exercising
  // the real dynamic import. Defaults to it in production — see `loadServerModule` below — so no
  // production call site ever has to supply this.
  readonly loadServer?: (() => Promise<FatalDiagnosticsModule>) | undefined;
}

function loadServerModule(): Promise<FatalDiagnosticsModule> {
  return import("@oscharko-dev/keiko-server");
}

const DEFAULT_PROCESS_GUARD_SINK: ProcessGuardSink = {
  err: (text: string): void => {
    process.stderr.write(text);
  },
  exit: (code: number): void => {
    process.exit(code);
  },
  loadServer: loadServerModule,
};

// A crashed process must exit within a human-noticeable bound even when the classifier import
// hangs. Two seconds is generous for a healthy install (the import itself costs low tens of
// milliseconds) and still short enough that an operator never mistakes the wait for a second hang.
const FATAL_IMPORT_TIMEOUT_MS = 2_000;

type FatalReasonKind = "uncaught-exception" | "unhandled-rejection";

// Last-resort classification for the bounded-timeout branch only: the timeout firing already
// means something is badly wrong (a hung import, a broken installation), so this must not trust
// anything beyond `instanceof`/`typeof` — no reflective property read, nothing that could itself
// throw or carry attacker-controlled content. It is a degrade, not a second classifier: every
// crash that resolves the real import in time uses `contentFreeErrorClass` via `describeError`.
function fallbackErrorKind(reason: unknown): string {
  return reason instanceof Error ? "Error" : typeof reason;
}

// Pure formatter. `errorKind` must already be a content-free classification by the time it
// reaches here (never a raw `.message`) — see `writeFatalLine` and `fallbackErrorKind`.
export function fatalProcessLine(kind: string, errorKind: string): string {
  return `keiko: fatal ${kind} (${errorKind}). The process will exit.\n`;
}

function fatalActivityLogExtra(
  machineKind: FatalReasonKind,
  described: ReturnType<FatalDiagnosticsModule["describeError"]>,
): Readonly<Record<string, unknown>> {
  const extra: Record<string, unknown> = { kind: machineKind };
  if (described.frames !== undefined) extra.frames = described.frames;
  if (described.causeChain !== undefined) extra.causeChain = described.causeChain;
  return extra;
}

function writeFatalActivityLogLine(
  server: FatalDiagnosticsModule,
  machineKind: FatalReasonKind,
  described: ReturnType<FatalDiagnosticsModule["describeError"]>,
): void {
  const stateDir = process.env.KEIKO_STATE_DIR;
  if (typeof stateDir !== "string" || stateDir.length === 0) return;
  const activityLog: ServerLogSink = server.createFileServerLogSink(stateDir);
  const event: ServerLogEvent = {
    level: "error",
    category: "process",
    op: "process.fatal",
    errorKind: described.code ?? described.errorClass,
    extra: fatalActivityLogExtra(machineKind, described),
  };
  activityLog.write(event);
  activityLog.close?.();
}

// Loads the classifier, writes the `process.fatal` activity-log line when a state directory is in
// scope, and resolves the stderr text — the content-free class only, never the code (the JSON
// line's `errorKind` is code-first for machine matching; the human-facing stderr line stays the
// simpler class name). Never throws: a failure here is caught by the caller, which keeps the
// pre-computed fallback line rather than losing the crash report entirely.
async function writeFatalLine(
  humanKind: string,
  machineKind: FatalReasonKind,
  reason: unknown,
  loadServer: () => Promise<FatalDiagnosticsModule>,
): Promise<string> {
  const server = await loadServer();
  const described = server.describeError(reason);
  writeFatalActivityLogLine(server, machineKind, described);
  return fatalProcessLine(humanKind, described.errorClass);
}

// Races the classifier import against the bounded timeout above. Exactly one of the two paths
// calls `finish()` for real (the guard makes the other a no-op), so stderr is written and the
// process exits exactly once, whichever settles first. Returned as a Promise (rather than
// fire-and-forget `void`) purely so tests can await completion through the exact listener
// `process.on` receives; Node itself ignores a listener's return value.
async function handleFatalReason(
  humanKind: string,
  machineKind: FatalReasonKind,
  reason: unknown,
  sink: ProcessGuardSink,
): Promise<void> {
  const loadServer = sink.loadServer ?? loadServerModule;
  let line = fatalProcessLine(humanKind, fallbackErrorKind(reason));
  let settled = false;
  // KEIKO-0837: await the sink.err write BEFORE sink.exit so an async stderr transport
  // (or a slow pipe on macOS) is guaranteed to flush the fatal line before the process
  // is instructed to exit. Node's process.stderr.write is synchronous for TTY/pipes on
  // POSIX; awaiting a plain-void return is a no-op, so this only affects the async path.
  const finish = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    try {
      await sink.err(line);
    } catch {
      // A sink whose write itself throws should not prevent the process from exiting.
    }
    sink.exit(1);
  };
  await new Promise<void>((resolve) => {
    // Deliberately NOT `.unref()`'d. This timer is created only from inside an actual crash
    // handler (never at module scope, never on a healthy invocation), so keeping it ref'd cannot
    // delay or block a normal exit — the resolved-import path below clears it as soon as
    // `writeFatalLine` settles. An unref'd timer does not count toward event-loop liveness: if
    // this handler is the only thing pending (a real crash with no other timers/I/O in flight)
    // and the classifier import hangs forever, Node's empty-event-loop exit would fire BEFORE the
    // timeout callback ever runs, so the process would exit 0 with no stderr line and no
    // `process.fatal` record — silently swallowing the very crash this file exists to report.
    const timer = setTimeout(() => {
      void finish().finally(resolve);
    }, FATAL_IMPORT_TIMEOUT_MS);
    writeFatalLine(humanKind, machineKind, reason, loadServer)
      .then((resolvedLine) => {
        line = resolvedLine;
      })
      .catch(() => {
        // The real classification failed to resolve into a value (a genuinely broken module, not
        // merely a slow one) — the fallback `line` computed above is still safe to use.
      })
      .finally(() => {
        clearTimeout(timer);
        void finish().finally(resolve);
      });
  });
}

// KEIKO-0837: installProcessGuards must be idempotent. A second call (e.g. because the
// entrypoint re-runs a bootstrapping helper, or a test invokes it twice) previously
// registered a second copy of each listener, so a single crash produced duplicate stderr
// lines AND double-called process.exit. This module-level flag makes the second (and
// every subsequent) call a no-op — matching what real bootstrapping code needs from a
// crash handler.
let processGuardsInstalled = false;

export function installProcessGuards(sink: ProcessGuardSink = DEFAULT_PROCESS_GUARD_SINK): void {
  if (processGuardsInstalled) return;
  processGuardsInstalled = true;
  // Node never awaits an event listener's return value, so each listener stays void-returning and
  // explicitly floats its async work with `void` — the same fire-and-forget shape every other
  // process-signal listener in this codebase already uses.
  process.on("uncaughtException", (error: Error): void => {
    void handleFatalReason("uncaught exception", "uncaught-exception", error, sink);
  });
  process.on("unhandledRejection", (reason: unknown): void => {
    void handleFatalReason("unhandled rejection", "unhandled-rejection", reason, sink);
  });
}

// Test seam: resets the "already installed" latch so unit tests can exercise both the
// first-install and idempotent-noop paths. Never called from production code.
export function _resetInstalledProcessGuardsForTests(): void {
  processGuardsInstalled = false;
}
