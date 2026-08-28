// Optional, injected message-history compaction port (KEIKO-0726, #3323). Mirrors the
// HarnessShaperPort pattern (shaper-port.ts): the harness produces no compaction itself and never
// imports keiko-workflows; the concrete compactor — backed by the keiko-workflows
// context-budget allocator, guarded by the same profile-present precondition PR4 used for the
// chat path's conversationForGatewayWithCompaction — is built and injected by the production
// wiring tier, which already depends on keiko-workflows. When no port is injected (every existing
// caller), checkModelCallLimits keeps its pre-KEIKO-0726 byte-only fail-closed behavior,
// byte-identical to today.
//
// The port is content-agnostic and MUST be total / fail closed: given the current accumulating
// message array and the byte budget it must fit under, it returns either a compacted message
// array or undefined ("nothing more this port can evict"). Any error the concrete implementation
// encounters must be represented as undefined, never thrown through the harness — checkModelCallLimits
// additionally wraps every call in try/catch and treats a throw identically to undefined, so a
// broken port degrades to the unchanged hard-fail rather than crashing the run.
//
// Reconciliation with HarnessShaperPort (ADR-0055 D4, executor.ts): the shaper narrowly recompacts
// individual tool-role messages, reactively, at tool-result insertion time. This port acts at
// model-call re-entry, over the WHOLE accumulating history. The two compose rather than conflict
// because they are scoped to disjoint responsibilities: production wiring for this port MUST NOT
// rewrite the content of any role:"tool" message — it may only evict/reorder whole messages —
// leaving tool-role content exactly as the shaper (or the raw tool result) left it.

import type { ChatMessage } from "@oscharko-dev/keiko-model-gateway";

export interface HarnessCompactionInput {
  // The full accumulating conversation, in order, as the harness currently holds it.
  readonly messages: readonly ChatMessage[];
  // The same byte ceiling checkModelCallLimits enforces (ctx.limits.maxContextBytes).
  readonly maxContextBytes: number;
}

export interface HarnessCompactionResult {
  // Replacement message array. The caller re-validates its byte size before trusting it — a
  // result that does not actually fit under maxContextBytes is treated as "could not compact".
  readonly messages: readonly ChatMessage[];
}

export type HarnessCompactionPort = (
  input: HarnessCompactionInput,
) => HarnessCompactionResult | undefined;
