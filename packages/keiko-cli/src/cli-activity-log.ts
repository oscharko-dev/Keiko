// The Activity Log port for CLI commands that compose domain packages in-process (#3532).
//
// The BFF hands every domain package the server's one process-wide adapter
// (`processServerLogSink`). A CLI command that opens the memory vault or builds a Model Gateway
// itself used to pass nothing, so those packages fell back to their silent no-op sinks and a
// `keiko memory` or `keiko run` session left no Activity Log evidence at all. This helper returns
// the same adapter: it resolves the runtime state directory exactly as `keiko start` does
// (`KEIKO_STATE_DIR`, else `<cwd>/.keiko`), never throws into the command, and counts any line it
// cannot persist in the process loss ledger. The server module loads lazily, only for the commands
// that construct those packages (GEN-PERF-CLI-001).

import type { ProcessServerLogSink } from "@oscharko-dev/keiko-server";
import { loadServer } from "./lazy-modules.js";

export async function cliActivityLogSink(): Promise<ProcessServerLogSink> {
  return (await loadServer()).processServerLogSink();
}
