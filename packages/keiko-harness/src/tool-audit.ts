import type { RunContext } from "./context.js";
import type { ToolCallMetadata } from "./ports.js";

export function emitToolMetadata(
  ctx: RunContext,
  metadata: ToolCallMetadata | undefined,
  durationMs: number,
): void {
  if (metadata === undefined) {
    return;
  }
  if (metadata.kind === "command") {
    ctx.emitter.emit({
      type: "sandbox:configured",
      envAllowlist: metadata.sandbox.envAllowlist,
      network: metadata.sandbox.network,
      maxOutputBytes: metadata.sandbox.maxOutputBytes,
      timeoutMs: metadata.sandbox.timeoutMs,
      terminationGraceMs: metadata.sandbox.terminationGraceMs,
      cwdRequested: metadata.sandbox.cwdRequested,
    });
    ctx.emitter.emit({
      type: "command:executed",
      executable: metadata.executable,
      argCount: metadata.argCount,
      exitCode: metadata.exitCode,
      timedOut: metadata.timedOut,
      durationMs,
    });
    return;
  }
  ctx.emitter.emit({
    type: "patch:applied",
    changedFiles: metadata.changedFiles,
    created: metadata.created,
    deleted: metadata.deleted,
  });
}
