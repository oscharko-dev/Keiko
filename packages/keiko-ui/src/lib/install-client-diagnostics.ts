"use client";

// Where THIS application delivers client diagnostics (0.3.0 release audit, #2802).
//
// `client-diagnostics.ts` owns the contract — what a diagnostic is, and that it is already redacted.
// It deliberately owns no transport, so that the one place a browser console is written to is a
// module whose whole purpose is choosing the transport, rather than a line buried in the library
// every call site imports.
//
// The console is the right destination for this product today: Keiko is local-first, there is no
// client->server diagnostics ingest, and adding one would mean a new subsystem and a new trust
// boundary for client-supplied text (AGENTS.md §5). Swapping it later — an operator panel, a support
// bundle, an opted-in endpoint — is an edit to this file and nothing else.
//
// Importing this module installs the transport as a side effect, at module scope rather than in an
// effect, so diagnostics raised during hydration or an early boot crash are delivered too. Whatever
// the sink buffered before this point is flushed by `setClientDiagnosticWriter`.

import { setClientDiagnosticWriter } from "./client-diagnostics";

function writeToBrowserConsole(message: string): void {
  // The single sanctioned console access in keiko-ui production code. Everything above this line is
  // why it is here — in the transport, not in the sink — rather than at each call site.
  // eslint-disable-next-line no-console
  if (typeof console !== "undefined" && typeof console.warn === "function") console.warn(message);
}

setClientDiagnosticWriter(writeToBrowserConsole);

export { writeToBrowserConsole };
