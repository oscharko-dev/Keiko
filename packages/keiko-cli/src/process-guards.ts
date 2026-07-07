// Process-level catch-alls for the CLI/BFF process. Request-scoped errors are
// already redacted and correlation-keyed inside keiko-server, but an async error
// OUTSIDE any request (timer, fire-and-forget promise, spawn bookkeeping)
// previously crashed the process with a raw stack trace. These guards keep the
// fail-fast exit (state correctness over limping on) while emitting one clean,
// body-free line: error name + message only — never a stack, never payload
// contents. The logic lives here (not in the SHA-pinned root facade) so it is
// unit-testable; the bin shim only calls installProcessGuards().

export interface ProcessGuardSink {
  readonly err: (text: string) => void;
  readonly exit: (code: number) => void;
}

export function fatalProcessLine(kind: string, reason: unknown): string {
  const named =
    reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : typeof reason === "string"
        ? reason
        : "unknown cause";
  return `keiko: fatal ${kind} (${named}). The process will exit.\n`;
}

export function installProcessGuards(
  sink: ProcessGuardSink = {
    err: (text: string): void => {
      process.stderr.write(text);
    },
    exit: (code: number): void => {
      process.exit(code);
    },
  },
): void {
  process.on("uncaughtException", (error: Error) => {
    sink.err(fatalProcessLine("uncaught exception", error));
    sink.exit(1);
  });
  process.on("unhandledRejection", (reason: unknown) => {
    sink.err(fatalProcessLine("unhandled rejection", reason));
    sink.exit(1);
  });
}
