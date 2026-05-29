// ScriptedModelPort — product-code model replay (ADR-0012 D4). Unlike the private test helper
// `scriptedModel` in tests/workflows/unit-tests/_support.ts, this is a first-class, SDK-exported
// capability: the deterministic offline evaluation runner and any future replay tooling build a
// ModelPort from a fixed transcript and inject it through the standard deps.model seam. No workflow
// code is touched. The port replays `script` in order; once calls exceed the script length the last
// entry repeats; an Error entry rejects with that error; an empty script rejects descriptively.

import type { ModelPort } from "../harness/ports.js";
import type { NormalizedResponse } from "../gateway/types.js";

export interface ScriptedModelPort extends ModelPort {
  // Number of calls made so far.
  readonly callCount: () => number;
}

export function createScriptedModelPort(
  script: readonly (NormalizedResponse | Error)[],
): ScriptedModelPort {
  let calls = 0;
  return {
    callCount: (): number => calls,
    // The AbortSignal is accepted to satisfy the ModelPort contract and reserve future cancellation
    // threading, but offline replay is synchronous and never observes it.
    call: (): Promise<NormalizedResponse> => {
      const index = Math.min(calls, script.length - 1);
      calls += 1;
      const entry = script[index];
      if (entry === undefined) {
        return Promise.reject(
          new Error("ScriptedModelPort: empty script — no scripted response to return"),
        );
      }
      if (entry instanceof Error) {
        return Promise.reject(entry);
      }
      return Promise.resolve(entry);
    },
  };
}
