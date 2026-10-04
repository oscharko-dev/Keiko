import {
  DEFAULT_EXPLORATION_BUDGET,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { assembleContextPack } from "@oscharko-dev/keiko-workflows";

/** Drive the real assembler's closed producer-invariant failure through route consumer tests. */
export async function failInvalidOmissionAssembly(scope: SelectedScope): Promise<never> {
  await assembleContextPack({
    scope,
    query: {
      kind: "exact-symbol",
      text: "ReviewProbe",
      caseSensitive: true,
      maxResults: 1,
      emittedAtMs: 0,
    },
    budget: DEFAULT_EXPLORATION_BUDGET,
    atoms: [],
    ranked: [],
    excerpts: new Map(),
    omittedFromRanking: [
      { scopePath: "../escaped-private-file", reason: "tool-unavailable", omittedAtMs: 0 },
    ],
  });
  throw new Error("fixture expected invalid omission refusal");
}
