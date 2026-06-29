// Issue #1381, ADR-0069 D6/I4 — bounded, content-free in-memory ledger of LSP process lifecycle
// events. Mirrors agentActionAudit.ts: a module-level append-only FIFO surfaces "recent LSP process
// activity" to the read-only status route. The record is content-free by construction (the contract
// `LspLifecycleEvent` carries only an opaque managerId, an enum status/error code, counts, and a
// timestamp — no source text, paths, method names, or raw stderr) and is run through the
// keiko-security redactor as defense in depth before it is stored or served, so a secret-shaped
// substring that ever slipped into an id cannot reach the ledger.

import type { LspLifecycleEvent } from "@oscharko-dev/keiko-contracts";
import { deepRedactStrings, redact } from "@oscharko-dev/keiko-security";

// Bounded like the agent-audit ledger: a long-lived server must not grow this without limit.
const MAX_EVENTS = 200;

interface LedgerState {
  readonly events: LspLifecycleEvent[];
}

const state: LedgerState = { events: [] };

function redactEvent(event: LspLifecycleEvent): LspLifecycleEvent {
  return deepRedactStrings(event, redact) as LspLifecycleEvent;
}

// Record one content-free lifecycle event. Best-effort and throw-free: a ledger failure must never
// break the manager's lifecycle path. Returns the stored (redacted) event, or null when recording
// failed. The manager's `onLifecycleEvent` callback feeds this on every state transition.
export function recordLspLifecycleEvent(event: LspLifecycleEvent): LspLifecycleEvent | null {
  try {
    const redacted = redactEvent(event);
    state.events.push(redacted);
    if (state.events.length > MAX_EVENTS) {
      state.events.splice(0, state.events.length - MAX_EVENTS);
    }
    return redacted;
  } catch {
    return null;
  }
}

// Recent lifecycle events, newest last, bounded to the FIFO cap. Already redacted at record time.
export function listLspLifecycleEvents(): readonly LspLifecycleEvent[] {
  return state.events;
}

export function _resetLspLifecycleLedgerForTests(): void {
  state.events.length = 0;
}
