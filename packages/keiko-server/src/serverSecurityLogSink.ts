import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import { processServerLogSinkFor } from "./process-log-sink.js";

/**
 * The sink a server-side security operation reports to when its composition names no narrower one.
 * The server always runs with its process sink, so a line that has no operation of its own is
 * written under the shared unknown correlation id instead of being lost as an unwired port (#4351).
 */
export function serverSecurityLogSink(): SecurityLogSink {
  return processServerLogSinkFor(UNKNOWN_CORRELATION_ID);
}
